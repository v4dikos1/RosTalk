package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
)

// Summary is the row count of the tables an operator cares about after a
// restore. It is printed by `rostalk-server restore` and does not require the
// migration runner, so an older archive can still be inspected.
type Summary struct {
	Users    int64
	Channels int64
	Roles    int64
}

// Snapshot writes a transactionally consistent copy of the database at dbPath
// to dest using SQLite's VACUUM INTO. The server may keep running: WAL readers
// and this snapshot do not block each other.
//
// dest must not exist; the caller owns it and should remove it on failure.
func Snapshot(ctx context.Context, dbPath, dest string) error {
	if dbPath == "" || dest == "" {
		return fmt.Errorf("snapshot: both paths are required")
	}
	absDB, err := filepath.Abs(dbPath)
	if err != nil {
		return fmt.Errorf("snapshot: resolve %q: %w", dbPath, err)
	}
	absDest, err := filepath.Abs(dest)
	if err != nil {
		return fmt.Errorf("snapshot: resolve %q: %w", dest, err)
	}
	if _, statErr := os.Stat(absDest); statErr == nil {
		return fmt.Errorf("snapshot: %q already exists", absDest)
	}

	sqlDB, err := sql.Open("sqlite", dsn(absDB))
	if err != nil {
		return fmt.Errorf("snapshot: open %q: %w", absDB, err)
	}
	defer func() { _ = sqlDB.Close() }()
	if err := sqlDB.PingContext(ctx); err != nil {
		return fmt.Errorf("snapshot: open %q: %w", absDB, err)
	}
	if _, err := sqlDB.ExecContext(ctx, "VACUUM INTO ?", absDest); err != nil {
		return fmt.Errorf("snapshot: copy %q to %q: %w", absDB, absDest, err)
	}
	return nil
}

// CheckIntegrity runs SQLite's integrity_check. Restore uses it before putting
// a database into service.
func CheckIntegrity(ctx context.Context, dbPath string) error {
	absDB, err := filepath.Abs(dbPath)
	if err != nil {
		return fmt.Errorf("integrity check: resolve %q: %w", dbPath, err)
	}
	sqlDB, err := sql.Open("sqlite", dsn(absDB))
	if err != nil {
		return fmt.Errorf("integrity check: open %q: %w", absDB, err)
	}
	defer func() { _ = sqlDB.Close() }()

	var result string
	if err := sqlDB.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&result); err != nil {
		return fmt.Errorf("integrity check: %w", err)
	}
	if result != "ok" {
		return fmt.Errorf("integrity check failed: %s", result)
	}
	return nil
}

// Summarize counts users, channels and roles in a database file without
// running migrations.
func Summarize(ctx context.Context, dbPath string) (Summary, error) {
	absDB, err := filepath.Abs(dbPath)
	if err != nil {
		return Summary{}, fmt.Errorf("summarize: resolve %q: %w", dbPath, err)
	}
	sqlDB, err := sql.Open("sqlite", dsn(absDB))
	if err != nil {
		return Summary{}, fmt.Errorf("summarize: open %q: %w", absDB, err)
	}
	defer func() { _ = sqlDB.Close() }()

	var summary Summary
	counts := []struct {
		table string
		dest  *int64
	}{
		{"users", &summary.Users},
		{"channels", &summary.Channels},
		{"roles", &summary.Roles},
	}
	for _, c := range counts {
		if err := sqlDB.QueryRowContext(ctx, "SELECT count(*) FROM "+c.table).Scan(c.dest); err != nil {
			return Summary{}, fmt.Errorf("summarize: count %s: %w", c.table, err)
		}
	}
	return summary, nil
}
