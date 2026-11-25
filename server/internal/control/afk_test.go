package control

import (
	"context"
	"testing"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/media"
	"github.com/v4dikos1/RosTalk/server/internal/state"
)

// idleChannel returns the channel flagged as the server's idle channel. The
// tests never look the channel up by name (ADR 0009).
func idleChannel(t *testing.T, fixture *planeFixture) channels.Channel {
	t.Helper()
	for _, channel := range fixture.channels.List() {
		if channel.AFK {
			return channel
		}
	}
	t.Fatal("the fixture has no idle channel")
	return channels.Channel{}
}

func requirePresence(t *testing.T, fixture *planeFixture, userID int64) state.Presence {
	t.Helper()
	presence, ok := fixture.hub.Presence(userID)
	if !ok {
		t.Fatalf("user %d is not online", userID)
	}
	return presence
}

func voiceStateFrame(requestID uint64, patch state.VoicePatch) *rostalkv1.ClientFrame {
	return &rostalkv1.ClientFrame{
		RequestId: requestID,
		Payload: &rostalkv1.ClientFrame_SetVoiceState{SetVoiceState: &rostalkv1.SetVoiceState{
			SelfMuted: patch.SelfMuted,
		}},
	}
}

// waitForOwnMute waits until the session has been told about its own forced
// mute. The event is queued before the join reply, but the writer is a separate
// goroutine.
func waitForOwnMute(t *testing.T, transport *queueTransport, muted bool) {
	t.Helper()
	waitFor(t, func() bool {
		for _, frame := range transport.sent() {
			user := frame.GetEvent().GetUserUpdated().GetUser()
			if user.GetId() == 1 && user.GetVoiceState().GetSelfMuted() == muted {
				return true
			}
		}
		return false
	})
}

func TestJoiningIdleChannelMutesAndStopsPublishing(t *testing.T) {
	fixture := newPlaneFixture(t)
	afk := idleChannel(t, fixture)
	transport := newQueueTransport(joinFrame(3, uint64(afk.ID)))
	fixture.start(t, transport, 1, false)

	credentials := requireCredentials(t, waitReply(t, transport, 3))
	if credentials.GetChannelId() != uint64(afk.ID) {
		t.Fatalf("credentials channel = %d, want %d", credentials.GetChannelId(), afk.ID)
	}
	if !requirePresence(t, fixture, 1).Voice.SelfMuted {
		t.Fatal("the idle channel did not force self_muted")
	}
	waitForOwnMute(t, transport, true)

	tokens := fixture.media.CallsOf("IssueToken")
	if len(tokens) != 1 {
		t.Fatalf("IssueToken calls = %+v, want one", tokens)
	}
	if hasSource(tokens[0].Grants.PublishSources, media.SourceMicrophone) {
		t.Fatalf("the idle channel issued a microphone grant: %v", tokens[0].Grants.PublishSources)
	}

	// An already connected participant is also stopped through the media plane.
	calls := fixture.media.SourceCalls(media.SourceMicrophone)
	if len(calls) != 1 || calls[0].CanPublish ||
		calls[0].Identity != "1:voice" || calls[0].Room != media.RoomName(uint64(afk.ID)) {
		t.Fatalf("microphone grant calls = %+v", calls)
	}
}

func TestLeavingIdleChannelRestoresMicrophoneAndReentryMutesAgain(t *testing.T) {
	fixture := newPlaneFixture(t)
	lobby := fixture.lobby
	afk := idleChannel(t, fixture)

	transport := newQueueTransport(joinFrame(3, uint64(afk.ID)))
	fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))
	if !requirePresence(t, fixture, 1).Voice.SelfMuted {
		t.Fatal("the idle channel did not force self_muted")
	}

	// Leaving the idle channel restores the user's own (unmuted) setting.
	transport.push(leaveFrame(4))
	if reply := waitReply(t, transport, 4); reply.GetAck() == nil {
		t.Fatalf("leave reply = %v, want Ack", reply.GetPayload())
	}
	if requirePresence(t, fixture, 1).Voice.SelfMuted {
		t.Fatal("leaving the idle channel kept the forced mute")
	}

	// Re-entering mutes again.
	transport.push(joinFrame(5, uint64(afk.ID)))
	requireCredentials(t, waitReply(t, transport, 5))
	if !requirePresence(t, fixture, 1).Voice.SelfMuted {
		t.Fatal("a second entry into the idle channel was not muted")
	}

	// A move into an ordinary channel publishes again and is not muted.
	transport.push(joinFrame(6, uint64(lobby.ID)))
	requireCredentials(t, waitReply(t, transport, 6))
	if requirePresence(t, fixture, 1).Voice.SelfMuted {
		t.Fatal("a move out of the idle channel kept the forced mute")
	}
	tokens := fixture.media.CallsOf("IssueToken")
	last := tokens[len(tokens)-1]
	if last.Room != media.RoomName(uint64(lobby.ID)) || !last.Grants.CanPublish {
		t.Fatalf("token after the move = %+v, want a publishing token for %d", last, lobby.ID)
	}
}

func TestIdleChannelKeepsTheUsersOwnMute(t *testing.T) {
	fixture := newPlaneFixture(t)
	afk := idleChannel(t, fixture)

	transport := newQueueTransport()
	fixture.start(t, transport, 1, false)
	muted := true
	transport.push(voiceStateFrame(3, state.VoicePatch{SelfMuted: &muted}))
	if reply := waitReply(t, transport, 3); reply.GetAck() == nil {
		t.Fatalf("set voice state reply = %v, want Ack", reply.GetPayload())
	}

	transport.push(joinFrame(4, uint64(afk.ID)))
	requireCredentials(t, waitReply(t, transport, 4))
	transport.push(leaveFrame(5))
	if reply := waitReply(t, transport, 5); reply.GetAck() == nil {
		t.Fatalf("leave reply = %v, want Ack", reply.GetPayload())
	}

	// The user muted before entering, so leaving restores that preference.
	if !requirePresence(t, fixture, 1).Voice.SelfMuted {
		t.Fatal("the user's own mute was cleared by the idle channel")
	}
}

func TestIdleChannelRejectsUnmute(t *testing.T) {
	fixture := newPlaneFixture(t)
	afk := idleChannel(t, fixture)

	transport := newQueueTransport(joinFrame(3, uint64(afk.ID)))
	fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))

	unmuted := false
	transport.push(voiceStateFrame(4, state.VoicePatch{SelfMuted: &unmuted}))
	reply := waitReply(t, transport, 4)
	if reply.GetError().GetCode() != rostalkv1.ErrorCode_ERROR_CODE_REJECTED {
		t.Fatalf("unmute reply = %v, want REJECTED", reply.GetPayload())
	}
	if !requirePresence(t, fixture, 1).Voice.SelfMuted {
		t.Fatal("the client lifted the idle-channel mute")
	}
}

func TestIdleChannelDoesNotTouchOtherChannels(t *testing.T) {
	fixture := newPlaneFixture(t)
	lobby := fixture.lobby
	afk := idleChannel(t, fixture)

	lobbyTransport := newQueueTransport(joinFrame(3, uint64(lobby.ID)))
	fixture.start(t, lobbyTransport, 1, false)
	requireCredentials(t, waitReply(t, lobbyTransport, 3))

	afkTransport := newQueueTransport(joinFrame(3, uint64(afk.ID)))
	fixture.start(t, afkTransport, 2, false)
	requireCredentials(t, waitReply(t, afkTransport, 3))

	if presence := requirePresence(t, fixture, 1); presence.Voice.SelfMuted || presence.ChannelID != uint64(lobby.ID) {
		t.Fatalf("the user in an ordinary channel changed: %+v", presence)
	}
	if !requirePresence(t, fixture, 2).Voice.SelfMuted {
		t.Fatal("the user in the idle channel is not muted")
	}

	// Only the idle channel participant was stopped in the media plane.
	for _, call := range fixture.media.SourceCalls(media.SourceMicrophone) {
		if call.Identity != "2:voice" {
			t.Fatalf("the media plane was changed for another participant: %+v", call)
		}
	}
	// A token for the ordinary channel still publishes.
	tokens := fixture.media.CallsOf("IssueToken")
	published := false
	for _, token := range tokens {
		if token.Room == media.RoomName(uint64(lobby.ID)) {
			published = token.Grants.CanPublish
		}
	}
	if !published {
		t.Fatalf("the ordinary channel lost the publish grant: %+v", tokens)
	}
}

func TestLiftingAModeratorMuteDoesNotUnmuteTheIdleChannel(t *testing.T) {
	fixture := newPlaneFixture(t)
	afk := idleChannel(t, fixture)

	transport := newQueueTransport(joinFrame(3, uint64(afk.ID)))
	fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))
	fixture.media.Reset()

	ctx := context.Background()
	if err := fixture.plane.SetServerMuted(ctx, 1, true); err != nil {
		t.Fatalf("SetServerMuted(true): %v", err)
	}
	if err := fixture.plane.SetServerMuted(ctx, 1, false); err != nil {
		t.Fatalf("SetServerMuted(false): %v", err)
	}
	calls := fixture.media.SourceCalls(media.SourceMicrophone)
	if len(calls) != 2 {
		t.Fatalf("microphone grant calls = %+v, want two", calls)
	}
	if calls[0].CanPublish || calls[1].CanPublish {
		t.Fatalf("a moderator unmute lifted the idle-channel mute: %+v", calls)
	}
}

func TestMarkingAChannelIdleAppliesToItsOccupants(t *testing.T) {
	fixture := newPlaneFixture(t)
	lobby := fixture.lobby

	transport := newQueueTransport(joinFrame(3, uint64(lobby.ID)))
	fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))
	fixture.media.Reset()

	idle := true
	if _, err := fixture.plane.UpdateChannel(context.Background(), lobby.ID, channels.UpdateParams{AFK: &idle}); err != nil {
		t.Fatalf("UpdateChannel: %v", err)
	}
	if !requirePresence(t, fixture, 1).Voice.SelfMuted {
		t.Fatal("flagging an occupied channel did not mute its occupants")
	}
	if calls := fixture.media.SourceCalls(media.SourceMicrophone); len(calls) != 1 || calls[0].CanPublish {
		t.Fatalf("microphone grant calls = %+v", calls)
	}

	// Clearing the flag restores the microphone setting of the occupants.
	active := false
	if _, err := fixture.plane.UpdateChannel(context.Background(), lobby.ID, channels.UpdateParams{AFK: &active}); err != nil {
		t.Fatalf("UpdateChannel: %v", err)
	}
	if requirePresence(t, fixture, 1).Voice.SelfMuted {
		t.Fatal("clearing the flag left the occupants muted")
	}
	calls := fixture.media.SourceCalls(media.SourceMicrophone)
	if len(calls) != 2 || !calls[1].CanPublish {
		t.Fatalf("microphone grant calls after clearing = %+v, want the grant restored", calls)
	}
}
