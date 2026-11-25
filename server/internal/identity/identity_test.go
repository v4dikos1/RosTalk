package identity

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLoadOrCreateIsStable(t *testing.T) {
	dir := t.TempDir()
	first, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	second, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatalf("LoadOrCreate again: %v", err)
	}
	if first.IDFingerprintHex() != second.IDFingerprintHex() {
		t.Fatalf("server id changed: %s -> %s", first.IDFingerprintHex(), second.IDFingerprintHex())
	}
	if len(first.ID) != 32 {
		t.Fatalf("server id is %d bytes, want 32", len(first.ID))
	}
	if len(first.Public) != 32 {
		t.Fatalf("public key is %d bytes, want 32", len(first.Public))
	}

	info, err := os.Stat(filepath.Join(dir, FileName))
	if err != nil {
		t.Fatalf("stat identity: %v", err)
	}
	if runtime.GOOS != "windows" {
		if perm := info.Mode().Perm(); perm&0o077 != 0 {
			t.Fatalf("identity permissions = %o, want no group/other access", perm)
		}
	}
}

func TestGenerateGivesDistinctIDs(t *testing.T) {
	a, err := Generate()
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	b, err := Generate()
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if a.IDFingerprintHex() == b.IDFingerprintHex() {
		t.Fatal("two generated identities have the same id")
	}
}
