package server

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/v4dikos1/RosTalk/server/internal/secret"
)

func TestJoinLink(t *testing.T) {
	got := JoinLink("192.168.1.10:7443", "abc", "token")
	want := "rostalk://join?host=192.168.1.10:7443&fp=abc&invite=token"
	if got != want {
		t.Fatalf("JoinLink = %q, want %q", got, want)
	}

	// Domain mode: Web PKI replaces the pinned fingerprint.
	got = JoinLink("rostalk.example.test:7443", "", "token")
	want = "rostalk://join?host=rostalk.example.test:7443&invite=token"
	if got != want {
		t.Fatalf("JoinLink without fp = %q, want %q", got, want)
	}
}

func TestResolvePublicHost(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
		want string
	}{
		{
			name: "explicit host with port",
			cfg:  Config{Listen: ":7443", PublicHost: "192.168.1.10:7443"},
			want: "192.168.1.10:7443",
		},
		{
			name: "advertise fallback",
			cfg:  Config{Listen: ":7443", AdvertiseIP: "10.0.0.5"},
			want: "10.0.0.5",
		},
		{
			name: "explicit listen address",
			cfg:  Config{Listen: "127.0.0.1:7443"},
			want: "127.0.0.1",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolvePublicHost(tc.cfg)
			if err != nil {
				t.Fatalf("resolvePublicHost: %v", err)
			}
			if got != tc.want {
				t.Fatalf("resolvePublicHost = %q, want %q", got, tc.want)
			}
		})
	}

	bad := []Config{
		{Listen: ":7443", PublicHost: "https://192.168.1.10"},
		{Listen: ":7443", PublicHost: "0.0.0.0"},
		{Listen: ":7443", PublicHost: "bad host"},
	}
	for _, cfg := range bad {
		if _, err := resolvePublicHost(cfg); err == nil {
			t.Errorf("resolvePublicHost(%+v) succeeded", cfg)
		}
	}
}

func TestNewAcceptsDomainModeWithoutCreatingFingerprintMaterial(t *testing.T) {
	dataDir := t.TempDir()
	app, err := New(Config{
		DataDir: dataDir,
		Listen:  "127.0.0.1:7443",
		Domain:  "rostalk.example.test",
	})
	if err != nil {
		t.Fatalf("New with --domain: %v", err)
	}
	defer func() { _ = app.Store.Close() }()
	if app.ACME == nil {
		t.Fatal("domain mode did not create an ACME manager")
	}
	if app.TLS != nil {
		t.Fatal("domain mode created the fingerprint certificate before Start")
	}
	if _, err := os.Stat(filepath.Join(dataDir, "server.crt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("domain mode wrote server.crt: %v", err)
	}
}

func TestNewRejectsBadLoginSettings(t *testing.T) {
	cases := map[string]Config{
		"unknown mode": {LoginMode: "sometimes"},
		"password with invite": {
			LoginMode:      "invite",
			ServerPassword: "secret",
		},
	}
	for name, cfg := range cases {
		t.Run(name, func(t *testing.T) {
			cfg.DataDir = t.TempDir()
			cfg.Listen = "127.0.0.1:7443"
			_, err := New(cfg)
			if err == nil {
				t.Fatalf("New(%+v) succeeded", cfg)
			}
			if strings.Contains(err.Error(), "secret") {
				t.Fatal("the server password must never appear in an error")
			}
		})
	}
}

func TestApplyLoginOverridesHashesThePassword(t *testing.T) {
	ctx := context.Background()
	app, err := New(Config{
		DataDir:        t.TempDir(),
		Listen:         "127.0.0.1:7443",
		LoginMode:      "password",
		ServerPassword: "correct horse battery staple",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = app.Store.Close() })
	if err := app.applyLoginOverrides(ctx); err != nil {
		t.Fatalf("applyLoginOverrides: %v", err)
	}
	settings, err := app.Store.Settings(ctx)
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if settings.LoginMode != "password" {
		t.Fatalf("login mode = %q, want password", settings.LoginMode)
	}
	if settings.ServerPassword == "" {
		t.Fatal("the password hash was not stored")
	}
	if settings.ServerPassword == "correct horse battery staple" {
		t.Fatal("the password was stored in clear text")
	}
	if !secret.VerifyPassword(settings.ServerPassword, "correct horse battery staple") {
		t.Fatal("the stored hash does not verify the password")
	}
}

func TestLinkHostAppendsListenPort(t *testing.T) {
	app := &App{
		publicHost: "192.168.1.10",
		addr:       &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 7443},
	}
	if got := app.linkHost(); got != "192.168.1.10:7443" {
		t.Fatalf("linkHost = %q, want 192.168.1.10:7443", got)
	}

	app.publicHost = "192.168.1.10:9000"
	if got := app.linkHost(); got != "192.168.1.10:9000" {
		t.Fatalf("linkHost with explicit port = %q", got)
	}

	app.publicHost = "::1"
	if got := app.linkHost(); !strings.HasPrefix(got, "[::1]:") {
		t.Fatalf("linkHost with IPv6 = %q", got)
	}
}
