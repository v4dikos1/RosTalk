package main

import (
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/netutil"
	"github.com/v4dikos1/RosTalk/server/internal/release"
	"github.com/v4dikos1/RosTalk/server/internal/server"
	"github.com/v4dikos1/RosTalk/server/internal/version"
)

// printVersion prints the build identity and the release key this binary
// trusts. Comparing the fingerprint with docs/INSTALL.md tells an operator
// whether an update source is even usable by this build.
func printVersion(stdout io.Writer) {
	_, _ = fmt.Fprintf(stdout, "rostalk-server %s\n", version.String())
	if pub, err := release.EmbeddedPublicKey(); err == nil {
		_, _ = fmt.Fprintf(stdout, "release key: %s (sha256 %s)\n",
			release.PublicKeyBase64, release.PublicKeyFingerprint(pub))
		return
	}
	_, _ = fmt.Fprintln(stdout, "release key: none (local build; `update` needs --pubkey)")
}

// runLink prints the join link for a pending administrator invite without
// starting the server. deploy/install.sh uses it after the first start instead
// of scraping the journal, which keeps the token out of the logs.
func runLink(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("link", flag.ContinueOnError)
	fs.SetOutput(stderr)
	cfg := server.Config{}
	fs.StringVar(&cfg.DataDir, "data", envString("ROSTALK_DATA", "./data"), "server data directory (ROSTALK_DATA)")
	fs.StringVar(&cfg.Listen, "listen", envString("ROSTALK_LISTEN", ":7443"), "listen address used for the link port (ROSTALK_LISTEN)")
	fs.StringVar(&cfg.PublicHost, "public-host", envString("ROSTALK_PUBLIC_HOST", ""), "host clients connect to (ROSTALK_PUBLIC_HOST)")
	fs.StringVar(&cfg.AdvertiseIP, "advertise-ip", envString("ROSTALK_ADVERTISE_IP", ""), "fallback host (ROSTALK_ADVERTISE_IP)")
	fs.StringVar(&cfg.Domain, "domain", envString("ROSTALK_DOMAIN", ""), "domain mode: the link has no fp (ROSTALK_DOMAIN)")
	token := fs.String("invite", "", "invite token; default: the pending administrator invite")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}

	tokenValue := strings.TrimSpace(*token)
	if tokenValue == "" {
		data, err := os.ReadFile(filepath.Join(cfg.DataDir, server.AdminInviteFile))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return errors.New("no pending administrator invite: an administrator already exists (use `rostalk-server invite` for a normal invite)")
			}
			return fmt.Errorf("read the pending administrator invite: %w", err)
		}
		tokenValue = strings.TrimSpace(string(data))
	}
	if tokenValue == "" {
		return errors.New("the pending administrator invite is empty")
	}
	link, err := server.LinkForToken(cfg, tokenValue)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintln(stdout, link)
	return nil
}

// runHealthcheck probes /healthz through TLS and exits non-zero on failure. It
// is the Docker HEALTHCHECK and a quick smoke test for install.sh: it verifies
// the server's CA instead of skipping certificate checks.
func runHealthcheck(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("healthcheck", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dataDir := fs.String("data", envString("ROSTALK_DATA", "./data"), "server data directory (ROSTALK_DATA)")
	url := fs.String("url", "", "health endpoint (default https://127.0.0.1:7443/healthz, or the domain)")
	domain := fs.String("domain", envString("ROSTALK_DOMAIN", ""), "domain mode: probe https://<domain>:7443/healthz (ROSTALK_DOMAIN)")
	timeout := fs.Duration("timeout", 5*time.Second, "request timeout")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	endpoint := *url
	if endpoint == "" {
		if *domain != "" {
			endpoint = "https://" + strings.TrimSpace(*domain) + ":7443/healthz"
		} else {
			endpoint = "https://127.0.0.1:7443/healthz"
		}
	}

	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	// Fingerprint mode: trust the CA the server generated. Domain mode has no
	// CA in the data directory; fall back to the system trust store.
	if material, err := netutil.LoadTLS(*dataDir); err == nil {
		tlsConfig.RootCAs = material.CAPool()
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("healthcheck: read TLS material from %s: %w", *dataDir, err)
	}

	client := &http.Client{
		Timeout: *timeout,
		Transport: &http.Transport{
			TLSClientConfig: tlsConfig,
		},
	}
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return fmt.Errorf("healthcheck: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("healthcheck: %s is not answering: %w", endpoint, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthcheck: %s returned %s", endpoint, resp.Status)
	}
	_, _ = fmt.Fprintln(stdout, "ok")
	return nil
}
