package server

import (
	"net/url"
	"regexp"
	"strings"
	"testing"
)

func TestLinkForTokenInDomainModeHasNoFingerprint(t *testing.T) {
	link, err := LinkForToken(Config{
		DataDir: t.TempDir(),
		Listen:  ":7443",
		Domain:  "rostalk.example.test",
	}, "token-123")
	if err != nil {
		t.Fatalf("LinkForToken: %v", err)
	}
	u, err := url.Parse(link)
	if err != nil {
		t.Fatalf("parse %q: %v", link, err)
	}
	q := u.Query()
	if q.Get("host") != "rostalk.example.test:7443" {
		t.Fatalf("host = %q", q.Get("host"))
	}
	if q.Get("invite") != "token-123" {
		t.Fatalf("invite = %q", q.Get("invite"))
	}
	if q.Has("fp") {
		t.Fatalf("domain link still carries fp: %s", link)
	}
}

func TestLinkForTokenWithoutDomainPinsTheFingerprint(t *testing.T) {
	dataDir := t.TempDir()
	link, err := LinkForToken(Config{
		DataDir:    dataDir,
		Listen:     ":7443",
		PublicHost: "192.0.2.10",
	}, "token-456")
	if err != nil {
		t.Fatalf("LinkForToken: %v", err)
	}
	u, err := url.Parse(link)
	if err != nil {
		t.Fatalf("parse %q: %v", link, err)
	}
	q := u.Query()
	if q.Get("host") != "192.0.2.10:7443" {
		t.Fatalf("host = %q", q.Get("host"))
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(q.Get("fp")) {
		t.Fatalf("fp is not a sha256 hex: %q", q.Get("fp"))
	}
	if strings.Contains(link, "localhost") {
		t.Fatalf("link uses localhost: %s", link)
	}
}

func TestLinkForTokenRejectsEmptyInput(t *testing.T) {
	if _, err := LinkForToken(Config{DataDir: t.TempDir(), Listen: ":7443"}, ""); err == nil {
		t.Fatal("an empty invite token was accepted")
	}
	if _, err := LinkForToken(Config{Listen: ":7443"}, "token"); err == nil {
		t.Fatal("an empty data directory was accepted")
	}
}
