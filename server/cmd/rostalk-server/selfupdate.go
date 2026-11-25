package main

import (
	"context"
	"crypto/ed25519"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/v4dikos1/RosTalk/server/internal/release"
	"github.com/v4dikos1/RosTalk/server/internal/update"
	"github.com/v4dikos1/RosTalk/server/internal/version"
)

func runUpdate(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(stderr)
	releaseURL := fs.String("release-url", envString("ROSTALK_RELEASE_URL", ""),
		"directory with SHA256SUMS, SHA256SUMS.sig and the binaries (ROSTALK_RELEASE_URL)")
	pubkey := fs.String("pubkey", envString("ROSTALK_RELEASE_PUBKEY", ""),
		"release public key (PEM file or base64 DER); default: the key embedded in this build")
	checkOnly := fs.Bool("check", false, "only report whether a newer release exists")
	binaryPath := fs.String("binary", "", "binary to replace (default: the running executable)")
	restart := fs.Bool("restart", false, "run `systemctl restart rostalk-server` after a successful update")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if *releaseURL == "" {
		return errors.New("update needs --release-url (or ROSTALK_RELEASE_URL): this project has no default download server")
	}

	publicKey, err := resolveReleaseKey(*pubkey)
	if err != nil {
		return err
	}
	client := &update.Client{
		BaseURL:        *releaseURL,
		PublicKey:      publicKey,
		CurrentVersion: version.Version,
		GOOS:           "linux",
	}
	if *checkOnly {
		remote, err := client.Check(context.Background())
		if err != nil {
			return err
		}
		if remote.Version == version.Version {
			_, _ = fmt.Fprintf(stdout, "up to date: %s\n", version.Version)
		} else {
			_, _ = fmt.Fprintf(stdout, "update available: %s (current %s, asset %s)\n",
				remote.Version, version.Version, remote.AssetName)
		}
		return nil
	}

	target := *binaryPath
	if target == "" {
		target, err = os.Executable()
		if err != nil {
			return fmt.Errorf("update: locate the running executable: %w", err)
		}
	}
	remote, err := client.Apply(context.Background(), target)
	if err != nil {
		return err
	}
	if remote.Version == version.Version {
		_, _ = fmt.Fprintf(stdout, "already at %s; nothing downloaded\n", version.Version)
	} else {
		_, _ = fmt.Fprintf(stdout, "updated %s: %s -> %s\n", target, version.Version, remote.Version)
	}
	if *restart {
		if err := restartService(); err != nil {
			return err
		}
		_, _ = fmt.Fprintln(stdout, "service restarted")
	} else {
		_, _ = fmt.Fprintln(stdout, "restart the service to run the new binary: systemctl restart rostalk-server")
	}
	return nil
}

// resolveReleaseKey loads --pubkey (a file or a pasted key) or falls back to
// the key this binary was built with.
func resolveReleaseKey(value string) (ed25519.PublicKey, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		pub, err := release.EmbeddedPublicKey()
		if err != nil {
			return nil, fmt.Errorf("%w; pass --pubkey with the release key from docs/INSTALL.md", err)
		}
		return pub, nil
	}
	if data, err := os.ReadFile(value); err == nil {
		return release.ParsePublicKeyPEM(data)
	}
	// Not a readable file: accept base64 DER or an inline PEM block.
	return release.ParsePublicKeyPEM([]byte(value))
}

func restartService() error {
	path, err := exec.LookPath("systemctl")
	if err != nil {
		return errors.New("update: systemctl is not available; restart the server yourself")
	}
	out, err := exec.Command(path, "restart", "rostalk-server").CombinedOutput()
	if err != nil {
		return fmt.Errorf("update: systemctl restart rostalk-server failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
