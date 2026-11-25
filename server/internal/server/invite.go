package server

import (
	"context"
	"errors"
	"fmt"
	"net"
	"path/filepath"

	"github.com/v4dikos1/RosTalk/server/internal/legacy"
	"github.com/v4dikos1/RosTalk/server/internal/netutil"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

// InviteDefaults used by the `rostalk-server invite` command.
const (
	DefaultInviteMaxUses = 1
)

// CreateInvite creates an invite in an existing data directory and returns a
// join link for it. It opens the same database as a running server (WAL allows
// both processes) and rebuilds the link with the same host rules, so the
// operator can add users without stopping the server.
//
// This is the operator entry point of stage 1.4: the control-plane admin API
// that manages invites arrives with moderation in stage 3.x.
func CreateInvite(ctx context.Context, cfg Config, opts store.InviteOptions) (string, error) {
	if cfg.DataDir == "" {
		return "", errors.New("data directory must not be empty")
	}

	if _, err := legacy.AdoptDataDir(cfg.DataDir); err != nil {
		return "", fmt.Errorf("adopt the pre-rename data directory: %w", err)
	}
	st, err := store.Open(filepath.Join(cfg.DataDir, legacy.DatabaseName))
	if err != nil {
		return "", err
	}
	defer func() { _ = st.Close() }()

	token, err := st.CreateInvite(ctx, opts)
	if err != nil {
		return "", err
	}
	return LinkForToken(cfg, token)
}

// LinkForToken builds the join link for an existing invite token. It never
// creates an invite and never touches the network: install.sh uses it to show
// the pending administrator link without parsing the journal.
//
// In domain mode the link has no fp parameter: the client validates the
// Let's Encrypt certificate through Web PKI (design 4.3). Without a domain the
// link carries the fingerprint of the existing certificate so the client can
// pin it (ADR 0001).
func LinkForToken(cfg Config, token string) (string, error) {
	if cfg.DataDir == "" {
		return "", errors.New("data directory must not be empty")
	}
	if token == "" {
		return "", errors.New("invite token must not be empty")
	}
	listenHost, listenPort, err := net.SplitHostPort(cfg.Listen)
	if err != nil {
		return "", fmt.Errorf("invalid listen address %q: %w", cfg.Listen, err)
	}
	publicHost, err := resolvePublicHost(cfg)
	if err != nil {
		return "", err
	}

	host := publicHost
	if listenPort != "" && listenPort != "0" {
		if _, _, splitErr := net.SplitHostPort(host); splitErr != nil {
			host = net.JoinHostPort(host, listenPort)
		}
	}

	if cfg.Domain != "" {
		return JoinLink(host, "", token), nil
	}

	// Use the material that already exists: a link printed by an invite command
	// must point at the certificate the running server presents.
	tlsMaterial, err := netutil.LoadOrCreateTLS(cfg.DataDir, []string{publicHost, listenHost, cfg.AdvertiseIP})
	if err != nil {
		return "", err
	}
	return JoinLink(host, tlsMaterial.FingerprintHex, token), nil
}
