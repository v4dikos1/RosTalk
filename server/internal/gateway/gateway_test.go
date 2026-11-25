package gateway

import (
	"context"
	"crypto/tls"
	"io"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/auth"
	"github.com/v4dikos1/RosTalk/server/internal/identity"
	"github.com/v4dikos1/RosTalk/server/internal/netutil"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/state"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

// stubHandler is the smallest auth.Handler: the gateway tests only check the
// listener, origin rules and shutdown, so no request loop is needed.
type stubHandler struct{}

func (stubHandler) PrepareSnapshot(context.Context, *state.Session) *state.PreparedSnapshot {
	return nil
}

func (stubHandler) Snapshot(*state.Session, []state.Presence, *state.PreparedSnapshot) *rostalkv1.ServerSnapshot {
	return &rostalkv1.ServerSnapshot{}
}

func (stubHandler) Serve(context.Context, *state.Session) error { return nil }

func newTestGateway(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "rostalk.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	id, err := identity.Generate()
	if err != nil {
		t.Fatalf("identity.Generate: %v", err)
	}
	roleService, err := roles.Open(context.Background(), roles.Config{Store: st})
	if err != nil {
		t.Fatalf("roles.Open: %v", err)
	}
	manager, err := auth.New(auth.Config{
		Store:         st,
		ServerID:      id.ID,
		ServerVersion: "test",
		Hub:           state.NewHub(state.Config{Visibility: roleService}),
		Roles:         roleService,
		Handler:       stubHandler{},
	})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	material, err := netutil.LoadOrCreateTLS(dir, []string{"127.0.0.1"})
	if err != nil {
		t.Fatalf("LoadOrCreateTLS: %v", err)
	}

	gw, err := New(Config{
		Listen:       "127.0.0.1:0",
		TLS:          material,
		Auth:         manager,
		PublicHost:   "127.0.0.1",
		PingInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("gateway.New: %v", err)
	}
	if err := gw.Start(); err != nil {
		t.Fatalf("gateway.Start: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = gw.Shutdown(ctx)
	})
	return gw, gw.Addr().String()
}

func testHTTPClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true, // the test checks the endpoint, not the certificate
		}},
		Timeout: 5 * time.Second,
	}
}

func TestHealthz(t *testing.T) {
	_, addr := newTestGateway(t)
	resp, err := testHTTPClient().Get("https://" + addr + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(body) != "ok\n" {
		t.Fatalf("body = %q, want ok", body)
	}
}

func TestWebSocketOriginRules(t *testing.T) {
	_, addr := newTestGateway(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	dial := func(origin string) (*websocket.Conn, *http.Response, error) {
		header := http.Header{}
		if origin != "" {
			header.Set("Origin", origin)
		}
		return websocket.Dial(ctx, "wss://"+addr+"/ws", &websocket.DialOptions{
			HTTPClient: testHTTPClient(),
			HTTPHeader: header,
		})
	}

	// A native client sends no Origin.
	conn, _, err := dial("")
	if err != nil {
		t.Fatalf("connection without Origin was rejected: %v", err)
	}
	_ = conn.CloseNow()

	// The server's own origin is allowed.
	conn, _, err = dial("https://" + addr)
	if err != nil {
		t.Fatalf("same-origin connection was rejected: %v", err)
	}
	_ = conn.CloseNow()

	// The configured public host is allowed even without the port.
	conn, _, err = dial("https://127.0.0.1")
	if err != nil {
		t.Fatalf("public-host connection was rejected: %v", err)
	}
	_ = conn.CloseNow()

	// A foreign origin is refused before the upgrade.
	conn, resp, err := dial("https://evil.example")
	if err == nil {
		_ = conn.CloseNow()
		t.Fatal("foreign Origin was accepted")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("foreign Origin status = %d, want 403", status)
	}
}
