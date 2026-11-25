package store

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// TestOpenRestrictsDatabaseFiles guards the secrets in the database: password
// and token hashes, the media secret and message bodies must not inherit a
// permissive umask. Pre-creating the file with 0644 makes the check
// independent of the umask the test runs under.
func TestOpenRestrictsDatabaseFiles(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows file modes are ACLs; the Unix check does not apply")
	}
	path := filepath.Join(t.TempDir(), "rostalk.db")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("create database file: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close database file: %v", err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatalf("chmod database file: %v", err)
	}

	st, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()

	for _, candidate := range []string{path, path + "-wal", path + "-shm"} {
		info, statErr := os.Stat(candidate)
		if errors.Is(statErr, os.ErrNotExist) {
			continue
		}
		if statErr != nil {
			t.Fatalf("stat %s: %v", candidate, statErr)
		}
		if mode := info.Mode().Perm(); mode != 0o600 {
			t.Fatalf("%s mode = %04o, want 0600", filepath.Base(candidate), mode)
		}
	}
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "rostalk.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		if err := st.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return st
}

func TestOpenAppliesMigrationsAndDefaults(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	settings, err := st.Settings(ctx)
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if settings.ServerName != "RosTalk" || settings.LoginMode != "invite" {
		t.Fatalf("unexpected defaults: %+v", settings)
	}
	if settings.AuthLimit != 10 || settings.AuthWindow != time.Minute {
		t.Fatalf("unexpected rate limit defaults: %+v", settings)
	}

	// Reopening the same file must not re-run migrations.
	path := st.Path()
	if err := st.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	again, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer func() { _ = again.Close() }()

	if err := again.SetSetting(ctx, "server_name", "Test"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	settings, err = again.Settings(ctx)
	if err != nil {
		t.Fatalf("Settings after reopen: %v", err)
	}
	if settings.ServerName != "Test" {
		t.Fatalf("server name = %q, want Test", settings.ServerName)
	}
}

func TestMigrationAddsIdleFlagToAnExistingDatabase(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rostalk.db")

	// Build a database exactly as the previous release left it: only the first
	// two migrations are recorded as applied.
	raw, err := sql.Open("sqlite", dsn(path))
	if err != nil {
		t.Fatalf("open legacy database: %v", err)
	}
	if _, err := raw.ExecContext(context.Background(), `CREATE TABLE schema_migrations (
		name       TEXT PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`); err != nil {
		t.Fatalf("create schema_migrations: %v", err)
	}
	for _, name := range []string{"migrations/0001_init.sql", "migrations/0002_channels.sql"} {
		body, err := migrationsFS.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if _, err := raw.ExecContext(context.Background(), string(body)); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
		if _, err := raw.ExecContext(context.Background(),
			`INSERT INTO schema_migrations (name, applied_at) VALUES (?, 0)`, name); err != nil {
			t.Fatalf("record %s: %v", name, err)
		}
	}
	if _, err := raw.ExecContext(context.Background(), `
		INSERT INTO channels (position, name, kind, voice_profile, temporary, created_at)
		VALUES (0, 'Лобби', 1, 1, 0, 0), (1, 'AFK', 1, 1, 0, 0), (2, 'Позже', 1, 1, 0, 0)
	`); err != nil {
		t.Fatalf("insert legacy channels: %v", err)
	}
	if err := raw.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	st, err := Open(path)
	if err != nil {
		t.Fatalf("Open migrated database: %v", err)
	}
	defer func() { _ = st.Close() }()

	rows, err := st.ListChannels(context.Background())
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("channels after the migration = %d, want 3", len(rows))
	}
	flags := map[string]bool{}
	for _, row := range rows {
		flags[row.Name] = row.AFK
	}
	if !flags["AFK"] {
		t.Fatal("the historic idle channel was not flagged by the migration")
	}
	if flags["Лобби"] || flags["Позже"] {
		t.Fatalf("the migration flagged an ordinary channel: %v", flags)
	}
}

func TestUsersUpsertPreservesIDAndAdmin(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	now := time.Unix(1_700_000_000, 0)

	first, err := st.UpsertUser(ctx, key, "alice", now)
	if err != nil {
		t.Fatalf("UpsertUser: %v", err)
	}
	second, err := st.UpsertUser(ctx, key, "alice2", now.Add(time.Hour))
	if err != nil {
		t.Fatalf("UpsertUser again: %v", err)
	}
	if first.ID != second.ID {
		t.Fatalf("user id changed: %d -> %d", first.ID, second.ID)
	}
	if second.Nickname != "alice2" {
		t.Fatalf("nickname = %q, want alice2", second.Nickname)
	}
	if second.CreatedAt != first.CreatedAt {
		t.Fatalf("created_at changed: %d -> %d", first.CreatedAt, second.CreatedAt)
	}

	admin, err := st.SetUserAdmin(ctx, key)
	if err != nil {
		t.Fatalf("SetUserAdmin: %v", err)
	}
	if admin.IsAdmin != 1 {
		t.Fatal("user is not an admin")
	}
	third, err := st.UpsertUser(ctx, key, "alice3", now.Add(2*time.Hour))
	if err != nil {
		t.Fatalf("Upsert after admin: %v", err)
	}
	if third.IsAdmin != 1 {
		t.Fatal("upsert cleared the admin flag")
	}
	admins, err := st.CountAdmins(ctx)
	if err != nil || admins != 1 {
		t.Fatalf("CountAdmins = %d, %v", admins, err)
	}
}

func TestUpsertUserRejectsShortKey(t *testing.T) {
	st := openTestStore(t)
	if _, err := st.UpsertUser(context.Background(), []byte("short"), "x", time.Now()); err == nil {
		t.Fatal("expected an error for a short public key")
	}
}

func TestInviteConsumeAndExpiry(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	now := time.Unix(1_700_000_000, 0)

	token, err := st.CreateInvite(ctx, InviteOptions{MaxUses: 1})
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	inv, err := st.ConsumeInvite(ctx, token, now)
	if err != nil {
		t.Fatalf("ConsumeInvite: %v", err)
	}
	if inv.UsedCount != 1 {
		t.Fatalf("used_count = %d, want 1", inv.UsedCount)
	}
	if _, err := st.ConsumeInvite(ctx, token, now); !errors.Is(err, ErrInviteInvalid) {
		t.Fatalf("second consume error = %v, want ErrInviteInvalid", err)
	}

	expiredAt := now.Add(-time.Minute)
	expired, err := st.CreateInvite(ctx, InviteOptions{MaxUses: 1, ExpiresAt: &expiredAt})
	if err != nil {
		t.Fatalf("CreateInvite expired: %v", err)
	}
	if _, err := st.ConsumeInvite(ctx, expired, now); !errors.Is(err, ErrInviteExpired) {
		t.Fatalf("expired consume error = %v, want ErrInviteExpired", err)
	}

	if _, err := st.ConsumeInvite(ctx, "unknown-token", now); !errors.Is(err, ErrInviteInvalid) {
		t.Fatalf("unknown consume error = %v, want ErrInviteInvalid", err)
	}
}

func TestInviteMultiUseAndRevokeBootstrap(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	now := time.Unix(1_700_000_000, 0)

	token, err := st.CreateInvite(ctx, InviteOptions{MaxUses: 2})
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if _, err := st.ConsumeInvite(ctx, token, now); err != nil {
		t.Fatalf("first consume: %v", err)
	}
	inv, err := st.ConsumeInvite(ctx, token, now)
	if err != nil {
		t.Fatalf("second consume: %v", err)
	}
	if inv.UsedCount != 2 {
		t.Fatalf("used_count = %d, want 2", inv.UsedCount)
	}
	if _, err := st.ConsumeInvite(ctx, token, now); !errors.Is(err, ErrInviteInvalid) {
		t.Fatalf("third consume error = %v, want ErrInviteInvalid", err)
	}

	bootstrap, err := st.CreateInvite(ctx, InviteOptions{MaxUses: 1, GrantAdmin: true, Bootstrap: true})
	if err != nil {
		t.Fatalf("CreateInvite bootstrap: %v", err)
	}
	if err := st.RevokeBootstrapInvites(ctx, now); err != nil {
		t.Fatalf("RevokeBootstrapInvites: %v", err)
	}
	if _, err := st.ConsumeInvite(ctx, bootstrap, now); !errors.Is(err, ErrInviteInvalid) {
		t.Fatalf("revoked bootstrap error = %v, want ErrInviteInvalid", err)
	}
}

func TestBansByKeyAndIP(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	now := time.Unix(1_700_000_000, 0)
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(200 - i)
	}

	if err := st.AddBan(ctx, BanOptions{PublicKey: key, Reason: "spam"}); err != nil {
		t.Fatalf("AddBan key: %v", err)
	}
	if _, err := st.BanByPublicKey(ctx, key, now); err != nil {
		t.Fatalf("BanByPublicKey: %v", err)
	}
	if _, err := st.BanByIP(ctx, "203.0.113.7", now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unexpected IP ban: %v", err)
	}

	if err := st.AddBan(ctx, BanOptions{IP: "203.0.113.7"}); err != nil {
		t.Fatalf("AddBan IP: %v", err)
	}
	if _, err := st.BanByIP(ctx, "203.0.113.7", now); err != nil {
		t.Fatalf("BanByIP: %v", err)
	}

	// Expired bans stop matching.
	past := now.Add(-time.Minute)
	if err := st.AddBan(ctx, BanOptions{IP: "203.0.113.8", ExpiresAt: &past}); err != nil {
		t.Fatalf("AddBan expired: %v", err)
	}
	if _, err := st.BanByIP(ctx, "203.0.113.8", now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired ban matched: %v", err)
	}

	if err := st.AddBan(ctx, BanOptions{}); err == nil {
		t.Fatal("expected an error for a ban without a subject")
	}
	if err := st.AddBan(ctx, BanOptions{PublicKey: []byte("x"), IP: "1.2.3.4"}); err == nil {
		t.Fatal("expected an error for a ban with two subjects")
	}
}
