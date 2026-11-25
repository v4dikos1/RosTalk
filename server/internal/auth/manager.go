// Package auth implements the control-plane handshake:
//
//	Hello -> Challenge -> Authenticate -> Welcome
//
// The client proves possession of its Ed25519 key by signing the server's
// nonce followed by the server id. The server id is the SHA-256 fingerprint of
// the server's long-lived Ed25519 key, not of the TLS certificate, so the login
// does not depend on certificate pinning (design 4.2).
//
// Admission policies (invite by default, password, open), bans, per-IP attempt
// limits and session replacement all live here. Online presence and the event
// fan-out live in internal/state; the authenticated request loop lives in
// internal/control.
package auth

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/nickname"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/secret"
	"github.com/v4dikos1/RosTalk/server/internal/state"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

// ProtocolVersion is the wire protocol version this server speaks.
const ProtocolVersion uint32 = 1

// handshakeTimeout bounds Hello -> Welcome. A client that connects and stalls
// cannot hold a handshake slot forever.
const handshakeTimeout = 30 * time.Second

// Transport is one WebSocket connection as seen by auth. The gateway implements
// it; tests can use an in-memory implementation.
type Transport interface {
	// RemoteAddr is the client address used for bans and rate limiting.
	RemoteAddr() net.Addr
	// Read returns the next decoded client frame.
	Read(ctx context.Context) (*rostalkv1.ClientFrame, error)
	// Write sends one server frame.
	Write(ctx context.Context, frame *rostalkv1.ServerFrame) error
	// Close closes the underlying connection.
	Close() error
}

// Handler is the authenticated half of a connection, implemented by
// internal/control. The handshake asks it for the Welcome snapshot and hands it
// the session once the client is online.
type Handler interface {
	// PrepareSnapshot reads the expensive part of the snapshot (the unread
	// counters) before the state hub lock is taken. Its result is passed back
	// to Snapshot unchanged; it may be nil. The context is the handshake
	// context, so a stalled read cannot outlive the handshake.
	PrepareSnapshot(ctx context.Context, self *state.Session) *state.PreparedSnapshot
	// Snapshot builds the Welcome snapshot. It runs while the state hub is
	// locked and receives the online users and the prepared data. It must not
	// touch the database or call back into the hub.
	Snapshot(self *state.Session, users []state.Presence, prepared *state.PreparedSnapshot) *rostalkv1.ServerSnapshot
	// Serve runs the request loop until the client disconnects.
	Serve(ctx context.Context, session *state.Session) error
}

// Config wires the manager to the rest of the server.
type Config struct {
	Store         *store.Store
	ServerID      [32]byte
	ServerVersion string
	Logger        *slog.Logger
	// Hub holds online presence and the event fan-out.
	Hub *state.Hub
	// Roles assigns the default and invite roles and exposes the role ids that
	// go into the session.
	Roles *roles.Service
	// Handler runs authenticated requests. Its Snapshot is used in Welcome.
	Handler Handler
	// Now overrides the clock in tests.
	Now func() time.Time
	// OnAdminGranted runs after a user becomes an administrator (the bootstrap
	// invite is consumed). It lets the server remove the printed invite file.
	OnAdminGranted func(userID int64)
}

// Manager owns the handshake rules.
type Manager struct {
	store      *store.Store
	serverID   [32]byte
	version    string
	logger     *slog.Logger
	now        func() time.Time
	settingsMu sync.RWMutex
	settings   store.Settings
	limiter    *rateLimiter
	hub        *state.Hub
	roles      *roles.Service
	handler    Handler
	onGranted  func(userID int64)
}

// New builds a manager from the current settings row. Settings are read once at
// startup; changing them at runtime is an admin feature of a later stage.
func New(cfg Config) (*Manager, error) {
	if cfg.Store == nil {
		return nil, errors.New("auth: store is required")
	}
	if cfg.Hub == nil {
		return nil, errors.New("auth: state hub is required")
	}
	if cfg.Handler == nil {
		return nil, errors.New("auth: session handler is required")
	}
	if cfg.Roles == nil {
		return nil, errors.New("auth: role service is required")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	settings, err := cfg.Store.Settings(context.Background())
	if err != nil {
		return nil, fmt.Errorf("auth: load settings: %w", err)
	}
	if _, err := loginMode(settings.LoginMode); err != nil {
		return nil, err
	}
	return &Manager{
		store:     cfg.Store,
		serverID:  cfg.ServerID,
		version:   cfg.ServerVersion,
		logger:    logger,
		now:       now,
		settings:  settings,
		limiter:   newRateLimiter(settings.AuthLimit, settings.AuthWindow, now),
		hub:       cfg.Hub,
		roles:     cfg.Roles,
		handler:   cfg.Handler,
		onGranted: cfg.OnAdminGranted,
	}, nil
}

// Settings returns the settings snapshot used by this manager.
func (m *Manager) Settings() store.Settings { return m.settingsSnapshot() }

func (m *Manager) settingsSnapshot() store.Settings {
	m.settingsMu.RLock()
	defer m.settingsMu.RUnlock()
	return m.settings
}

func (m *Manager) allowLimit(ip string) bool {
	m.settingsMu.RLock()
	limiter := m.limiter
	m.settingsMu.RUnlock()
	return limiter.allow(ip)
}

func (m *Manager) resetLimit(ip string) {
	m.settingsMu.RLock()
	limiter := m.limiter
	m.settingsMu.RUnlock()
	limiter.reset(ip)
}

// ApplySettings swaps the admission policy at runtime after the administrator
// changed it through the admin protocol or the local socket. The new rate-limit
// window takes effect immediately; existing sessions are unaffected.
func (m *Manager) ApplySettings(settings store.Settings) {
	m.settingsMu.Lock()
	m.settings = settings
	m.limiter = newRateLimiter(settings.AuthLimit, settings.AuthWindow, m.now)
	m.settingsMu.Unlock()
}

// Failure is a handshake failure that is reported to the client in an Error
// frame and then closes the connection.
type Failure struct {
	Code      rostalkv1.ErrorCode
	Message   string
	Retryable bool
	ActionURL string

	// replyTo is the request id this failure answers. It is set by the
	// handshake and never leaves the server.
	replyTo uint64
}

func (f *Failure) Error() string {
	return fmt.Sprintf("%s: %s", f.Code.String(), f.Message)
}

func fail(code rostalkv1.ErrorCode, format string, args ...any) *Failure {
	return &Failure{Code: code, Message: fmt.Sprintf(format, args...)}
}

// withReply returns the same failure carrying the request id it answers.
func (f *Failure) withReply(id uint64) *Failure {
	f.replyTo = id
	return f
}

// Handle authenticates one connection and then hands it to the request handler.
// The gateway closes the transport when this returns.
func (m *Manager) Handle(ctx context.Context, tr Transport) error {
	ip := remoteIP(tr.RemoteAddr())

	hsCtx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	session, err := m.handshake(hsCtx, tr, ip)
	cancel()
	if err != nil {
		var failure *Failure
		if errors.As(err, &failure) {
			// The handshake already knows the request id it is answering.
			m.writeFailure(ctx, tr, failure.replyTo, failure)
			return nil
		}
		return err
	}

	m.resetLimit(ip)
	m.logger.Info("authenticated",
		"user_id", session.UserID(),
		"nickname", session.Nickname(),
		"admin", session.Admin(),
		"ip", ip,
	)
	return m.handler.Serve(ctx, session)
}

// handshake runs Hello -> Challenge -> Authenticate -> Welcome.
func (m *Manager) handshake(ctx context.Context, tr Transport, ip string) (*state.Session, error) {
	helloFrame, err := tr.Read(ctx)
	if err != nil {
		return nil, err
	}
	hello := helloFrame.GetHello()
	if hello == nil {
		return nil, fail(rostalkv1.ErrorCode_ERROR_CODE_INVALID_FRAME,
			"the first frame must be Hello").withReply(helloFrame.GetRequestId())
	}
	settings := m.settingsSnapshot()
	replyTo := helloFrame.GetRequestId()
	if replyTo == 0 {
		return nil, fail(rostalkv1.ErrorCode_ERROR_CODE_INVALID_FRAME,
			"request_id must not be zero").withReply(0)
	}

	if !m.allowLimit(ip) {
		return nil, fail(rostalkv1.ErrorCode_ERROR_CODE_RATE_LIMITED,
			"too many connection attempts; retry later").withReply(replyTo)
	}

	if v := hello.GetProtocolVersion(); v != ProtocolVersion {
		f := fail(rostalkv1.ErrorCode_ERROR_CODE_PROTOCOL_VERSION_UNSUPPORTED,
			"protocol version %d is not supported, this server speaks version %d", v, ProtocolVersion)
		f.Retryable = false
		f.ActionURL = "https://github.com/v4dikos1/RosTalk/releases"
		return nil, f.withReply(replyTo)
	}

	publicKey := hello.GetPublicKey()
	if len(publicKey) != ed25519.PublicKeySize {
		return nil, fail(rostalkv1.ErrorCode_ERROR_CODE_AUTH_FAILED,
			"public_key must be %d bytes", ed25519.PublicKeySize).withReply(replyTo)
	}
	publicKeyID := hex.EncodeToString(publicKey)

	if err := m.checkBans(ctx, publicKey, ip, replyTo); err != nil {
		return nil, err
	}

	user, err := m.store.UserByPublicKey(ctx, publicKey)
	known := err == nil
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("look up user: %w", err)
	}

	fallback := ""
	if known {
		fallback = user.Nickname
	}
	nick, err := nickname.Normalize(hello.GetNickname(), fallback)
	if err != nil {
		return nil, fail(rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST,
			"%s", err.Error()).withReply(replyTo)
	}

	// Check capacity and nickname before any invite is consumed or a user row is
	// written. Both checks are repeated atomically in Register; these early
	// passes keep an obvious rejection from costing the client a one-time token.
	// A key that already has a session may reconnect at the limit because its
	// old session will be replaced.
	if max := settings.MaxUsers; max > 0 &&
		!m.hub.HasPublicKey(publicKeyID) && m.hub.Count() >= int(max) {
		return nil, fail(rostalkv1.ErrorCode_ERROR_CODE_REJECTED,
			"the server is full").withReply(replyTo)
	}
	exceptUserID := int64(0)
	if known {
		exceptUserID = user.ID
	}
	if !m.hub.NicknameAvailable(nick, exceptUserID) {
		return nil, fail(rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST,
			"nickname %q is already used by another online user", nick).withReply(replyTo)
	}

	var pendingInvite *string
	mode, _ := loginMode(settings.LoginMode)
	switch mode {
	case rostalkv1.LoginMode_LOGIN_MODE_INVITE:
		if !known {
			token := hello.GetInvite()
			if token == "" {
				return nil, fail(rostalkv1.ErrorCode_ERROR_CODE_INVITE_INVALID,
					"this server is invite-only; use an invitation link").withReply(replyTo)
			}
			pending, inviteErr := m.validateInvite(ctx, token, replyTo)
			if inviteErr != nil {
				return nil, inviteErr
			}
			pendingInvite = pending
		}
	case rostalkv1.LoginMode_LOGIN_MODE_PASSWORD:
		if settings.ServerPassword == "" {
			return nil, fail(rostalkv1.ErrorCode_ERROR_CODE_REJECTED,
				"password login is enabled but no server password is configured").withReply(replyTo)
		}
		if !secret.VerifyPassword(settings.ServerPassword, hello.GetPassword()) {
			return nil, fail(rostalkv1.ErrorCode_ERROR_CODE_WRONG_PASSWORD,
				"wrong server password").withReply(replyTo)
		}
		// The one-time administrator link is printed on the first start
		// regardless of the admission mode. An invite in password mode is
		// optional, but when the client supplies one it is honoured after the
		// password check so the first administrator can bootstrap the server.
		if token := hello.GetInvite(); token != "" {
			pending, inviteErr := m.validateInvite(ctx, token, replyTo)
			if inviteErr != nil {
				return nil, inviteErr
			}
			pendingInvite = pending
		}
	case rostalkv1.LoginMode_LOGIN_MODE_OPEN:
		// Anyone who knows the address is admitted. An optional invite still
		// grants its role or the administrator flag, which is how the printed
		// bootstrap link works in open mode too.
		if token := hello.GetInvite(); token != "" {
			pending, inviteErr := m.validateInvite(ctx, token, replyTo)
			if inviteErr != nil {
				return nil, inviteErr
			}
			pendingInvite = pending
		}
	}

	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("generate challenge nonce: %w", err)
	}
	if err := tr.Write(ctx, &rostalkv1.ServerFrame{
		ReplyTo: replyTo,
		Payload: &rostalkv1.ServerFrame_Challenge{Challenge: &rostalkv1.Challenge{
			Nonce:    nonce,
			ServerId: m.serverID[:],
		}},
	}); err != nil {
		return nil, fmt.Errorf("send challenge: %w", err)
	}

	authFrame, err := tr.Read(ctx)
	if err != nil {
		return nil, err
	}
	authReply := authFrame.GetRequestId()
	authenticate := authFrame.GetAuthenticate()
	if authenticate == nil || authReply == 0 {
		return nil, fail(rostalkv1.ErrorCode_ERROR_CODE_UNAUTHENTICATED,
			"expected Authenticate after Challenge").withReply(authReply)
	}

	signed := make([]byte, 0, len(nonce)+len(m.serverID))
	signed = append(signed, nonce...)
	signed = append(signed, m.serverID[:]...)
	if !ed25519.Verify(ed25519.PublicKey(publicKey), signed, authenticate.GetSignature()) {
		m.logger.Warn("signature verification failed", "ip", ip)
		return nil, fail(rostalkv1.ErrorCode_ERROR_CODE_AUTH_FAILED,
			"signature does not verify").withReply(authReply)
	}

	grantAdmin := false
	var inviteRoleID int64
	if pendingInvite != nil {
		inv, consumeErr := m.store.ConsumeInvite(ctx, *pendingInvite, m.now())
		if consumeErr != nil {
			return nil, inviteFailure(consumeErr, authReply)
		}
		grantAdmin = inv.GrantAdmin != 0
		if inv.RoleID.Valid {
			inviteRoleID = inv.RoleID.Int64
		}
	}

	updated, err := m.store.UpsertUser(ctx, publicKey, nick, m.now())
	if err != nil {
		return nil, fmt.Errorf("upsert user: %w", err)
	}
	// A user needs a baseline role, but an invite that names a role replaces
	// the default: a Guest invite must not silently also grant Member.
	if inviteRoleID != 0 {
		if _, ok := m.roles.RoleByID(inviteRoleID); !ok {
			return nil, fmt.Errorf("invite grants role %d, which no longer exists", inviteRoleID)
		}
		if err := m.roles.Assign(ctx, roles.System, updated.ID, inviteRoleID); err != nil {
			return nil, fmt.Errorf("assign the invite role: %w", err)
		}
	} else if err := m.roles.EnsureDefaultRole(ctx, updated.ID); err != nil {
		return nil, fmt.Errorf("assign the default role: %w", err)
	}
	if grantAdmin {
		if updated.IsAdmin == 0 {
			updated, err = m.store.SetUserAdmin(ctx, publicKey)
			if err != nil {
				return nil, fmt.Errorf("grant administrator: %w", err)
			}
		}
		if err := m.roles.GrantAdmin(ctx, updated.ID); err != nil {
			return nil, fmt.Errorf("grant the admin role: %w", err)
		}
		if m.onGranted != nil {
			m.onGranted(updated.ID)
		}
		m.logger.Info("administrator granted", "user_id", updated.ID)
	}

	session, err := state.NewSession(state.SessionParams{
		UserID:      updated.ID,
		PublicKeyID: publicKeyID,
		Nickname:    updated.Nickname,
		Admin:       updated.IsAdmin != 0,
		RoleIDs:     m.roles.RoleIDs(updated.ID),
		ConnectedAt: m.now(),
		AvatarHash:  updated.AvatarHash,
		IP:          ip,
		Transport:   tr,
	})
	if err != nil {
		return nil, err
	}

	old, registerErr := m.hub.Register(session)
	switch {
	case errors.Is(registerErr, state.ErrNicknameTaken):
		// The name was free during the early check but another handshake took
		// it first. Rejecting is deliberate: the client should choose the name.
		return nil, fail(rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST,
			"nickname %q is already used by another online user", nick).withReply(authReply)
	case errors.Is(registerErr, state.ErrServerFull):
		return nil, fail(rostalkv1.ErrorCode_ERROR_CODE_REJECTED,
			"the server is full").withReply(authReply)
	case registerErr != nil:
		return nil, fmt.Errorf("register session: %w", registerErr)
	}
	if old != nil {
		m.logger.Info("session replaced",
			"user_id", session.UserID(),
			"old_connected_at", old.ConnectedAt().Format(time.RFC3339),
		)
		old.Terminate(rostalkv1.ErrorCode_ERROR_CODE_SESSION_REPLACED,
			"another connection with the same key replaced this session")
	}

	// The unread counters are the only database work in Welcome. Read them
	// before taking the hub lock: at 20 channels and 100k messages the old
	// in-lock build held every connect, move and leave for hundreds of
	// milliseconds (docs/PERF.md).
	prepared := m.handler.PrepareSnapshot(ctx, session)
	if err := m.hub.Welcome(session, authReply, func(users []state.Presence) *rostalkv1.ServerSnapshot {
		return m.handler.Snapshot(session, users, prepared)
	}); err != nil {
		m.hub.Unregister(session)
		return nil, fmt.Errorf("send welcome: %w", err)
	}
	return session, nil
}

// validateInvite checks that a supplied invite can be used right now. The
// caller stores the token and consumes it only after the client proves
// possession of the key, so a failed signature never spends a use.
func (m *Manager) validateInvite(ctx context.Context, token string, replyTo uint64) (*string, error) {
	inv, err := m.store.FindInvite(ctx, token)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil, fail(rostalkv1.ErrorCode_ERROR_CODE_INVITE_INVALID,
			"invitation is unknown or revoked").withReply(replyTo)
	case err != nil:
		return nil, fmt.Errorf("look up invite: %w", err)
	}
	if err := store.CheckInvite(inv, m.now()); err != nil {
		return nil, inviteFailure(err, replyTo)
	}
	return &token, nil
}

func (m *Manager) checkBans(ctx context.Context, publicKey []byte, ip string, replyTo uint64) error {
	if _, err := m.store.BanByPublicKey(ctx, publicKey, m.now()); err == nil {
		m.logger.Info("banned key rejected", "ip", ip)
		return fail(rostalkv1.ErrorCode_ERROR_CODE_BANNED, "this key is banned on this server").withReply(replyTo)
	} else if !errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("check ban by key: %w", err)
	}
	if ip != "" {
		if _, err := m.store.BanByIP(ctx, ip, m.now()); err == nil {
			m.logger.Info("banned address rejected", "ip", ip)
			return fail(rostalkv1.ErrorCode_ERROR_CODE_BANNED, "this address is banned on this server").withReply(replyTo)
		} else if !errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("check ban by ip: %w", err)
		}
	}
	return nil
}

func inviteFailure(err error, replyTo uint64) error {
	switch {
	case errors.Is(err, store.ErrInviteExpired):
		return fail(rostalkv1.ErrorCode_ERROR_CODE_INVITE_EXPIRED,
			"invitation has expired").withReply(replyTo)
	default:
		return fail(rostalkv1.ErrorCode_ERROR_CODE_INVITE_INVALID,
			"invitation is unknown, revoked or already used").withReply(replyTo)
	}
}

func loginMode(value string) (rostalkv1.LoginMode, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "invite":
		return rostalkv1.LoginMode_LOGIN_MODE_INVITE, nil
	case "password":
		return rostalkv1.LoginMode_LOGIN_MODE_PASSWORD, nil
	case "open":
		return rostalkv1.LoginMode_LOGIN_MODE_OPEN, nil
	default:
		return rostalkv1.LoginMode_LOGIN_MODE_UNSPECIFIED,
			fmt.Errorf("auth: unknown login_mode %q (want invite, password or open)", value)
	}
}

func remoteIP(addr net.Addr) string {
	if addr == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String()
	}
	return host
}

func (m *Manager) writeFailure(ctx context.Context, tr Transport, replyTo uint64, failure *Failure) {
	_ = tr.Write(ctx, &rostalkv1.ServerFrame{
		ReplyTo: replyTo,
		Payload: &rostalkv1.ServerFrame_Error{Error: &rostalkv1.Error{
			Code:      failure.Code,
			Message:   failure.Message,
			Retryable: failure.Retryable,
			ActionUrl: failure.ActionURL,
		}},
	})
}
