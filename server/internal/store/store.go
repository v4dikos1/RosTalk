// Package store owns the server's SQLite database: embedded migrations, WAL
// settings and typed access to settings, users, invites and bans.
//
// The generated query layer lives in ./db and is produced by `sqlc generate`
// from ./migrations and ./queries. Hand-written code in this package adds the
// pieces SQL alone cannot express well: the migration runner, invite token
// generation hashing and typed settings.
package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite" // registers the "sqlite" driver

	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

//go:generate sqlc generate -f sqlc.yaml

//go:embed migrations/*.sql
var migrationsFS embed.FS

// ErrInviteExpired is returned when an invite exists but its expiration time
// has passed.
var ErrInviteExpired = errors.New("invite expired")

// ErrInviteInvalid is returned for unknown, revoked or used-up invites.
var ErrInviteInvalid = errors.New("invite invalid")

// ErrNotFound is returned by typed lookups when the row does not exist.
var ErrNotFound = errors.New("not found")

// Store is an open database handle.
type Store struct {
	sqlDB *sql.DB
	q     *db.Queries
	path  string
}

// Open opens (and creates if needed) the SQLite database at path, applies the
// embedded migrations and turns on WAL. The parent directory must exist or be
// creatable.
func Open(path string) (*Store, error) {
	if path == "" {
		return nil, errors.New("database path must not be empty")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve database path %q: %w", path, err)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o750); err != nil {
		return nil, fmt.Errorf("create data directory for %q: %w", abs, err)
	}

	sqlDB, err := sql.Open("sqlite", dsn(abs))
	if err != nil {
		return nil, fmt.Errorf("open sqlite database %q: %w", abs, err)
	}
	// WAL allows one writer and several readers. A handful of connections is
	// plenty for the control plane and keeps short reads from serialising
	// behind a write.
	sqlDB.SetMaxOpenConns(4)
	sqlDB.SetMaxIdleConns(4)

	s := &Store{sqlDB: sqlDB, q: db.New(sqlDB), path: abs}
	if err := s.migrate(context.Background()); err != nil {
		_ = sqlDB.Close()
		return nil, err
	}
	// The database holds password and token hashes, the LiveKit secret and
	// message contents. SQLite creates it with the process umask, which may
	// leave it group- or world-readable; restrict the database and its WAL
	// sidecars explicitly. The data directory itself is 0750 by contract.
	if err := restrictDatabaseFiles(abs); err != nil {
		_ = sqlDB.Close()
		return nil, err
	}
	return s, nil
}

// restrictDatabaseFiles makes the SQLite database and the sidecars that may
// exist while WAL is active readable only by the service user. A sidecar that
// does not exist yet is not an error: SQLite creates it on the first write and
// Store.Open runs again (and restricts it) on the next start.
func restrictDatabaseFiles(path string) error {
	for _, candidate := range []string{path, path + "-wal", path + "-shm"} {
		if err := os.Chmod(candidate, 0o600); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("restrict database file %q: %w", candidate, err)
		}
	}
	return nil
}

// Path returns the absolute database file path.
func (s *Store) Path() string { return s.path }

// Queries exposes the generated query layer. Packages that need a query this
// file does not wrap (chat history joins, for example) use it instead of
// opening a second connection.
func (s *Store) Queries() *db.Queries { return s.q }

// InTx runs fn inside a write transaction. The generated queries passed to fn
// are bound to the transaction, so a failure rolls every statement back.
func (s *Store) InTx(ctx context.Context, fn func(*db.Queries) error) error {
	tx, err := s.sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	if err := fn(db.New(tx)); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}

// Close closes the database.
func (s *Store) Close() error {
	if s == nil || s.sqlDB == nil {
		return nil
	}
	return s.sqlDB.Close()
}

// dsn builds a modernc.org/sqlite URI with the pragmas every connection needs.
// The URI form works on Windows too: file:///C:/path becomes file:///C:/path.
func dsn(absPath string) string {
	p := filepath.ToSlash(absPath)
	if !strings.HasPrefix(p, "/") {
		// Windows drive letters: file:D:/x is not absolute, file:///D:/x is.
		p = "/" + p
	}
	u := url.URL{Scheme: "file", Path: p}
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "foreign_keys(ON)")
	q.Add("_pragma", "synchronous(NORMAL)")
	u.RawQuery = q.Encode()
	return u.String()
}

// migrate applies embedded migrations that have not run yet, each in its own
// transaction. Migration names are the file names and are applied in lexical
// order.
func (s *Store) migrate(ctx context.Context) error {
	if _, err := s.sqlDB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		name       TEXT PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	names, err := fs.Glob(migrationsFS, "migrations/*.sql")
	if err != nil {
		return fmt.Errorf("list embedded migrations: %w", err)
	}
	sort.Strings(names)

	for _, name := range names {
		var applied int
		err := s.sqlDB.QueryRowContext(ctx,
			`SELECT count(*) FROM schema_migrations WHERE name = ?`, name).Scan(&applied)
		if err != nil {
			return fmt.Errorf("check migration %s: %w", name, err)
		}
		if applied > 0 {
			continue
		}

		body, err := migrationsFS.ReadFile(name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}

		tx, err := s.sqlDB.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin migration %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
			name, time.Now().UnixMilli()); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("record migration %s: %w", name, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %s: %w", name, err)
		}
	}
	return nil
}

// DefaultMaxAttachmentBytes is the per-file attachment limit used when the
// administrator has not chosen one. It is large enough for a minute of phone
// video and for screenshots without a second resize pass on the client.
const DefaultMaxAttachmentBytes int64 = 25 << 20

// Settings is the typed view of the settings table (design 4.5).
type Settings struct {
	ServerName     string
	LoginMode      string
	MaxUsers       uint32
	ServerPassword string // argon2id hash, empty when password mode is off
	AuthLimit      int
	AuthWindow     time.Duration
	// MediaKey and MediaSecret sign the short-lived media tokens. They are
	// generated on the first start and never leave the process (design 4.1).
	MediaKey    string
	MediaSecret string
	// MessageRetentionDays removes messages older than this many days. 0 keeps
	// history forever.
	MessageRetentionDays int
	// MaxAttachmentBytes bounds one uploaded file.
	MaxAttachmentBytes int64
	// AttachmentQuotaBytes bounds the total size of stored attachments.
	AttachmentQuotaBytes int64
}

// Settings reads and parses every setting, applying sane defaults for missing
// rows so an old database can gain new keys without a migration.
func (s *Store) Settings(ctx context.Context) (Settings, error) {
	rows, err := s.q.ListSettings(ctx)
	if err != nil {
		return Settings{}, fmt.Errorf("list settings: %w", err)
	}
	values := make(map[string]string, len(rows))
	for _, row := range rows {
		values[row.Key] = row.Value
	}

	out := Settings{
		ServerName:     values["server_name"],
		LoginMode:      values["login_mode"],
		ServerPassword: values["server_password_hash"],
		MediaKey:       values["media_key"],
		MediaSecret:    values["media_secret"],
		AuthLimit:      10,
		AuthWindow:     time.Minute,
	}
	if out.ServerName == "" {
		out.ServerName = "RosTalk"
	}
	if out.LoginMode == "" {
		out.LoginMode = "invite"
	}
	if v, err := strconv.ParseUint(values["max_users"], 10, 32); err == nil {
		out.MaxUsers = uint32(v)
	}
	if v, err := strconv.Atoi(values["auth_attempts_limit"]); err == nil && v > 0 {
		out.AuthLimit = v
	}
	if v, err := strconv.Atoi(values["auth_attempts_window_seconds"]); err == nil && v > 0 {
		out.AuthWindow = time.Duration(v) * time.Second
	}
	if v, err := strconv.Atoi(values["message_retention_days"]); err == nil && v >= 0 {
		out.MessageRetentionDays = v
	}
	if v, err := strconv.ParseInt(values["max_attachment_bytes"], 10, 64); err == nil && v > 0 {
		out.MaxAttachmentBytes = v
	}
	if v, err := strconv.ParseInt(values["attachment_quota_bytes"], 10, 64); err == nil && v > 0 {
		out.AttachmentQuotaBytes = v
	}
	return out, nil
}

// MaxAttachmentBytesOrDefault returns the effective per-file attachment limit.
// A zero value means the setting was never written, so the default applies;
// callers never have to duplicate that rule.
func (s Settings) MaxAttachmentBytesOrDefault() int64 {
	if s.MaxAttachmentBytes > 0 {
		return s.MaxAttachmentBytes
	}
	return DefaultMaxAttachmentBytes
}

// SetSetting writes one setting.
func (s *Store) SetSetting(ctx context.Context, key, value string) error {
	if key == "" {
		return errors.New("setting key must not be empty")
	}
	if err := s.q.UpsertSetting(ctx, db.UpsertSettingParams{
		Key:       key,
		Value:     value,
		UpdatedAt: time.Now().UnixMilli(),
	}); err != nil {
		return fmt.Errorf("set setting %q: %w", key, err)
	}
	return nil
}

// UserByPublicKey looks a user up by its 32-byte Ed25519 public key.
func (s *Store) UserByPublicKey(ctx context.Context, publicKey []byte) (db.User, error) {
	user, err := s.q.GetUserByPublicKey(ctx, publicKey)
	if errors.Is(err, sql.ErrNoRows) {
		return db.User{}, ErrNotFound
	}
	if err != nil {
		return db.User{}, fmt.Errorf("get user by public key: %w", err)
	}
	return user, nil
}

// UpsertUser creates the user or refreshes its nickname and last-seen time.
func (s *Store) UpsertUser(ctx context.Context, publicKey []byte, nickname string, now time.Time) (db.User, error) {
	if len(publicKey) != 32 {
		return db.User{}, fmt.Errorf("public key must be 32 bytes, got %d", len(publicKey))
	}
	ms := now.UnixMilli()
	user, err := s.q.UpsertUser(ctx, db.UpsertUserParams{
		PublicKey:  publicKey,
		Nickname:   nickname,
		CreatedAt:  ms,
		LastSeenAt: ms,
	})
	if err != nil {
		return db.User{}, fmt.Errorf("upsert user: %w", err)
	}
	return user, nil
}

// SetUserAdmin grants the administrator flag to a user.
func (s *Store) SetUserAdmin(ctx context.Context, publicKey []byte) (db.User, error) {
	user, err := s.q.SetUserAdmin(ctx, publicKey)
	if errors.Is(err, sql.ErrNoRows) {
		return db.User{}, ErrNotFound
	}
	if err != nil {
		return db.User{}, fmt.Errorf("set user admin: %w", err)
	}
	return user, nil
}

// CountAdmins reports how many users hold the administrator flag.
func (s *Store) CountAdmins(ctx context.Context) (int64, error) {
	n, err := s.q.CountAdmins(ctx)
	if err != nil {
		return 0, fmt.Errorf("count admins: %w", err)
	}
	return n, nil
}

// InviteOptions describes a new invite.
type InviteOptions struct {
	// CreatedBy is the user id of the creator; nil for the bootstrap invite.
	CreatedBy *int64
	// GrantAdmin makes the first user who logs in with the invite an admin.
	GrantAdmin bool
	// MaxUses is how many logins the invite admits; at least 1.
	MaxUses int
	// ExpiresAt is nil for an invite that never expires.
	ExpiresAt *time.Time
	// Bootstrap marks the invite whose token the server reprints at startup
	// while no administrator exists.
	Bootstrap bool
	// RoleID is the role granted on login. Nil means the default Member role,
	// resolved by the auth manager.
	RoleID *int64
}

// CreateInvite generates a token, stores only its SHA-256 hash and returns the
// plaintext token. Tokens are never written to the database.
func (s *Store) CreateInvite(ctx context.Context, opts InviteOptions) (string, error) {
	if opts.MaxUses < 1 {
		return "", errors.New("invite max uses must be at least 1")
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate invite token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	var expires sql.NullInt64
	if opts.ExpiresAt != nil {
		expires = sql.NullInt64{Int64: opts.ExpiresAt.UnixMilli(), Valid: true}
	}
	var createdBy sql.NullInt64
	if opts.CreatedBy != nil {
		createdBy = sql.NullInt64{Int64: *opts.CreatedBy, Valid: true}
	}
	var roleID sql.NullInt64
	if opts.RoleID != nil {
		roleID = sql.NullInt64{Int64: *opts.RoleID, Valid: true}
	}
	if err := s.q.CreateInvite(ctx, db.CreateInviteParams{
		TokenHash:  HashInviteToken(token),
		CreatedBy:  createdBy,
		GrantAdmin: boolToInt(opts.GrantAdmin),
		MaxUses:    int64(opts.MaxUses),
		CreatedAt:  time.Now().UnixMilli(),
		ExpiresAt:  expires,
		Bootstrap:  boolToInt(opts.Bootstrap),
		RoleID:     roleID,
	}); err != nil {
		return "", fmt.Errorf("create invite: %w", err)
	}
	return token, nil
}

// HashInviteToken returns the SHA-256 hash stored in the invites table.
func HashInviteToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// FindInvite looks an invite up by its plaintext token.
func (s *Store) FindInvite(ctx context.Context, token string) (db.Invite, error) {
	inv, err := s.q.GetInviteByHash(ctx, HashInviteToken(token))
	if errors.Is(err, sql.ErrNoRows) {
		return db.Invite{}, ErrNotFound
	}
	if err != nil {
		return db.Invite{}, fmt.Errorf("get invite: %w", err)
	}
	return inv, nil
}

// CheckInvite reports whether an invite can still be used at now.
func CheckInvite(inv db.Invite, now time.Time) error {
	if inv.RevokedAt.Valid || inv.UsedCount >= inv.MaxUses {
		return ErrInviteInvalid
	}
	if inv.ExpiresAt.Valid && inv.ExpiresAt.Int64 <= now.UnixMilli() {
		return ErrInviteExpired
	}
	return nil
}

// ConsumeInvite atomically increments the use counter. The update only matches
// an invite that is still valid, so two concurrent logins cannot spend the last
// use twice.
func (s *Store) ConsumeInvite(ctx context.Context, token string, now time.Time) (db.Invite, error) {
	inv, err := s.q.ConsumeInvite(ctx, db.ConsumeInviteParams{
		TokenHash: HashInviteToken(token),
		ExpiresAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true},
	})
	if errors.Is(err, sql.ErrNoRows) {
		current, findErr := s.FindInvite(ctx, token)
		if findErr != nil {
			return db.Invite{}, ErrInviteInvalid
		}
		if checkErr := CheckInvite(current, now); checkErr != nil {
			return db.Invite{}, checkErr
		}
		return db.Invite{}, ErrInviteInvalid
	}
	if err != nil {
		return db.Invite{}, fmt.Errorf("consume invite: %w", err)
	}
	return inv, nil
}

// RevokeBootstrapInvites invalidates every unused bootstrap invite.
func (s *Store) RevokeBootstrapInvites(ctx context.Context, now time.Time) error {
	if err := s.q.RevokeBootstrapInvites(ctx, sql.NullInt64{
		Int64: now.UnixMilli(),
		Valid: true,
	}); err != nil {
		return fmt.Errorf("revoke bootstrap invites: %w", err)
	}
	return nil
}

// DeleteInvite removes an invite row.
func (s *Store) DeleteInvite(ctx context.Context, token string) error {
	if err := s.q.DeleteInvite(ctx, HashInviteToken(token)); err != nil {
		return fmt.Errorf("delete invite: %w", err)
	}
	return nil
}

// BanOptions describes a new ban. Exactly one of PublicKey and IP must be set.
type BanOptions struct {
	PublicKey []byte
	IP        string
	Reason    string
	CreatedBy *int64
	ExpiresAt *time.Time
}

// AddBan creates a ban. Adding a duplicate subject replaces the old ban.
func (s *Store) AddBan(ctx context.Context, opts BanOptions) error {
	hasKey := len(opts.PublicKey) > 0
	hasIP := opts.IP != ""
	if hasKey == hasIP {
		return errors.New("ban needs exactly one subject: a public key or an IP")
	}

	var publicKey []byte
	if hasKey {
		if len(opts.PublicKey) != 32 {
			return fmt.Errorf("ban public key must be 32 bytes, got %d", len(opts.PublicKey))
		}
		if err := s.q.DeleteBanByPublicKey(ctx, opts.PublicKey); err != nil {
			return fmt.Errorf("replace ban by key: %w", err)
		}
		publicKey = opts.PublicKey
	}
	var ip sql.NullString
	if hasIP {
		if err := s.q.DeleteBanByIP(ctx, sql.NullString{String: opts.IP, Valid: true}); err != nil {
			return fmt.Errorf("replace ban by ip: %w", err)
		}
		ip = sql.NullString{String: opts.IP, Valid: true}
	}

	var createdBy sql.NullInt64
	if opts.CreatedBy != nil {
		createdBy = sql.NullInt64{Int64: *opts.CreatedBy, Valid: true}
	}
	var expires sql.NullInt64
	if opts.ExpiresAt != nil {
		expires = sql.NullInt64{Int64: opts.ExpiresAt.UnixMilli(), Valid: true}
	}

	if err := s.q.CreateBan(ctx, db.CreateBanParams{
		PublicKey: publicKey,
		Ip:        ip,
		Reason:    opts.Reason,
		CreatedBy: createdBy,
		CreatedAt: time.Now().UnixMilli(),
		ExpiresAt: expires,
	}); err != nil {
		return fmt.Errorf("create ban: %w", err)
	}
	return nil
}

// BanByPublicKey returns the active ban for a key, or ErrNotFound.
func (s *Store) BanByPublicKey(ctx context.Context, publicKey []byte, now time.Time) (db.Ban, error) {
	ban, err := s.q.GetActiveBanByPublicKey(ctx, db.GetActiveBanByPublicKeyParams{
		PublicKey: publicKey,
		ExpiresAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true},
	})
	return banOrError(ban, err)
}

// BanByIP returns the active ban for an address, or ErrNotFound.
func (s *Store) BanByIP(ctx context.Context, ip string, now time.Time) (db.Ban, error) {
	ban, err := s.q.GetActiveBanByIP(ctx, db.GetActiveBanByIPParams{
		Ip:        sql.NullString{String: ip, Valid: true},
		ExpiresAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true},
	})
	return banOrError(ban, err)
}

func banOrError(ban db.Ban, err error) (db.Ban, error) {
	if errors.Is(err, sql.ErrNoRows) {
		return db.Ban{}, ErrNotFound
	}
	if err != nil {
		return db.Ban{}, fmt.Errorf("get ban: %w", err)
	}
	return ban, nil
}

func boolToInt(v bool) int64 {
	if v {
		return 1
	}
	return 0
}
