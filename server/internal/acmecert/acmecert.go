// Package acmecert obtains and renews the TLS certificate used by --domain
// mode. It wraps golang.org/x/crypto/acme/autocert, so the only new code here
// is lifecycle: the two challenge listeners, an eager first issuance with a
// clear error instead of a silent failure on the first client handshake, and
// the TLSMaterial adapter the gateway already understands.
//
// Let's Encrypt validates HTTP-01 on TCP 80 and TLS-ALPN-01 on TCP 443. The
// control plane itself keeps listening on 7443; the two extra listeners exist
// only for ACME (and redirect plain HTTP to the control plane). That is why the
// systemd unit written by deploy/install.sh grants CAP_NET_BIND_SERVICE.
package acmecert

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"

	"github.com/v4dikos1/RosTalk/server/internal/netutil"
)

// Defaults for the two ACME challenge ports.
const (
	DefaultHTTPAddr = ":80"
	DefaultTLSAddr  = ":443"
	// DefaultObtainTimeout bounds the first certificate request.
	DefaultObtainTimeout = 90 * time.Second
)

// Config configures domain mode.
type Config struct {
	// Domain is the public DNS name clients use.
	Domain string
	// DataDir holds the ACME account key and certificates. Defaults to
	// <server data>/acme.
	DataDir string
	// Email is the optional ACME account contact.
	Email string
	// HTTPAddr and TLSAddr are the challenge listeners (:80 and :443).
	HTTPAddr string
	TLSAddr  string
	// DirectoryURL overrides the ACME directory; tests point it at a fake
	// server. Empty means the production Let's Encrypt directory.
	DirectoryURL string
	// ObtainTimeout bounds the first issuance; tests shorten it.
	ObtainTimeout time.Duration
	// Logger receives lifecycle messages, never keys or tokens.
	Logger *slog.Logger
}

// Manager owns the autocert manager and its listeners.
type Manager struct {
	cfg      Config
	mgr      *autocert.Manager
	logger   *slog.Logger
	material *netutil.TLSMaterial

	mu      sync.Mutex
	httpSrv *http.Server
	tlsSrv  *http.Server
	httpLn  net.Listener
	tlsLn   net.Listener
	started bool
	closed  bool
}

// New validates the configuration and prepares the autocert manager. It does
// not bind ports; Start does that and obtains the certificate.
func New(cfg Config) (*Manager, error) {
	domain := strings.TrimSpace(cfg.Domain)
	if domain == "" {
		return nil, errors.New("acme: a domain is required")
	}
	if strings.ContainsAny(domain, "/: ") {
		return nil, fmt.Errorf("acme: %q is not a bare domain name", cfg.Domain)
	}
	if cfg.DataDir == "" {
		return nil, errors.New("acme: a data directory is required")
	}
	if cfg.HTTPAddr == "" {
		cfg.HTTPAddr = DefaultHTTPAddr
	}
	if cfg.TLSAddr == "" {
		cfg.TLSAddr = DefaultTLSAddr
	}
	if cfg.ObtainTimeout <= 0 {
		cfg.ObtainTimeout = DefaultObtainTimeout
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, fmt.Errorf("acme: create %q: %w", cfg.DataDir, err)
	}

	mgr := &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		Cache:      autocert.DirCache(cfg.DataDir),
		Email:      cfg.Email,
		HostPolicy: autocert.HostWhitelist(domain),
	}
	if cfg.DirectoryURL != "" {
		mgr.Client = &acme.Client{DirectoryURL: cfg.DirectoryURL}
	}

	return &Manager{cfg: cfg, mgr: mgr, logger: logger}, nil
}

// Domain returns the configured DNS name.
func (m *Manager) Domain() string { return m.cfg.Domain }

// Start binds the challenge listeners, obtains the certificate and returns the
// material ready for the gateway.
func (m *Manager) Start(ctx context.Context) (*netutil.TLSMaterial, error) {
	m.mu.Lock()
	if m.started {
		m.mu.Unlock()
		return m.material, nil
	}
	m.started = true
	m.mu.Unlock()

	httpLn, err := net.Listen("tcp", m.cfg.HTTPAddr)
	if err != nil {
		return nil, fmt.Errorf("--domain=%q: cannot listen on %s for the Let's Encrypt HTTP challenge: %w; "+
			"open TCP 80 and let the service bind it (deploy/install.sh sets CAP_NET_BIND_SERVICE)", m.cfg.Domain, m.cfg.HTTPAddr, err)
	}
	tlsLn, err := net.Listen("tcp", m.cfg.TLSAddr)
	if err != nil {
		_ = httpLn.Close()
		return nil, fmt.Errorf("--domain=%q: cannot listen on %s for the Let's Encrypt TLS challenge: %w; "+
			"open TCP 443 and let the service bind it", m.cfg.Domain, m.cfg.TLSAddr, err)
	}
	m.httpLn, m.tlsLn = httpLn, tlsLn

	redirect := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://"+m.controlPlaneHost(r)+"/", http.StatusFound)
	})
	m.httpSrv = &http.Server{
		Handler:           m.mgr.HTTPHandler(redirect),
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          slog.NewLogLogger(m.logger.Handler(), slog.LevelWarn),
	}
	tlsConfig := m.mgr.TLSConfig()
	tlsConfig.MinVersion = tls.VersionTLS12
	tlsConfig.NextProtos = []string{"http/1.1", acme.ALPNProto}
	m.tlsSrv = &http.Server{
		Handler:           redirect,
		TLSConfig:         tlsConfig,
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          slog.NewLogLogger(m.logger.Handler(), slog.LevelWarn),
	}

	go func() {
		if serveErr := m.httpSrv.Serve(httpLn); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			m.logger.Warn("ACME HTTP challenge listener stopped", "error", serveErr)
		}
	}()
	go func() {
		if serveErr := m.tlsSrv.Serve(tls.NewListener(tlsLn, tlsConfig)); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			m.logger.Warn("ACME TLS challenge listener stopped", "error", serveErr)
		}
	}()

	cert, err := m.obtain(ctx)
	if err != nil {
		_ = m.Close()
		return nil, err
	}
	m.logger.Info("ACME certificate is ready",
		"domain", m.cfg.Domain,
		"expires", cert.Leaf.NotAfter.UTC().Format(time.RFC3339),
		"issuer", cert.Leaf.Issuer.CommonName,
	)

	m.material = &netutil.TLSMaterial{
		Dir:            m.cfg.DataDir,
		GetCertificate: m.mgr.GetCertificate,
		Leaf:           cert.Leaf,
	}
	return m.material, nil
}

// obtain asks autocert for a certificate now. autocert renews in the
// background later through the same GetCertificate callback.
func (m *Manager) obtain(ctx context.Context) (*tls.Certificate, error) {
	timeout := m.cfg.ObtainTimeout
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining < timeout {
			timeout = remaining
		}
	}
	obtainCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	type result struct {
		cert *tls.Certificate
		err  error
	}
	done := make(chan result, 1)
	go func() {
		cert, err := m.mgr.GetCertificate(&tls.ClientHelloInfo{
			ServerName:      m.cfg.Domain,
			SupportedProtos: []string{"http/1.1"},
		})
		done <- result{cert: cert, err: err}
	}()

	select {
	case <-obtainCtx.Done():
		return nil, fmt.Errorf("--domain=%q: no Let's Encrypt certificate after %s: %w. "+
			"Check that the DNS A/AAAA record points at this machine, that TCP 80 and 443 are reachable from the internet and that nothing else uses them. "+
			"Without a public domain, run without --domain and use the fingerprint invite link",
			m.cfg.Domain, timeout, obtainCtx.Err())
	case res := <-done:
		if res.err != nil {
			return nil, fmt.Errorf("--domain=%q: could not obtain a Let's Encrypt certificate: %w. "+
				"Check the DNS record, ports 80/443 and the ACME rate limit; without a public domain run without --domain", m.cfg.Domain, res.err)
		}
		if res.cert == nil {
			return nil, fmt.Errorf("--domain=%q: the ACME manager returned no certificate", m.cfg.Domain)
		}
		if res.cert.Leaf == nil && len(res.cert.Certificate) > 0 {
			if leaf, parseErr := x509.ParseCertificate(res.cert.Certificate[0]); parseErr == nil {
				res.cert.Leaf = leaf
			}
		}
		return res.cert, nil
	}
}

func (m *Manager) controlPlaneHost(r *http.Request) string {
	host := m.cfg.Domain
	if _, port, err := net.SplitHostPort(r.Host); err == nil && port != "80" && port != "443" {
		return net.JoinHostPort(host, port)
	}
	return host
}

// Close stops the challenge listeners. Certificates stay in the data directory.
func (m *Manager) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	httpSrv, tlsSrv := m.httpSrv, m.tlsSrv
	m.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var errs []error
	if httpSrv != nil {
		if err := httpSrv.Shutdown(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if tlsSrv != nil {
		if err := tlsSrv.Shutdown(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// CacheDir returns the directory the account key and certificates live in. It
// exists so backup can document what it copies.
func (m *Manager) CacheDir() string { return filepath.Clean(m.cfg.DataDir) }
