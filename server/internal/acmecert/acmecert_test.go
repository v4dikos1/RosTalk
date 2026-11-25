package acmecert

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNewValidatesDomain(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Fatal("an empty domain was accepted")
	}
	if _, err := New(Config{Domain: "a/b", DataDir: t.TempDir()}); err == nil {
		t.Fatal("a domain with a slash was accepted")
	}
}

func TestStartReportsACMEDirectoryFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not an ACME directory", http.StatusInternalServerError)
	}))
	defer srv.Close()

	m, err := New(Config{
		Domain:        "rostalk.example.test",
		DataDir:       t.TempDir(),
		HTTPAddr:      "127.0.0.1:0",
		TLSAddr:       "127.0.0.1:0",
		DirectoryURL:  srv.URL,
		ObtainTimeout: 3 * time.Second,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = m.Start(context.Background())
	if err == nil {
		_ = m.Close()
		t.Fatal("Start succeeded against a broken ACME directory")
	}
	message := err.Error()
	if !strings.Contains(message, "rostalk.example.test") {
		t.Errorf("the error does not name the domain: %v", err)
	}
	if !strings.Contains(message, "Let's Encrypt") {
		t.Errorf("the error is not actionable about ACME: %v", err)
	}
	if !strings.Contains(message, "without --domain") {
		t.Errorf("the error does not offer the fingerprint fallback: %v", err)
	}
}

func TestStartReportsBusyChallengePort(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = busy.Close() }()

	m, err := New(Config{
		Domain:   "rostalk.example.test",
		DataDir:  t.TempDir(),
		HTTPAddr: busy.Addr().String(),
		TLSAddr:  "127.0.0.1:0",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = m.Start(context.Background())
	if err == nil {
		_ = m.Close()
		t.Fatal("Start succeeded although the HTTP challenge port was busy")
	}
	if !strings.Contains(err.Error(), "cannot listen") || !strings.Contains(err.Error(), "CAP_NET_BIND_SERVICE") {
		t.Fatalf("the busy-port error is not actionable: %v", err)
	}
}

func TestCacheDirIsInsideTheDataDirectory(t *testing.T) {
	dir := t.TempDir()
	m, err := New(Config{Domain: "rostalk.example.test", DataDir: dir})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if m.CacheDir() != dir {
		t.Fatalf("CacheDir = %q, want %q", m.CacheDir(), dir)
	}
}
