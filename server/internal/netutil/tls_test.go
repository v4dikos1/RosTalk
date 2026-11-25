package netutil

import (
	"crypto/x509"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestLoadOrCreateProducesSeparateCAAndLeaf(t *testing.T) {
	dir := t.TempDir()
	material, err := LoadOrCreateTLS(dir, []string{"192.168.1.10", "example.test"})
	if err != nil {
		t.Fatalf("LoadOrCreateTLS: %v", err)
	}

	if !material.CA.IsCA {
		t.Fatal("CA certificate is not marked as a CA")
	}
	if material.Leaf.IsCA {
		t.Fatal("server leaf must not be a CA: rustls rejects CaUsedAsEndEntity (ADR 0001)")
	}
	if material.Leaf.CheckSignatureFrom(material.CA) != nil {
		t.Fatal("server leaf is not signed by the CA")
	}
	if material.FingerprintHex != FingerprintHex(material.Leaf.Raw) {
		t.Fatal("fingerprint does not match the leaf DER")
	}
	if len(material.FingerprintHex) != 64 {
		t.Fatalf("fingerprint has %d hex chars, want 64", len(material.FingerprintHex))
	}

	// A strict WebPKI verifier (what rustls does) must accept the chain.
	roots := x509.NewCertPool()
	roots.AddCert(material.CA)
	for _, host := range []string{"192.168.1.10", "example.test", "127.0.0.1"} {
		if _, err := material.Leaf.Verify(x509.VerifyOptions{
			Roots:     roots,
			DNSName:   host,
			KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		}); err != nil {
			t.Fatalf("leaf does not verify for %q: %v", host, err)
		}
	}

	for _, name := range []string{CACertFile, CAKeyFile, ServerCertFile, ServerKeyFile} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("%s missing: %v", name, err)
		}
	}
	if runtime.GOOS != "windows" {
		if info, err := os.Stat(filepath.Join(dir, ServerKeyFile)); err == nil {
			if perm := info.Mode().Perm(); perm&0o077 != 0 {
				t.Fatalf("server key permissions = %o, want no group/other access", perm)
			}
		}
	}
}

func TestLoadOrCreateIsStableAcrossRestarts(t *testing.T) {
	dir := t.TempDir()
	first, err := LoadOrCreateTLS(dir, []string{"127.0.0.1"})
	if err != nil {
		t.Fatalf("first LoadOrCreateTLS: %v", err)
	}
	second, err := LoadOrCreateTLS(dir, []string{"127.0.0.1"})
	if err != nil {
		t.Fatalf("second LoadOrCreateTLS: %v", err)
	}
	if first.FingerprintHex != second.FingerprintHex {
		t.Fatalf("fingerprint changed across restart: %s -> %s", first.FingerprintHex, second.FingerprintHex)
	}
	if !first.Leaf.Equal(second.Leaf) {
		t.Fatal("leaf certificate changed across restart")
	}
}

func TestLoadOrCreateReissuesLeafWhenMissing(t *testing.T) {
	dir := t.TempDir()
	first, err := LoadOrCreateTLS(dir, []string{"127.0.0.1"})
	if err != nil {
		t.Fatalf("LoadOrCreateTLS: %v", err)
	}
	if err := os.Remove(filepath.Join(dir, ServerCertFile)); err != nil {
		t.Fatalf("remove leaf: %v", err)
	}
	second, err := LoadOrCreateTLS(dir, []string{"127.0.0.1"})
	if err != nil {
		t.Fatalf("LoadOrCreateTLS after removal: %v", err)
	}
	if !first.CA.Equal(second.CA) {
		t.Fatal("CA changed when only the leaf was missing")
	}
	if second.Leaf.IsCA {
		t.Fatal("reissued leaf is a CA")
	}
	if post := second.Leaf.NotAfter; post.Before(time.Now().Add(24 * time.Hour)) {
		t.Fatalf("reissued leaf expires too soon: %s", post)
	}
}

func TestNormalizeHost(t *testing.T) {
	cases := map[string]string{
		"192.168.1.10:7443": "192.168.1.10",
		"[::1]:7443":        "::1",
		"[::1]":             "::1",
		"example.test":      "example.test",
		"  ":                "",
	}
	for input, want := range cases {
		if got := NormalizeHost(input); got != want {
			t.Errorf("NormalizeHost(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestDetectLANIPIsNotLoopback(t *testing.T) {
	ip := DetectLANIP()
	if ip == "" {
		t.Skip("host has no non-loopback IPv4 address")
	}
	parsed := net.ParseIP(ip)
	if parsed == nil || parsed.IsLoopback() {
		t.Fatalf("DetectLANIP returned %q", ip)
	}
}
