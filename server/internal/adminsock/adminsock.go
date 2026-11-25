// Package adminsock serves the local administration CLI over a Unix domain
// socket (design 4.4: "CLI rostalk-server admin ...").
//
// The socket lives in the data directory and is chmod 0600: access is granted by
// the filesystem, so there is no network listener and no token to leak. Each
// connection carries exactly one JSON request and one JSON response.
package adminsock

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/control"
)

// DefaultName is the socket file name inside the data directory.
const DefaultName = "rostalk-admin.sock"

// Request is one CLI command.
type Request struct {
	// Command is one of the command constants below.
	Command string `json:"command"`
	// Role is the role name for invite.create and token.create.
	Role string `json:"role,omitempty"`
	// Name is the human-readable name for token.create.
	Name string `json:"name,omitempty"`
	// MaxUses is the invite limit.
	MaxUses int `json:"max_uses,omitempty"`
	// ExpiresSeconds is the invite/ban lifetime; 0 means no expiry.
	ExpiresSeconds int64 `json:"expires_seconds,omitempty"`
	// UserID, PublicKey and IP select the subject of ban/unban.
	UserID    int64  `json:"user_id,omitempty"`
	PublicKey string `json:"public_key,omitempty"`
	IP        string `json:"ip,omitempty"`
	Reason    string `json:"reason,omitempty"`
	// Key and Value are used by settings.set.
	Key   string `json:"key,omitempty"`
	Value string `json:"value,omitempty"`
}

// Response is the CLI answer.
type Response struct {
	OK    bool            `json:"ok"`
	Error string          `json:"error,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

// InviteResult is the reply to invite.create.
type InviteResult struct {
	URL            string `json:"url"`
	Role           string `json:"role"`
	MaxUses        int    `json:"max_uses"`
	ExpiresSeconds int64  `json:"expires_seconds"`
}

// UserRow is one row of user.list.
type UserRow struct {
	ID           int64    `json:"id"`
	Nickname     string   `json:"nickname"`
	RoleIDs      []int64  `json:"role_ids"`
	RoleNames    []string `json:"role_names"`
	Online       bool     `json:"online"`
	LastSeenUnix int64    `json:"last_seen_unix_ms"`
}

// TokenResult is the reply to token.create. The plaintext token appears here
// once and is never stored.
type TokenResult struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Role  string `json:"role"`
	Token string `json:"token"`
}

// TokenRow is one row of token.list. It has no secret.
type TokenRow struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	RoleID     int64  `json:"role_id"`
	CreatedAt  int64  `json:"created_at_unix_ms"`
	ExpiresAt  int64  `json:"expires_at_unix_ms"`
	RevokedAt  int64  `json:"revoked_at_unix_ms"`
	LastUsedAt int64  `json:"last_used_at_unix_ms"`
}

// SettingsResult is the reply to settings.get. It deliberately excludes media
// keys and the password hash.
type SettingsResult struct {
	ServerName           string `json:"server_name"`
	LoginMode            string `json:"login_mode"`
	MaxUsers             uint32 `json:"max_users"`
	PasswordSet          bool   `json:"password_set"`
	MessageRetentionDays int    `json:"message_retention_days"`
	MaxAttachmentBytes   int64  `json:"max_attachment_bytes"`
	AttachmentQuotaBytes int64  `json:"attachment_quota_bytes"`
}

// Server owns the listening Unix socket.
type Server struct {
	plane  *control.Plane
	logger *slog.Logger
	path   string
	ln     net.Listener
}

// New binds the socket. An existing stale socket file is removed first.
func New(path string, plane *control.Plane, logger *slog.Logger) (*Server, error) {
	if path == "" {
		return nil, errors.New("adminsock: socket path is required")
	}
	if plane == nil {
		return nil, errors.New("adminsock: control plane is required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, fmt.Errorf("adminsock: create socket directory: %w", err)
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("adminsock: remove stale socket %q: %w", path, err)
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("adminsock: listen on %q: %w", path, err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = ln.Close()
		return nil, fmt.Errorf("adminsock: restrict socket %q: %w", path, err)
	}
	return &Server{plane: plane, logger: logger, path: path, ln: ln}, nil
}

// Path returns the socket path.
func (s *Server) Path() string { return s.path }

// Serve accepts connections until ctx is cancelled or the listener closes.
func (s *Server) Serve(ctx context.Context) {
	go func() {
		<-ctx.Done()
		_ = s.ln.Close()
	}()
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
			}
			if errors.Is(err, net.ErrClosed) {
				return
			}
			s.logger.Warn("adminsock accept failed", "error", err)
			continue
		}
		go s.handle(ctx, conn)
	}
}

// Close stops the listener and removes the socket file.
func (s *Server) Close() error {
	err := s.ln.Close()
	_ = os.Remove(s.path)
	return err
}

func (s *Server) handle(ctx context.Context, conn net.Conn) {
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))

	var request Request
	decoder := json.NewDecoder(io.LimitReader(conn, 1<<20))
	if err := decoder.Decode(&request); err != nil {
		writeResponse(conn, Response{Error: "invalid request: " + err.Error()})
		return
	}
	data, err := s.dispatch(ctx, request)
	if err != nil {
		writeResponse(conn, Response{Error: err.Error()})
		return
	}
	response := Response{OK: true}
	if data != nil {
		encoded, err := json.Marshal(data)
		if err != nil {
			writeResponse(conn, Response{Error: "could not encode the reply"})
			return
		}
		response.Data = encoded
	}
	writeResponse(conn, response)
}

func (s *Server) dispatch(ctx context.Context, request Request) (any, error) {
	switch request.Command {
	case "invite.create":
		return s.inviteCreate(ctx, request)
	case "user.list":
		return s.userList(ctx)
	case "ban":
		return nil, s.ban(ctx, request)
	case "unban":
		return nil, s.unban(ctx, request)
	case "settings.get":
		return s.settingsGet(ctx)
	case "settings.set":
		return nil, s.settingsSet(ctx, request)
	case "token.create":
		return s.tokenCreate(ctx, request)
	case "token.list":
		return s.tokenList(ctx)
	default:
		return nil, fmt.Errorf("unknown command %q", request.Command)
	}
}

func (s *Server) inviteCreate(ctx context.Context, request Request) (any, error) {
	expires := time.Duration(request.ExpiresSeconds) * time.Second
	url, err := s.plane.CLIInvite(ctx, control.InviteParams{
		RoleName:  request.Role,
		MaxUses:   request.MaxUses,
		ExpiresIn: expires,
	})
	if err != nil {
		return nil, err
	}
	role := request.Role
	if role == "" {
		role = "Member"
	}
	return InviteResult{
		URL:            url,
		Role:           role,
		MaxUses:        request.MaxUses,
		ExpiresSeconds: request.ExpiresSeconds,
	}, nil
}

func (s *Server) userList(ctx context.Context) (any, error) {
	users, err := s.plane.CLIUsers(ctx)
	if err != nil {
		return nil, err
	}
	rows := make([]UserRow, 0, len(users))
	for _, user := range users {
		rows = append(rows, UserRow{
			ID:           user.ID,
			Nickname:     user.Nickname,
			RoleIDs:      user.RoleIDs,
			RoleNames:    user.RoleNames,
			Online:       user.Online,
			LastSeenUnix: user.LastSeenAt.UnixMilli(),
		})
	}
	return rows, nil
}

func (s *Server) ban(ctx context.Context, request Request) error {
	return s.plane.CLIBan(ctx, control.BanParams{
		UserID:       request.UserID,
		PublicKeyHex: request.PublicKey,
		IP:           request.IP,
		Reason:       request.Reason,
		Duration:     time.Duration(request.ExpiresSeconds) * time.Second,
	})
}

func (s *Server) unban(ctx context.Context, request Request) error {
	return s.plane.CLIUnban(ctx, request.UserID, request.PublicKey, request.IP)
}

func (s *Server) settingsGet(ctx context.Context) (any, error) {
	settings, err := s.plane.CLISettings(ctx)
	if err != nil {
		return nil, err
	}
	return SettingsResult{
		ServerName:           settings.ServerName,
		LoginMode:            settings.LoginMode,
		MaxUsers:             settings.MaxUsers,
		PasswordSet:          settings.ServerPassword != "",
		MessageRetentionDays: settings.MessageRetentionDays,
		MaxAttachmentBytes:   settings.MaxAttachmentBytesOrDefault(),
		AttachmentQuotaBytes: settings.AttachmentQuotaBytes,
	}, nil
}

func (s *Server) settingsSet(ctx context.Context, request Request) error {
	if request.Key == "" {
		return errors.New("settings.set needs a key")
	}
	return s.plane.CLISetSetting(ctx, request.Key, request.Value)
}

func (s *Server) tokenCreate(ctx context.Context, request Request) (any, error) {
	if request.Name == "" {
		return nil, errors.New("token.create needs a name")
	}
	expires := time.Duration(request.ExpiresSeconds) * time.Second
	token, id, err := s.plane.CLITokenCreate(ctx, request.Name, request.Role, expires)
	if err != nil {
		return nil, err
	}
	role := request.Role
	if role == "" {
		role = "Member"
	}
	return TokenResult{ID: id, Name: request.Name, Role: role, Token: token}, nil
}

func (s *Server) tokenList(ctx context.Context) (any, error) {
	tokens, err := s.plane.CLITokenList(ctx)
	if err != nil {
		return nil, err
	}
	rows := make([]TokenRow, 0, len(tokens))
	for _, token := range tokens {
		row := TokenRow{
			ID:        token.ID,
			Name:      token.Name,
			RoleID:    token.RoleID,
			CreatedAt: token.CreatedAt.UnixMilli(),
		}
		if token.ExpiresAt != nil {
			row.ExpiresAt = token.ExpiresAt.UnixMilli()
		}
		if token.RevokedAt != nil {
			row.RevokedAt = token.RevokedAt.UnixMilli()
		}
		if token.LastUsedAt != nil {
			row.LastUsedAt = token.LastUsedAt.UnixMilli()
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func writeResponse(w io.Writer, response Response) {
	_ = json.NewEncoder(w).Encode(response)
}

// Call sends one request to a running server and decodes the reply.
func Call(socketPath string, request Request) (json.RawMessage, error) {
	conn, err := net.DialTimeout("unix", socketPath, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("connect to %q (is rostalk-server running?): %w", socketPath, err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	if err := json.NewEncoder(conn).Encode(request); err != nil {
		return nil, fmt.Errorf("send the command: %w", err)
	}
	var response Response
	if err := json.NewDecoder(conn).Decode(&response); err != nil {
		return nil, fmt.Errorf("read the reply: %w", err)
	}
	if !response.OK {
		if response.Error == "" {
			response.Error = "the command failed"
		}
		return nil, errors.New(response.Error)
	}
	return response.Data, nil
}
