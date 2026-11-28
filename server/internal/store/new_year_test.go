package store

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"path/filepath"
	"testing"

	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

func TestNewYearMigrationPreservesUsers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rostalk.db")
	raw, err := sql.Open("sqlite", dsn(path))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = raw.Close() }()
	run := func(query string, args ...any) {
		t.Helper()
		if _, err := raw.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	run("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)")
	names, err := fs.Glob(migrationsFS, "migrations/000[1-8]*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		body, err := migrationsFS.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		run(string(body))
		run("INSERT INTO schema_migrations VALUES (?, 0)", name)
	}
	run("INSERT INTO users (id, public_key, nickname, created_at, last_seen_at) VALUES (7, zeroblob(32), 'fixture', 1, 1)")
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	for i := range 3 {
		st, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		user, readErr := st.Queries().GetUserByID(ctx, 7)
		if readErr != nil || user.Nickname != "fixture" || user.CreatedAt != 1 {
			t.Fatalf("open %d: user ID 7 did not survive: %v", i, readErr)
		}
		var count int
		err = st.sqlDB.QueryRow("SELECT count(*) FROM schema_migrations WHERE name = 'migrations/0009_new_year.sql'").Scan(&count)
		if err != nil || count != 1 {
			t.Fatalf("open %d: recorded migrations = %d, err = %v", i, count, err)
		}
		if err := st.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestNewYearConstraintsAndRollback(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	run := func(query string, wantError bool) {
		t.Helper()
		if _, err := st.sqlDB.Exec(query); (err != nil) != wantError {
			t.Fatalf("%s: want error = %v, got %v", query, wantError, err)
		}
	}
	run("INSERT INTO users (id, public_key, nickname, created_at, last_seen_at) VALUES (7, zeroblob(32), 'fixture', 1, 1)", false)
	run("INSERT INTO ny_seasons VALUES ('2026-12', 'UTC')", false)
	run("INSERT INTO ny_players (season,user_id,enrolled_ms) VALUES ('2026-12',7,0)", false)
	run("UPDATE ny_players SET flakes = -1", true)
	run("INSERT INTO ny_days (season,user_id,day,voice_flakes) VALUES ('2026-12',7,'2026-12-01',25)", true)
	run("INSERT INTO ny_days (season,user_id,day) VALUES ('2026-12',7,'2026-12-1x')", true)
	run("INSERT INTO ny_inventory VALUES ('2026-12',7,'ball-red',0)", true)
	run("INSERT INTO ny_layout VALUES ('2026-12',7,0,'ball-red',500,500,100,0)", true)
	run("INSERT INTO ny_spins VALUES ('2026-12',7,'fixture','ball-red',0,0)", false)
	run("INSERT INTO ny_spins VALUES ('2026-12',7,'fixture','ball-red',1,2)", true)

	sentinel := errors.New("abort transaction")
	err := st.InTx(ctx, func(q *db.Queries) error {
		if _, err := q.CreditNYFlakes(ctx, db.CreditNYFlakesParams{Amount: 2, Season: "2026-12", UserID: 7}); err != nil {
			return err
		}
		if _, err := q.AddNYLedger(ctx, db.AddNYLedgerParams{Season: "2026-12", UserID: 7, Kind: "voice", Delta: 2, Source: "1"}); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	player, err := st.Queries().GetNYPlayer(ctx, db.GetNYPlayerParams{Season: "2026-12", UserID: 7})
	if err != nil || player.Flakes != 0 {
		t.Fatalf("wallet after rollback = %d, err = %v", player.Flakes, err)
	}
	ledger, err := st.Queries().ListNYLedger(ctx, db.ListNYLedgerParams{Season: "2026-12", UserID: 7})
	if err != nil || len(ledger) != 0 {
		t.Fatalf("ledger after rollback = %d, err = %v", len(ledger), err)
	}
	run("DELETE FROM ny_seasons WHERE season = '2026-12'", false)
	_, err = st.Queries().GetNYSpin(ctx, db.GetNYSpinParams{Season: "2026-12", UserID: 7, RequestID: "fixture"})
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("receipt after cascade: %v", err)
	}
}
