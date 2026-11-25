package backup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/netutil"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

// seedServerData creates a data directory shaped like a real installation:
// TLS material, a database with users/roles/channels and the pending admin
// invite file. It returns the fingerprint of the leaf certificate.
func seedServerData(t *testing.T) (dataDir, fingerprint string) {
	t.Helper()
	ctx := context.Background()
	dataDir = t.TempDir()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	st, err := store.Open(filepath.Join(dataDir, "rostalk.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	if _, err := st.UpsertUser(ctx, bytes.Repeat([]byte{7}, 32), "alice", testNow()); err != nil {
		t.Fatalf("UpsertUser: %v", err)
	}
	if _, err := st.UpsertUser(ctx, bytes.Repeat([]byte{8}, 32), "bob", testNow()); err != nil {
		t.Fatalf("UpsertUser: %v", err)
	}
	if err := st.SetSetting(ctx, "server_name", "Backup Test"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	if _, err := roles.Open(ctx, roles.Config{Store: st, Logger: logger}); err != nil {
		t.Fatalf("roles.Open: %v", err)
	}
	svc, err := channels.Open(ctx, channels.Config{Store: st, Logger: logger})
	if err != nil {
		t.Fatalf("channels.Open: %v", err)
	}
	if _, err := svc.Create(ctx, channels.CreateParams{
		Name: "Gaming",
		Kind: rostalkv1.ChannelKind_CHANNEL_KIND_VOICE,
	}); err != nil {
		t.Fatalf("channels.Create: %v", err)
	}
	// Backup while the database is open with WAL: this is the running-server
	// case, not a closed-file copy.
	// Keep st open until the caller is done.

	material, err := netutil.LoadOrCreateTLS(dataDir, []string{"192.0.2.10"})
	if err != nil {
		t.Fatalf("LoadOrCreateTLS: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "admin-invite"), []byte("bootstrap-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "acme"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "acme", "account.key"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return dataDir, material.FingerprintHex
}

func testNow() time.Time { return time.Unix(1_700_000_000, 0).UTC() }

func TestBackupRestoreRoundTrip(t *testing.T) {
	source, fingerprint := seedServerData(t)
	// A backup must not preserve a too-open secret mode: make the source key
	// world readable and check the restore tightens it.
	if runtime.GOOS != "windows" {
		if err := os.Chmod(filepath.Join(source, "server.key"), 0o644); err != nil {
			t.Fatalf("chmod source key: %v", err)
		}
	}
	archive := filepath.Join(t.TempDir(), "backup.tar.gz")

	created, err := Create(context.Background(), CreateOptions{
		DataDir: source,
		OutPath: archive,
		Version: "test-build",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if created.Summary.Users != 2 || created.Summary.Channels < 3 || created.Summary.Roles < 4 {
		t.Fatalf("unexpected summary %+v", created.Summary)
	}
	if created.SHA256 == "" || created.Size == 0 {
		t.Fatalf("backup result has no digest/size: %+v", created)
	}
	if _, err := os.Stat(archive); err != nil {
		t.Fatalf("archive: %v", err)
	}

	target := filepath.Join(t.TempDir(), "restored")
	restored, err := Restore(context.Background(), RestoreOptions{Archive: archive, DataDir: target})
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restored.Summary.Users != 2 || restored.Summary.Channels != created.Summary.Channels {
		t.Fatalf("restored summary %+v, want %+v", restored.Summary, created.Summary)
	}

	st, err := store.Open(filepath.Join(target, "rostalk.db"))
	if err != nil {
		t.Fatalf("open restored database: %v", err)
	}
	defer func() { _ = st.Close() }()
	users, err := st.ListUsers(context.Background())
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	if len(users) != 2 {
		t.Fatalf("restored users = %d, want 2", len(users))
	}
	channelRows, err := st.ListChannels(context.Background())
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	found := false
	for _, channel := range channelRows {
		if channel.Name == "Gaming" {
			found = true
		}
	}
	if !found {
		t.Fatalf("restored channels do not contain Gaming: %+v", channelRows)
	}
	roleRows, err := st.ListRoles(context.Background())
	if err != nil {
		t.Fatalf("ListRoles: %v", err)
	}
	if len(roleRows) < 4 {
		t.Fatalf("restored roles = %d", len(roleRows))
	}
	settings, err := st.Settings(context.Background())
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if settings.ServerName != "Backup Test" {
		t.Fatalf("server name = %q", settings.ServerName)
	}

	material, err := netutil.LoadTLS(target)
	if err != nil {
		t.Fatalf("LoadTLS on the restored directory: %v", err)
	}
	if material.FingerprintHex != fingerprint {
		t.Fatalf("certificate fingerprint changed: %s -> %s", fingerprint, material.FingerprintHex)
	}
	invite, err := os.ReadFile(filepath.Join(target, "admin-invite"))
	if err != nil || string(invite) != "bootstrap-token\n" {
		t.Fatalf("admin invite was not restored: %q, %v", invite, err)
	}
	if _, err := os.Stat(filepath.Join(target, "acme", "account.key")); err != nil {
		t.Fatalf("ACME state was not restored: %v", err)
	}
	if runtime.GOOS != "windows" {
		for _, name := range []string{"server.key", "admin-invite", "rostalk.db"} {
			info, statErr := os.Stat(filepath.Join(target, name))
			if statErr != nil {
				t.Fatalf("stat %s: %v", name, statErr)
			}
			if mode := info.Mode().Perm(); mode != 0o600 {
				t.Fatalf("restored %s mode = %04o, want 0600", name, mode)
			}
		}
	}
}

func TestBackupSnapshotsFilesWhileTheyGrow(t *testing.T) {
	source, _ := seedServerData(t)
	logDir := filepath.Join(source, "logs")
	if err := os.MkdirAll(logDir, 0o700); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(logDir, "rostalk-server.log")
	// A few megabytes make hashing and archiving take long enough for the
	// writer below to append while the backup is running.
	if err := os.WriteFile(logPath, bytes.Repeat([]byte("a"), 4<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	var writer sync.WaitGroup
	writer.Add(1)
	go func() {
		defer writer.Done()
		chunk := bytes.Repeat([]byte("b"), 8<<10)
		for i := 0; i < 600; i++ {
			select {
			case <-stop:
				return
			default:
			}
			f, err := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0o600)
			if err == nil {
				_, _ = f.Write(chunk)
				_ = f.Close()
			}
			time.Sleep(time.Millisecond)
		}
	}()
	archive := filepath.Join(t.TempDir(), "backup.tar.gz")
	created, err := Create(context.Background(), CreateOptions{DataDir: source, OutPath: archive})
	close(stop)
	writer.Wait()
	if err != nil {
		t.Fatalf("Create while the log grows: %v", err)
	}
	if created.SHA256 == "" {
		t.Fatal("the backup has no digest")
	}

	target := filepath.Join(t.TempDir(), "restored")
	if _, err := Restore(context.Background(), RestoreOptions{Archive: archive, DataDir: target}); err != nil {
		t.Fatalf("Restore of a backup taken while the log grew: %v", err)
	}
	restored, err := os.ReadFile(filepath.Join(target, "logs", "rostalk-server.log"))
	if err != nil {
		t.Fatalf("read the restored log: %v", err)
	}
	final, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read the source log: %v", err)
	}
	// The restored file is exactly the snapshot the manifest describes, so it
	// has to be an unmodified prefix of the file that kept growing.
	if len(restored) > len(final) || !bytes.Equal(restored, final[:len(restored)]) {
		t.Fatalf("the restored log is not a prefix of the source (restored %d bytes, source %d)", len(restored), len(final))
	}
	if len(restored) < 4<<20 {
		t.Fatalf("the restored log lost its initial content: %d bytes", len(restored))
	}
}

func TestRestoreRefusesNonEmptyDirectoryWithoutForce(t *testing.T) {
	source, _ := seedServerData(t)
	archive := filepath.Join(t.TempDir(), "backup.tar.gz")
	if _, err := Create(context.Background(), CreateOptions{DataDir: source, OutPath: archive}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	target := t.TempDir()
	if err := os.WriteFile(filepath.Join(target, "keep.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Restore(context.Background(), RestoreOptions{Archive: archive, DataDir: target}); err == nil {
		t.Fatal("restore into a non-empty directory succeeded without --force")
	}

	// With --force it replaces and keeps the old directory aside.
	result, err := Restore(context.Background(), RestoreOptions{Archive: archive, DataDir: target, Force: true})
	if err != nil {
		t.Fatalf("Restore --force: %v", err)
	}
	if result.PreviousDir == "" {
		t.Fatal("restore did not report where the previous data went")
	}
	if _, err := os.Stat(filepath.Join(result.PreviousDir, "keep.txt")); err != nil {
		t.Fatalf("the previous directory was not kept: %v", err)
	}
	// Restoring the same archive again is idempotent.
	if _, err := Restore(context.Background(), RestoreOptions{Archive: archive, DataDir: target, Force: true}); err != nil {
		t.Fatalf("second Restore --force: %v", err)
	}
	if _, err := os.Stat(filepath.Join(target, "rostalk.db")); err != nil {
		t.Fatalf("database missing after the second restore: %v", err)
	}
}

func TestBackupIsRepeatable(t *testing.T) {
	source, _ := seedServerData(t)
	out := filepath.Join(t.TempDir(), "backup.tar.gz")
	first, err := Create(context.Background(), CreateOptions{DataDir: source, OutPath: out})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	second, err := Create(context.Background(), CreateOptions{DataDir: source, OutPath: out})
	if err != nil {
		t.Fatalf("Create again: %v", err)
	}
	if first.Summary != second.Summary {
		t.Fatalf("two backups of the same data differ: %+v vs %+v", first.Summary, second.Summary)
	}
	if _, err := Restore(context.Background(), RestoreOptions{Archive: out, DataDir: filepath.Join(t.TempDir(), "r")}); err != nil {
		t.Fatalf("Restore of the overwritten archive: %v", err)
	}
}

func TestBackupRequiresDatabase(t *testing.T) {
	if _, err := Create(context.Background(), CreateOptions{DataDir: t.TempDir()}); err == nil {
		t.Fatal("backup of a directory without a database succeeded")
	}
}

func TestRestoreRejectsCorruptArchive(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.tar.gz")
	if err := os.WriteFile(path, []byte("not a gzip archive"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Restore(context.Background(), RestoreOptions{Archive: path, DataDir: filepath.Join(dir, "out")}); err == nil {
		t.Fatal("restore of a non-gzip file succeeded")
	}
}

func TestRestoreRejectsPathTraversal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "evil.tar.gz")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	manifest := `{"format":1,"created_at":"2026-01-01T00:00:00Z","database":"rostalk.db","files":[{"name":"../evil","size":1,"sha256":"","mode":384}]}`
	if err := tw.WriteHeader(&tar.Header{Name: ManifestName, Mode: 0o600, Size: int64(len(manifest))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte(manifest)); err != nil {
		t.Fatal(err)
	}
	if err := tw.WriteHeader(&tar.Header{Name: "../evil", Mode: 0o600, Size: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	_ = tw.Close()
	_ = gz.Close()
	_ = f.Close()

	if _, err := Restore(context.Background(), RestoreOptions{Archive: path, DataDir: filepath.Join(t.TempDir(), "out")}); err == nil {
		t.Fatal("a path traversal entry was extracted")
	}
}

// TestRestoreAcceptsArchiveFromBeforeRename restores an archive written by a
// server published as "Hearth": its manifest names hearth.db and the database
// entry carries that name (ADR 0033). The restored directory uses rostalk.db.
func TestRestoreAcceptsArchiveFromBeforeRename(t *testing.T) {
	source, _ := seedServerData(t)
	archive := filepath.Join(t.TempDir(), "backup.tar.gz")
	if _, err := Create(context.Background(), CreateOptions{DataDir: source, OutPath: archive, Version: "test"}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	legacy := filepath.Join(t.TempDir(), "legacy.tar.gz")
	relabelDatabase(t, archive, legacy, LegacyDatabaseName)

	target := filepath.Join(t.TempDir(), "restored")
	restored, err := Restore(context.Background(), RestoreOptions{Archive: legacy, DataDir: target})
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restored.Summary.Users != 2 {
		t.Fatalf("restored users = %d, want 2", restored.Summary.Users)
	}
	if _, err := os.Stat(filepath.Join(target, LegacyDatabaseName)); !os.IsNotExist(err) {
		t.Fatalf("legacy database name left in the data directory: %v", err)
	}
	st, err := store.Open(filepath.Join(target, DatabaseName))
	if err != nil {
		t.Fatalf("open restored database: %v", err)
	}
	_ = st.Close()
}

// relabelDatabase copies a backup archive, renaming the database entry and the
// manifest's database field to name, as an old server would have written it.
func relabelDatabase(t *testing.T, from, to, name string) {
	t.Helper()
	in, err := os.Open(from)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = in.Close() }()
	gzr, err := gzip.NewReader(in)
	if err != nil {
		t.Fatal(err)
	}
	out, err := os.Create(to)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = out.Close() }()
	gzw := gzip.NewWriter(out)
	tw := tar.NewWriter(gzw)
	tr := tar.NewReader(gzr)
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		switch header.Name {
		case ManifestName:
			var manifest Manifest
			if err := json.Unmarshal(data, &manifest); err != nil {
				t.Fatal(err)
			}
			manifest.Database = name
			if data, err = json.Marshal(manifest); err != nil {
				t.Fatal(err)
			}
		case DatabaseName:
			header.Name = name
		}
		header.Size = int64(len(data))
		if err := tw.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzw.Close(); err != nil {
		t.Fatal(err)
	}
}
