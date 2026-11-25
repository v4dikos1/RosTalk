package legacy

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, dir, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(data)
}

func absent(t *testing.T, dir, name string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
		t.Fatalf("%s should not exist (err=%v)", name, err)
	}
}

func TestAdoptMovesDatabaseAndSidecars(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "hearth.db", "main")
	write(t, dir, "hearth.db-wal", "wal")
	write(t, dir, "hearth.db-shm", "shm")
	write(t, dir, "identity.key", "id")

	moved, err := AdoptDataDir(dir)
	if err != nil || !moved {
		t.Fatalf("AdoptDataDir = %v, %v; want true, nil", moved, err)
	}
	if read(t, dir, "rostalk.db") != "main" || read(t, dir, "rostalk.db-wal") != "wal" || read(t, dir, "rostalk.db-shm") != "shm" {
		t.Fatal("database files were not moved intact")
	}
	absent(t, dir, "hearth.db")
	absent(t, dir, "hearth.db-wal")
	if read(t, dir, "identity.key") != "id" {
		t.Fatal("unrelated files must stay")
	}

	moved, err = AdoptDataDir(dir)
	if err != nil || moved {
		t.Fatalf("second run = %v, %v; want false, nil", moved, err)
	}
}

func TestAdoptFinishesAnInterruptedRun(t *testing.T) {
	// The database moved, then the process died before the WAL followed.
	dir := t.TempDir()
	write(t, dir, "rostalk.db", "main")
	write(t, dir, "hearth.db-wal", "wal")

	moved, err := AdoptDataDir(dir)
	if err != nil || !moved {
		t.Fatalf("AdoptDataDir = %v, %v; want true, nil", moved, err)
	}
	if read(t, dir, "rostalk.db-wal") != "wal" {
		t.Fatal("the leftover WAL was not moved")
	}
}

func TestAdoptNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "rostalk.db", "new")
	write(t, dir, "hearth.db", "old")
	write(t, dir, "hearth.db-wal", "old-wal")

	moved, err := AdoptDataDir(dir)
	if err != nil || moved {
		t.Fatalf("AdoptDataDir = %v, %v; want false, nil", moved, err)
	}
	if read(t, dir, "rostalk.db") != "new" || read(t, dir, "hearth.db") != "old" {
		t.Fatal("an existing database was touched")
	}
	absent(t, dir, "rostalk.db-wal")
}

func TestAdoptFreshDirectory(t *testing.T) {
	moved, err := AdoptDataDir(t.TempDir())
	if err != nil || moved {
		t.Fatalf("AdoptDataDir = %v, %v; want false, nil", moved, err)
	}
}

func TestLookupEnvPrefersTheNewName(t *testing.T) {
	t.Setenv("ROSTALK_LISTEN", ":1")
	t.Setenv("HEARTH_LISTEN", ":2")
	v, ok, legacyName := LookupEnv("ROSTALK_LISTEN")
	if v != ":1" || !ok || legacyName != "" {
		t.Fatalf("LookupEnv = %q, %v, %q", v, ok, legacyName)
	}
}

func TestLookupEnvFallsBackToTheOldName(t *testing.T) {
	t.Setenv("ROSTALK_DATA", "")
	t.Setenv("HEARTH_DATA", "/var/lib/hearth")
	v, ok, legacyName := LookupEnv("ROSTALK_DATA")
	if v != "/var/lib/hearth" || !ok || legacyName != "HEARTH_DATA" {
		t.Fatalf("LookupEnv = %q, %v, %q", v, ok, legacyName)
	}
}

func TestLookupEnvUnset(t *testing.T) {
	t.Setenv("ROSTALK_NAT", "")
	t.Setenv("HEARTH_NAT", "")
	if _, ok, _ := LookupEnv("ROSTALK_NAT"); ok {
		t.Fatal("empty variables must count as unset")
	}
	if _, ok, _ := LookupEnv("OTHER_THING"); ok {
		t.Fatal("only ROSTALK_ names fall back")
	}
}
