// Package legacy carries a server installed under the old name "Hearth" over
// the RosTalk rename (ADR 0033).
//
// Two things changed on disk and in the environment: the database file
// (hearth.db → rostalk.db) and the prefix of configuration variables
// (HEARTH_* → ROSTALK_*). Everything else in the data directory (identity,
// TLS material, attachments, ACME account) kept its name.
package legacy

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const (
	// DatabaseName is the database file of the data directory.
	DatabaseName = "rostalk.db"
	// LegacyDatabaseName is the database file written before the rename.
	LegacyDatabaseName = "hearth.db"

	envPrefix       = "ROSTALK_"
	legacyEnvPrefix = "HEARTH_"
)

// sqliteSidecars are renamed with the database. The write-ahead log may hold
// committed transactions that are not in the main file yet, so it must move
// under the matching name or those transactions are lost.
var sqliteSidecars = []string{"-wal", "-shm"}

// AdoptDataDir renames the database of a pre-rename data directory in place.
//
// It is idempotent and finishes an interrupted run: the database moves first,
// and leftover hearth.db-wal/-shm next to a rostalk.db (with no hearth.db) are
// moved on the next call. It never overwrites a file that already exists.
// The server must not be running on the directory; callers are the command
// entry points, before the database is opened.
func AdoptDataDir(dataDir string) (bool, error) {
	newDB := filepath.Join(dataDir, DatabaseName)
	oldDB := filepath.Join(dataDir, LegacyDatabaseName)

	newExists, err := exists(newDB)
	if err != nil {
		return false, err
	}
	oldExists, err := exists(oldDB)
	if err != nil {
		return false, err
	}
	switch {
	case newExists && oldExists:
		// Both present: someone already runs RosTalk here. Leave the old file
		// for the operator instead of guessing which one is current.
		return false, nil
	case !newExists && !oldExists:
		return false, nil
	case !newExists:
		if err := os.Rename(oldDB, newDB); err != nil {
			return false, fmt.Errorf("rename %s to %s: %w", LegacyDatabaseName, DatabaseName, err)
		}
	}

	moved := !newExists
	for _, suffix := range sqliteSidecars {
		from, to := oldDB+suffix, newDB+suffix
		fromExists, err := exists(from)
		if err != nil {
			return moved, err
		}
		toExists, err := exists(to)
		if err != nil {
			return moved, err
		}
		if !fromExists || toExists {
			continue
		}
		if err := os.Rename(from, to); err != nil {
			return moved, fmt.Errorf("rename %s: %w", filepath.Base(from), err)
		}
		moved = true
	}
	return moved, nil
}

// LookupEnv reads ROSTALK_<suffix> for name "ROSTALK_<suffix>", falling back to
// the pre-rename HEARTH_<suffix>. legacyName is the variable actually used when
// the fallback applied, so the caller can warn once; it is empty otherwise.
// An empty value counts as unset, like the server's flag defaults.
func LookupEnv(name string) (value string, ok bool, legacyName string) {
	if v, found := os.LookupEnv(name); found && v != "" {
		return v, true, ""
	}
	suffix, isOurs := strings.CutPrefix(name, envPrefix)
	if !isOurs {
		return "", false, ""
	}
	old := legacyEnvPrefix + suffix
	if v, found := os.LookupEnv(old); found && v != "" {
		return v, true, old
	}
	return "", false, ""
}

func exists(path string) (bool, error) {
	_, err := os.Lstat(path)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return false, fmt.Errorf("stat %s: %w", path, err)
}
