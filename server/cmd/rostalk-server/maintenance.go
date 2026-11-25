package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/backup"
	"github.com/v4dikos1/RosTalk/server/internal/version"
)

// runBackup writes the single archive described in docs/INSTALL.md: database
// snapshot, keys, ACME state and settings.
func runBackup(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("backup", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dataDir := fs.String("data", envString("ROSTALK_DATA", "./data"), "server data directory (ROSTALK_DATA)")
	out := fs.String("out", "", "archive path (default rostalk-backup-<UTC>.tar.gz in the current directory)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}

	result, err := backup.Create(context.Background(), backup.CreateOptions{
		DataDir: *dataDir,
		OutPath: *out,
		Version: version.String(),
	})
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "%s\n", result.Path)
	_, _ = fmt.Fprintf(stdout, "size: %d bytes\nsha256: %s\n", result.Size, result.SHA256)
	_, _ = fmt.Fprintf(stdout, "users: %d, channels: %d, roles: %d\n",
		result.Summary.Users, result.Summary.Channels, result.Summary.Roles)
	_, _ = fmt.Fprintln(stdout, "store this archive somewhere safe: it contains the server keys and the database")
	return nil
}

// runRestore replaces a data directory with an archive after verifying every
// file hash and the SQLite integrity check.
func runRestore(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	fs.SetOutput(stderr)
	archive := fs.String("archive", "", "archive written by `rostalk-server backup` (required)")
	dataDir := fs.String("data", envString("ROSTALK_DATA", "./data"), "target data directory (ROSTALK_DATA)")
	force := fs.Bool("force", false, "replace a non-empty data directory (stop the server first)")
	owner := fs.String("owner", envString("ROSTALK_OWNER", ""), "give the restored files to user[:group], e.g. rostalk:rostalk (fresh machine)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if *archive == "" && fs.NArg() == 1 {
		*archive = fs.Arg(0)
	} else if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if *archive == "" {
		return errors.New("restore needs --archive")
	}
	if running, socket := adminSocketRunning(*dataDir); running {
		return fmt.Errorf("restore: the server is running (%s); stop it first (systemctl stop rostalk-server)", socket)
	}

	result, err := backup.Restore(context.Background(), backup.RestoreOptions{
		Archive: *archive,
		DataDir: *dataDir,
		Force:   *force,
		Owner:   *owner,
	})
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "restored %s into %s\n", *archive, result.Path)
	if result.SHA256 != "" {
		_, _ = fmt.Fprintf(stdout, "archive sha256: %s\n", result.SHA256)
	}
	_, _ = fmt.Fprintf(stdout, "archive: format %d, version %s, created %s\n",
		result.Manifest.Format, result.Manifest.Version, result.Manifest.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"))
	_, _ = fmt.Fprintf(stdout, "users: %d, channels: %d, roles: %d\n",
		result.Summary.Users, result.Summary.Channels, result.Summary.Roles)
	if result.PreviousDir != "" {
		_, _ = fmt.Fprintf(stdout, "the previous data directory is kept at %s\n", result.PreviousDir)
	}
	_, _ = fmt.Fprintln(stdout, "start the server, then check the join link with `rostalk-server link` (admin invite) or `rostalk-server invite`")
	return nil
}

// adminSocketRunning reports whether a live admin socket answers. A stale
// socket file exists after an unclean stop, so a failed dial means "not
// running", not "unsafe to restore".
func adminSocketRunning(dataDir string) (bool, string) {
	socket := filepath.Join(dataDir, "rostalk-admin.sock")
	if _, err := os.Stat(socket); err != nil {
		return false, socket
	}
	conn, err := net.DialTimeout("unix", socket, 500*time.Millisecond)
	if err != nil {
		return false, socket
	}
	_ = conn.Close()
	return true, socket
}
