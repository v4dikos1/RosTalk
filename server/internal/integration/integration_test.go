package integration

import (
	"context"
	"crypto/x509"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/media/mediafake"
	"github.com/v4dikos1/RosTalk/server/internal/secret"
	"github.com/v4dikos1/RosTalk/server/internal/server"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

// newTestApp starts a real control-plane server on a random loopback port with
// a temporary data directory. mutate runs after New and before Start, so a test
// can change settings the way an administrator eventually will.
//
// The media plane is the in-memory fake: these tests exercise the control plane,
// while the real embedded SFU is covered by the rostalkctl end-to-end test that
// runs two bots against a real server process (CONTRIBUTING.md).
func newTestApp(t *testing.T, mutate func(*store.Store)) *server.App {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("rostalk-server runs only on Linux (CONTRIBUTING.md); CI and make test-server-docker cover the integration suite")
	}

	app, err := server.New(server.Config{
		DataDir:    t.TempDir(),
		Listen:     "127.0.0.1:0",
		PublicHost: "127.0.0.1",
		Media:      mediafake.New(),
		Version:    "test",
	})
	if err != nil {
		t.Fatalf("server.New: %v", err)
	}
	if mutate != nil {
		mutate(app.Store)
	}
	if err := app.Start(context.Background()); err != nil {
		t.Fatalf("server.Start: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := app.Close(ctx); err != nil {
			t.Errorf("server.Close: %v", err)
		}
	})
	return app
}

func connectContext(t *testing.T) (context.Context, context.CancelFunc) {
	t.Helper()
	return context.WithTimeout(context.Background(), 10*time.Second)
}

func adminInvite(t *testing.T, app *server.App) (link, token string) {
	t.Helper()
	link = app.AdminInviteLink()
	if link == "" {
		t.Fatal("server printed no admin invite link")
	}
	u, err := url.Parse(link)
	if err != nil {
		t.Fatalf("parse admin link: %v", err)
	}
	if u.Scheme != "rostalk" || u.Host != "join" {
		t.Fatalf("admin link has unexpected shape: %s", link)
	}
	q := u.Query()
	if q.Get("host") == "" || q.Get("fp") == "" || q.Get("invite") == "" {
		t.Fatalf("admin link is missing parameters: %s", link)
	}
	if strings.Contains(q.Get("host"), "localhost") {
		t.Fatalf("admin link uses localhost: %s", link)
	}
	return link, q.Get("invite")
}

func TestFirstStartAdminInviteAndWelcome(t *testing.T) {
	app := newTestApp(t, nil)
	_, token := adminInvite(t, app)
	addr := app.Addr().String()

	identity, err := newTestIdentity()
	if err != nil {
		t.Fatalf("newTestIdentity: %v", err)
	}
	ctx, cancel := connectContext(t)
	defer cancel()
	session, err := testConnect(ctx, addr, connectOptions{
		identity:    identity,
		nickname:    "admin",
		invite:      token,
		fingerprint: app.TLS.FingerprintHex,
	})
	if err != nil {
		t.Fatalf("connect with the admin invite: %v", err)
	}
	defer session.close()

	snapshot := session.welcome.GetSnapshot()
	if session.welcome.GetSelfUserId() == 0 {
		t.Fatal("Welcome has self_user_id 0")
	}
	if snapshot.GetServer().GetName() != "RosTalk" {
		t.Fatalf("server name = %q", snapshot.GetServer().GetName())
	}
	if snapshot.GetServer().GetOnlineUsers() != 1 {
		t.Fatalf("online users = %d, want 1", snapshot.GetServer().GetOnlineUsers())
	}
	if !bytesEqual(snapshot.GetServer().GetId(), app.Identity.ID[:]) {
		t.Fatal("Welcome carries a different server id")
	}
	if len(snapshot.GetPermissions().GetServer().GetPermissions()) == 0 {
		t.Fatal("the first user is not an administrator")
	}
	if len(snapshot.GetUsers()) != 1 || snapshot.GetUsers()[0].GetNickname() != "admin" {
		t.Fatalf("unexpected users in snapshot: %v", snapshot.GetUsers())
	}

	user, err := app.Store.UserByPublicKey(context.Background(), identity.pub)
	if err != nil {
		t.Fatalf("UserByPublicKey: %v", err)
	}
	if user.IsAdmin != 1 {
		t.Fatal("admin flag was not persisted")
	}
	if _, err := os.Stat(filepath.Join(appDataDir(t, app), server.AdminInviteFile)); !os.IsNotExist(err) {
		t.Fatalf("admin invite file still exists: %v", err)
	}
	if link := app.AdminInviteLink(); link != "" {
		t.Fatalf("server still prints an admin link after the admin logged in: %s", link)
	}

	// A known key is admitted without an invite (design 4.2).
	again, err := testConnect(ctx, addr, connectOptions{
		identity:    identity,
		nickname:    "",
		fingerprint: app.TLS.FingerprintHex,
	})
	if err != nil {
		t.Fatalf("returning user was rejected: %v", err)
	}
	defer again.close()
	if again.welcome.GetSnapshot().GetServer().GetOnlineUsers() != 1 {
		t.Fatal("returning user produced a second online session")
	}
}

func TestInvalidSignatureIsRejected(t *testing.T) {
	app := newTestApp(t, nil)
	_, token := adminInvite(t, app)
	identity, _ := newTestIdentity()

	ctx, cancel := connectContext(t)
	defer cancel()
	_, err := testConnect(ctx, app.Addr().String(), connectOptions{
		identity:     identity,
		nickname:     "mallory",
		invite:       token,
		fingerprint:  app.TLS.FingerprintHex,
		badSignature: true,
	})
	serverErr, ok := asServerError(err)
	if !ok {
		t.Fatalf("expected a server error, got %v", err)
	}
	if serverErr.code != rostalkv1.ErrorCode_ERROR_CODE_AUTH_FAILED {
		t.Fatalf("error code = %s, want AUTH_FAILED", serverErr.code)
	}
}

func TestUnsupportedProtocolVersionIsRejected(t *testing.T) {
	app := newTestApp(t, nil)
	_, token := adminInvite(t, app)
	identity, _ := newTestIdentity()

	ctx, cancel := connectContext(t)
	defer cancel()
	_, err := testConnect(ctx, app.Addr().String(), connectOptions{
		identity:        identity,
		nickname:        "future",
		invite:          token,
		fingerprint:     app.TLS.FingerprintHex,
		protocolVersion: 2,
	})
	serverErr, ok := asServerError(err)
	if !ok {
		t.Fatalf("expected a server error, got %v", err)
	}
	if serverErr.code != rostalkv1.ErrorCode_ERROR_CODE_PROTOCOL_VERSION_UNSUPPORTED {
		t.Fatalf("error code = %s, want PROTOCOL_VERSION_UNSUPPORTED", serverErr.code)
	}
}

func TestForeignFingerprintFailsTLS(t *testing.T) {
	app := newTestApp(t, nil)
	_, token := adminInvite(t, app)
	identity, _ := newTestIdentity()

	ctx, cancel := connectContext(t)
	defer cancel()
	_, err := testConnect(ctx, app.Addr().String(), connectOptions{
		identity:    identity,
		nickname:    "victim",
		invite:      token,
		fingerprint: strings.Repeat("00", 32),
	})
	if err == nil {
		t.Fatal("connection with a foreign fingerprint succeeded")
	}
	if !strings.Contains(err.Error(), "fingerprint mismatch") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestUsedInviteIsRejected(t *testing.T) {
	app := newTestApp(t, nil)
	token, err := app.Store.CreateInvite(context.Background(), store.InviteOptions{MaxUses: 1})
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	addr := app.Addr().String()

	first, _ := newTestIdentity()
	ctx, cancel := connectContext(t)
	defer cancel()
	session, err := testConnect(ctx, addr, connectOptions{
		identity:    first,
		nickname:    "first",
		invite:      token,
		fingerprint: app.TLS.FingerprintHex,
	})
	if err != nil {
		t.Fatalf("first login: %v", err)
	}
	defer session.close()

	second, _ := newTestIdentity()
	_, err = testConnect(ctx, addr, connectOptions{
		identity:    second,
		nickname:    "second",
		invite:      token,
		fingerprint: app.TLS.FingerprintHex,
	})
	serverErr, ok := asServerError(err)
	if !ok {
		t.Fatalf("expected a server error, got %v", err)
	}
	if serverErr.code != rostalkv1.ErrorCode_ERROR_CODE_INVITE_INVALID {
		t.Fatalf("error code = %s, want INVITE_INVALID", serverErr.code)
	}
}

func TestExpiredInviteIsRejected(t *testing.T) {
	app := newTestApp(t, nil)
	past := time.Now().Add(-time.Minute)
	token, err := app.Store.CreateInvite(context.Background(), store.InviteOptions{
		MaxUses:   1,
		ExpiresAt: &past,
	})
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	identity, _ := newTestIdentity()

	ctx, cancel := connectContext(t)
	defer cancel()
	_, err = testConnect(ctx, app.Addr().String(), connectOptions{
		identity:    identity,
		nickname:    "late",
		invite:      token,
		fingerprint: app.TLS.FingerprintHex,
	})
	serverErr, ok := asServerError(err)
	if !ok {
		t.Fatalf("expected a server error, got %v", err)
	}
	if serverErr.code != rostalkv1.ErrorCode_ERROR_CODE_INVITE_EXPIRED {
		t.Fatalf("error code = %s, want INVITE_EXPIRED", serverErr.code)
	}
}

func TestBanByKeyIsRejected(t *testing.T) {
	app := newTestApp(t, nil)
	_, token := adminInvite(t, app)
	identity, _ := newTestIdentity()
	if err := app.Store.AddBan(context.Background(), store.BanOptions{
		PublicKey: identity.pub,
		Reason:    "test",
	}); err != nil {
		t.Fatalf("AddBan: %v", err)
	}

	ctx, cancel := connectContext(t)
	defer cancel()
	_, err := testConnect(ctx, app.Addr().String(), connectOptions{
		identity:    identity,
		nickname:    "banned",
		invite:      token,
		fingerprint: app.TLS.FingerprintHex,
	})
	serverErr, ok := asServerError(err)
	if !ok {
		t.Fatalf("expected a server error, got %v", err)
	}
	if serverErr.code != rostalkv1.ErrorCode_ERROR_CODE_BANNED {
		t.Fatalf("error code = %s, want BANNED", serverErr.code)
	}
}

func TestBanByIPIsRejected(t *testing.T) {
	app := newTestApp(t, nil)
	_, token := adminInvite(t, app)
	if err := app.Store.AddBan(context.Background(), store.BanOptions{
		IP:     "127.0.0.1",
		Reason: "test",
	}); err != nil {
		t.Fatalf("AddBan: %v", err)
	}
	identity, _ := newTestIdentity()

	ctx, cancel := connectContext(t)
	defer cancel()
	_, err := testConnect(ctx, app.Addr().String(), connectOptions{
		identity:    identity,
		nickname:    "banned",
		invite:      token,
		fingerprint: app.TLS.FingerprintHex,
	})
	serverErr, ok := asServerError(err)
	if !ok {
		t.Fatalf("expected a server error, got %v", err)
	}
	if serverErr.code != rostalkv1.ErrorCode_ERROR_CODE_BANNED {
		t.Fatalf("error code = %s, want BANNED", serverErr.code)
	}
}

func TestNewConnectionReplacesOldSession(t *testing.T) {
	app := newTestApp(t, nil)
	_, token := adminInvite(t, app)
	addr := app.Addr().String()
	identity, _ := newTestIdentity()

	ctx, cancel := connectContext(t)
	defer cancel()
	first, err := testConnect(ctx, addr, connectOptions{
		identity:    identity,
		nickname:    "alice",
		invite:      token,
		fingerprint: app.TLS.FingerprintHex,
	})
	if err != nil {
		t.Fatalf("first connect: %v", err)
	}
	defer first.close()

	second, err := testConnect(ctx, addr, connectOptions{
		identity:    identity,
		nickname:    "alice",
		fingerprint: app.TLS.FingerprintHex,
	})
	if err != nil {
		t.Fatalf("second connect: %v", err)
	}
	defer second.close()

	frame := waitFrame(t, first)
	serverErr := frame.GetError()
	if serverErr == nil {
		t.Fatalf("old session received %T, want SESSION_REPLACED", frame.GetPayload())
	}
	if serverErr.GetCode() != rostalkv1.ErrorCode_ERROR_CODE_SESSION_REPLACED {
		t.Fatalf("old session error = %s, want SESSION_REPLACED", serverErr.GetCode())
	}
	if frame.GetReplyTo() != 0 {
		t.Fatalf("session replacement error has reply_to %d, want 0", frame.GetReplyTo())
	}

	if users := app.Hub.SnapshotUsers(); len(users) != 1 {
		t.Fatalf("online users = %d, want 1", len(users))
	}
}

func TestNicknameUniqueness(t *testing.T) {
	app := newTestApp(t, nil)
	_, adminToken := adminInvite(t, app)
	addr := app.Addr().String()

	ctx, cancel := connectContext(t)
	defer cancel()

	alice, _ := newTestIdentity()
	first, err := testConnect(ctx, addr, connectOptions{
		identity:    alice,
		nickname:    "alice",
		invite:      adminToken,
		fingerprint: app.TLS.FingerprintHex,
	})
	if err != nil {
		t.Fatalf("connect alice: %v", err)
	}
	defer first.close()

	bob, _ := newTestIdentity()
	inviteB, err := app.Store.CreateInvite(context.Background(), store.InviteOptions{MaxUses: 1})
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	_, err = testConnect(ctx, addr, connectOptions{
		identity:    bob,
		nickname:    "ALICE", // nicknames are compared case-insensitively
		invite:      inviteB,
		fingerprint: app.TLS.FingerprintHex,
	})
	if serverErr, ok := asServerError(err); !ok || serverErr.code != rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST {
		t.Fatalf("duplicate nickname error = %v, want INVALID_REQUEST", err)
	}

	// The rejected name did not spend the invite: bob can still use it.
	bobSession, err := testConnect(ctx, addr, connectOptions{
		identity:    bob,
		nickname:    "bob",
		invite:      inviteB,
		fingerprint: app.TLS.FingerprintHex,
	})
	if err != nil {
		t.Fatalf("connect bob with the same invite: %v", err)
	}
	defer bobSession.close()

	// The same key may reconnect with its own nickname.
	aliceAgain, err := testConnect(ctx, addr, connectOptions{
		identity:    alice,
		nickname:    "alice",
		fingerprint: app.TLS.FingerprintHex,
	})
	if err != nil {
		t.Fatalf("reconnect alice: %v", err)
	}
	defer aliceAgain.close()

	// A different key cannot take an online nickname, and an online key cannot
	// switch to a name held by someone else.
	carol, _ := newTestIdentity()
	inviteC, err := app.Store.CreateInvite(context.Background(), store.InviteOptions{MaxUses: 1})
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	_, err = testConnect(ctx, addr, connectOptions{
		identity:    carol,
		nickname:    "alice",
		invite:      inviteC,
		fingerprint: app.TLS.FingerprintHex,
	})
	if serverErr, ok := asServerError(err); !ok || serverErr.code != rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST {
		t.Fatalf("second duplicate nickname error = %v, want INVALID_REQUEST", err)
	}

	_, err = testConnect(ctx, addr, connectOptions{
		identity:    bob,
		nickname:    "alice",
		fingerprint: app.TLS.FingerprintHex,
	})
	if serverErr, ok := asServerError(err); !ok || serverErr.code != rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST {
		t.Fatalf("switch to an occupied nickname error = %v, want INVALID_REQUEST", err)
	}
}

func TestMaxUsersDoesNotConsumeInvite(t *testing.T) {
	app := newTestApp(t, func(st *store.Store) {
		if err := st.SetSetting(context.Background(), "max_users", "1"); err != nil {
			t.Fatalf("SetSetting max_users: %v", err)
		}
	})
	_, adminToken := adminInvite(t, app)
	addr := app.Addr().String()

	ctx, cancel := connectContext(t)
	defer cancel()

	first, _ := newTestIdentity()
	firstSession, err := testConnect(ctx, addr, connectOptions{
		identity:    first,
		nickname:    "first",
		invite:      adminToken,
		fingerprint: app.TLS.FingerprintHex,
	})
	if err != nil {
		t.Fatalf("first connect: %v", err)
	}

	second, _ := newTestIdentity()
	invite, err := app.Store.CreateInvite(context.Background(), store.InviteOptions{MaxUses: 1})
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	_, err = testConnect(ctx, addr, connectOptions{
		identity:    second,
		nickname:    "second",
		invite:      invite,
		fingerprint: app.TLS.FingerprintHex,
	})
	serverErr, ok := asServerError(err)
	if !ok || serverErr.code != rostalkv1.ErrorCode_ERROR_CODE_REJECTED {
		t.Fatalf("over-capacity login error = %v, want REJECTED", err)
	}

	// The rejected login must not have consumed the invite.
	stored, err := app.Store.FindInvite(context.Background(), invite)
	if err != nil {
		t.Fatalf("FindInvite: %v", err)
	}
	if err := store.CheckInvite(stored, time.Now()); err != nil {
		t.Fatalf("invite was consumed by a rejected login: %v", err)
	}

	// Once the only seat is free, the same invite works.
	firstSession.close()
	waitOnline(t, app, 0)

	secondSession, err := testConnect(ctx, addr, connectOptions{
		identity:    second,
		nickname:    "second",
		invite:      invite,
		fingerprint: app.TLS.FingerprintHex,
	})
	if err != nil {
		t.Fatalf("connect after a seat was freed: %v", err)
	}
	defer secondSession.close()
}

func TestRateLimitByIP(t *testing.T) {
	app := newTestApp(t, func(st *store.Store) {
		ctx := context.Background()
		if err := st.SetSetting(ctx, "auth_attempts_limit", "2"); err != nil {
			t.Fatalf("SetSetting limit: %v", err)
		}
		if err := st.SetSetting(ctx, "auth_attempts_window_seconds", "60"); err != nil {
			t.Fatalf("SetSetting window: %v", err)
		}
	})
	_, token := adminInvite(t, app)
	addr := app.Addr().String()

	for attempt := 1; attempt <= 2; attempt++ {
		identity, _ := newTestIdentity()
		ctx, cancel := connectContext(t)
		_, err := testConnect(ctx, addr, connectOptions{
			identity:     identity,
			nickname:     "bad",
			invite:       token,
			fingerprint:  app.TLS.FingerprintHex,
			badSignature: true,
		})
		cancel()
		serverErr, ok := asServerError(err)
		if !ok || serverErr.code != rostalkv1.ErrorCode_ERROR_CODE_AUTH_FAILED {
			t.Fatalf("attempt %d: unexpected error %v", attempt, err)
		}
	}

	identity, _ := newTestIdentity()
	ctx, cancel := connectContext(t)
	defer cancel()
	_, err := testConnect(ctx, addr, connectOptions{
		identity:    identity,
		nickname:    "limited",
		invite:      token,
		fingerprint: app.TLS.FingerprintHex,
	})
	serverErr, ok := asServerError(err)
	if !ok {
		t.Fatalf("expected a server error, got %v", err)
	}
	if serverErr.code != rostalkv1.ErrorCode_ERROR_CODE_RATE_LIMITED {
		t.Fatalf("error code = %s, want RATE_LIMITED", serverErr.code)
	}
}

func TestTLSChainIsValidForStrictClients(t *testing.T) {
	app := newTestApp(t, nil)
	_, token := adminInvite(t, app)

	if app.TLS.Leaf.IsCA {
		t.Fatal("leaf certificate is a CA; rustls rejects CaUsedAsEndEntity (ADR 0001)")
	}
	roots := app.TLS.CAPool()
	if _, err := app.TLS.Leaf.Verify(x509.VerifyOptions{
		Roots:     roots,
		DNSName:   "127.0.0.1",
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}); err != nil {
		t.Fatalf("leaf does not verify against the CA: %v", err)
	}

	identity, _ := newTestIdentity()
	ctx, cancel := connectContext(t)
	defer cancel()
	session, err := testConnect(ctx, app.Addr().String(), connectOptions{
		identity:    identity,
		nickname:    "strict",
		invite:      token,
		fingerprint: app.TLS.FingerprintHex,
		roots:       roots,
	})
	if err != nil {
		t.Fatalf("connect with full chain validation: %v", err)
	}
	defer session.close()
}

func TestPasswordAndOpenModes(t *testing.T) {
	t.Run("password", func(t *testing.T) {
		hash, err := secret.HashPassword("s3cret")
		if err != nil {
			t.Fatalf("HashPassword: %v", err)
		}
		app := newTestApp(t, func(st *store.Store) {
			ctx := context.Background()
			if err := st.SetSetting(ctx, "login_mode", "password"); err != nil {
				t.Fatalf("SetSetting mode: %v", err)
			}
			if err := st.SetSetting(ctx, "server_password_hash", hash); err != nil {
				t.Fatalf("SetSetting password: %v", err)
			}
		})
		addr := app.Addr().String()

		identity, _ := newTestIdentity()
		ctx, cancel := connectContext(t)
		defer cancel()
		_, err = testConnect(ctx, addr, connectOptions{
			identity:    identity,
			nickname:    "alice",
			password:    "wrong",
			fingerprint: app.TLS.FingerprintHex,
		})
		serverErr, ok := asServerError(err)
		if !ok || serverErr.code != rostalkv1.ErrorCode_ERROR_CODE_WRONG_PASSWORD {
			t.Fatalf("wrong password error = %v", err)
		}

		session, err := testConnect(ctx, addr, connectOptions{
			identity:    identity,
			nickname:    "alice",
			password:    "s3cret",
			fingerprint: app.TLS.FingerprintHex,
		})
		if err != nil {
			t.Fatalf("password login: %v", err)
		}
		defer session.close()
	})

	t.Run("open", func(t *testing.T) {
		app := newTestApp(t, func(st *store.Store) {
			if err := st.SetSetting(context.Background(), "login_mode", "open"); err != nil {
				t.Fatalf("SetSetting mode: %v", err)
			}
		})
		identity, _ := newTestIdentity()
		ctx, cancel := connectContext(t)
		defer cancel()
		session, err := testConnect(ctx, app.Addr().String(), connectOptions{
			identity:    identity,
			nickname:    "guest",
			fingerprint: app.TLS.FingerprintHex,
		})
		if err != nil {
			t.Fatalf("open login: %v", err)
		}
		defer session.close()
	})
}

// TestBootstrapAdminInviteWorksInEveryLoginMode covers the printed one-time
// administrator link. Password and open admission do not require an invite,
// but when the client comes from that link the invite must still be consumed:
// otherwise the first start in those modes produces a link that cannot create
// an administrator.
func TestBootstrapAdminInviteWorksInEveryLoginMode(t *testing.T) {
	assertAdmin := func(t *testing.T, session *testSession) {
		t.Helper()
		for _, permission := range session.welcome.GetSnapshot().GetPermissions().GetServer().GetPermissions() {
			if permission == rostalkv1.Permission_PERMISSION_MANAGE_SERVER {
				return
			}
		}
		t.Fatal("the bootstrap link did not grant manage_server")
	}

	t.Run("password", func(t *testing.T) {
		hash, err := secret.HashPassword("s3cret")
		if err != nil {
			t.Fatalf("HashPassword: %v", err)
		}
		app := newTestApp(t, func(st *store.Store) {
			ctx := context.Background()
			if err := st.SetSetting(ctx, "login_mode", "password"); err != nil {
				t.Fatalf("SetSetting mode: %v", err)
			}
			if err := st.SetSetting(ctx, "server_password_hash", hash); err != nil {
				t.Fatalf("SetSetting password: %v", err)
			}
		})
		_, token := adminInvite(t, app)
		identity, _ := newTestIdentity()
		ctx, cancel := connectContext(t)
		defer cancel()
		session, err := testConnect(ctx, app.Addr().String(), connectOptions{
			identity:    identity,
			nickname:    "admin",
			password:    "s3cret",
			invite:      token,
			fingerprint: app.TLS.FingerprintHex,
		})
		if err != nil {
			t.Fatalf("password login with the admin invite: %v", err)
		}
		defer session.close()
		assertAdmin(t, session)
	})

	t.Run("open", func(t *testing.T) {
		app := newTestApp(t, func(st *store.Store) {
			if err := st.SetSetting(context.Background(), "login_mode", "open"); err != nil {
				t.Fatalf("SetSetting mode: %v", err)
			}
		})
		_, token := adminInvite(t, app)
		identity, _ := newTestIdentity()
		ctx, cancel := connectContext(t)
		defer cancel()
		session, err := testConnect(ctx, app.Addr().String(), connectOptions{
			identity:    identity,
			nickname:    "admin",
			invite:      token,
			fingerprint: app.TLS.FingerprintHex,
		})
		if err != nil {
			t.Fatalf("open login with the admin invite: %v", err)
		}
		defer session.close()
		assertAdmin(t, session)
	})
}

func TestRestartKeepsIdentityFingerprintAndAdminInvite(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("rostalk-server runs only on Linux (CONTRIBUTING.md); CI and make test-server-docker cover this test")
	}
	dir := t.TempDir()
	cfg := server.Config{
		DataDir:    dir,
		Listen:     "127.0.0.1:0",
		PublicHost: "127.0.0.1",
		Media:      mediafake.New(),
		Version:    "test",
	}

	first, err := server.New(cfg)
	if err != nil {
		t.Fatalf("first New: %v", err)
	}
	if err := first.Start(context.Background()); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	firstLink := first.AdminInviteLink()
	firstFP := first.TLS.FingerprintHex
	firstID := first.Identity.IDFingerprintHex()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	if err := first.Close(shutdownCtx); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	shutdownCancel()

	second, err := server.New(cfg)
	if err != nil {
		t.Fatalf("second New: %v", err)
	}
	if err := second.Start(context.Background()); err != nil {
		t.Fatalf("second Start: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = second.Close(ctx)
	})

	if second.TLS.FingerprintHex != firstFP {
		t.Fatalf("TLS fingerprint changed across restart: %s -> %s", firstFP, second.TLS.FingerprintHex)
	}
	if second.Identity.IDFingerprintHex() != firstID {
		t.Fatalf("server id changed across restart: %s -> %s", firstID, second.Identity.IDFingerprintHex())
	}
	secondLink := second.AdminInviteLink()
	if firstLink == "" || secondLink == "" {
		t.Fatalf("admin invite missing: %q / %q", firstLink, secondLink)
	}
	firstToken := tokenFromLink(t, firstLink)
	secondToken := tokenFromLink(t, secondLink)
	if firstToken != secondToken {
		t.Fatal("admin invite token changed across restart")
	}
}

func tokenFromLink(t *testing.T, link string) string {
	t.Helper()
	u, err := url.Parse(link)
	if err != nil {
		t.Fatalf("parse link: %v", err)
	}
	return u.Query().Get("invite")
}

// waitOnline waits for the server's online set to reach want sessions. Closing
// a WebSocket is asynchronous: the server notices on the next read.
func waitOnline(t *testing.T, app *server.App, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if got := len(app.Hub.SnapshotUsers()); got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("online users = %d, want %d", len(app.Hub.SnapshotUsers()), want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// appDataDir finds the data directory through the store path. Tests use it to
// check that the plaintext bootstrap invite file disappears after use.
func appDataDir(t *testing.T, app *server.App) string {
	t.Helper()
	return filepath.Dir(app.Store.Path())
}
