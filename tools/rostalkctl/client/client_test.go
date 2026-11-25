package client

import (
	"crypto/ed25519"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseLink(t *testing.T) {
	fp := strings.Repeat("ab", 32)
	raw := "rostalk://join?host=192.168.1.10:7443&fp=" + fp + "&invite=token123"
	link, err := ParseLink(raw)
	if err != nil {
		t.Fatalf("ParseLink: %v", err)
	}
	if link.Host != "192.168.1.10:7443" || link.Fingerprint != fp || link.Invite != "token123" {
		t.Fatalf("unexpected link: %+v", link)
	}
	if link.WSURL() != "wss://192.168.1.10:7443/ws" {
		t.Fatalf("WSURL = %q", link.WSURL())
	}
	if link.Hostname() != "192.168.1.10" {
		t.Fatalf("Hostname = %q", link.Hostname())
	}
	if link.String() != raw {
		t.Fatalf("String = %q, want %q", link.String(), raw)
	}
}

func TestParseLinkRejectsBadInput(t *testing.T) {
	fp := strings.Repeat("0", 64)
	cases := []string{
		"https://example.test/join?host=x&fp=" + fp + "&invite=x",
		"rostalk://join?fp=" + fp + "&invite=x",
		"rostalk://join?host=example.test&invite=x",
		"rostalk://join?host=example.test&fp=xyz&invite=x",
		"rostalk://join?host=example.test&fp=" + fp,
		"rostalk://notjoin?host=example.test&fp=" + fp + "&invite=x",
		"rostalk://join?host=bad host&fp=" + fp + "&invite=x",
	}
	for _, raw := range cases {
		if _, err := ParseLink(raw); err == nil {
			t.Errorf("ParseLink(%q) succeeded", raw)
		}
	}
}

func TestIdentityCreateLoadSign(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "identity.key")
	id, err := NewIdentity(path, false)
	if err != nil {
		t.Fatalf("NewIdentity: %v", err)
	}
	if len(id.Public) != ed25519.PublicKeySize {
		t.Fatalf("public key is %d bytes", len(id.Public))
	}
	if len(id.Fingerprint()) != 64 {
		t.Fatalf("fingerprint = %q", id.Fingerprint())
	}

	loaded, err := LoadIdentity(path)
	if err != nil {
		t.Fatalf("LoadIdentity: %v", err)
	}
	if !loaded.Public.Equal(id.Public) {
		t.Fatal("loaded public key differs")
	}

	msg := []byte("hello")
	sig := id.Sign(msg)
	if !ed25519.Verify(id.Public, msg, sig) {
		t.Fatal("signature does not verify")
	}

	if _, err := NewIdentity(path, false); err == nil {
		t.Fatal("NewIdentity overwrote an existing key without --force")
	}
	replaced, err := NewIdentity(path, true)
	if err != nil {
		t.Fatalf("NewIdentity overwrite: %v", err)
	}
	if replaced.Public.Equal(id.Public) {
		t.Fatal("overwrite produced the same key")
	}
}

func TestLoadOrCreateIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.key")
	id, created, err := LoadOrCreateIdentity(path)
	if err != nil {
		t.Fatalf("first LoadOrCreateIdentity: %v", err)
	}
	if !created {
		t.Fatal("first call did not create an identity")
	}
	again, created, err := LoadOrCreateIdentity(path)
	if err != nil {
		t.Fatalf("second LoadOrCreateIdentity: %v", err)
	}
	if created {
		t.Fatal("second call recreated the identity")
	}
	if !again.Public.Equal(id.Public) {
		t.Fatal("identity changed")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("identity file missing: %v", err)
	}
}

func TestLoadRootCAs(t *testing.T) {
	if _, err := LoadRootCAs([]byte("not a certificate")); err == nil {
		t.Fatal("invalid PEM was accepted")
	}
}
