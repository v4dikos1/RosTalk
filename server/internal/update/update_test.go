package update

import (
	"context"
	"crypto/ed25519"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/v4dikos1/RosTalk/server/internal/release"
)

type fakeRelease struct {
	baseDir   string
	baseURL   string
	version   string
	goarch    string
	asset     []byte
	publicKey ed25519.PublicKey
}

func newFakeRelease(t *testing.T, version, goarch string) *fakeRelease {
	t.Helper()
	dir := t.TempDir()
	pub, priv, err := release.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeRelease{baseDir: dir, version: version, goarch: goarch, publicKey: pub}
	f.asset = []byte("#!/bin/sh\necho rostalk-server " + version + "\n")
	name := release.AssetName(version, goarch)
	if err := os.WriteFile(filepath.Join(dir, name), f.asset, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := release.WriteSumsFile(dir, []string{name}); err != nil {
		t.Fatal(err)
	}
	sums, err := os.ReadFile(filepath.Join(dir, release.ChecksumName))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, release.SignatureName), release.Sign(priv, sums), 0o644); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *fakeRelease) client(t *testing.T) *Client {
	t.Helper()
	return &Client{
		BaseURL:        "https://releases.example.test/rostalk",
		PublicKey:      f.publicKey,
		CurrentVersion: "1.0.0",
		GOARCH:         f.goarch,
		GOOS:           "linux",
		HTTP:           f.httpClient(t),
		Validate:       func(string) error { return nil },
	}
}

func (f *fakeRelease) httpClient(t *testing.T) *http.Client {
	t.Helper()
	server := httptest.NewServer(http.FileServer(http.Dir(f.baseDir)))
	t.Cleanup(server.Close)
	f.baseURL = server.URL
	return &http.Client{Transport: rewriteTransport{base: server.URL}}
}

// rewriteTransport sends every request to the test server while keeping the
// client's configured URL intact, so the test exercises URL handling too.
type rewriteTransport struct{ base string }

func (r rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.URL.Scheme = "http"
	clone.URL.Host = strings.TrimPrefix(r.base, "http://")
	clone.URL.Path = strings.TrimPrefix(req.URL.Path, "/rostalk")
	clone.URL.RawPath = ""
	return http.DefaultTransport.RoundTrip(clone)
}

func TestCheckAndApply(t *testing.T) {
	f := newFakeRelease(t, "1.2.3", "amd64")
	client := f.client(t)

	remote, err := client.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if remote.Version != "1.2.3" || remote.AssetName != "rostalk-server_1.2.3_linux_amd64" {
		t.Fatalf("unexpected release %+v", remote)
	}

	target := filepath.Join(t.TempDir(), "rostalk-server")
	if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	applied, err := client.Apply(context.Background(), target)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if applied.Version != "1.2.3" {
		t.Fatalf("applied version %q", applied.Version)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string(f.asset) {
		t.Fatalf("target was not replaced:\n%s", data)
	}
}

func TestApplyRejectsBadSignature(t *testing.T) {
	f := newFakeRelease(t, "1.2.3", "amd64")
	client := f.client(t)
	// Corrupt the signature after the manifest was signed.
	if err := os.WriteFile(filepath.Join(f.baseDir, release.SignatureName), []byte("not a signature"), 0o644); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "rostalk-server")
	if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Apply(context.Background(), target); err == nil {
		t.Fatal("update installed a release with a broken signature")
	}
	if data, _ := os.ReadFile(target); string(data) != "old" {
		t.Fatal("the target changed after a failed update")
	}
}

func TestApplyRejectsChecksumMismatch(t *testing.T) {
	f := newFakeRelease(t, "1.2.3", "amd64")
	client := f.client(t)
	// Change the binary after signing the manifest.
	name := release.AssetName("1.2.3", "amd64")
	if err := os.WriteFile(filepath.Join(f.baseDir, name), []byte("tampered"), 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "rostalk-server")
	if _, err := client.Apply(context.Background(), target); err == nil {
		t.Fatal("update installed a binary that does not match SHA256SUMS")
	}
}

func TestCheckRequiresPublicKey(t *testing.T) {
	f := newFakeRelease(t, "1.2.3", "amd64")
	client := f.client(t)
	client.PublicKey = nil
	if _, err := client.Check(context.Background()); err == nil {
		t.Fatal("Check worked without a public key")
	}
}

func TestApplySkipsSameVersion(t *testing.T) {
	f := newFakeRelease(t, "1.2.3", "amd64")
	client := f.client(t)
	client.CurrentVersion = "1.2.3"
	target := filepath.Join(t.TempDir(), "rostalk-server")
	if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Apply(context.Background(), target); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if data, _ := os.ReadFile(target); string(data) != "old" {
		t.Fatal("Apply replaced the binary although the version is current")
	}
}

func TestJoinRejectsNonHTTP(t *testing.T) {
	client := &Client{BaseURL: "file:///tmp/release", PublicKey: make([]byte, ed25519.PublicKeySize)}
	if _, err := client.Check(context.Background()); err == nil {
		t.Fatal("a file:// release URL was accepted")
	}
}
