// Package server wires the control plane together: configuration, database,
// identity, TLS material, authentication and the HTTPS gateway.
//
// Stage 1.2 starts with an empty data directory, creates everything it needs,
// prints a one-time administrator invite link and accepts clients by Ed25519
// key. Channels and media arrive in later stages.
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/acmecert"
	"github.com/v4dikos1/RosTalk/server/internal/adminsock"
	"github.com/v4dikos1/RosTalk/server/internal/auth"
	"github.com/v4dikos1/RosTalk/server/internal/avatars"
	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/chat"
	"github.com/v4dikos1/RosTalk/server/internal/control"
	"github.com/v4dikos1/RosTalk/server/internal/gateway"
	"github.com/v4dikos1/RosTalk/server/internal/httpapi"
	"github.com/v4dikos1/RosTalk/server/internal/identity"
	"github.com/v4dikos1/RosTalk/server/internal/legacy"
	"github.com/v4dikos1/RosTalk/server/internal/media"
	"github.com/v4dikos1/RosTalk/server/internal/metrics"
	"github.com/v4dikos1/RosTalk/server/internal/nat"
	"github.com/v4dikos1/RosTalk/server/internal/netutil"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/secret"
	"github.com/v4dikos1/RosTalk/server/internal/sessionauth"
	"github.com/v4dikos1/RosTalk/server/internal/state"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

// AdminInviteFile stores the plaintext bootstrap invite token while the server
// still has no administrator. The database keeps only the hash, so this file is
// the one place the token survives a restart; it is removed as soon as the
// invite is consumed.
const AdminInviteFile = "admin-invite"

// Config is the startup configuration. Everything else lives in the settings
// table (design 4.5).
type Config struct {
	// DataDir holds the database, identity key, certificates and the pending
	// admin invite.
	DataDir string
	// Listen is the HTTPS/WSS bind address.
	Listen string
	// Domain switches to an automatic Let's Encrypt certificate. The invite
	// links then carry no fp and clients use Web PKI (design 4.3).
	Domain string
	// ACMEEmail is the optional ACME account contact.
	ACMEEmail string
	// ACMEHTTPAddr and ACMETLSAddr are the challenge listeners for domain mode.
	// Zero values mean :80 and :443.
	ACMEHTTPAddr string
	ACMETLSAddr  string
	// ACMEDirectoryURL overrides the ACME directory (tests).
	ACMEDirectoryURL string
	// ACMEObtainTimeout bounds the first certificate request; tests shorten it.
	ACMEObtainTimeout time.Duration
	// PublicHost is the host (optional port) clients use in invite links. It
	// must be the LAN IP or DNS name clients can reach, never localhost when
	// clients run on another machine (ADR 0001).
	PublicHost string
	// AdvertiseIP is the address the media backend announces in ICE candidates
	// (rtc.node_ip). Empty means "detect the LAN IP"; on a Windows dev host it
	// is the LAN IP of the host, never 127.0.0.1 (ADR 0001).
	AdvertiseIP string
	// LoginMode, when set, overwrites the stored admission policy on every
	// start: "invite", "password" or "open" (design 4.2, ADR 0008). Empty
	// keeps the stored value.
	LoginMode string
	// ServerPassword is the plain server password for password login. It is
	// hashed with argon2id into the settings table on start and never stored
	// or logged in clear text.
	ServerPassword string
	// EnableLoopbackCandidate offers loopback ICE candidates. The media backend
	// forces it off when AdvertiseIP is not loopback (ADR 0001, trap 4).
	EnableLoopbackCandidate bool
	// MediaSignalPort, MediaUDPPort and MediaTCPPort are the media ports
	// (design 4.1). Zero means the default; tests use random ports.
	MediaSignalPort int
	MediaUDPPort    int
	MediaTCPPort    int
	// DisableMediaBatchIO turns off batched UDP writes in the embedded SFU.
	// Batching is on by default (docs/PERF.md).
	DisableMediaBatchIO bool
	// NATMode asks the router for port forwards: off, auto, upnp or pmp. It is
	// meant for a home Linux machine, never for Docker (publish ports instead).
	NATMode string
	// Media injects a media backend instead of starting the embedded one. It is
	// used by tests that only exercise the control plane; the injected backend
	// stays owned by the caller.
	Media media.Backend
	// DisconnectGrace overrides the media cleanup delay after a dropped control
	// connection. Zero means control.DefaultDisconnectGrace.
	DisconnectGrace time.Duration
	// AdminSocket is the Unix socket the local `rostalk-server admin` CLI talks
	// to. Empty means <data>/rostalk-admin.sock; "off" disables it (Windows
	// hosts and tests that do not need it).
	AdminSocket string
	// MetricsAddr is the local Prometheus listener. Empty means
	// metrics.DefaultAddr (127.0.0.1:9090); "off" disables it. It is never
	// mounted on the public gateway (stage 7.1).
	MetricsAddr string
	// Version is the build identity reported in ServerInfo.version.
	Version string
	Logger  *slog.Logger
}

// App is a fully wired server instance.
type App struct {
	cfg    Config
	logger *slog.Logger

	Store    *store.Store
	Identity *identity.Identity
	TLS      *netutil.TLSMaterial
	// ACME is the domain-mode certificate manager, nil without --domain.
	ACME     *acmecert.Manager
	Auth     *auth.Manager
	Channels *channels.Service
	Roles    *roles.Service
	Hub      *state.Hub
	Control  *control.Plane
	HTTPAPI  *httpapi.Server
	Gateway  *gateway.Server
	Media    media.Backend
	// Chat is the message store and broadcaster (stage 4.1).
	Chat *chat.Service
	// Avatars stores user pictures by their content hash (stage P11).
	Avatars *avatars.Service
	// Tokens maps the chat HTTP bearer tokens to user sessions.
	Tokens *sessionauth.Registry
	// NAT is the router port-forward session, nil with --nat=off or when the
	// router refused.
	NAT *nat.Session
	// AdminSocket is the local admin CLI listener, nil when disabled.
	AdminSocket *adminsock.Server
	// Metrics is the local Prometheus listener, nil when disabled.
	Metrics *metrics.Server

	ownsMedia bool
	// internal is cancelled by Close; it stops the supervisor and the event
	// drain loop.
	internal       context.Context
	internalCancel context.CancelFunc

	mu          sync.Mutex
	adminInvite string
	publicHost  string
	addr        net.Addr
}

// New validates the configuration and opens the persistent parts: database,
// server identity and TLS material. It does not bind the network yet, so tests
// can adjust settings between New and Start.
func New(cfg Config) (*App, error) {
	if strings.TrimSpace(cfg.DataDir) == "" {
		return nil, errors.New("data directory must not be empty")
	}
	if cfg.Domain != "" && cfg.PublicHost == "" {
		cfg.PublicHost = cfg.Domain
	}
	switch cfg.LoginMode {
	case "", "invite", "password", "open":
	default:
		return nil, fmt.Errorf("--login-mode=%q: want invite, password or open", cfg.LoginMode)
	}
	if cfg.ServerPassword != "" && cfg.LoginMode != "password" {
		return nil, fmt.Errorf("--server-password only applies to --login-mode=password")
	}
	if _, _, err := net.SplitHostPort(cfg.Listen); err != nil {
		return nil, fmt.Errorf("invalid listen address %q: %w", cfg.Listen, err)
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}

	// A data directory written before the RosTalk rename keeps its database
	// under the old name; move it before opening (ADR 0033).
	if moved, err := legacy.AdoptDataDir(cfg.DataDir); err != nil {
		return nil, fmt.Errorf("adopt the pre-rename data directory: %w", err)
	} else if moved {
		logger.Info("renamed the database of a pre-rename data directory", "from", legacy.LegacyDatabaseName, "to", legacy.DatabaseName)
	}
	st, err := store.Open(filepath.Join(cfg.DataDir, legacy.DatabaseName))
	if err != nil {
		return nil, err
	}

	id, err := identity.LoadOrCreate(cfg.DataDir)
	if err != nil {
		_ = st.Close()
		return nil, err
	}

	publicHost, err := resolvePublicHost(cfg)
	if err != nil {
		_ = st.Close()
		return nil, err
	}

	listenHost, _, _ := net.SplitHostPort(cfg.Listen)
	hosts := []string{publicHost, listenHost, cfg.AdvertiseIP}
	var (
		tlsMaterial *netutil.TLSMaterial
		acmeManager *acmecert.Manager
	)
	if cfg.Domain != "" {
		acmeManager, err = acmecert.New(acmecert.Config{
			Domain:        cfg.Domain,
			DataDir:       filepath.Join(cfg.DataDir, "acme"),
			Email:         cfg.ACMEEmail,
			HTTPAddr:      cfg.ACMEHTTPAddr,
			TLSAddr:       cfg.ACMETLSAddr,
			DirectoryURL:  cfg.ACMEDirectoryURL,
			ObtainTimeout: cfg.ACMEObtainTimeout,
			Logger:        logger,
		})
		if err != nil {
			_ = st.Close()
			return nil, err
		}
	} else {
		tlsMaterial, err = netutil.LoadOrCreateTLS(cfg.DataDir, hosts)
		if err != nil {
			_ = st.Close()
			return nil, err
		}
	}

	return &App{
		cfg:        cfg,
		logger:     logger,
		Store:      st,
		Identity:   id,
		TLS:        tlsMaterial,
		ACME:       acmeManager,
		publicHost: publicHost,
	}, nil
}

// applyLoginOverrides writes the admission settings given on the command line
// into the settings table. The password is hashed here and never stored or
// logged in clear text.
func (a *App) applyLoginOverrides(ctx context.Context) error {
	if a.cfg.LoginMode != "" {
		if err := a.Store.SetSetting(ctx, "login_mode", a.cfg.LoginMode); err != nil {
			return fmt.Errorf("store login mode: %w", err)
		}
	}
	if a.cfg.ServerPassword != "" {
		hash, err := secret.HashPassword(a.cfg.ServerPassword)
		if err != nil {
			return fmt.Errorf("hash the server password: %w", err)
		}
		if err := a.Store.SetSetting(ctx, "server_password_hash", hash); err != nil {
			return fmt.Errorf("store the server password: %w", err)
		}
	}
	return nil
}

// Start authenticates the settings, ensures the bootstrap admin invite, starts
// the media plane, binds the gateway and starts serving.
func (a *App) Start(ctx context.Context) error {
	if err := a.applyLoginOverrides(ctx); err != nil {
		return err
	}
	settings, err := a.Store.Settings(ctx)
	if err != nil {
		return err
	}
	if settings.LoginMode == "password" && settings.ServerPassword == "" {
		return errors.New("password login is enabled but no server password is configured")
	}
	settings, err = a.ensureMediaKeys(ctx, settings)
	if err != nil {
		return err
	}
	if a.ACME != nil {
		material, acmeErr := a.ACME.Start(ctx)
		if acmeErr != nil {
			return acmeErr
		}
		a.TLS = material
	}
	logFields := []any{
		"version", a.cfg.Version,
		"data", a.cfg.DataDir,
		"listen", a.cfg.Listen,
		"login_mode", settings.LoginMode,
		"server_id", a.Identity.IDFingerprintHex(),
	}
	if a.TLS.FingerprintHex != "" {
		logFields = append(logFields, "certificate_fingerprint", a.TLS.FingerprintHex)
	}
	if a.cfg.Domain != "" {
		logFields = append(logFields, "domain", a.cfg.Domain)
	}
	a.logger.Info("starting rostalk-server", logFields...)

	a.Media, a.ownsMedia, err = a.startMedia(settings)
	if err != nil {
		return err
	}
	a.internal, a.internalCancel = context.WithCancel(context.Background())
	go a.drainMediaEvents(a.internal)
	go a.sweepChat(a.internal)

	a.Channels, err = channels.Open(ctx, channels.Config{
		Store:  a.Store,
		Logger: a.logger,
	})
	if err != nil {
		return err
	}
	a.Roles, err = roles.Open(ctx, roles.Config{
		Store:  a.Store,
		Logger: a.logger,
	})
	if err != nil {
		return err
	}
	a.Tokens = sessionauth.New(0)
	a.Hub = state.NewHub(state.Config{
		Logger:     a.logger,
		MaxUsers:   settings.MaxUsers,
		Channels:   a.Channels,
		Visibility: a.Roles,
		Tokens:     a.Tokens,
	})
	a.Chat, err = chat.New(chat.Config{
		Store:    a.Store,
		Roles:    a.Roles,
		Hub:      a.Hub,
		FilesDir: filepath.Join(a.cfg.DataDir, "files"),
		Logger:   a.logger,
		Settings: func() store.Settings {
			if a.Control == nil {
				return settings
			}
			return a.Control.Settings()
		},
	})
	if err != nil {
		return err
	}
	a.Avatars, err = avatars.New(avatars.Config{
		Store:  a.Store,
		Hub:    a.Hub,
		Dir:    filepath.Join(a.cfg.DataDir, "avatars"),
		Logger: a.logger,
	})
	if err != nil {
		return err
	}
	if publisher, ok := a.Media.(media.Publisher); ok {
		supervisor, supErr := media.NewSupervisor(media.SupervisorConfig{
			Backend:   a.Media,
			Presence:  a.Hub,
			Publisher: publisher,
			Logger:    a.logger,
		})
		if supErr != nil {
			return supErr
		}
		go supervisor.Run(a.internal)
	}
	a.Control, err = control.New(control.Config{
		Store:    a.Store,
		Channels: a.Channels,
		Hub:      a.Hub,
		Roles:    a.Roles,
		Settings: settings,
		ServerID: a.Identity.ID,
		Version:  a.cfg.Version,
		Protocol: auth.ProtocolVersion,
		Logger:   a.logger,
		Media:    a.Media,
		MediaURL: a.mediaURL,
		Chat:     a.Chat,
		InviteURL: func(token string) string {
			return JoinLink(a.linkHost(), a.TLS.FingerprintHex, token)
		},
		OnSettingsChanged: func(updated store.Settings) {
			if a.Auth != nil {
				a.Auth.ApplySettings(updated)
			}
		},
		DisconnectGrace: a.cfg.DisconnectGrace,
	})
	if err != nil {
		return err
	}

	a.Auth, err = auth.New(auth.Config{
		Store:         a.Store,
		ServerID:      a.Identity.ID,
		ServerVersion: a.cfg.Version,
		Logger:        a.logger,
		Hub:           a.Hub,
		Roles:         a.Roles,
		Handler:       a.Control,
		OnAdminGranted: func(userID int64) {
			a.clearAdminInviteFile()
		},
	})
	if err != nil {
		return err
	}

	if a.cfg.AdminSocket != "off" {
		socketPath := a.cfg.AdminSocket
		if socketPath == "" {
			socketPath = filepath.Join(a.cfg.DataDir, adminsock.DefaultName)
		}
		a.AdminSocket, err = adminsock.New(socketPath, a.Control, a.logger)
		if err != nil {
			return err
		}
		go a.AdminSocket.Serve(a.internal)
		a.logger.Info("admin socket listening", "path", socketPath)
	}

	if err := a.ensureAdminInvite(ctx); err != nil {
		return err
	}

	a.HTTPAPI, err = httpapi.New(httpapi.Config{
		Plane:    a.Control,
		Store:    a.Store,
		Chat:     a.Chat,
		Avatars:  a.Avatars,
		Sessions: a.Tokens,
		Logger:   a.logger,
	})
	if err != nil {
		return err
	}

	a.Gateway, err = gateway.New(gateway.Config{
		Listen:     a.cfg.Listen,
		TLS:        a.TLS,
		Auth:       a.Auth,
		RTC:        a.Media.Signalling(),
		API:        a.HTTPAPI.Handler(),
		PublicHost: a.publicHost,
		Logger:     a.logger,
	})
	if err != nil {
		return err
	}
	a.Metrics, err = metrics.Start(a.cfg.MetricsAddr, metrics.Registry(metrics.Source{
		Snapshot: a.metricsSnapshot,
		Version:  a.cfg.Version,
	}), a.logger)
	if err != nil {
		return err
	}
	if err := a.Gateway.Start(); err != nil {
		return err
	}
	a.addr = a.Gateway.Addr()
	a.logger.Info("gateway listening", "addr", a.addr.String(), "media_url", a.mediaURL())
	a.startNAT(ctx)

	host := a.linkHost()
	if a.TLS.Leaf != nil && !hostMatchesCert(host, a.TLS) {
		a.logger.Warn("public host is not covered by the certificate SANs; "+
			"clients may reject the TLS connection",
			"public_host", host,
		)
	}
	return nil
}

// Addr returns the bound HTTPS address.
func (a *App) Addr() net.Addr { return a.addr }

// metricsSnapshot reads the control and media planes for one Prometheus scrape.
// Every part is optional: a component that is shutting down contributes zero
// instead of failing the scrape.
func (a *App) metricsSnapshot(ctx context.Context) metrics.Snapshot {
	var snapshot metrics.Snapshot
	if a.Hub != nil {
		snapshot.OnlineUsers = a.Hub.Count()
	}
	if a.Channels != nil {
		snapshot.Channels = len(a.Channels.List())
	}
	if a.Media != nil {
		rooms, err := a.Media.Rooms(ctx)
		if err != nil {
			a.logger.Debug("metrics: media snapshot unavailable", "error", err)
			return snapshot
		}
		snapshot.MediaRooms = len(rooms)
		for _, room := range rooms {
			snapshot.MediaParticipants += len(room.Participants)
			for _, participant := range room.Participants {
				snapshot.MediaTracks += len(participant.Tracks)
			}
		}
	}
	return snapshot
}

// PublicHost returns the host used in invite links.
func (a *App) PublicHost() string { return a.publicHost }

// MediaURL is the WebSocket URL of the media gateway that clients connect to.
// It lives on the control-plane host and port so certificate pinning and the
// local proxy rules stay the same (design 4.6).
func (a *App) mediaURL() string {
	host := a.linkHost()
	if host == "" {
		return ""
	}
	return "wss://" + host + "/rtc"
}

// AdminInviteLink returns the one-time administrator invite link, or "" when an
// administrator already exists. The token is printed once at startup and is
// never written to the log.
func (a *App) AdminInviteLink() string {
	a.mu.Lock()
	token := a.adminInvite
	a.mu.Unlock()
	if token == "" || a.addr == nil {
		return ""
	}
	fingerprint := ""
	if a.TLS != nil {
		fingerprint = a.TLS.FingerprintHex
	}
	return JoinLink(a.linkHost(), fingerprint, token)
}

// JoinLink formats a rostalk:// invite link (design 4.3). fingerprintHex is
// empty in domain mode: Web PKI is the trust root and there is nothing to pin.
func JoinLink(host, fingerprintHex, token string) string {
	link := "rostalk://join?host=" + host
	if fingerprintHex != "" {
		link += "&fp=" + fingerprintHex
	}
	return link + "&invite=" + token
}

// Close stops the gateway, the media plane and the database.
func (a *App) Close(ctx context.Context) error {
	var errs []error
	if a.Metrics != nil {
		if err := a.Metrics.Close(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if a.Gateway != nil {
		if err := a.Gateway.Shutdown(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if a.AdminSocket != nil {
		if err := a.AdminSocket.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	if a.ACME != nil {
		if err := a.ACME.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	// Stop the background loops (media supervisor, chat sweep, event drain)
	// before closing the media backend they publish into. The event bus is
	// safe against a racing publish as well, but ordering the shutdown keeps
	// the normal path quiet.
	a.mu.Lock()
	if a.internalCancel != nil {
		a.internalCancel()
		a.internalCancel = nil
	}
	a.mu.Unlock()
	if a.Media != nil && a.ownsMedia {
		if err := a.Media.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	if a.NAT != nil {
		natCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := a.NAT.Close(natCtx); err != nil {
			errs = append(errs, err)
		}
		cancel()
	}
	if a.Store != nil {
		if err := a.Store.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// startNAT asks the router for the inbound ports when --nat is enabled. A
// router that does not answer is logged and ignored: the server still works on
// a network with a public address or manual forwards.
func (a *App) startNAT(ctx context.Context) {
	if a.cfg.NATMode == "" || a.cfg.NATMode == "off" {
		return
	}
	lanIP := a.cfg.AdvertiseIP
	if lanIP == "" {
		lanIP = netutil.DetectLANIP()
	}
	if lanIP == "" {
		a.logger.Warn("--nat is enabled but no LAN address was found; not forwarding any port")
		return
	}
	controlPort := 0
	if tcp, ok := a.addr.(*net.TCPAddr); ok {
		controlPort = tcp.Port
	}
	udpPort := a.cfg.MediaUDPPort
	if udpPort == 0 {
		udpPort = media.DefaultUDPPort
	}
	tcpPort := a.cfg.MediaTCPPort
	if tcpPort == 0 {
		tcpPort = media.DefaultTCPPort
	}
	var mappings []nat.Mapping
	if controlPort != 0 {
		mappings = append(mappings, nat.Mapping{Protocol: "tcp", InternalPort: controlPort, ExternalPort: controlPort})
	}
	mappings = append(mappings,
		nat.Mapping{Protocol: "tcp", InternalPort: tcpPort, ExternalPort: tcpPort},
		nat.Mapping{Protocol: "udp", InternalPort: udpPort, ExternalPort: udpPort},
	)
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	session, err := nat.Forward(probeCtx, nat.Options{
		Mode:     a.cfg.NATMode,
		LANIP:    lanIP,
		Mappings: mappings,
		Lease:    time.Hour,
		Logger:   a.logger,
	})
	if err != nil {
		a.logger.Warn("automatic port forwarding failed; forward the ports in the router or use a public address",
			"error", err, "lan_ip", lanIP)
		return
	}
	if session == nil {
		return
	}
	a.NAT = session
	go a.renewNAT()
}

// renewNAT refreshes the mapping before the lease expires. NAT-PMP leases are
// short by design, so this keeps the ports open for as long as the server runs.
func (a *App) renewNAT() {
	ticker := time.NewTicker(30 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-a.internal.Done():
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			err := a.NAT.Renew(ctx)
			cancel()
			if err != nil {
				a.logger.Warn("could not renew the router port mapping", "error", err)
			}
		}
	}
}

// startMedia starts the embedded media backend unless the caller injected one.
func (a *App) startMedia(settings store.Settings) (backend media.Backend, owned bool, err error) {
	if a.cfg.Media != nil {
		a.logger.Info("using the injected media backend")
		return a.cfg.Media, false, nil
	}
	nodeIP := a.cfg.AdvertiseIP
	if nodeIP == "" {
		nodeIP = netutil.DetectLANIP()
	}
	if nodeIP == "" {
		nodeIP = "127.0.0.1"
	}
	signalPort := a.cfg.MediaSignalPort
	if signalPort == 0 {
		signalPort = media.DefaultSignalPort
	}
	udpPort := a.cfg.MediaUDPPort
	if udpPort == 0 {
		udpPort = media.DefaultUDPPort
	}
	tcpPort := a.cfg.MediaTCPPort
	if tcpPort == 0 {
		tcpPort = media.DefaultTCPPort
	}
	backend, err = media.NewLiveKit(media.LiveKitConfig{
		SignalPort:              signalPort,
		UDPPort:                 udpPort,
		TCPPort:                 tcpPort,
		NodeIP:                  nodeIP,
		EnableLoopbackCandidate: a.cfg.EnableLoopbackCandidate,
		DisableBatchIO:          a.cfg.DisableMediaBatchIO,
		APIKey:                  settings.MediaKey,
		APISecret:               settings.MediaSecret,
		Logger:                  a.logger,
	})
	if err != nil {
		return nil, false, err
	}
	return backend, true, nil
}

// ChatSweepInterval is how often retention and orphaned uploads are cleaned.
// The sweep works in small batches, so a large history does not block writes.
const ChatSweepInterval = 15 * time.Minute

// sweepChat runs the retention sweep in the background.
func (a *App) sweepChat(ctx context.Context) {
	ticker := time.NewTicker(ChatSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sweepCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			if _, err := a.Chat.Sweep(sweepCtx); err != nil {
				a.logger.Warn("chat sweep failed", "error", err)
			}
			cancel()
		}
	}
}

// drainMediaEvents keeps the event stream flowing. Voice activity is measured
// by clients (design 4.6), but the screen-share presence flag comes from the
// media plane: a published screen_share track of "<uid>:stream" means the user
// is streaming (stage 5.1).
func (a *App) drainMediaEvents(ctx context.Context) {
	events := a.Media.Events()
	if events == nil {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			a.logger.Debug("media event",
				"event", string(event.Kind),
				"room", event.Room,
				"channel_id", event.ChannelID,
				"identity", event.Identity,
				"track", event.Track,
				"source", string(event.Source),
			)
			a.applyStreamEvent(event)
		}
	}
}

// applyStreamEvent maps screen-share track changes to the presence flag. It is
// intentionally driven by the track source, not by an identity suffix: the
// suffix says which participant kind it is, and only that participant may flip
// the flag. A participant that disappears without an unpublish event (a crash,
// a kick, a moderator stop) clears the flag too.
func (a *App) applyStreamEvent(event media.Event) {
	if event.UserID == 0 || event.ParticipantKind != media.KindStream {
		return
	}
	var streaming bool
	switch event.Kind {
	case media.EventTrackPublished:
		if event.Source != media.SourceScreenShare {
			// A stream may publish its system-audio track first or without
			// video; only the video track defines "streaming".
			return
		}
		streaming = true
	case media.EventTrackUnpublished:
		if event.Source != media.SourceScreenShare {
			return
		}
	case media.EventParticipantLeft:
		streaming = false
	default:
		return
	}
	// A stale event from a room the user has already left must not touch the
	// presence of the new channel.
	presence, online := a.Hub.Presence(event.UserID)
	if !online || presence.ChannelID == 0 || presence.ChannelID != event.ChannelID {
		return
	}
	changed, err := a.Hub.SetStreaming(event.UserID, streaming)
	if err != nil {
		if !errors.Is(err, state.ErrNotOnline) {
			a.logger.Warn("could not update the streaming flag",
				"user_id", event.UserID, "streaming", streaming, "error", err)
		}
		return
	}
	if changed {
		a.logger.Debug("streaming flag changed",
			"user_id", event.UserID, "streaming", streaming, "channel_id", event.ChannelID)
	}
}

// ensureMediaKeys generates the media signing key on the first start and stores
// it in the settings table. The secret never appears in a log or an invite link.
func (a *App) ensureMediaKeys(ctx context.Context, settings store.Settings) (store.Settings, error) {
	if settings.MediaKey != "" && settings.MediaSecret != "" {
		return settings, nil
	}
	key, err := randomHex(12)
	if err != nil {
		return settings, err
	}
	secret, err := randomHex(32)
	if err != nil {
		return settings, err
	}
	if err := a.Store.SetSetting(ctx, "media_key", key); err != nil {
		return settings, err
	}
	if err := a.Store.SetSetting(ctx, "media_secret", secret); err != nil {
		return settings, err
	}
	settings.MediaKey = key
	settings.MediaSecret = secret
	return settings, nil
}

func randomHex(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate media key: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

func (a *App) ensureAdminInvite(ctx context.Context) error {
	admins, err := a.Store.CountAdmins(ctx)
	if err != nil {
		return err
	}
	path := filepath.Join(a.cfg.DataDir, AdminInviteFile)

	if admins > 0 {
		// An administrator exists: the bootstrap invite is no longer needed.
		_ = os.Remove(path)
		return nil
	}

	// Reuse the token from a previous start as long as it is still valid, so
	// restarting the server does not invalidate a link the operator copied.
	if data, readErr := os.ReadFile(path); readErr == nil {
		token := strings.TrimSpace(string(data))
		if token != "" {
			if inv, findErr := a.Store.FindInvite(ctx, token); findErr == nil &&
				store.CheckInvite(inv, time.Now()) == nil && inv.Bootstrap != 0 && inv.GrantAdmin != 0 {
				a.mu.Lock()
				a.adminInvite = token
				a.mu.Unlock()
				return nil
			}
		}
	}

	// Invalidate stale bootstrap invites so exactly one admin link is valid.
	if err := a.Store.RevokeBootstrapInvites(ctx, time.Now()); err != nil {
		return err
	}
	token, err := a.Store.CreateInvite(ctx, store.InviteOptions{
		GrantAdmin: true,
		MaxUses:    1,
		Bootstrap:  true,
	})
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
		return fmt.Errorf("write admin invite %q: %w", path, err)
	}
	// os.WriteFile keeps the mode of an existing file, including a stale file
	// left by an older release or an operator. The token is a one-time
	// administrator credential, so force the mode every time.
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("restrict admin invite %q: %w", path, err)
	}
	a.mu.Lock()
	a.adminInvite = token
	a.mu.Unlock()
	return nil
}

func (a *App) clearAdminInviteFile() {
	a.mu.Lock()
	a.adminInvite = ""
	a.mu.Unlock()
	if err := os.Remove(filepath.Join(a.cfg.DataDir, AdminInviteFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
		a.logger.Warn("could not remove the consumed admin invite file", "error", err)
	}
}

func (a *App) linkHost() string {
	host := a.publicHost
	if a.addr == nil {
		return host
	}
	port := ""
	if tcp, ok := a.addr.(*net.TCPAddr); ok {
		port = fmt.Sprintf("%d", tcp.Port)
	} else if _, p, err := net.SplitHostPort(a.addr.String()); err == nil {
		port = p
	}
	if port == "" {
		return host
	}
	if _, _, err := net.SplitHostPort(host); err == nil {
		// The operator already included a port.
		return host
	}
	return net.JoinHostPort(host, port)
}

func resolvePublicHost(cfg Config) (string, error) {
	candidate := cfg.PublicHost
	if candidate == "" {
		candidate = cfg.Domain
	}
	if candidate == "" {
		candidate = cfg.AdvertiseIP
	}
	if candidate == "" {
		listenHost, _, _ := net.SplitHostPort(cfg.Listen)
		if listenHost != "" {
			if ip := net.ParseIP(netutil.NormalizeHost(listenHost)); ip == nil || !ip.IsUnspecified() {
				candidate = listenHost
			}
		}
	}
	if candidate == "" {
		candidate = netutil.DetectLANIP()
	}
	if candidate == "" {
		return "127.0.0.1", nil
	}

	candidate = strings.TrimSpace(candidate)
	if strings.Contains(candidate, "://") || strings.ContainsAny(candidate, "/?#") {
		return "", fmt.Errorf("public host %q must be a host name or address, optionally with a port", candidate)
	}
	if _, _, err := net.SplitHostPort(candidate); err == nil {
		if ip := net.ParseIP(netutil.NormalizeHost(candidate)); ip != nil && ip.IsUnspecified() {
			return "", fmt.Errorf("public host %q is an unspecified address; clients cannot connect to it", candidate)
		}
		return candidate, nil
	}
	host := netutil.NormalizeHost(candidate)
	if host == "" {
		return "", fmt.Errorf("public host %q is empty", candidate)
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsUnspecified() {
			return "", fmt.Errorf("public host %q is an unspecified address; clients cannot connect to it", candidate)
		}
		return host, nil
	}
	if validHostname(host) {
		return host, nil
	}
	return "", fmt.Errorf("public host %q is not a valid host name or IP address", candidate)
}

func validHostname(host string) bool {
	if len(host) > 253 {
		return false
	}
	for _, label := range strings.Split(strings.TrimSuffix(host, "."), ".") {
		if label == "" || len(label) > 63 {
			return false
		}
		for i, r := range label {
			switch {
			case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			case r == '-' && i != 0 && i != len(label)-1:
			default:
				return false
			}
		}
	}
	return true
}

// hostMatchesCert reports whether the link host is one of the SANs. It is a
// cheap pre-flight check for a clear log message; the client still performs the
// real verification.
func hostMatchesCert(host string, material *netutil.TLSMaterial) bool {
	hostOnly := netutil.NormalizeHost(host)
	if ip := net.ParseIP(hostOnly); ip != nil {
		for _, certIP := range material.Leaf.IPAddresses {
			if certIP.Equal(ip) {
				return true
			}
		}
		return false
	}
	for _, dnsName := range material.Leaf.DNSNames {
		if strings.EqualFold(dnsName, hostOnly) {
			return true
		}
	}
	return false
}
