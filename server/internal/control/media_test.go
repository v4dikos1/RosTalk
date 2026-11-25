package control

import (
	"context"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/media"
	"github.com/v4dikos1/RosTalk/server/internal/media/mediafake"
	"github.com/v4dikos1/RosTalk/server/internal/perms"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
)

// mediaCall aliases the recorded backend call for readable assertions.
type mediaCall = mediafake.Call

// waitForMediaCall blocks until a recorded call matches. The handlers make
// media calls often from a deferred cleanup, so a test cannot assume they
// finished when the reply arrives.
func waitForMediaCall(t *testing.T, fixture *planeFixture, method string, match func(mediaCall) bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, call := range fixture.media.CallsOf(method) {
			if match(call) {
				return
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("no %s call matched; recorded: %+v", method, fixture.media.CallsOf(method))
}

// otherChannel returns a second voice channel (the default AFK channel).
func (f *planeFixture) otherChannel(t *testing.T) channels.Channel {
	t.Helper()
	for _, channel := range f.channels.List() {
		if channel.ID != f.lobby.ID && channel.Kind == rostalkv1.ChannelKind_CHANNEL_KIND_VOICE {
			return channel
		}
	}
	t.Fatal("the fixture has no second voice channel")
	return channels.Channel{}
}

func channelParams(name string) channels.CreateParams {
	return channels.CreateParams{Name: name}
}

// waitFor polls a condition.
func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("condition was not met in time")
}

func TestJoinChannelReturnsMediaCredentials(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	fixture.start(t, transport, 1, false)

	credentials := requireCredentials(t, waitReply(t, transport, 3))
	if credentials.GetRoom() != media.RoomName(uint64(fixture.lobby.ID)) {
		t.Fatalf("room = %q, want %q", credentials.GetRoom(), media.RoomName(uint64(fixture.lobby.ID)))
	}
	if credentials.GetParticipantIdentity() != "1:voice" {
		t.Fatalf("identity = %q, want 1:voice", credentials.GetParticipantIdentity())
	}
	if credentials.GetUrl() != "wss://127.0.0.1:7443/rtc" {
		t.Fatalf("url = %q", credentials.GetUrl())
	}
	if credentials.GetExpiresInSeconds() != 60 {
		t.Fatalf("expires in %d s, want 60", credentials.GetExpiresInSeconds())
	}
	if credentials.GetKind() != rostalkv1.MediaKind_MEDIA_KIND_VOICE {
		t.Fatalf("kind = %v", credentials.GetKind())
	}
	if credentials.GetChannelId() != uint64(fixture.lobby.ID) {
		t.Fatalf("channel = %d", credentials.GetChannelId())
	}
	if credentials.GetToken() == "" {
		t.Fatal("credentials carry no token")
	}

	if calls := fixture.media.CallsOf("EnsureRoom"); len(calls) != 1 {
		t.Fatalf("EnsureRoom calls = %+v, want one", calls)
	}
	tokens := fixture.media.CallsOf("IssueToken")
	if len(tokens) != 1 {
		t.Fatalf("IssueToken calls = %+v, want one", tokens)
	}
	if !tokens[0].Grants.CanPublish {
		t.Fatal("speak did not become canPublish")
	}
	// A Member holds speak and stream: the voice participant may publish the
	// microphone and the stream audio the core captures (ADR 0027).
	if got := tokens[0].Grants.PublishSources; len(got) != 2 ||
		got[0] != media.SourceMicrophone || got[1] != media.SourceScreenShareAudio {
		t.Fatalf("publish sources = %v, want [microphone screen_share_audio]", got)
	}
	if !tokens[0].Grants.CanSubscribe {
		t.Fatal("voice token cannot subscribe")
	}
}

func TestJoinWithoutSpeakIssuesNonPublishingToken(t *testing.T) {
	fixture := newPlaneFixture(t)
	member, ok := fixture.roles.RoleByName(roles.MemberName)
	if !ok {
		t.Fatal("the Member role is missing")
	}
	if _, err := fixture.roles.SetOverride(context.Background(), roles.System, fixture.lobby.ID, member.ID,
		0, perms.Mask(rostalkv1.Permission_PERMISSION_SPEAK)); err != nil {
		t.Fatalf("SetOverride: %v", err)
	}
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))

	tokens := fixture.media.CallsOf("IssueToken")
	if len(tokens) != 1 {
		t.Fatalf("IssueToken calls = %+v", tokens)
	}
	if hasSource(tokens[0].Grants.PublishSources, media.SourceMicrophone) {
		t.Fatal("a user without the speak right may publish the microphone")
	}
	// The stream right is independent of speak: the stream audio stays.
	if got := tokens[0].Grants.PublishSources; len(got) != 1 || got[0] != media.SourceScreenShareAudio {
		t.Fatalf("publish sources = %v, want [screen_share_audio]", got)
	}
}

// TestVoiceTokenStreamAudioRequiresStream guards ADR 0027 on the server: the
// voice participant may publish screen_share_audio only with the stream right
// in that channel. Without speak and stream the token publishes nothing.
func TestVoiceTokenStreamAudioRequiresStream(t *testing.T) {
	fixture := newPlaneFixture(t)
	member, ok := fixture.roles.RoleByName(roles.MemberName)
	if !ok {
		t.Fatal("the Member role is missing")
	}
	if _, err := fixture.roles.SetOverride(context.Background(), roles.System, fixture.lobby.ID, member.ID,
		0, perms.Mask(rostalkv1.Permission_PERMISSION_STREAM)); err != nil {
		t.Fatalf("SetOverride: %v", err)
	}
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))

	tokens := fixture.media.CallsOf("IssueToken")
	if len(tokens) != 1 {
		t.Fatalf("IssueToken calls = %+v", tokens)
	}
	if got := tokens[0].Grants.PublishSources; len(got) != 1 || got[0] != media.SourceMicrophone {
		t.Fatalf("publish sources without stream = %v, want [microphone]", got)
	}

	// Speak denied as well: nothing to publish at all.
	if _, err := fixture.roles.SetOverride(context.Background(), roles.System, fixture.lobby.ID, member.ID,
		0, perms.Mask(rostalkv1.Permission_PERMISSION_STREAM, rostalkv1.Permission_PERMISSION_SPEAK)); err != nil {
		t.Fatalf("SetOverride: %v", err)
	}
	fixture.media.Reset()
	transport.push(&rostalkv1.ClientFrame{
		RequestId: 7,
		Payload: &rostalkv1.ClientFrame_RequestMediaCredentials{
			RequestMediaCredentials: &rostalkv1.RequestMediaCredentials{
				ChannelId: uint64(fixture.lobby.ID),
				Kind:      rostalkv1.MediaKind_MEDIA_KIND_VOICE,
			},
		},
	})
	requireCredentials(t, waitReply(t, transport, 7))
	tokens = fixture.media.CallsOf("IssueToken")
	if len(tokens) != 1 || tokens[0].Grants.CanPublish || len(tokens[0].Grants.PublishSources) != 0 {
		t.Fatalf("token without speak and stream = %+v", tokens)
	}
}

// TestStreamRevocationWithdrawsVoiceStreamAudio checks the live side: a role
// change that removes the stream right withdraws screen_share_audio from the
// connected voice participant (the SFU then removes the track), and granting
// it back restores the source. The microphone is untouched by it.
func TestStreamRevocationWithdrawsVoiceStreamAudio(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))
	member, ok := fixture.roles.RoleByName(roles.MemberName)
	if !ok {
		t.Fatal("the Member role is missing")
	}

	fixture.media.Reset()
	if _, err := fixture.roles.SetOverride(context.Background(), roles.System, fixture.lobby.ID, member.ID,
		0, perms.Mask(rostalkv1.Permission_PERMISSION_STREAM)); err != nil {
		t.Fatalf("SetOverride: %v", err)
	}
	fixture.plane.afterRoleChange(context.Background(), fixture.plane.captureVisibility())
	audio := fixture.media.SourceCalls(media.SourceScreenShareAudio)
	if len(audio) == 0 || audio[len(audio)-1].CanPublish || audio[len(audio)-1].Identity != "1:voice" {
		t.Fatalf("stream audio grant after revoking stream = %+v", audio)
	}
	mic := fixture.media.SourceCalls(media.SourceMicrophone)
	if len(mic) == 0 || !mic[len(mic)-1].CanPublish {
		t.Fatalf("revoking stream touched the microphone: %+v", mic)
	}

	fixture.media.Reset()
	if _, err := fixture.roles.SetOverride(context.Background(), roles.System, fixture.lobby.ID, member.ID,
		0, 0); err != nil {
		t.Fatalf("SetOverride: %v", err)
	}
	fixture.plane.afterRoleChange(context.Background(), fixture.plane.captureVisibility())
	audio = fixture.media.SourceCalls(media.SourceScreenShareAudio)
	if len(audio) == 0 || !audio[len(audio)-1].CanPublish {
		t.Fatalf("stream audio grant after restoring stream = %+v", audio)
	}
}

func hasSource(sources []media.Source, want media.Source) bool {
	for _, source := range sources {
		if source == want {
			return true
		}
	}
	return false
}

func TestLeaveChannelRemovesMediaParticipants(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))
	fixture.media.Reset()

	transport.push(leaveFrame(4))
	if reply := waitReply(t, transport, 4); reply.GetAck() == nil {
		t.Fatalf("leave reply = %v, want Ack", reply.GetPayload())
	}
	waitForMediaCall(t, fixture, "RemoveParticipant", func(call mediaCall) bool {
		return call.Identity == "1:voice" && call.Room == media.RoomName(uint64(fixture.lobby.ID))
	})
	waitForMediaCall(t, fixture, "RemoveParticipant", func(call mediaCall) bool {
		return call.Identity == "1:stream" && call.Room == media.RoomName(uint64(fixture.lobby.ID))
	})
}

func TestMoveRemovesOldRoomParticipant(t *testing.T) {
	fixture := newPlaneFixture(t)
	other, err := fixture.plane.CreateChannel(context.Background(), channelParams("Другая"))
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))
	fixture.media.Reset()

	transport.push(joinFrame(4, uint64(other.ID)))
	credentials := requireCredentials(t, waitReply(t, transport, 4))
	if credentials.GetRoom() != media.RoomName(uint64(other.ID)) {
		t.Fatalf("room = %q, want the new channel", credentials.GetRoom())
	}
	waitForMediaCall(t, fixture, "RemoveParticipant", func(call mediaCall) bool {
		return call.Room == media.RoomName(uint64(fixture.lobby.ID)) && call.Identity == "1:voice"
	})
}

func TestDisconnectRemovesMediaAfterGrace(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	session := fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))
	fixture.media.Reset()

	// The control connection drops: media must survive the grace period and
	// then be cleaned up.
	_ = transport.Close()
	waitFor(t, func() bool {
		_, online := fixture.hub.Presence(1)
		return !online
	})
	if removed := fixture.media.CallsOf("RemoveParticipant"); len(removed) != 0 {
		t.Fatalf("media removed before the grace: %+v", removed)
	}
	_ = session
	waitForMediaCall(t, fixture, "RemoveParticipant", func(call mediaCall) bool {
		return call.Identity == "1:voice" && call.Room == media.RoomName(uint64(fixture.lobby.ID))
	})
}

func TestServerMuteDisablesPublishing(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))
	fixture.media.Reset()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := fixture.plane.SetServerMuted(ctx, 1, true); err != nil {
		t.Fatalf("SetServerMuted: %v", err)
	}
	calls := fixture.media.SourceCalls(media.SourceMicrophone)
	if len(calls) != 1 || calls[0].CanPublish || calls[0].Identity != "1:voice" {
		t.Fatalf("microphone grant calls = %+v", calls)
	}

	// A token issued while muted cannot publish either.
	transport.push(&rostalkv1.ClientFrame{
		RequestId: 7,
		Payload: &rostalkv1.ClientFrame_RequestMediaCredentials{
			RequestMediaCredentials: &rostalkv1.RequestMediaCredentials{
				ChannelId: uint64(fixture.lobby.ID),
				Kind:      rostalkv1.MediaKind_MEDIA_KIND_VOICE,
			},
		},
	})
	requireCredentials(t, waitReply(t, transport, 7))
	tokens := fixture.media.CallsOf("IssueToken")
	if len(tokens) != 1 || hasSource(tokens[0].Grants.PublishSources, media.SourceMicrophone) {
		t.Fatalf("muted user may publish the microphone: %+v", tokens)
	}
	// A server mute silences the microphone, not the stream audio (ADR 0027).
	if !hasSource(tokens[0].Grants.PublishSources, media.SourceScreenShareAudio) {
		t.Fatalf("a server mute removed the stream audio: %+v", tokens)
	}
	if calls := fixture.media.SourceCalls(media.SourceScreenShareAudio); len(calls) != 0 {
		t.Fatalf("a server mute touched the stream audio grant: %+v", calls)
	}

	// Unmuting restores publishing.
	if err := fixture.plane.SetServerMuted(ctx, 1, false); err != nil {
		t.Fatalf("SetServerMuted(false): %v", err)
	}
	calls = fixture.media.SourceCalls(media.SourceMicrophone)
	if len(calls) != 2 || !calls[1].CanPublish {
		t.Fatalf("microphone grant calls = %+v", calls)
	}
}

func TestRequestMediaCredentialsRejectsForeignChannel(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))
	fixture.media.Reset()

	afk := fixture.otherChannel(t)
	transport.push(&rostalkv1.ClientFrame{
		RequestId: 9,
		Payload: &rostalkv1.ClientFrame_RequestMediaCredentials{
			RequestMediaCredentials: &rostalkv1.RequestMediaCredentials{
				ChannelId: uint64(afk.ID),
				Kind:      rostalkv1.MediaKind_MEDIA_KIND_STREAM,
			},
		},
	})
	reply := waitReply(t, transport, 9)
	if reply.GetError() == nil {
		t.Fatalf("a token for a foreign channel was issued: %+v", reply.GetPayload())
	}
	if reply.GetError().GetCode() != rostalkv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatalf("error = %v, want PERMISSION_DENIED", reply.GetError().GetCode())
	}
	if calls := fixture.media.CallsOf("IssueToken"); len(calls) != 0 {
		t.Fatalf("IssueToken was called for a foreign channel: %+v", calls)
	}
}

func TestRequestStreamCredentials(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))
	fixture.media.Reset()

	transport.push(&rostalkv1.ClientFrame{
		RequestId: 9,
		Payload: &rostalkv1.ClientFrame_RequestMediaCredentials{
			RequestMediaCredentials: &rostalkv1.RequestMediaCredentials{
				ChannelId: uint64(fixture.lobby.ID),
				Kind:      rostalkv1.MediaKind_MEDIA_KIND_STREAM,
			},
		},
	})
	credentials := requireCredentials(t, waitReply(t, transport, 9))
	if credentials.GetParticipantIdentity() != "1:stream" {
		t.Fatalf("identity = %q, want 1:stream", credentials.GetParticipantIdentity())
	}
	if credentials.GetKind() != rostalkv1.MediaKind_MEDIA_KIND_STREAM {
		t.Fatalf("kind = %v", credentials.GetKind())
	}
	// The fixture user is a Member: PERMISSION_STREAM is held, STREAM_HQ is not,
	// so only the base presets are advertised.
	presets := credentials.GetStreamPresets()
	wantPresets := []string{"720p30", "1080p30"}
	if len(presets) != len(wantPresets) {
		t.Fatalf("stream presets = %v, want %v", presets, wantPresets)
	}
	for i, want := range wantPresets {
		if presets[i] != want {
			t.Fatalf("stream presets = %v, want %v", presets, wantPresets)
		}
	}
	tokens := fixture.media.CallsOf("IssueToken")
	if len(tokens) != 1 || !tokens[0].Grants.CanPublish {
		t.Fatalf("IssueToken calls = %+v", tokens)
	}
	sources := tokens[0].Grants.PublishSources
	if len(sources) != 2 || sources[0] != media.SourceScreenShare || sources[1] != media.SourceScreenShareAudio {
		t.Fatalf("publish sources = %v", sources)
	}
}

func TestRequestMediaCredentialsOutsideChannel(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport()
	fixture.start(t, transport, 1, false)

	transport.push(&rostalkv1.ClientFrame{
		RequestId: 9,
		Payload: &rostalkv1.ClientFrame_RequestMediaCredentials{
			RequestMediaCredentials: &rostalkv1.RequestMediaCredentials{
				ChannelId: uint64(fixture.lobby.ID),
				Kind:      rostalkv1.MediaKind_MEDIA_KIND_VOICE,
			},
		},
	})
	reply := waitReply(t, transport, 9)
	if reply.GetError() == nil {
		t.Fatalf("a token was issued outside a channel: %+v", reply.GetPayload())
	}
}

func TestRemoveMediaParticipant(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))
	fixture.media.Reset()

	if err := fixture.plane.RemoveMediaParticipant(context.Background(), 1); err != nil {
		t.Fatalf("RemoveMediaParticipant: %v", err)
	}
	calls := fixture.media.CallsOf("RemoveParticipant")
	if len(calls) != 2 {
		t.Fatalf("RemoveParticipant calls = %+v, want voice and stream", calls)
	}
	identities := map[string]bool{}
	for _, call := range calls {
		identities[call.Identity] = true
		if call.Room != media.RoomName(uint64(fixture.lobby.ID)) {
			t.Fatalf("removed from room %q", call.Room)
		}
	}
	if !identities["1:voice"] || !identities["1:stream"] {
		t.Fatalf("identities = %v", identities)
	}
}

// TestStopStreamWithdrawsVoiceStreamAudio covers moderation (ADR 0016) with
// the core-published stream audio (ADR 0027): stopping a stream removes the
// screen-share participant and also withdraws screen_share_audio from the
// voice participant, so the SFU drops that track; the source is handed back
// right away because the stream right itself is not revoked.
func TestStopStreamWithdrawsVoiceStreamAudio(t *testing.T) {
	fixture := newPlaneFixture(t)
	ctx := context.Background()
	registerBareSession(t, fixture, 1)
	admin := actor{subject: fixture.roles.Subject(2), userID: 2, name: "user2"}
	if _, err := fixture.plane.adminMove(ctx, admin, &rostalkv1.MemberMove{
		UserId:    1,
		ChannelId: uint64(fixture.lobby.ID),
	}); err != nil {
		t.Fatalf("move into the lobby: %v", err)
	}

	fixture.media.Reset()
	if _, err := fixture.plane.adminStopStream(ctx, admin, &rostalkv1.MemberStopStream{UserId: 1}); err != nil {
		t.Fatalf("stop stream: %v", err)
	}
	room := media.RoomName(uint64(fixture.lobby.ID))
	removed := false
	for _, call := range fixture.media.CallsOf("RemoveParticipant") {
		if call.Identity == "1:stream" && call.Room == room {
			removed = true
		}
	}
	if !removed {
		t.Fatalf("the screen-share participant was not removed: %+v", fixture.media.Calls())
	}
	audio := fixture.media.SourceCalls(media.SourceScreenShareAudio)
	if len(audio) != 2 || audio[0].CanPublish || !audio[1].CanPublish ||
		audio[0].Identity != "1:voice" || audio[0].Room != room {
		t.Fatalf("stream audio grant calls = %+v, want withdraw then restore on 1:voice", audio)
	}
	if mic := fixture.media.SourceCalls(media.SourceMicrophone); len(mic) != 0 {
		t.Fatalf("stopping a stream touched the microphone: %+v", mic)
	}
}
