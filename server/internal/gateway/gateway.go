// Package gateway owns the public HTTPS listener: TLS termination, /healthz,
// the /ws control-plane endpoint and graceful shutdown.
//
// It deliberately knows nothing about authentication frames. Once a WebSocket
// is accepted it hands a Transport to internal/auth and only keeps the
// connection alive (pings, read limits, timeouts).
package gateway

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/auth"
	"github.com/v4dikos1/RosTalk/server/internal/netutil"
)

const (
	// maxFrameSize bounds one control-plane frame. The protocol is tiny; a
	// client never needs more than this, and it protects the server from a
	// memory-exhaustion frame.
	maxFrameSize = 1 << 20 // 1 MiB

	defaultPingInterval = 25 * time.Second
	defaultPingTimeout  = 10 * time.Second
	writeTimeout        = 10 * time.Second
)

// Config configures the gateway.
type Config struct {
	// Listen is the address to bind, e.g. ":7443" or "127.0.0.1:0".
	Listen string
	// TLS is the certificate material from internal/netutil.
	TLS *netutil.TLSMaterial
	// Auth handles the handshake after a WebSocket is accepted.
	Auth *auth.Manager
	// RTC is the media signalling proxy mounted on /rtc (WebSocket included).
	// The gateway treats it as an opaque HTTP handler: which SFU answers it is
	// none of its business (design 3).
	RTC http.Handler
	// API is the bearer-token HTTP API mounted on /api/v1 (stage 3.2). It is
	// opaque to the gateway, which only terminates TLS.
	API http.Handler
	// PublicHost is the host (with optional port) clients use in invite links.
	// It is allowed as an Origin in addition to the request Host, which matters
	// behind a reverse proxy.
	PublicHost string
	Logger     *slog.Logger
	// PingInterval and PingTimeout are tunable for tests.
	PingInterval time.Duration
	PingTimeout  time.Duration
}

// Server is the running HTTPS gateway.
type Server struct {
	cfg        Config
	logger     *slog.Logger
	httpServer *http.Server
	listener   net.Listener

	mu     sync.Mutex
	conns  map[*websocket.Conn]struct{}
	closed bool
}

// New creates a gateway. Call Start to bind and serve.
func New(cfg Config) (*Server, error) {
	if cfg.TLS == nil {
		return nil, errors.New("gateway: TLS material is required")
	}
	if cfg.Auth == nil {
		return nil, errors.New("gateway: auth manager is required")
	}
	if cfg.Listen == "" {
		return nil, errors.New("gateway: listen address is required")
	}
	if cfg.PingInterval <= 0 {
		cfg.PingInterval = defaultPingInterval
	}
	if cfg.PingTimeout <= 0 {
		cfg.PingTimeout = defaultPingTimeout
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}

	s := &Server{
		cfg:    cfg,
		logger: logger,
		conns:  make(map[*websocket.Conn]struct{}),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/ws", s.handleWebSocket)
	if cfg.RTC != nil {
		// Media signalling: LiveKit's WebSocket endpoint plus the HTTP calls it
		// makes on the same path. Everything is forwarded as-is.
		mux.Handle("/rtc", cfg.RTC)
		mux.Handle("/rtc/", cfg.RTC)
	}
	if cfg.API != nil {
		mux.Handle("/api/v1/", cfg.API)
	}

	s.httpServer = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
	return s, nil
}

// Start binds the listener and begins serving in the background.
func (s *Server) Start() error {
	ln, err := net.Listen("tcp", s.cfg.Listen)
	if err != nil {
		return fmt.Errorf("gateway: listen on %q: %w", s.cfg.Listen, err)
	}
	tlsConfig := s.cfg.TLS.TLSConfig()
	s.listener = tls.NewListener(ln, tlsConfig)

	go func() {
		err := s.httpServer.Serve(s.listener)
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.logger.Error("gateway stopped unexpectedly", "error", err)
		}
	}()
	return nil
}

// Addr returns the bound address. Port 0 in Config resolves to the real port.
func (s *Server) Addr() net.Addr {
	if s.listener == nil {
		return nil
	}
	return s.listener.Addr()
}

// Shutdown stops accepting, closes live WebSockets and waits for handlers.
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	conns := make([]*websocket.Conn, 0, len(s.conns))
	for conn := range s.conns {
		conns = append(conns, conn)
	}
	s.mu.Unlock()

	for _, conn := range conns {
		_ = conn.Close(websocket.StatusGoingAway, "server is shutting down")
	}

	err := s.httpServer.Shutdown(ctx)
	if err != nil {
		return fmt.Errorf("gateway: shutdown: %w", err)
	}
	return nil
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write([]byte("ok\n"))
	}
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin checking is done by the library: a request without Origin is
		// allowed (native client), the request Host is always allowed, and
		// PublicHost is allowed for deployments behind a reverse proxy.
		OriginPatterns:  originPatterns(s.cfg.PublicHost, r.Host),
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		s.logger.Debug("websocket upgrade rejected", "remote", r.RemoteAddr, "error", err)
		return
	}
	conn.SetReadLimit(maxFrameSize)

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = conn.Close(websocket.StatusGoingAway, "server is shutting down")
		return
	}
	s.conns[conn] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.conns, conn)
		s.mu.Unlock()
		_ = conn.CloseNow()
	}()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Ping in the background: coder/websocket answers pings from the peer in
	// its read loop, and Ping here doubles as a liveness probe for ours.
	go s.keepAlive(ctx, conn, cancel)

	transport := &transport{conn: conn, remote: remoteAddr(r)}
	if err := s.cfg.Auth.Handle(ctx, transport); err != nil {
		s.logger.Warn("connection handler failed", "remote", r.RemoteAddr, "error", err)
	}
}

func (s *Server) keepAlive(ctx context.Context, conn *websocket.Conn, cancel context.CancelFunc) {
	ticker := time.NewTicker(s.cfg.PingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pingCtx, pingCancel := context.WithTimeout(ctx, s.cfg.PingTimeout)
			err := conn.Ping(pingCtx)
			pingCancel()
			if err != nil {
				s.logger.Debug("ping failed, closing connection", "error", err)
				cancel()
				_ = conn.CloseNow()
				return
			}
		}
	}
}

// originPatterns builds library patterns for the extra hosts allowed besides
// the request Host. Without a scheme each pattern matches the origin host,
// which is what we want.
func originPatterns(publicHost, requestHost string) []string {
	var patterns []string
	seen := map[string]bool{}
	add := func(host string) {
		host = strings.TrimSpace(host)
		if host == "" {
			return
		}
		host = strings.ToLower(host)
		if seen[host] {
			return
		}
		seen[host] = true
		patterns = append(patterns, host)
	}

	add(publicHost)
	// A bare public host (no port) must also accept the origin with the port
	// the request actually arrived on.
	if publicHost != "" {
		if u, err := url.Parse("https://" + publicHost); err == nil && u.Port() == "" && u.Host != "" {
			if _, port, err := net.SplitHostPort(requestHost); err == nil {
				add(net.JoinHostPort(u.Hostname(), port))
			}
		}
	}
	return patterns
}

// transport adapts a WebSocket connection to auth.Transport.
type transport struct {
	conn   *websocket.Conn
	remote net.Addr

	writeMu sync.Mutex
}

func (t *transport) RemoteAddr() net.Addr { return t.remote }

func (t *transport) Read(ctx context.Context) (*rostalkv1.ClientFrame, error) {
	typ, data, err := t.conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageBinary {
		return nil, fmt.Errorf("expected a binary frame, got %v", typ)
	}
	frame := &rostalkv1.ClientFrame{}
	if err := proto.Unmarshal(data, frame); err != nil {
		return nil, fmt.Errorf("decode ClientFrame: %w", err)
	}
	return frame, nil
}

func (t *transport) Write(ctx context.Context, frame *rostalkv1.ServerFrame) error {
	data, err := proto.Marshal(frame)
	if err != nil {
		return fmt.Errorf("encode ServerFrame: %w", err)
	}
	writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	return t.conn.Write(writeCtx, websocket.MessageBinary, data)
}

func (t *transport) Close() error {
	return t.conn.CloseNow()
}

func remoteAddr(r *http.Request) net.Addr {
	host, port, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return staticAddr(r.RemoteAddr)
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return staticAddr(r.RemoteAddr)
	}
	return &net.TCPAddr{IP: ip, Port: atoiOrZero(port)}
}

func atoiOrZero(s string) int {
	var n int
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}

type staticAddr string

func (a staticAddr) Network() string { return "tcp" }
func (a staticAddr) String() string  { return string(a) }
