package auth

import (
	"context"
	"crypto/ed25519"
	"errors"
	"io"
	"net"
	"path/filepath"
	"sync"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/identity"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/state"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

func TestRateLimiterSlidingWindow(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	clock := func() time.Time { return now }
	limiter := newRateLimiter(3, time.Minute, clock)

	for i := 0; i < 3; i++ {
		if !limiter.allow("1.2.3.4") {
			t.Fatalf("attempt %d was rejected", i+1)
		}
	}
	if limiter.allow("1.2.3.4") {
		t.Fatal("fourth attempt was allowed")
	}
	// Rejected attempts must not append timestamps: the bucket stays at limit.
	for i := 0; i < 100; i++ {
		if limiter.allow("1.2.3.4") {
			t.Fatal("an attempt beyond the limit was allowed")
		}
	}
	if got := len(limiter.attempts["1.2.3.4"]); got > 3 {
		t.Fatalf("bucket grew to %d entries, limit is 3", got)
	}
	if got := len(limiter.attempts["1.2.3.4"]); got != 3 {
		t.Fatalf("bucket has %d entries, want 3", got)
	}
	if !limiter.allow("5.6.7.8") {
		t.Fatal("a different address was rejected")
	}

	// After the window the address is allowed again.
	now = now.Add(61 * time.Second)
	if !limiter.allow("1.2.3.4") {
		t.Fatal("attempt after the window was rejected")
	}

	limiter.reset("1.2.3.4")
	if !limiter.allow("1.2.3.4") {
		t.Fatal("attempt after reset was rejected")
	}

	now = now.Add(2 * time.Minute)
	limiter.prune()
	for _, key := range []string{"1.2.3.4", "5.6.7.8"} {
		if _, ok := limiter.attempts[key]; ok {
			t.Fatalf("prune kept an expired bucket for %s", key)
		}
	}
}

func TestRateLimiterPrunesAutomatically(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	clock := func() time.Time { return now }
	limiter := newRateLimiter(2, time.Minute, clock)

	if !limiter.allow("10.0.0.1") || !limiter.allow("10.0.0.2") {
		t.Fatal("initial attempts were rejected")
	}
	now = now.Add(2 * time.Minute)
	if !limiter.allow("10.0.0.3") {
		t.Fatal("attempt after the window was rejected")
	}
	if _, ok := limiter.attempts["10.0.0.1"]; ok {
		t.Fatal("automatic prune kept an expired bucket for 10.0.0.1")
	}
	if _, ok := limiter.attempts["10.0.0.2"]; ok {
		t.Fatal("automatic prune kept an expired bucket for 10.0.0.2")
	}
	if got := len(limiter.attempts["10.0.0.3"]); got != 1 {
		t.Fatalf("new bucket has %d entries, want 1", got)
	}
}

func TestLoginModeParsing(t *testing.T) {
	cases := map[string]bool{
		"":          true,
		"invite":    true,
		"password":  true,
		"open":      true,
		"INVITE":    true,
		"something": false,
	}
	for input, ok := range cases {
		_, err := loginMode(input)
		if ok && err != nil {
			t.Errorf("loginMode(%q) returned %v", input, err)
		}
		if !ok && err == nil {
			t.Errorf("loginMode(%q) unexpectedly succeeded", input)
		}
	}
}

// noopHandler is the smallest Handler the manager accepts. It never sees a
// session in these tests: every connection stops during the handshake.
type noopHandler struct{}

func (noopHandler) PrepareSnapshot(context.Context, *state.Session) *state.PreparedSnapshot {
	return nil
}

func (noopHandler) Snapshot(*state.Session, []state.Presence, *state.PreparedSnapshot) *rostalkv1.ServerSnapshot {
	return &rostalkv1.ServerSnapshot{}
}

func (noopHandler) Serve(context.Context, *state.Session) error { return nil }

func newManager(t *testing.T, mutate func(*store.Store)) *Manager {
	t.Helper()
	return newManagerWithHandler(t, mutate, noopHandler{})
}

func newManagerWithHandler(t *testing.T, mutate func(*store.Store), handler Handler) *Manager {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "rostalk.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if mutate != nil {
		mutate(st)
	}
	id, err := identity.Generate()
	if err != nil {
		t.Fatalf("identity.Generate: %v", err)
	}
	settings, err := st.Settings(context.Background())
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	roleService, err := roles.Open(context.Background(), roles.Config{Store: st})
	if err != nil {
		t.Fatalf("roles.Open: %v", err)
	}
	hub := state.NewHub(state.Config{MaxUsers: settings.MaxUsers, Visibility: roleService})
	manager, err := New(Config{
		Store:         st,
		ServerID:      id.ID,
		ServerVersion: "test",
		Hub:           hub,
		Roles:         roleService,
		Handler:       handler,
	})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	return manager
}

// scriptedTransport sends one Hello frame and then fails the read.
type scriptedTransport struct {
	mu        sync.Mutex
	code      rostalkv1.ErrorCode
	hello     *rostalkv1.ClientFrame
	remaining int
}

func (t *scriptedTransport) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 12345}
}

func (t *scriptedTransport) Read(context.Context) (*rostalkv1.ClientFrame, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.remaining > 0 {
		t.remaining--
		return t.hello, nil
	}
	return nil, io.EOF
}

func (t *scriptedTransport) Write(_ context.Context, frame *rostalkv1.ServerFrame) error {
	if err := frame.GetError(); err != nil {
		t.mu.Lock()
		t.code = err.GetCode()
		t.mu.Unlock()
	}
	return nil
}

func (t *scriptedTransport) Close() error { return nil }

func (t *scriptedTransport) failureCode() rostalkv1.ErrorCode {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.code
}

func TestHandleRejectsTooManyAttempts(t *testing.T) {
	manager := newManager(t, func(st *store.Store) {
		ctx := context.Background()
		if err := st.SetSetting(ctx, "auth_attempts_limit", "1"); err != nil {
			t.Fatalf("SetSetting: %v", err)
		}
		if err := st.SetSetting(ctx, "auth_attempts_window_seconds", "60"); err != nil {
			t.Fatalf("SetSetting: %v", err)
		}
		if err := st.SetSetting(ctx, "login_mode", "open"); err != nil {
			t.Fatalf("SetSetting: %v", err)
		}
	})
	id, err := identity.Generate()
	if err != nil {
		t.Fatalf("identity.Generate: %v", err)
	}

	hello := &rostalkv1.ClientFrame{
		RequestId: 1,
		Payload: &rostalkv1.ClientFrame_Hello{Hello: &rostalkv1.Hello{
			ProtocolVersion: ProtocolVersion,
			PublicKey:       id.Public,
			Nickname:        "alice",
		}},
	}
	tr := &scriptedTransport{hello: hello, remaining: 1}
	if err := manager.Handle(context.Background(), tr); err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("first Handle: %v", err)
	}
	if tr.failureCode() != 0 {
		t.Fatalf("first attempt failed with %v, want it to reach the challenge", tr.failureCode())
	}
	tr = &scriptedTransport{hello: hello, remaining: 1}
	if err := manager.Handle(context.Background(), tr); err != nil {
		t.Fatalf("second Handle: %v", err)
	}
	if tr.failureCode() != rostalkv1.ErrorCode_ERROR_CODE_RATE_LIMITED {
		t.Fatalf("second attempt code = %v, want RATE_LIMITED", tr.failureCode())
	}
}

// signingTransport completes a real handshake: Hello, then an Authenticate
// frame signed with the test key, then EOF. It lets a test reach Welcome.
type signingTransport struct {
	key      ed25519.PrivateKey
	public   []byte
	serverID []byte

	mu     sync.Mutex
	step   int
	nonce  []byte
	closed bool
}

func (t *signingTransport) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 12345}
}

func (t *signingTransport) Read(context.Context) (*rostalkv1.ClientFrame, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch t.step {
	case 0:
		t.step++
		return &rostalkv1.ClientFrame{
			RequestId: 1,
			Payload: &rostalkv1.ClientFrame_Hello{Hello: &rostalkv1.Hello{
				ProtocolVersion: ProtocolVersion,
				PublicKey:       t.public,
				Nickname:        "alice",
			}},
		}, nil
	case 1:
		if t.nonce == nil {
			return nil, errors.New("Authenticate before Challenge")
		}
		signed := append(append([]byte(nil), t.nonce...), t.serverID...)
		t.step++
		return &rostalkv1.ClientFrame{
			RequestId: 2,
			Payload: &rostalkv1.ClientFrame_Authenticate{Authenticate: &rostalkv1.Authenticate{
				Signature: ed25519.Sign(t.key, signed),
			}},
		}, nil
	default:
		return nil, io.EOF
	}
}

func (t *signingTransport) Write(_ context.Context, frame *rostalkv1.ServerFrame) error {
	if challenge := frame.GetChallenge(); challenge != nil {
		t.mu.Lock()
		t.nonce = append([]byte(nil), challenge.GetNonce()...)
		t.mu.Unlock()
	}
	return nil
}

func (t *signingTransport) Close() error {
	t.mu.Lock()
	t.closed = true
	t.mu.Unlock()
	return nil
}

// blockingHandler records the order of the snapshot halves and holds
// PrepareSnapshot until the test releases it.
type blockingHandler struct {
	entered     chan struct{}
	release     chan struct{}
	snapshotted chan struct{}
	enterOnce   sync.Once
	snapOnce    sync.Once
}

func newBlockingHandler() *blockingHandler {
	return &blockingHandler{
		entered:     make(chan struct{}),
		release:     make(chan struct{}),
		snapshotted: make(chan struct{}),
	}
}

func (h *blockingHandler) PrepareSnapshot(context.Context, *state.Session) *state.PreparedSnapshot {
	h.enterOnce.Do(func() { close(h.entered) })
	<-h.release
	return &state.PreparedSnapshot{}
}

func (h *blockingHandler) Snapshot(*state.Session, []state.Presence, *state.PreparedSnapshot) *rostalkv1.ServerSnapshot {
	h.snapOnce.Do(func() { close(h.snapshotted) })
	return &rostalkv1.ServerSnapshot{}
}

func (h *blockingHandler) Serve(context.Context, *state.Session) error { return nil }

// TestWelcomeReadsTheSnapshotOutsideTheHubLock pins the stage 7.2 invariant:
// the expensive snapshot read (PrepareSnapshot) runs before the hub lock, so a
// slow database query cannot stop Move, Leave or another connect. Before this
// change every Welcome held the lock for the unread SQL and serialised them.
func TestWelcomeReadsTheSnapshotOutsideTheHubLock(t *testing.T) {
	handler := newBlockingHandler()
	manager := newManagerWithHandler(t, func(st *store.Store) {
		if err := st.SetSetting(context.Background(), "login_mode", "open"); err != nil {
			t.Fatalf("SetSetting: %v", err)
		}
	}, handler)

	id, err := identity.Generate()
	if err != nil {
		t.Fatalf("identity.Generate: %v", err)
	}
	tr := &signingTransport{key: id.Private, public: id.Public, serverID: manager.serverID[:]}
	done := make(chan error, 1)
	go func() { done <- manager.Handle(context.Background(), tr) }()

	select {
	case <-handler.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("the handshake never reached PrepareSnapshot")
	}

	// The session is registered but Welcome is still waiting for the read.
	moved := make(chan error, 1)
	go func() {
		_, moveErr := manager.hub.Move(1, 42, 0)
		moved <- moveErr
	}()
	select {
	case moveErr := <-moved:
		if moveErr != nil {
			t.Fatalf("Move during a snapshot read: %v", moveErr)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Move blocked behind the snapshot read: the hub lock is held across SQL")
	}

	close(handler.release)
	select {
	case <-handler.snapshotted:
	case <-time.After(2 * time.Second):
		t.Fatal("Welcome did not build the snapshot after the read")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Handle: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Handle did not finish after Welcome")
	}
}

func TestNewRequiresHubAndHandler(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "rostalk.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id, err := identity.Generate()
	if err != nil {
		t.Fatalf("identity.Generate: %v", err)
	}
	if _, err := New(Config{Store: st, ServerID: id.ID}); err == nil {
		t.Fatal("New without a hub succeeded")
	}
}
