package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

// queryPlan returns the EXPLAIN QUERY PLAN details of one statement.
func queryPlan(t *testing.T, db *sql.DB, query string, args ...any) []string {
	t.Helper()
	rows, err := db.Query("EXPLAIN QUERY PLAN "+query, args...)
	if err != nil {
		t.Fatalf("explain %q: %v", query, err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatalf("scan plan: %v", err)
		}
		out = append(out, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("plan rows: %v", err)
	}
	return out
}

func indexNames(t *testing.T, db *sql.DB) map[string]bool {
	t.Helper()
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'`)
	if err != nil {
		t.Fatalf("list indexes: %v", err)
	}
	defer func() { _ = rows.Close() }()
	names := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan index: %v", err)
		}
		names[name] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("index rows: %v", err)
	}
	return names
}

// TestCoveringIndexIsUsed proves the new index is what the two hot queries
// actually use: an unread count and the newest history page. A regression to a
// full table scan (which is what made connect p50 grow to 333 ms on a long
// history) fails here.
func TestCoveringIndexIsUsed(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(filepath.Join(dir, "rostalk.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = st.Close() }()
	ctx := context.Background()

	if _, err := st.sqlDB.ExecContext(ctx,
		`INSERT INTO users (public_key, nickname, created_at, last_seen_at) VALUES (?, 'alice', 0, 0)`,
		make([]byte, 32)); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if _, err := st.sqlDB.ExecContext(ctx,
		`INSERT INTO channels (name, kind, created_at) VALUES ('general', 1, 0)`); err != nil {
		t.Fatalf("insert channel: %v", err)
	}
	for i := 0; i < 3; i++ {
		if _, err := st.sqlDB.ExecContext(ctx,
			`INSERT INTO messages (channel_id, sender_id, body, created_at) VALUES (1, 1, 'hello', 0)`); err != nil {
			t.Fatalf("insert message: %v", err)
		}
	}

	unread := queryPlan(t, st.sqlDB,
		`SELECT count(*) FROM messages WHERE channel_id = ? AND id > ? AND sender_id <> ?`, 1, 0, 2)
	if plan := strings.Join(unread, "\n"); !strings.Contains(plan, "messages_channel_cover_idx") ||
		strings.Contains(plan, "SCAN messages") {
		t.Fatalf("unread count does not use the covering index:\n%s", plan)
	}

	history := queryPlan(t, st.sqlDB, `SELECT m.*, u.nickname
		FROM messages m JOIN users u ON u.id = m.sender_id
		WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`, 1, 100, 50)
	if plan := strings.Join(history, "\n"); !strings.Contains(plan, "messages_channel_cover_idx") ||
		strings.Contains(plan, "SCAN m") {
		t.Fatalf("history page does not use the covering index:\n%s", plan)
	}
}

// TestCoveringIndexMigrationUpgradesExistingDatabase emulates a database that
// was created before stage 7.2 (old index, no migration row) and reopens it:
// the data survives, the old index is replaced and the new one is used.
func TestCoveringIndexMigrationUpgradesExistingDatabase(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rostalk.db")

	first, err := Open(path)
	if err != nil {
		t.Fatalf("open fresh store: %v", err)
	}
	ctx := context.Background()
	if _, err := first.sqlDB.ExecContext(ctx,
		`INSERT INTO users (public_key, nickname, created_at, last_seen_at) VALUES (?, 'alice', 0, 0)`,
		make([]byte, 32)); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if _, err := first.sqlDB.ExecContext(ctx,
		`INSERT INTO channels (name, kind, created_at) VALUES ('general', 1, 0)`); err != nil {
		t.Fatalf("insert channel: %v", err)
	}
	if _, err := first.sqlDB.ExecContext(ctx,
		`INSERT INTO messages (channel_id, sender_id, body, created_at) VALUES (1, 1, 'kept', 0)`); err != nil {
		t.Fatalf("insert message: %v", err)
	}
	// Roll the schema back to the pre-7.2 shape.
	if _, err := first.sqlDB.ExecContext(ctx,
		`DROP INDEX messages_channel_cover_idx;
		 CREATE INDEX messages_channel_idx ON messages (channel_id, id);
		 DELETE FROM schema_migrations WHERE name = 'migrations/0006_messages_channel_cover.sql';`); err != nil {
		t.Fatalf("downgrade schema: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("close before upgrade: %v", err)
	}

	upgraded, err := Open(path)
	if err != nil {
		t.Fatalf("reopen and migrate: %v", err)
	}
	defer func() { _ = upgraded.Close() }()

	var body string
	if err := upgraded.sqlDB.QueryRowContext(ctx, `SELECT body FROM messages WHERE id = 1`).Scan(&body); err != nil {
		t.Fatalf("read preserved message: %v", err)
	}
	if body != "kept" {
		t.Fatalf("message body = %q, want kept", body)
	}
	names := indexNames(t, upgraded.sqlDB)
	if !names["messages_channel_cover_idx"] {
		t.Fatalf("covering index is missing after upgrade: %v", names)
	}
	if names["messages_channel_idx"] {
		t.Fatalf("old channel index was not replaced: %v", names)
	}
}

// TestCoveringIndexOnCleanDatabase checks the fresh-install path: every
// migration applies and only the new channel index remains.
func TestCoveringIndexOnCleanDatabase(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "rostalk.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = st.Close() }()

	names := indexNames(t, st.sqlDB)
	if !names["messages_channel_cover_idx"] || names["messages_channel_idx"] {
		t.Fatalf("clean install indexes = %v", names)
	}
}
