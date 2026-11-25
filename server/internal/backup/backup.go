// Package backup writes and restores the single RosTalk server archive: the
// SQLite database, the TLS/identity keys, ACME state and the pending admin
// invite. `rostalk-server backup` and `rostalk-server restore` are thin wrappers.
//
// The database goes into the archive through store.Snapshot (VACUUM INTO), so a
// running server is safe to back up. Every file carries its own SHA-256 in the
// manifest; restore verifies it before the archive goes into service.
package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/legacy"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

// Format is the archive format version. A restore refuses a newer format.
const Format = 1

// Names inside the archive.
const (
	ManifestName = "manifest.json"
	DatabaseName = legacy.DatabaseName
	// LegacyDatabaseName is the database file of servers and archives made
	// before the RosTalk rename (ADR 0033). Restore accepts it and writes the
	// file back under DatabaseName.
	LegacyDatabaseName = legacy.LegacyDatabaseName
)

// maxRestoreBytes bounds one restored archive (databases and files, not the
// archive itself). RosTalk is small; this only stops a malicious tarball from
// filling the disk.
const maxRestoreBytes = 8 << 30 // 8 GiB

// File is one archived file.
type File struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Mode   uint32 `json:"mode"`
}

// Manifest is the first tar entry. It doubles as an allowlist for restore.
type Manifest struct {
	Format    int       `json:"format"`
	CreatedAt time.Time `json:"created_at"`
	Version   string    `json:"version"`
	Database  string    `json:"database"`
	Files     []File    `json:"files"`
}

// Result describes a completed backup or restore.
type Result struct {
	Path     string
	SHA256   string
	Size     int64
	Manifest Manifest
	Summary  store.Summary
	// PreviousDir is where the replaced data directory was kept, if restore
	// had to move it aside.
	PreviousDir string
}

// CreateOptions configures Create.
type CreateOptions struct {
	DataDir string
	OutPath string
	// Version is the build identity recorded in the manifest; optional.
	Version string
	// Now is injectable for tests.
	Now func() time.Time
}

// Create writes a gzip-compressed tar archive to opts.OutPath.
func Create(ctx context.Context, opts CreateOptions) (Result, error) {
	if opts.DataDir == "" {
		return Result{}, errors.New("backup: a data directory is required")
	}
	dataDir, err := filepath.Abs(opts.DataDir)
	if err != nil {
		return Result{}, fmt.Errorf("backup: resolve the data directory: %w", err)
	}
	info, err := os.Stat(dataDir)
	if err != nil {
		return Result{}, fmt.Errorf("backup: %w", err)
	}
	if !info.IsDir() {
		return Result{}, fmt.Errorf("backup: %q is not a directory", dataDir)
	}
	if _, err := legacy.AdoptDataDir(dataDir); err != nil {
		return Result{}, fmt.Errorf("backup: %w", err)
	}
	dbPath := filepath.Join(dataDir, DatabaseName)
	if _, err := os.Stat(dbPath); err != nil {
		return Result{}, fmt.Errorf("backup: %q has no database; start the server once before backing up", dataDir)
	}

	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}
	createdAt := now().UTC()
	outPath := opts.OutPath
	if outPath == "" {
		outPath = fmt.Sprintf("rostalk-backup-%s.tar.gz", createdAt.Format("20060102-150405"))
	}
	outAbs, err := filepath.Abs(outPath)
	if err != nil {
		return Result{}, fmt.Errorf("backup: resolve the output path: %w", err)
	}

	tmpDir, err := os.MkdirTemp("", "rostalk-backup-*")
	if err != nil {
		return Result{}, fmt.Errorf("backup: create a temporary directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

	snapshot := filepath.Join(tmpDir, DatabaseName)
	if err := store.Snapshot(ctx, dbPath, snapshot); err != nil {
		return Result{}, err
	}
	summary, err := store.Summarize(ctx, snapshot)
	if err != nil {
		return Result{}, err
	}

	// Every regular file is copied into the temporary directory first and the
	// archive is written from those copies. The data directory is live: the
	// server keeps appending to logs/rostalk-server.log while the backup runs.
	// Hashing the original and then streaming it again later would record a
	// size/digest from one moment and bytes from another, which tar rejects
	// with "write too long" or restore rejects as a checksum mismatch.
	filesDir := filepath.Join(tmpDir, "files")
	if err := os.MkdirAll(filesDir, 0o700); err != nil {
		return Result{}, fmt.Errorf("backup: create the file snapshot directory: %w", err)
	}
	collected, err := collectFiles(dataDir, outAbs, filesDir)
	if err != nil {
		return Result{}, err
	}
	files := make([]File, len(collected))
	for i := range collected {
		files[i] = collected[i].File
	}

	manifest := Manifest{
		Format:    Format,
		CreatedAt: createdAt,
		Version:   opts.Version,
		Database:  DatabaseName,
		Files:     files,
	}

	tmpArchive := outAbs + ".tmp"
	archive, err := os.OpenFile(tmpArchive, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return Result{}, fmt.Errorf("backup: create %q: %w", tmpArchive, err)
	}
	hasher := sha256.New()
	gz := gzip.NewWriter(io.MultiWriter(archive, hasher))
	tw := tar.NewWriter(gz)

	writeErr := writeManifest(tw, manifest)
	if writeErr == nil {
		writeErr = writeFileEntry(tw, snapshot, DatabaseName)
	}
	for _, file := range collected {
		if writeErr != nil {
			break
		}
		writeErr = writeFileEntry(tw, file.snapshot, file.Name)
	}
	if writeErr == nil {
		writeErr = tw.Close()
	} else {
		_ = tw.Close()
	}
	if closeErr := gz.Close(); writeErr == nil {
		writeErr = closeErr
	}
	if closeErr := archive.Close(); writeErr == nil {
		writeErr = closeErr
	}
	if writeErr != nil {
		_ = os.Remove(tmpArchive)
		return Result{}, fmt.Errorf("backup: write %q: %w", tmpArchive, writeErr)
	}
	if err := os.Rename(tmpArchive, outAbs); err != nil {
		_ = os.Remove(tmpArchive)
		return Result{}, fmt.Errorf("backup: move into place: %w", err)
	}
	stat, err := os.Stat(outAbs)
	if err != nil {
		return Result{}, fmt.Errorf("backup: %w", err)
	}
	return Result{
		Path:     outAbs,
		SHA256:   hex.EncodeToString(hasher.Sum(nil)),
		Size:     stat.Size(),
		Manifest: manifest,
		Summary:  summary,
	}, nil
}

// collectedFile is one regular file of the data directory together with its
// private copy. The copy is what the manifest describes and what goes into the
// archive, so the two can never disagree even while the source grows.
type collectedFile struct {
	File
	snapshot string
}

// collectFiles copies every regular file of dataDir into snapshotDir and
// returns the copies with their size and digest. snapshotDir must be outside
// dataDir; Create puts it in its own temporary directory.
func collectFiles(dataDir, outPath, snapshotDir string) ([]collectedFile, error) {
	var files []collectedFile
	err := filepath.WalkDir(dataDir, func(p string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if p == dataDir {
			return nil
		}
		rel, err := filepath.Rel(dataDir, p)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(rel)
		if name == DatabaseName || name == DatabaseName+"-wal" || name == DatabaseName+"-shm" {
			return nil
		}
		if p == outPath || p == outPath+".tmp" {
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("backup: %q is a symlink; RosTalk never creates one in the data directory, refusing to follow it", p)
		}
		if !entry.Type().IsRegular() {
			// The admin socket is a Unix socket in the data directory, and a
			// crashed process can leave other non-regular entries. They carry
			// no state.
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		snapshot := filepath.Join(snapshotDir, strconv.Itoa(len(files)))
		size, digest, err := snapshotFile(p, snapshot)
		if err != nil {
			return err
		}
		files = append(files, collectedFile{
			File: File{
				Name:   name,
				Size:   size,
				SHA256: digest,
				Mode:   uint32(info.Mode().Perm()),
			},
			snapshot: snapshot,
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	return files, nil
}

// snapshotFile copies one live file and returns the size and digest of the
// bytes actually copied. Reading to EOF once is the snapshot: whatever the
// server appends afterwards stays out of the copy and out of the manifest.
func snapshotFile(source, dest string) (int64, string, error) {
	in, err := os.Open(source)
	if err != nil {
		return 0, "", fmt.Errorf("backup: open %q: %w", source, err)
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, "", fmt.Errorf("backup: create the snapshot of %q: %w", source, err)
	}
	h := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(out, h), in)
	if closeErr := out.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return 0, "", fmt.Errorf("backup: copy %q: %w", source, copyErr)
	}
	return written, hex.EncodeToString(h.Sum(nil)), nil
}

func hashFile(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", fmt.Errorf("backup: open %q: %w", p, err)
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("backup: hash %q: %w", p, err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func writeManifest(tw *tar.Writer, manifest Manifest) error {
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode the manifest: %w", err)
	}
	data = append(data, '\n')
	header := &tar.Header{
		Name:     ManifestName,
		Mode:     0o600,
		Size:     int64(len(data)),
		ModTime:  manifest.CreatedAt,
		Typeflag: tar.TypeReg,
	}
	if err := tw.WriteHeader(header); err != nil {
		return err
	}
	_, err = tw.Write(data)
	return err
}

func writeFileEntry(tw *tar.Writer, source, name string) error {
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	header := &tar.Header{
		Name:     name,
		Mode:     int64(info.Mode().Perm()),
		Size:     info.Size(),
		ModTime:  info.ModTime().UTC(),
		Typeflag: tar.TypeReg,
	}
	if err := tw.WriteHeader(header); err != nil {
		return err
	}
	f, err := os.Open(source)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	_, err = io.Copy(tw, f)
	return err
}

// RestoreOptions configures Restore.
type RestoreOptions struct {
	Archive string
	DataDir string
	// Force replaces a non-empty data directory. The old directory is kept
	// next to it as <data>.pre-restore-<timestamp> when the filesystem allows a
	// rename; otherwise its contents are removed.
	Force bool
	// Owner, "user" or "user:group", gives the restored tree to the service
	// user when the data directory did not exist yet (restore on a fresh
	// machine). Empty means "keep the owner of the existing directory".
	Owner string
}

// Restore extracts archive into DataDir after verifying every hash. It refuses
// symlinks, absolute paths and names that are not listed in the manifest.
func Restore(ctx context.Context, opts RestoreOptions) (Result, error) {
	if opts.Archive == "" || opts.DataDir == "" {
		return Result{}, errors.New("restore: an archive and a data directory are required")
	}
	archivePath, err := filepath.Abs(opts.Archive)
	if err != nil {
		return Result{}, fmt.Errorf("restore: resolve the archive: %w", err)
	}
	dataDir, err := filepath.Abs(opts.DataDir)
	if err != nil {
		return Result{}, fmt.Errorf("restore: resolve the data directory: %w", err)
	}
	parent := filepath.Dir(dataDir)
	if err := os.MkdirAll(parent, 0o750); err != nil {
		return Result{}, fmt.Errorf("restore: create %q: %w", parent, err)
	}

	existing := false
	var existingMode os.FileMode
	var ownerUID, ownerGID int
	if opts.Owner != "" {
		uid, gid, err := lookupOwner(opts.Owner)
		if err != nil {
			return Result{}, err
		}
		ownerUID, ownerGID = uid, gid
	}
	if info, statErr := os.Stat(dataDir); statErr == nil {
		if !info.IsDir() {
			return Result{}, fmt.Errorf("restore: %q is not a directory", dataDir)
		}
		nonEmpty, err := dirHasEntries(dataDir)
		if err != nil {
			return Result{}, err
		}
		if nonEmpty && !opts.Force {
			return Result{}, fmt.Errorf("restore: %q is not empty; stop the server and pass --force to replace it", dataDir)
		}
		existing = true
		existingMode = info.Mode().Perm()
		if opts.Owner == "" {
			ownerUID, ownerGID = fileOwner(info)
		}
	}

	tmpDir, err := os.MkdirTemp(parent, "."+filepath.Base(dataDir)+".restore-*")
	if err != nil {
		return Result{}, fmt.Errorf("restore: create a temporary directory: %w", err)
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.RemoveAll(tmpDir)
		}
	}()

	manifest, err := extract(archivePath, tmpDir)
	if err != nil {
		return Result{}, err
	}
	dbPath := filepath.Join(tmpDir, DatabaseName)
	if err := store.CheckIntegrity(ctx, dbPath); err != nil {
		return Result{}, fmt.Errorf("restore: the archived database is damaged: %w", err)
	}
	summary, err := store.Summarize(ctx, dbPath)
	if err != nil {
		return Result{}, err
	}

	result := Result{
		Path:     dataDir,
		SHA256:   "",
		Manifest: manifest,
		Summary:  summary,
	}
	if digest, err := hashFile(archivePath); err == nil {
		result.SHA256 = digest
	}

	if existing {
		previous, err := replaceDirectory(dataDir, tmpDir, opts.Force)
		if err != nil {
			return Result{}, err
		}
		result.PreviousDir = previous
	} else if err := os.Rename(tmpDir, dataDir); err != nil {
		return Result{}, fmt.Errorf("restore: move the restored data into %q: %w", dataDir, err)
	}
	cleanup = false

	mode := existingMode
	if mode == 0 {
		mode = 0o750
	}
	_ = os.Chmod(dataDir, mode)
	if runtime.GOOS != "windows" && (ownerUID != 0 || ownerGID != 0) {
		if err := chownTree(dataDir, ownerUID, ownerGID); err != nil {
			return result, fmt.Errorf("restore: files restored, but giving them back to the data directory owner failed: %w", err)
		}
	}
	return result, nil
}

// replaceDirectory puts the content of tmpDir at dataDir. The clean way is a
// rename of the whole directory; on a mount point (the /data volume in Docker)
// that fails with EBUSY, so the content is moved instead after the old content
// is removed. It returns where the old directory was kept, if anywhere.
func replaceDirectory(dataDir, tmpDir string, force bool) (string, error) {
	previous := fmt.Sprintf("%s.pre-restore-%s", dataDir, time.Now().UTC().Format("20060102-150405"))
	if force {
		if err := os.Rename(dataDir, previous); err == nil {
			if err := os.Rename(tmpDir, dataDir); err != nil {
				_ = os.Rename(previous, dataDir)
				return "", fmt.Errorf("restore: move the restored data into %q: %w", dataDir, err)
			}
			return previous, nil
		}
		if err := removeContents(dataDir); err != nil {
			return "", err
		}
	}
	if err := moveContents(tmpDir, dataDir); err != nil {
		return "", err
	}
	_ = os.Remove(tmpDir)
	return "", nil
}

func removeContents(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("restore: read %q: %w", dir, err)
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
			return fmt.Errorf("restore: clear %q: %w", dir, err)
		}
	}
	return nil
}

func moveContents(from, to string) error {
	entries, err := os.ReadDir(from)
	if err != nil {
		return fmt.Errorf("restore: read %q: %w", from, err)
	}
	for _, entry := range entries {
		source := filepath.Join(from, entry.Name())
		target := filepath.Join(to, entry.Name())
		if err := os.Rename(source, target); err != nil {
			return fmt.Errorf("restore: move %q into place: %w", source, err)
		}
	}
	return nil
}

func dirHasEntries(dir string) (bool, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false, fmt.Errorf("restore: read %q: %w", dir, err)
	}
	return len(entries) > 0, nil
}

func extract(archivePath, dest string) (Manifest, error) {
	f, err := os.Open(archivePath)
	if err != nil {
		return Manifest{}, fmt.Errorf("restore: open %q: %w", archivePath, err)
	}
	defer func() { _ = f.Close() }()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return Manifest{}, fmt.Errorf("restore: %q is not a gzip archive: %w", archivePath, err)
	}
	defer func() { _ = gz.Close() }()
	tr := tar.NewReader(gz)

	manifest, err := readManifest(tr)
	if err != nil {
		return Manifest{}, err
	}
	allowed := make(map[string]File, len(manifest.Files)+1)
	for _, file := range manifest.Files {
		allowed[file.Name] = file
	}
	// Archives made before the rename carry the database as hearth.db.
	dbEntry := DatabaseName
	if manifest.Database == LegacyDatabaseName {
		dbEntry = LegacyDatabaseName
	}
	allowed[dbEntry] = File{Name: dbEntry}
	// The database has no manifest entry, so its size/hash are not known up
	// front; cap it by the global limit.

	var total int64
	seen := make(map[string]bool, len(allowed))
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return Manifest{}, fmt.Errorf("restore: read the archive: %w", err)
		}
		name := header.Name
		if name == ManifestName {
			continue
		}
		if header.Typeflag != tar.TypeReg {
			return Manifest{}, fmt.Errorf("restore: %q is not a regular file; refusing to extract it", name)
		}
		if !filepath.IsLocal(filepath.FromSlash(name)) {
			return Manifest{}, fmt.Errorf("restore: unsafe path %q in the archive", name)
		}
		expected, ok := allowed[name]
		if !ok {
			return Manifest{}, fmt.Errorf("restore: %q is not listed in the manifest", name)
		}
		if header.Size < 0 || header.Size > maxRestoreBytes {
			return Manifest{}, fmt.Errorf("restore: %q is too large", name)
		}
		total += header.Size
		if total > maxRestoreBytes {
			return Manifest{}, errors.New("restore: the archive expands beyond the size limit")
		}
		if seen[name] {
			return Manifest{}, fmt.Errorf("restore: %q appears twice in the archive", name)
		}
		seen[name] = true

		target := filepath.Join(dest, filepath.FromSlash(name))
		modeName := name
		if name == dbEntry {
			target = filepath.Join(dest, DatabaseName)
			modeName = DatabaseName
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
			return Manifest{}, fmt.Errorf("restore: create %q: %w", filepath.Dir(target), err)
		}
		mode := restoredMode(modeName, expected.Mode)
		mode &^= os.ModeSetuid | os.ModeSetgid | os.ModeSticky
		out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
		if err != nil {
			return Manifest{}, fmt.Errorf("restore: create %q: %w", target, err)
		}
		h := sha256.New()
		written, copyErr := io.Copy(io.MultiWriter(out, h), tr)
		if closeErr := out.Close(); copyErr == nil {
			copyErr = closeErr
		}
		if copyErr != nil {
			return Manifest{}, fmt.Errorf("restore: write %q: %w", target, copyErr)
		}
		if written != header.Size {
			return Manifest{}, fmt.Errorf("restore: %q is truncated", name)
		}
		if name == dbEntry {
			continue
		}
		digest := hex.EncodeToString(h.Sum(nil))
		if expected.SHA256 != "" && digest != expected.SHA256 {
			return Manifest{}, fmt.Errorf("restore: checksum mismatch for %q", name)
		}
		if expected.Size != 0 && written != expected.Size {
			return Manifest{}, fmt.Errorf("restore: size mismatch for %q", name)
		}
	}
	if !seen[dbEntry] {
		return Manifest{}, fmt.Errorf("restore: the archive has no %s", dbEntry)
	}
	for _, file := range manifest.Files {
		if !seen[file.Name] {
			return Manifest{}, fmt.Errorf("restore: the archive is missing %q", file.Name)
		}
	}
	return manifest, nil
}

// restoredMode keeps private material private even if the archive (for example
// one made before an operator fixed the source directory) records a loose
// mode. The archive is trusted for content, not for file permissions: a world
// readable identity key would let any local user impersonate the server.
func restoredMode(name string, recorded uint32) fs.FileMode {
	mode := fs.FileMode(recorded & 0o777)
	switch {
	case name == DatabaseName,
		name == "identity.key",
		name == "ca.key",
		name == "server.key",
		name == "admin-invite":
		return 0o600
	case strings.HasPrefix(name, "files/"):
		// Attachments are private to the conversations that reference them.
		return 0o600
	}
	if mode == 0 {
		mode = 0o600
	}
	return mode
}

func readManifest(tr *tar.Reader) (Manifest, error) {
	header, err := tr.Next()
	if errors.Is(err, io.EOF) {
		return Manifest{}, errors.New("restore: the archive is empty")
	}
	if err != nil {
		return Manifest{}, fmt.Errorf("restore: read the archive: %w", err)
	}
	if header.Name != ManifestName {
		return Manifest{}, fmt.Errorf("restore: the first entry is %q, not %s", header.Name, ManifestName)
	}
	if header.Size < 0 || header.Size > 1<<20 {
		return Manifest{}, errors.New("restore: the manifest is too large")
	}
	data, err := io.ReadAll(io.LimitReader(tr, 1<<20))
	if err != nil {
		return Manifest{}, fmt.Errorf("restore: read the manifest: %w", err)
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("restore: decode the manifest: %w", err)
	}
	if manifest.Format > Format {
		return Manifest{}, fmt.Errorf("restore: the archive format %d is newer than this build supports (%d); update rostalk-server first", manifest.Format, Format)
	}
	if manifest.Format < 1 {
		return Manifest{}, errors.New("restore: the archive has no format version")
	}
	return manifest, nil
}

func fileOwner(info fs.FileInfo) (int, int) {
	return dataDirOwner(info)
}

func chownTree(root string, uid, gid int) error {
	return filepath.WalkDir(root, func(p string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := os.Lchown(p, uid, gid); err != nil {
			return err
		}
		return nil
	})
}
