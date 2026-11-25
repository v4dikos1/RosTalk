package control

import (
	"context"
	"errors"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/media"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/sessionauth"
	"github.com/v4dikos1/RosTalk/server/internal/state"
)

// TestInviteCannotGrantRightsAboveTheCreator closes the invite variant of the
// role-assignment escalation: a moderator may manage a lower role, but must not
// mint an invite for it when that role carries a permission the moderator does
// not hold. The login path assigns the invite role as the system actor, so
// without this check the moderator could redeem the link with a fresh key and
// gain the extra right.
func TestInviteCannotGrantRightsAboveTheCreator(t *testing.T) {
	fixture := newPlaneFixture(t)
	ctx := context.Background()

	moderatorRole, ok := fixture.roles.RoleByName(roles.ModeratorName)
	if !ok {
		t.Fatal("the Moderator role is missing")
	}
	if err := fixture.roles.Assign(ctx, roles.System, 1, moderatorRole.ID); err != nil {
		t.Fatalf("assign Moderator: %v", err)
	}

	// The helper sits below Moderator, so the moderator may manage it, but it
	// carries manage_channels: a right the moderator lacks.
	helper, err := fixture.roles.Create(ctx, roles.System, roles.CreateParams{
		Name:        "Helper",
		Permissions: []rostalkv1.Permission{rostalkv1.Permission_PERMISSION_MANAGE_CHANNELS},
	})
	if err != nil {
		t.Fatalf("create Helper: %v", err)
	}
	if helper.Position >= moderatorRole.Position {
		t.Fatalf("Helper position %d is not below Moderator %d", helper.Position, moderatorRole.Position)
	}

	actor := actor{
		subject: fixture.roles.Subject(1),
		userID:  1,
		name:    "user1",
	}
	_, err = fixture.plane.adminInviteCreate(ctx, actor, &rostalkv1.InviteCreate{
		RoleId: uint64(helper.ID),
	})
	if !errors.Is(err, roles.ErrPermissionDenied) {
		t.Fatalf("invite for a role above the creator = %v, want permission denied", err)
	}
}

// TestKickRevokesTheChatTokenImmediately checks that a kicked user's HTTP
// bearer dies with the decision, not whenever the final control frame happens
// to flush. The session is registered but its Serve loop is not started, so
// Unregister cannot run and only the explicit revocation can invalidate the
// token.
func TestKickRevokesTheChatTokenImmediately(t *testing.T) {
	fixture := newPlaneFixture(t)
	ctx := context.Background()

	session, err := state.NewSession(state.SessionParams{
		UserID:      1,
		PublicKeyID: "key-1",
		Nickname:    "user1",
		RoleIDs:     fixture.roles.RoleIDs(1),
		ConnectedAt: time.Unix(1_700_000_000, 0),
		Transport:   newQueueTransport(),
	})
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	if _, err := fixture.hub.Register(session); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if err := fixture.hub.Welcome(session, 1, func(users []state.Presence) *rostalkv1.ServerSnapshot {
		return fixture.plane.Snapshot(session, users, fixture.plane.PrepareSnapshot(context.Background(), session))
	}); err != nil {
		t.Fatalf("Welcome: %v", err)
	}
	token := session.HTTPToken()
	if token == "" {
		t.Fatal("the session did not receive a chat token")
	}

	admin := actor{subject: fixture.roles.Subject(2), userID: 2, name: "user2"}
	if _, err := fixture.plane.adminKick(ctx, admin, &rostalkv1.MemberKick{UserId: 1}); err != nil {
		t.Fatalf("kick: %v", err)
	}
	if _, err := fixture.tokens.Lookup(token); !errors.Is(err, sessionauth.ErrInvalid) {
		t.Fatalf("chat token after kick = %v, want invalid", err)
	}
}

// registerBareSession makes a user online without starting the Serve loop, so
// a test can inspect moderation effects without the request loop racing it.
func registerBareSession(t *testing.T, f *planeFixture, userID int64) *state.Session {
	t.Helper()
	session, err := state.NewSession(state.SessionParams{
		UserID:      userID,
		PublicKeyID: "key",
		Nickname:    "user1",
		RoleIDs:     f.roles.RoleIDs(userID),
		ConnectedAt: time.Unix(1_700_000_000, 0),
		Transport:   newQueueTransport(),
	})
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	if _, err := f.hub.Register(session); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if err := f.hub.Welcome(session, 1, func(users []state.Presence) *rostalkv1.ServerSnapshot {
		return f.plane.Snapshot(session, users, f.plane.PrepareSnapshot(context.Background(), session))
	}); err != nil {
		t.Fatalf("Welcome: %v", err)
	}
	return session
}

// TestMoveIntoPasswordChannelIsRejected covers the gap the "move checks the
// destination like a join" comment promised but did not implement: a
// moderator may not place a user in a password-protected channel the user
// cannot open without the password.
func TestMoveIntoPasswordChannelIsRejected(t *testing.T) {
	fixture := newPlaneFixture(t)
	ctx := context.Background()
	registerBareSession(t, fixture, 1)

	protected, err := fixture.channels.Create(ctx, channels.CreateParams{
		Name:     "Secret",
		Kind:     rostalkv1.ChannelKind_CHANNEL_KIND_VOICE,
		Password: "open sesame",
	})
	if err != nil {
		t.Fatalf("create protected channel: %v", err)
	}

	admin := actor{subject: fixture.roles.Subject(2), userID: 2, name: "user2"}
	_, err = fixture.plane.adminMove(ctx, admin, &rostalkv1.MemberMove{
		UserId:    1,
		ChannelId: uint64(protected.ID),
	})
	if !errors.Is(err, roles.ErrPermissionDenied) {
		t.Fatalf("move into a password channel = %v, want permission denied", err)
	}
	if presence, ok := fixture.hub.Presence(1); !ok || presence.ChannelID != 0 {
		t.Fatalf("the rejected move changed the presence: %+v", presence)
	}
}

// TestMoveIntoIdleChannelAppliesTheMute checks that AFK is a channel policy,
// not a side effect of the client's JoinChannel handler.
func TestMoveIntoIdleChannelAppliesTheMute(t *testing.T) {
	fixture := newPlaneFixture(t)
	ctx := context.Background()
	registerBareSession(t, fixture, 1)

	list := fixture.channels.List()
	var afk int64
	for _, channel := range list {
		if channel.AFK {
			afk = channel.ID
			break
		}
	}
	if afk == 0 {
		t.Fatal("the fixture has no idle channel")
	}

	admin := actor{subject: fixture.roles.Subject(2), userID: 2, name: "user2"}
	if _, err := fixture.plane.adminMove(ctx, admin, &rostalkv1.MemberMove{
		UserId:    1,
		ChannelId: uint64(afk),
	}); err != nil {
		t.Fatalf("move into AFK: %v", err)
	}
	presence, ok := fixture.hub.Presence(1)
	if !ok || presence.ChannelID != uint64(afk) {
		t.Fatalf("presence after move = %+v", presence)
	}
	if !presence.Voice.SelfMuted {
		t.Fatal("a user moved into AFK was not muted")
	}
	calls := fixture.media.SourceCalls(media.SourceMicrophone)
	if len(calls) == 0 || calls[len(calls)-1].CanPublish {
		t.Fatalf("publishing was not disabled in AFK: %+v", calls)
	}
}

// TestPermissionChangeKeepsIdleMute guards the other AFK bypass: a role or
// override change runs syncMedia, which used to grant canPublish to an AFK
// occupant because it looked only at speak and server mute.
func TestPermissionChangeKeepsIdleMute(t *testing.T) {
	fixture := newPlaneFixture(t)
	ctx := context.Background()
	registerBareSession(t, fixture, 1)

	list := fixture.channels.List()
	var afk int64
	for _, channel := range list {
		if channel.AFK {
			afk = channel.ID
			break
		}
	}
	admin := actor{subject: fixture.roles.Subject(2), userID: 2, name: "user2"}
	if _, err := fixture.plane.adminMove(ctx, admin, &rostalkv1.MemberMove{
		UserId:    1,
		ChannelId: uint64(afk),
	}); err != nil {
		t.Fatalf("move into AFK: %v", err)
	}

	fixture.media.Reset()
	fixture.plane.afterRoleChange(ctx, fixture.plane.captureVisibility())
	for _, call := range fixture.media.SourceCalls(media.SourceMicrophone) {
		if call.Identity == "1:voice" && call.CanPublish {
			t.Fatal("a permission recalculation unmuted an AFK occupant")
		}
	}
}

// TestInviteForOwnRightsStillWorks guards against over-blocking: the same
// moderator may invite for a role whose permissions are a subset of theirs.
func TestInviteForOwnRightsStillWorks(t *testing.T) {
	fixture := newPlaneFixture(t)
	ctx := context.Background()

	moderatorRole, ok := fixture.roles.RoleByName(roles.ModeratorName)
	if !ok {
		t.Fatal("the Moderator role is missing")
	}
	if err := fixture.roles.Assign(ctx, roles.System, 1, moderatorRole.ID); err != nil {
		t.Fatalf("assign Moderator: %v", err)
	}
	member, ok := fixture.roles.RoleByName(roles.MemberName)
	if !ok {
		t.Fatal("the Member role is missing")
	}

	actor := actor{
		subject: fixture.roles.Subject(1),
		userID:  1,
		name:    "user1",
	}
	if _, err := fixture.plane.adminInviteCreate(ctx, actor, &rostalkv1.InviteCreate{
		RoleId: uint64(member.ID),
	}); err != nil {
		t.Fatalf("invite for a subset role: %v", err)
	}
}
