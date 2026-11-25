package integration

import (
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/media"
	"github.com/v4dikos1/RosTalk/server/internal/media/mediafake"
	"github.com/v4dikos1/RosTalk/server/internal/perms"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
)

func requestStreamCredentials(t *testing.T, client *testClient, channelID uint64) *rostalkv1.ServerFrame {
	t.Helper()
	ctx, cancel := connectContext(t)
	defer cancel()
	reply, err := client.request(ctx, &rostalkv1.RequestMediaCredentials{
		ChannelId: channelID,
		Kind:      rostalkv1.MediaKind_MEDIA_KIND_STREAM,
	})
	if err != nil {
		t.Fatalf("RequestMediaCredentials: %v", err)
	}
	return reply
}

func requirePresets(t *testing.T, credentials *rostalkv1.MediaCredentials, want ...string) {
	t.Helper()
	got := credentials.GetStreamPresets()
	if len(got) != len(want) {
		t.Fatalf("stream presets = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("stream presets = %v, want %v", got, want)
		}
	}
}

func TestStreamCredentialsHonourPermissionsAndAdvertisePresets(t *testing.T) {
	app := newChannelsTestApp(t)
	lobby := app.Channels.List()[0]
	member := connectTestClient(t, app, "member")
	ctx, cancel := connectContext(t)
	defer cancel()
	if err := member.join(ctx, uint64(lobby.ID), ""); err != nil {
		t.Fatalf("join lobby: %v", err)
	}
	userID := int64(member.conn.welcome.GetSelfUserId())

	// The built-in Member role has PERMISSION_STREAM but not PERMISSION_STREAM_HQ.
	reply := requestStreamCredentials(t, member, uint64(lobby.ID))
	if reply.GetError() != nil {
		t.Fatalf("stream credentials: %v", reply.GetError())
	}
	credentials := reply.GetMediaCredentials()
	if credentials.GetParticipantIdentity() == "" ||
		credentials.GetKind() != rostalkv1.MediaKind_MEDIA_KIND_STREAM {
		t.Fatalf("unexpected stream credentials: %+v", credentials)
	}
	wantIdentity := media.IdentityFor(userID, media.KindStream)
	if credentials.GetParticipantIdentity() != wantIdentity {
		t.Fatalf("identity = %q, want %q", credentials.GetParticipantIdentity(), wantIdentity)
	}
	requirePresets(t, credentials, "720p30", "1080p30")

	// The HQ permission adds 1080p60 and the native "source" preset; that is the
	// only difference from a Member's list.
	memberRole, ok := app.Roles.RoleByName(roles.MemberName)
	if !ok {
		t.Fatal("the Member role is missing")
	}
	if _, err := app.Roles.SetOverride(ctx, roles.System, lobby.ID, memberRole.ID,
		perms.Mask(rostalkv1.Permission_PERMISSION_STREAM,
			rostalkv1.Permission_PERMISSION_STREAM_HQ), 0); err != nil {
		t.Fatalf("allow stream_hq: %v", err)
	}
	reply = requestStreamCredentials(t, member, uint64(lobby.ID))
	if reply.GetError() != nil {
		t.Fatalf("stream credentials with HQ: %v", reply.GetError())
	}
	requirePresets(t, reply.GetMediaCredentials(), "720p30", "1080p30", "1080p60", "source")

	// Losing the stream right is a hard denial: no token is issued at all.
	backend := app.Media.(*mediafake.Backend)
	before := len(backend.CallsOf("IssueToken"))
	if _, err := app.Roles.SetOverride(ctx, roles.System, lobby.ID, memberRole.ID,
		0, perms.Mask(rostalkv1.Permission_PERMISSION_STREAM)); err != nil {
		t.Fatalf("deny stream: %v", err)
	}
	reply = requestStreamCredentials(t, member, uint64(lobby.ID))
	if reply.GetError() == nil {
		t.Fatalf("a stream token was issued without PERMISSION_STREAM: %+v", reply.GetMediaCredentials())
	}
	if code := reply.GetError().GetCode(); code != rostalkv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatalf("error = %v, want PERMISSION_DENIED", code)
	}
	if after := len(backend.CallsOf("IssueToken")); after != before {
		t.Fatalf("IssueToken was called after the deny: %+v", backend.CallsOf("IssueToken")[before:])
	}
}

func TestStreamingFlagFollowsScreenShareEvents(t *testing.T) {
	app := newChannelsTestApp(t)
	channels := app.Channels.List()
	lobby, other := channels[0], channels[1]
	member := connectTestClient(t, app, "streamer")
	ctx, cancel := connectContext(t)
	defer cancel()
	if err := member.join(ctx, uint64(lobby.ID), ""); err != nil {
		t.Fatalf("join lobby: %v", err)
	}
	userID := int64(member.conn.welcome.GetSelfUserId())
	backend := app.Media.(*mediafake.Backend)
	identity := media.IdentityFor(userID, media.KindStream)

	waitStreaming := func(want bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			presence, ok := app.Hub.Presence(userID)
			if ok && presence.Streaming == want {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		presence, _ := app.Hub.Presence(userID)
		t.Fatalf("streaming = %t, want %t", presence.Streaming, want)
	}

	// Audio alone is not "streaming"; the video track is.
	backend.Publish(media.Event{
		Kind: media.EventTrackPublished, Room: media.RoomName(uint64(lobby.ID)),
		ChannelID: uint64(lobby.ID), Identity: identity, UserID: userID,
		ParticipantKind: media.KindStream, Track: "audio", Source: media.SourceScreenShareAudio,
	})
	time.Sleep(20 * time.Millisecond)
	presence, _ := app.Hub.Presence(userID)
	if presence.Streaming {
		t.Fatal("the screen-share audio track set the streaming flag")
	}

	backend.Publish(media.Event{
		Kind: media.EventTrackPublished, Room: media.RoomName(uint64(lobby.ID)),
		ChannelID: uint64(lobby.ID), Identity: identity, UserID: userID,
		ParticipantKind: media.KindStream, Track: "video", Source: media.SourceScreenShare,
	})
	waitStreaming(true)

	// A duplicate publication is idempotent.
	backend.Publish(media.Event{
		Kind: media.EventTrackPublished, Room: media.RoomName(uint64(lobby.ID)),
		ChannelID: uint64(lobby.ID), Identity: identity, UserID: userID,
		ParticipantKind: media.KindStream, Track: "video", Source: media.SourceScreenShare,
	})
	time.Sleep(20 * time.Millisecond)
	waitStreaming(true)

	// A stale event from another room must not clear the flag of this channel.
	backend.Publish(media.Event{
		Kind: media.EventTrackUnpublished, Room: media.RoomName(uint64(other.ID)),
		ChannelID: uint64(other.ID), Identity: identity, UserID: userID,
		ParticipantKind: media.KindStream, Track: "video", Source: media.SourceScreenShare,
	})
	time.Sleep(20 * time.Millisecond)
	waitStreaming(true)

	backend.Publish(media.Event{
		Kind: media.EventTrackUnpublished, Room: media.RoomName(uint64(lobby.ID)),
		ChannelID: uint64(lobby.ID), Identity: identity, UserID: userID,
		ParticipantKind: media.KindStream, Track: "video", Source: media.SourceScreenShare,
	})
	waitStreaming(false)

	// A participant that disappears without an unpublish event still clears it.
	backend.Publish(media.Event{
		Kind: media.EventTrackPublished, Room: media.RoomName(uint64(lobby.ID)),
		ChannelID: uint64(lobby.ID), Identity: identity, UserID: userID,
		ParticipantKind: media.KindStream, Track: "video", Source: media.SourceScreenShare,
	})
	waitStreaming(true)
	backend.Publish(media.Event{
		Kind: media.EventParticipantLeft, Room: media.RoomName(uint64(lobby.ID)),
		ChannelID: uint64(lobby.ID), Identity: identity, UserID: userID,
		ParticipantKind: media.KindStream,
	})
	waitStreaming(false)
}

// waitViewers waits until the client's mirrored presence shows exactly want as
// the audience of streamerID.
func waitViewers(t *testing.T, client *testClient, streamerID uint64, want []uint64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last []uint64
	for time.Now().Before(deadline) {
		last = client.viewersOf(streamerID)
		if len(last) == len(want) {
			same := true
			for i := range want {
				if last[i] != want[i] {
					same = false
					break
				}
			}
			if same {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("viewers of %d = %v, want %v", streamerID, last, want)
}

// TestEveryClientInTheChannelSeesTheViewers covers the whole P12 path: a
// viewer names a live share in its own channel, everyone in the channel learns
// the audience from the presence, and the audience disappears when the share
// stops or the channel changes.
func TestEveryClientInTheChannelSeesTheViewers(t *testing.T) {
	app := newChannelsTestApp(t)
	lobby := app.Channels.List()[0]
	streamer := connectTestClient(t, app, "streamer")
	watcher := connectTestClient(t, app, "watcher")
	observer := connectTestClient(t, app, "observer")
	ctx, cancel := connectContext(t)
	defer cancel()
	streamerID := streamer.conn.welcome.GetSelfUserId()
	watcherID := watcher.conn.welcome.GetSelfUserId()
	for _, client := range []*testClient{streamer, watcher, observer} {
		if err := client.join(ctx, uint64(lobby.ID), ""); err != nil {
			t.Fatalf("join the lobby: %v", err)
		}
	}

	backend := app.Media.(*mediafake.Backend)
	backend.Publish(media.Event{
		Kind: media.EventTrackPublished, Room: media.RoomName(uint64(lobby.ID)),
		ChannelID: uint64(lobby.ID), Identity: media.IdentityFor(int64(streamerID), media.KindStream),
		UserID: int64(streamerID), ParticipantKind: media.KindStream, Track: "video",
		Source: media.SourceScreenShare,
	})
	deadline := time.Now().Add(5 * time.Second)
	for {
		if presence, ok := app.Hub.Presence(int64(streamerID)); ok && presence.Streaming {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the screen share was not recorded")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// The viewer asks to watch the share.
	reply, err := watcher.request(ctx, &rostalkv1.SetWatching{StreamerIds: []uint64{streamerID}})
	if err != nil {
		t.Fatalf("SetWatching: %v", err)
	}
	if reply.GetAck() == nil {
		t.Fatalf("reply = %v, want Ack", reply.GetPayload())
	}
	// Everyone in the channel, the streamer included, sees who is watching.
	for _, client := range []*testClient{streamer, observer, watcher} {
		waitViewers(t, client, streamerID, []uint64{watcherID})
	}

	// The share stops: the audience is cleared for every client.
	backend.Publish(media.Event{
		Kind: media.EventTrackUnpublished, Room: media.RoomName(uint64(lobby.ID)),
		ChannelID: uint64(lobby.ID), Identity: media.IdentityFor(int64(streamerID), media.KindStream),
		UserID: int64(streamerID), ParticipantKind: media.KindStream, Track: "video",
		Source: media.SourceScreenShare,
	})
	for _, client := range []*testClient{streamer, observer, watcher} {
		waitViewers(t, client, streamerID, nil)
	}

	// A list that names a share outside the caller's channel is dropped.
	if err := watcher.leave(ctx); err != nil {
		t.Fatalf("leave the lobby: %v", err)
	}
	if err := watcher.join(ctx, uint64(app.Channels.List()[1].ID), ""); err != nil {
		t.Fatalf("join another channel: %v", err)
	}
	reply, err = watcher.request(ctx, &rostalkv1.SetWatching{StreamerIds: []uint64{streamerID}})
	if err != nil {
		t.Fatalf("SetWatching from another channel: %v", err)
	}
	if reply.GetAck() == nil {
		t.Fatalf("reply = %v, want Ack", reply.GetPayload())
	}
	waitViewers(t, observer, streamerID, nil)
}

func TestStreamingFlagIgnoresVoiceParticipantTracks(t *testing.T) {
	app := newChannelsTestApp(t)
	lobby := app.Channels.List()[0]
	member := connectTestClient(t, app, "speaker")
	ctx, cancel := connectContext(t)
	defer cancel()
	if err := member.join(ctx, uint64(lobby.ID), ""); err != nil {
		t.Fatalf("join lobby: %v", err)
	}
	userID := int64(member.conn.welcome.GetSelfUserId())
	backend := app.Media.(*mediafake.Backend)

	// A malformed event that attributes a screen share to the voice participant
	// must not set the flag: the participant kind comes from the identity.
	backend.Publish(media.Event{
		Kind: media.EventTrackPublished, Room: media.RoomName(uint64(lobby.ID)),
		ChannelID: uint64(lobby.ID), Identity: media.IdentityFor(userID, media.KindVoice),
		UserID: userID, ParticipantKind: media.KindVoice, Track: "voice",
		Source: media.SourceMicrophone,
	})
	time.Sleep(20 * time.Millisecond)
	presence, _ := app.Hub.Presence(userID)
	if presence.Streaming {
		t.Fatal("the microphone track set the streaming flag")
	}
}
