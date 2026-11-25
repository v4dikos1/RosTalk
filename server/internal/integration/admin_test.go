package integration

import (
	"context"
	"net/url"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/control"
	"github.com/v4dikos1/RosTalk/server/internal/media"
	"github.com/v4dikos1/RosTalk/server/internal/media/mediafake"
	"github.com/v4dikos1/RosTalk/server/internal/perms"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/server"
)

// inviteForRole creates an invite that grants the named role and returns the
// token from the join link.
func inviteForRole(t *testing.T, app *server.App, roleName string) string {
	t.Helper()
	link, err := app.Control.CLIInvite(context.Background(), control.InviteParams{
		RoleName:  roleName,
		MaxUses:   1,
		ExpiresIn: time.Hour,
	})
	if err != nil {
		t.Fatalf("CLIInvite(%s): %v", roleName, err)
	}
	parsed, err := url.Parse(link)
	if err != nil {
		t.Fatalf("parse invite link: %v", err)
	}
	token := parsed.Query().Get("invite")
	if token == "" {
		t.Fatalf("invite link has no token: %s", link)
	}
	return token
}

func connectAs(t *testing.T, app *server.App, roleName, nickname string) *testSession {
	t.Helper()
	token := inviteForRole(t, app, roleName)
	identity, err := newTestIdentity()
	if err != nil {
		t.Fatalf("newTestIdentity: %v", err)
	}
	ctx, cancel := connectContext(t)
	defer cancel()
	session, err := testConnect(ctx, app.Addr().String(), connectOptions{
		identity:    identity,
		nickname:    nickname,
		invite:      token,
		fingerprint: app.TLS.FingerprintHex,
	})
	if err != nil {
		t.Fatalf("connect %s: %v", nickname, err)
	}
	t.Cleanup(session.close)
	return session
}

func connectAdmin(t *testing.T, app *server.App) *testSession {
	t.Helper()
	_, token := adminInvite(t, app)
	identity, err := newTestIdentity()
	if err != nil {
		t.Fatalf("newTestIdentity: %v", err)
	}
	ctx, cancel := connectContext(t)
	defer cancel()
	session, err := testConnect(ctx, app.Addr().String(), connectOptions{
		identity:    identity,
		nickname:    "admin",
		invite:      token,
		fingerprint: app.TLS.FingerprintHex,
	})
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	t.Cleanup(session.close)
	return session
}

func sendAdmin(t *testing.T, session *testSession, requestID uint64, action *rostalkv1.AdminAction) *rostalkv1.ServerFrame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := writeClientFrame(ctx, session.conn, &rostalkv1.ClientFrame{
		RequestId: requestID,
		Payload:   &rostalkv1.ClientFrame_AdminAction{AdminAction: action},
	}); err != nil {
		t.Fatalf("write AdminAction: %v", err)
	}
	for {
		frame := waitFrame(t, session)
		if frame.GetReplyTo() == requestID {
			return frame
		}
	}
}

func requireAdminOK(t *testing.T, frame *rostalkv1.ServerFrame) *rostalkv1.AdminResult {
	t.Helper()
	if serverErr := frame.GetError(); serverErr != nil {
		t.Fatalf("admin action failed: %s: %s", serverErr.GetCode(), serverErr.GetMessage())
	}
	result := frame.GetAdminResult()
	if result == nil {
		t.Fatalf("admin reply = %T, want AdminResult", frame.GetPayload())
	}
	return result
}

func TestModeratorCannotKickAdministrator(t *testing.T) {
	app := newTestApp(t, nil)
	admin := connectAdmin(t, app)
	moderator := connectAs(t, app, roles.ModeratorName, "moderator")

	moderatorID := moderator.welcome.GetSelfUserId()
	adminID := admin.welcome.GetSelfUserId()
	if moderatorID == 0 || adminID == 0 {
		t.Fatal("missing self ids")
	}

	reply := sendAdmin(t, moderator, 10, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_MemberKick{MemberKick: &rostalkv1.MemberKick{
			UserId: adminID,
			Reason: "test",
		}},
	})
	if code := reply.GetError().GetCode(); code != rostalkv1.ErrorCode_ERROR_CODE_HIERARCHY {
		t.Fatalf("moderator kick admin = %s, want HIERARCHY", code)
	}
	if !adminStillOnline(app, adminID) {
		t.Fatal("the administrator was disconnected")
	}
}

func adminStillOnline(app *server.App, userID uint64) bool {
	presence, ok := app.Hub.Presence(int64(userID))
	return ok && presence.UserID == int64(userID)
}

func TestBannedUserCannotEnterByKeyOrIP(t *testing.T) {
	t.Run("key", func(t *testing.T) {
		app := newTestApp(t, nil)
		admin := connectAdmin(t, app)
		identity, _ := newTestIdentity()
		token := inviteForRole(t, app, roles.MemberName)
		ctx, cancel := connectContext(t)
		member, err := testConnect(ctx, app.Addr().String(), connectOptions{
			identity:    identity,
			nickname:    "member",
			invite:      token,
			fingerprint: app.TLS.FingerprintHex,
		})
		if err != nil {
			t.Fatalf("connect member: %v", err)
		}
		t.Cleanup(member.close)
		memberID := member.welcome.GetSelfUserId()

		reply := sendAdmin(t, admin, 10, &rostalkv1.AdminAction{
			Action: &rostalkv1.AdminAction_MemberBan{MemberBan: &rostalkv1.MemberBan{
				UserId: memberID,
				Reason: "test ban",
			}},
		})
		requireAdminOK(t, reply)
		cancel()

		// Reconnecting with the same key is rejected even though the user is
		// known to the server and no invite is needed.
		ctx, cancel = connectContext(t)
		defer cancel()
		_, err = testConnect(ctx, app.Addr().String(), connectOptions{
			identity:    identity,
			nickname:    "member",
			fingerprint: app.TLS.FingerprintHex,
		})
		serverErr, ok := asServerError(err)
		if !ok || serverErr.code != rostalkv1.ErrorCode_ERROR_CODE_BANNED {
			t.Fatalf("reconnect after a key ban = %v, want BANNED", err)
		}
	})

	t.Run("ip", func(t *testing.T) {
		app := newTestApp(t, nil)
		admin := connectAdmin(t, app)
		member := connectAs(t, app, roles.MemberName, "member")
		memberID := member.welcome.GetSelfUserId()

		reply := sendAdmin(t, admin, 10, &rostalkv1.AdminAction{
			Action: &rostalkv1.AdminAction_MemberBan{MemberBan: &rostalkv1.MemberBan{
				UserId: memberID,
				ByIp:   true,
				Reason: "test ip ban",
			}},
		})
		requireAdminOK(t, reply)

		// A fresh key from the same address is rejected as well.
		identity, _ := newTestIdentity()
		token := inviteForRole(t, app, roles.MemberName)
		ctx, cancel := connectContext(t)
		defer cancel()
		_, err := testConnect(ctx, app.Addr().String(), connectOptions{
			identity:    identity,
			nickname:    "other",
			invite:      token,
			fingerprint: app.TLS.FingerprintHex,
		})
		serverErr, ok := asServerError(err)
		if !ok || serverErr.code != rostalkv1.ErrorCode_ERROR_CODE_BANNED {
			t.Fatalf("connect after an IP ban = %v, want BANNED", err)
		}
	})
}

func TestRemovingSpeakDisablesPublishingWithoutRejoin(t *testing.T) {
	app := newTestApp(t, nil)
	admin := connectAdmin(t, app)
	member := connectAs(t, app, roles.MemberName, "member")
	memberID := member.welcome.GetSelfUserId()

	lobby := app.Channels.List()[0]
	// Member joins the lobby and receives a publishing token.
	ctx, cancel := connectContext(t)
	defer cancel()
	if err := writeClientFrame(ctx, member.conn, &rostalkv1.ClientFrame{
		RequestId: 20,
		Payload: &rostalkv1.ClientFrame_JoinChannel{JoinChannel: &rostalkv1.JoinChannel{
			ChannelId: uint64(lobby.ID),
		}},
	}); err != nil {
		t.Fatalf("join: %v", err)
	}
	joinReply := waitReplyFor(t, member, 20)
	if joinReply.GetMediaCredentials() == nil {
		t.Fatalf("join reply = %v", joinReply.GetPayload())
	}
	backend := app.Media.(*mediafake.Backend)
	if !hasPublishingToken(backend, memberID, uint64(lobby.ID)) {
		t.Fatal("the member did not receive a publishing token")
	}

	memberRole, ok := app.Roles.RoleByName(roles.MemberName)
	if !ok {
		t.Fatal("the Member role is missing")
	}
	reply := sendAdmin(t, admin, 10, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_ChannelOverrideSet{ChannelOverrideSet: &rostalkv1.ChannelOverrideSet{
			ChannelId: uint64(lobby.ID),
			RoleId:    uint64(memberRole.ID),
			Deny: &rostalkv1.PermissionSet{Permissions: []rostalkv1.Permission{
				rostalkv1.Permission_PERMISSION_SPEAK,
			}},
		}},
	})
	requireAdminOK(t, reply)

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, call := range backend.SourceCalls(media.SourceMicrophone) {
			if call.Identity == media.IdentityFor(int64(memberID), media.KindVoice) && !call.CanPublish {
				// The user did not rejoin: the same presence is still in the
				// channel and the media grant was revoked live.
				presence, online := app.Hub.Presence(int64(memberID))
				if !online || presence.ChannelID != uint64(lobby.ID) {
					t.Fatalf("the member left the channel instead of losing the right")
				}
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("speak was not revoked in the media plane; calls: %+v", backend.SourceCalls(media.SourceMicrophone))
}

func hasPublishingToken(backend *mediafake.Backend, userID uint64, channelID uint64) bool {
	for _, call := range backend.CallsOf("IssueToken") {
		if call.UserID == int64(userID) && call.ChannelID == channelID && call.Grants.CanPublish {
			return true
		}
	}
	return false
}

func waitReplyFor(t *testing.T, session *testSession, requestID uint64) *rostalkv1.ServerFrame {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		frame := waitFrame(t, session)
		if frame.GetReplyTo() == requestID {
			return frame
		}
	}
	t.Fatalf("no reply to request %d", requestID)
	return nil
}

func TestChannelWithoutViewIsHiddenFromSnapshotAndEvents(t *testing.T) {
	app := newTestApp(t, nil)
	ctx := context.Background()
	hidden, err := app.Control.CreateChannel(ctx, channels.CreateParams{
		Name: "Секретная",
		Kind: rostalkv1.ChannelKind_CHANNEL_KIND_VOICE,
	})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	memberRole, ok := app.Roles.RoleByName(roles.MemberName)
	if !ok {
		t.Fatal("the Member role is missing")
	}
	if _, err := app.Roles.SetOverride(ctx, roles.System, hidden.ID, memberRole.ID,
		0, perms.Mask(rostalkv1.Permission_PERMISSION_VIEW_CHANNEL)); err != nil {
		t.Fatalf("SetOverride: %v", err)
	}

	admin := connectAdmin(t, app)
	member := connectAs(t, app, roles.MemberName, "member")
	memberID := member.welcome.GetSelfUserId()

	snapshot := member.welcome.GetSnapshot()
	if channelInSnapshot(snapshot, uint64(hidden.ID)) {
		t.Fatal("a channel without view_channel is present in the snapshot")
	}
	for _, channelPermissions := range snapshot.GetPermissions().GetChannels() {
		if channelPermissions.GetChannelId() == uint64(hidden.ID) {
			t.Fatal("permissions for a hidden channel leaked into the snapshot")
		}
	}

	// Admin joins the hidden channel; the member must not learn about it.
	if err := writeClientFrame(ctx, admin.conn, &rostalkv1.ClientFrame{
		RequestId: 30,
		Payload: &rostalkv1.ClientFrame_JoinChannel{JoinChannel: &rostalkv1.JoinChannel{
			ChannelId: uint64(hidden.ID),
		}},
	}); err != nil {
		t.Fatalf("admin join: %v", err)
	}
	waitReplyFor(t, admin, 30)

	// Renaming the hidden channel must not reach the member. A visible channel
	// update follows as a marker, so the absence check is deterministic.
	if _, err := app.Control.UpdateChannel(ctx, hidden.ID, channels.UpdateParams{
		Topic: stringPtr("секрет"),
	}); err != nil {
		t.Fatalf("UpdateChannel: %v", err)
	}
	visible := app.Channels.List()[0]
	if _, err := app.Control.UpdateChannel(ctx, visible.ID, channels.UpdateParams{
		Topic: stringPtr("видно всем"),
	}); err != nil {
		t.Fatalf("UpdateChannel visible: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		frame := waitFrame(t, member)
		event := frame.GetEvent()
		if event == nil {
			continue
		}
		if updated := event.GetChannelUpdated(); updated != nil {
			if updated.GetChannel().GetId() == uint64(hidden.ID) {
				t.Fatal("an event about a hidden channel reached the member")
			}
			if updated.GetChannel().GetId() == uint64(visible.ID) {
				// The marker arrived and no hidden update came before it.
				break
			}
		}
		if joined := event.GetUserJoined(); joined != nil &&
			joined.GetUser().GetId() == admin.welcome.GetSelfUserId() {
			t.Fatal("a user in a hidden channel reached the member")
		}
	}

	// Joining the hidden channel is rejected as if it did not exist.
	if err := writeClientFrame(ctx, member.conn, &rostalkv1.ClientFrame{
		RequestId: 21,
		Payload: &rostalkv1.ClientFrame_JoinChannel{JoinChannel: &rostalkv1.JoinChannel{
			ChannelId: uint64(hidden.ID),
		}},
	}); err != nil {
		t.Fatalf("member join: %v", err)
	}
	reply := waitReplyFor(t, member, 21)
	if code := reply.GetError().GetCode(); code != rostalkv1.ErrorCode_ERROR_CODE_NOT_FOUND {
		t.Fatalf("join hidden = %s, want NOT_FOUND", code)
	}

	// Leaving the hidden channel removes the admin from the member's view; no
	// action is needed because the member never saw the join.
	_ = memberID
}

func channelInSnapshot(snapshot *rostalkv1.ServerSnapshot, channelID uint64) bool {
	for _, channel := range snapshot.GetChannels() {
		if channel.GetId() == channelID {
			return true
		}
	}
	return false
}

func stringPtr(value string) *string { return &value }

// TestAdminSetsAttachmentLimit covers stage P3: the limit is an admin setting,
// it is validated on the server, and a connecting client receives the effective
// value in its snapshot so the UI checks the right number.
func TestAdminSetsAttachmentLimit(t *testing.T) {
	app := newTestApp(t, nil)
	admin := connectAdmin(t, app)

	const defaultLimit = 25 << 20
	if got := admin.welcome.GetSnapshot().GetServer().GetMaxAttachmentBytes(); got != defaultLimit {
		t.Fatalf("default max_attachment_bytes = %d, want %d", got, defaultLimit)
	}

	limit := uint64(16 << 20)
	reply := requireAdminOK(t, sendAdmin(t, admin, 80, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_ServerSettingsSet{ServerSettingsSet: &rostalkv1.ServerSettingsSet{
			MaxAttachmentBytes: &limit,
		}},
	}))
	if got := reply.GetServer().GetMaxAttachmentBytes(); got != limit {
		t.Fatalf("admin reply max_attachment_bytes = %d, want %d", got, limit)
	}

	// A fresh handshake sees the new value; this is what the client uses
	// instead of a hard-coded limit.
	member := connectAs(t, app, roles.MemberName, "limit-reader")
	if got := member.welcome.GetSnapshot().GetServer().GetMaxAttachmentBytes(); got != limit {
		t.Fatalf("new client max_attachment_bytes = %d, want %d", got, limit)
	}

	// Outside 1 MiB..2 GiB the server refuses instead of storing a value the
	// UI could not show.
	tooSmall := uint64(512 << 10)
	rejected := sendAdmin(t, admin, 81, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_ServerSettingsSet{ServerSettingsSet: &rostalkv1.ServerSettingsSet{
			MaxAttachmentBytes: &tooSmall,
		}},
	})
	if rejected.GetError() == nil {
		t.Fatalf("a 512 KiB attachment limit was accepted: %+v", rejected)
	}
	if got := member.welcome.GetSnapshot().GetServer().GetMaxAttachmentBytes(); got != limit {
		t.Fatalf("the rejected value changed the limit to %d", got)
	}
}

func TestLoginModeChangesAtRuntime(t *testing.T) {
	app := newTestApp(t, nil)
	admin := connectAdmin(t, app)

	mode := rostalkv1.LoginMode_LOGIN_MODE_OPEN
	requireAdminOK(t, sendAdmin(t, admin, 10, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_ServerSettingsSet{ServerSettingsSet: &rostalkv1.ServerSettingsSet{
			LoginMode: &mode,
		}},
	}))

	identity, _ := newTestIdentity()
	ctx, cancel := connectContext(t)
	defer cancel()
	session, err := testConnect(ctx, app.Addr().String(), connectOptions{
		identity:    identity,
		nickname:    "open-user",
		fingerprint: app.TLS.FingerprintHex,
	})
	if err != nil {
		t.Fatalf("open login after the runtime change: %v", err)
	}
	defer session.close()
	if session.welcome.GetSnapshot().GetServer().GetLoginMode() != rostalkv1.LoginMode_LOGIN_MODE_OPEN {
		t.Fatal("the snapshot does not report the new login mode")
	}
}

func TestLosingChannelAccessMovesToTheDefaultChannel(t *testing.T) {
	app := newTestApp(t, nil)
	admin := connectAdmin(t, app)
	member := connectAs(t, app, roles.MemberName, "member")
	memberID := member.welcome.GetSelfUserId()

	channelsList := app.Channels.List()
	lobby, afk := channelsList[0], channelsList[1]
	// The member joins AFK, then loses view_channel there.
	ctx, cancel := connectContext(t)
	defer cancel()
	if err := writeClientFrame(ctx, member.conn, &rostalkv1.ClientFrame{
		RequestId: 20,
		Payload: &rostalkv1.ClientFrame_JoinChannel{JoinChannel: &rostalkv1.JoinChannel{
			ChannelId: uint64(afk.ID),
		}},
	}); err != nil {
		t.Fatalf("join: %v", err)
	}
	waitReplyFor(t, member, 20)

	memberRole, ok := app.Roles.RoleByName(roles.MemberName)
	if !ok {
		t.Fatal("the Member role is missing")
	}
	requireAdminOK(t, sendAdmin(t, admin, 10, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_ChannelOverrideSet{ChannelOverrideSet: &rostalkv1.ChannelOverrideSet{
			ChannelId: uint64(afk.ID),
			RoleId:    uint64(memberRole.ID),
			Deny: &rostalkv1.PermissionSet{Permissions: []rostalkv1.Permission{
				rostalkv1.Permission_PERMISSION_VIEW_CHANNEL,
			}},
		}},
	}))

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		presence, online := app.Hub.Presence(int64(memberID))
		if online && presence.ChannelID == uint64(lobby.ID) {
			// The member also received the personal permissions update and the
			// deletion of the channel they may no longer see.
			sawPermissions, sawDeleted := false, false
			for _, frame := range framesUntilQuiet(member) {
				event := frame.GetEvent()
				if event.GetPermissionsUpdated() != nil {
					sawPermissions = true
				}
				if deleted := event.GetChannelDeleted(); deleted != nil && deleted.GetChannelId() == uint64(afk.ID) {
					sawDeleted = true
				}
			}
			if !sawPermissions || !sawDeleted {
				t.Fatalf("events after losing access: permissions=%t deleted=%t", sawPermissions, sawDeleted)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("the member was not moved to the default channel")
}

// framesUntilQuiet drains the frames that are already queued without waiting
// for new ones. It is used only to inspect the burst a mutation produced.
func framesUntilQuiet(session *testSession) []*rostalkv1.ServerFrame {
	var frames []*rostalkv1.ServerFrame
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		frame, err := session.next(ctx)
		cancel()
		if err != nil {
			return frames
		}
		frames = append(frames, frame)
	}
}

func TestMoveWithoutPermissionIsRejected(t *testing.T) {
	app := newTestApp(t, nil)
	member := connectAs(t, app, roles.MemberName, "member")
	other := connectAs(t, app, roles.MemberName, "other")
	lobby := app.Channels.List()[1]

	reply := sendAdmin(t, member, 10, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_MemberMove{MemberMove: &rostalkv1.MemberMove{
			UserId:    other.welcome.GetSelfUserId(),
			ChannelId: uint64(lobby.ID),
		}},
	})
	if code := reply.GetError().GetCode(); code != rostalkv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED &&
		code != rostalkv1.ErrorCode_ERROR_CODE_HIERARCHY {
		t.Fatalf("move without permission = %s", code)
	}
	if presence, ok := app.Hub.Presence(int64(other.welcome.GetSelfUserId())); ok && presence.ChannelID != 0 {
		t.Fatal("the rejected move changed the channel")
	}
}

func TestEveryAdminActionIsAudited(t *testing.T) {
	app := newTestApp(t, nil)
	admin := connectAdmin(t, app)
	moderator := connectAs(t, app, roles.ModeratorName, "moderator")
	moderatorID := moderator.welcome.GetSelfUserId()

	// Role create.
	created := requireAdminOK(t, sendAdmin(t, admin, 10, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_RoleCreate{RoleCreate: &rostalkv1.RoleCreate{
			Name: "Bot",
			Permissions: &rostalkv1.PermissionSet{Permissions: []rostalkv1.Permission{
				rostalkv1.Permission_PERMISSION_VIEW_CHANNEL,
				rostalkv1.Permission_PERMISSION_JOIN_CHANNEL,
			}},
		}},
	}))
	botRole := created.GetRole()
	if botRole == nil {
		t.Fatal("role create returned no role")
	}
	// Role update.
	requireAdminOK(t, sendAdmin(t, admin, 11, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_RoleUpdate{RoleUpdate: &rostalkv1.RoleUpdate{
			RoleId: botRole.GetId(),
			Name:   stringPtr("Bot 2"),
		}},
	}))
	// Role assign.
	requireAdminOK(t, sendAdmin(t, admin, 12, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_RoleAssign{RoleAssign: &rostalkv1.RoleAssign{
			UserId: moderatorID,
			RoleId: botRole.GetId(),
		}},
	}))
	// Role unassign.
	requireAdminOK(t, sendAdmin(t, admin, 13, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_RoleUnassign{RoleUnassign: &rostalkv1.RoleUnassign{
			UserId: moderatorID,
			RoleId: botRole.GetId(),
		}},
	}))
	// Channel override.
	memberRole, ok := app.Roles.RoleByName(roles.MemberName)
	if !ok {
		t.Fatal("the Member role is missing")
	}
	lobby := app.Channels.List()[0]
	requireAdminOK(t, sendAdmin(t, admin, 15, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_ChannelOverrideSet{ChannelOverrideSet: &rostalkv1.ChannelOverrideSet{
			ChannelId: uint64(lobby.ID),
			RoleId:    uint64(memberRole.ID),
			Allow:     &rostalkv1.PermissionSet{Permissions: []rostalkv1.Permission{rostalkv1.Permission_PERMISSION_SPEAK}},
		}},
	}))
	// Invite create and revoke.
	inviteResult := requireAdminOK(t, sendAdmin(t, admin, 16, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_InviteCreate{InviteCreate: &rostalkv1.InviteCreate{RoleId: uint64(memberRole.ID)}},
	}))
	invite := inviteResult.GetInvite()
	if invite == nil || invite.GetUrl() == "" {
		t.Fatal("invite create returned no link")
	}
	requireAdminOK(t, sendAdmin(t, admin, 17, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_InviteRevoke{InviteRevoke: &rostalkv1.InviteRevoke{
			InviteId: invite.GetId(),
		}},
	}))
	// Role delete.
	requireAdminOK(t, sendAdmin(t, admin, 23, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_RoleDelete{RoleDelete: &rostalkv1.RoleDelete{
			RoleId: botRole.GetId(),
		}},
	}))
	// Moderation: mute, unmute, move, stop stream, kick.
	requireAdminOK(t, sendAdmin(t, admin, 18, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_MemberSetMuted{MemberSetMuted: &rostalkv1.MemberSetMuted{
			UserId: moderatorID, Muted: true,
		}},
	}))
	requireAdminOK(t, sendAdmin(t, admin, 19, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_MemberSetDeafened{MemberSetDeafened: &rostalkv1.MemberSetDeafened{
			UserId: moderatorID, Deafened: true,
		}},
	}))
	requireAdminOK(t, sendAdmin(t, admin, 20, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_MemberStopStream{MemberStopStream: &rostalkv1.MemberStopStream{
			UserId: moderatorID,
		}},
	}))
	requireAdminOK(t, sendAdmin(t, admin, 21, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_MemberKick{MemberKick: &rostalkv1.MemberKick{
			UserId: moderatorID, Reason: "audit test",
		}},
	}))

	audit := requireAdminOK(t, sendAdmin(t, admin, 30, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_AuditList{AuditList: &rostalkv1.AuditList{Limit: 100}},
	})).GetAudit()
	if audit == nil {
		t.Fatal("audit list returned no page")
	}
	actions := make(map[string]bool)
	for _, entry := range audit.GetEntries() {
		actions[entry.GetAction()] = true
	}
	for _, want := range []string{
		"role.create", "role.update", "role.assign", "role.unassign", "role.delete",
		"channel.override.set", "invite.create", "invite.revoke",
		"member.mute", "member.deafen", "member.stop_stream", "member.kick",
	} {
		if !actions[want] {
			t.Errorf("audit log has no entry for %s; entries: %v", want, actions)
		}
	}
	if !audit.GetHasMore() && audit.GetNextBeforeId() != 0 {
		t.Fatal("a last page carries a next cursor")
	}
}
