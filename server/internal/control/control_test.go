package control

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"sync"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/media/mediafake"
	"github.com/v4dikos1/RosTalk/server/internal/perms"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/sessionauth"
	"github.com/v4dikos1/RosTalk/server/internal/state"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

// queueTransport feeds scripted client frames and records server frames.
type queueTransport struct {
	mu       sync.Mutex
	incoming []*rostalkv1.ClientFrame
	frames   []*rostalkv1.ServerFrame
	wake     chan struct{}
	done     chan struct{}
	closeOne sync.Once
}

func newQueueTransport(frames ...*rostalkv1.ClientFrame) *queueTransport {
	return &queueTransport{
		incoming: frames,
		wake:     make(chan struct{}, 1),
		done:     make(chan struct{}),
	}
}

// push adds a frame after the session has already started.
func (t *queueTransport) push(frame *rostalkv1.ClientFrame) {
	t.mu.Lock()
	t.incoming = append(t.incoming, frame)
	t.mu.Unlock()
	select {
	case t.wake <- struct{}{}:
	default:
	}
}

func (t *queueTransport) Read(ctx context.Context) (*rostalkv1.ClientFrame, error) {
	for {
		t.mu.Lock()
		if len(t.incoming) > 0 {
			frame := t.incoming[0]
			t.incoming = t.incoming[1:]
			t.mu.Unlock()
			return frame, nil
		}
		t.mu.Unlock()
		select {
		case <-t.done:
			return nil, io.EOF
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-t.wake:
		}
	}
}

func (t *queueTransport) Write(_ context.Context, frame *rostalkv1.ServerFrame) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.frames = append(t.frames, frame)
	return nil
}

func (t *queueTransport) Close() error {
	t.closeOne.Do(func() { close(t.done) })
	return nil
}

func (t *queueTransport) sent() []*rostalkv1.ServerFrame {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]*rostalkv1.ServerFrame(nil), t.frames...)
}

type planeFixture struct {
	plane    *Plane
	hub      *state.Hub
	channels *channels.Service
	roles    *roles.Service
	tokens   *sessionauth.Registry
	store    *store.Store
	media    *mediafake.Backend
	lobby    channels.Channel
}

func newPlaneFixture(t *testing.T) *planeFixture {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "rostalk.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	channelService, err := channels.Open(ctx, channels.Config{Store: st})
	if err != nil {
		t.Fatalf("channels.Open: %v", err)
	}
	roleService, err := roles.Open(ctx, roles.Config{Store: st})
	if err != nil {
		t.Fatalf("roles.Open: %v", err)
	}
	// The fixture users exist in the database so role assignments have a real
	// foreign key. IDs are assigned in creation order: 1 then 2.
	for _, user := range []struct {
		id   int
		name string
	}{{1, "user1"}, {2, "user2"}} {
		key := make([]byte, 32)
		key[0] = byte(user.id)
		if _, err := st.UpsertUser(ctx, key, user.name, time.Unix(1_700_000_000, 0)); err != nil {
			t.Fatalf("UpsertUser %d: %v", user.id, err)
		}
	}
	member, ok := roleService.RoleByName(roles.MemberName)
	if !ok {
		t.Fatal("the Member role is missing")
	}
	adminRole, ok := roleService.RoleByName(roles.AdminName)
	if !ok {
		t.Fatal("the Admin role is missing")
	}
	for userID := int64(1); userID <= 2; userID++ {
		if err := roleService.Assign(ctx, roles.System, userID, member.ID); err != nil {
			t.Fatalf("assign Member to %d: %v", userID, err)
		}
	}
	if err := roleService.Assign(ctx, roles.System, 2, adminRole.ID); err != nil {
		t.Fatalf("assign Admin to 2: %v", err)
	}

	settings, err := st.Settings(ctx)
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	tokens := sessionauth.New(0)
	hub := state.NewHub(state.Config{
		MaxUsers:   settings.MaxUsers,
		Channels:   channelService,
		Visibility: roleService,
		Tokens:     tokens,
	})
	backend := mediafake.New()
	plane, err := New(Config{
		Store:           st,
		Channels:        channelService,
		Hub:             hub,
		Roles:           roleService,
		Settings:        settings,
		Version:         "test",
		Protocol:        1,
		Media:           backend,
		MediaURL:        func() string { return "wss://127.0.0.1:7443/rtc" },
		InviteURL:       func(token string) string { return "rostalk://join?invite=" + token },
		DisconnectGrace: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("control.New: %v", err)
	}
	return &planeFixture{
		plane:    plane,
		hub:      hub,
		channels: channelService,
		roles:    roleService,
		tokens:   tokens,
		store:    st,
		media:    backend,
		lobby:    channelService.List()[0],
	}
}

// start registers a session, sends Welcome and runs the request loop.
func (f *planeFixture) start(t *testing.T, transport *queueTransport, userID int64, admin bool) *state.Session {
	t.Helper()
	session, err := state.NewSession(state.SessionParams{
		UserID:      userID,
		PublicKeyID: fmt.Sprintf("key-%d", userID),
		Nickname:    fmt.Sprintf("user%d", userID),
		Admin:       admin,
		RoleIDs:     f.roles.RoleIDs(userID),
		ConnectedAt: time.Unix(1_700_000_000, 0),
		Transport:   transport,
	})
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	if _, err := f.hub.Register(session); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if err := f.hub.Welcome(session, 2, func(users []state.Presence) *rostalkv1.ServerSnapshot {
		return f.plane.Snapshot(session, users, f.plane.PrepareSnapshot(context.Background(), session))
	}); err != nil {
		t.Fatalf("Welcome: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = f.plane.Serve(ctx, session) }()
	return session
}

func waitReply(t *testing.T, transport *queueTransport, requestID uint64) *rostalkv1.ServerFrame {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		for _, frame := range transport.sent() {
			if frame.GetReplyTo() == requestID {
				return frame
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no reply to request %d", requestID)
		}
		time.Sleep(time.Millisecond)
	}
}

func joinFrame(requestID, channelID uint64) *rostalkv1.ClientFrame {
	return &rostalkv1.ClientFrame{
		RequestId: requestID,
		Payload: &rostalkv1.ClientFrame_JoinChannel{JoinChannel: &rostalkv1.JoinChannel{
			ChannelId: channelID,
		}},
	}
}

// requireCredentials fails unless the reply carries media credentials.
func requireCredentials(t *testing.T, reply *rostalkv1.ServerFrame) *rostalkv1.MediaCredentials {
	t.Helper()
	credentials := reply.GetMediaCredentials()
	if credentials == nil {
		t.Fatalf("join reply = %v, want MediaCredentials", reply.GetPayload())
	}
	return credentials
}

func leaveFrame(requestID uint64) *rostalkv1.ClientFrame {
	return &rostalkv1.ClientFrame{
		RequestId: requestID,
		Payload:   &rostalkv1.ClientFrame_LeaveChannel{LeaveChannel: &rostalkv1.LeaveChannel{}},
	}
}

func setWatchingFrame(requestID uint64, streamerIDs ...uint64) *rostalkv1.ClientFrame {
	return &rostalkv1.ClientFrame{
		RequestId: requestID,
		Payload: &rostalkv1.ClientFrame_SetWatching{SetWatching: &rostalkv1.SetWatching{
			StreamerIds: streamerIDs,
		}},
	}
}

// TestSetWatchingRequestKeepsOnlyLiveSharesOfTheOwnChannel drives the request
// through the control plane: the reply is an Ack, invalid ids are dropped, and
// the presence carries the accepted list (stage P12).
func TestSetWatchingRequestKeepsOnlyLiveSharesOfTheOwnChannel(t *testing.T) {
	fixture := newPlaneFixture(t)
	other := createFixtureChannel(t, fixture, "Отдых")

	streamerTransport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	fixture.start(t, streamerTransport, 1, false)
	requireCredentials(t, waitReply(t, streamerTransport, 3))

	// The watcher joins the same channel and starts a share of their own, so
	// watching themselves is a valid-looking but forbidden id.
	watcherTransport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	fixture.start(t, watcherTransport, 2, false)
	requireCredentials(t, waitReply(t, watcherTransport, 3))
	if _, err := fixture.hub.SetStreaming(1, true); err != nil {
		t.Fatalf("SetStreaming: %v", err)
	}
	if _, err := fixture.hub.SetStreaming(2, true); err != nil {
		t.Fatalf("SetStreaming of the watcher: %v", err)
	}

	watcherTransport.push(setWatchingFrame(4, 1, 2, 1))
	if reply := waitReply(t, watcherTransport, 4); reply.GetAck() == nil {
		t.Fatalf("reply = %v, want Ack", reply.GetPayload())
	}
	presence, ok := fixture.hub.Presence(2)
	if !ok {
		t.Fatal("the watcher went offline")
	}
	if len(presence.Watching) != 1 || presence.Watching[0] != 1 {
		t.Fatalf("watching = %v, want [1]", presence.Watching)
	}

	// A stream in another channel is not a live share of the caller's channel.
	watcherTransport.push(joinFrame(5, uint64(other.ID)))
	requireCredentials(t, waitReply(t, watcherTransport, 5))
	watcherTransport.push(setWatchingFrame(6, 1))
	if reply := waitReply(t, watcherTransport, 6); reply.GetAck() == nil {
		t.Fatalf("reply = %v, want Ack", reply.GetPayload())
	}
	presence, _ = fixture.hub.Presence(2)
	if len(presence.Watching) != 0 {
		t.Fatalf("watching = %v after moving to another channel", presence.Watching)
	}
}

// createFixtureChannel creates one voice channel in the fixture server.
func createFixtureChannel(t *testing.T, fixture *planeFixture, name string) channels.Channel {
	t.Helper()
	channel, err := fixture.plane.CreateChannel(context.Background(), channels.CreateParams{
		Name: name,
		Kind: rostalkv1.ChannelKind_CHANNEL_KIND_VOICE,
	})
	if err != nil {
		t.Fatalf("CreateChannel %q: %v", name, err)
	}
	return channel
}

func TestJoinDeniedByChannelOverride(t *testing.T) {
	fixture := newPlaneFixture(t)
	member, ok := fixture.roles.RoleByName(roles.MemberName)
	if !ok {
		t.Fatal("the Member role is missing")
	}
	if _, err := fixture.roles.SetOverride(context.Background(), roles.System, fixture.lobby.ID, member.ID,
		0, perms.Mask(rostalkv1.Permission_PERMISSION_JOIN_CHANNEL)); err != nil {
		t.Fatalf("SetOverride: %v", err)
	}
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	session := fixture.start(t, transport, 1, false)

	reply := waitReply(t, transport, 3)
	if code := reply.GetError().GetCode(); code != rostalkv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatalf("join without permission = %s, want PERMISSION_DENIED", code)
	}
	if session.ChannelID() != 0 {
		t.Fatal("a denied join moved the user")
	}
}

func TestJoinMovesTheUserAndAcks(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	session := fixture.start(t, transport, 1, false)

	reply := waitReply(t, transport, 3)
	requireCredentials(t, reply)
	if got := session.ChannelID(); got != uint64(fixture.lobby.ID) {
		t.Fatalf("user is in channel %d, want %d", got, fixture.lobby.ID)
	}

	// The user and every other client learn about the move; the channel count
	// follows.
	var sawMoved, sawUpdated bool
	for _, frame := range transport.sent() {
		if moved := frame.GetEvent().GetUserMoved(); moved != nil {
			sawMoved = moved.GetToChannelId() == uint64(fixture.lobby.ID)
		}
		if updated := frame.GetEvent().GetChannelUpdated(); updated != nil {
			sawUpdated = updated.GetChannel().GetUserCount() == 1
		}
	}
	if !sawMoved || !sawUpdated {
		t.Fatalf("events after join: moved=%t, channel_updated=%t", sawMoved, sawUpdated)
	}
}

func TestMediaCredentialsFollowAChannelMove(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))

	other := fixture.channels.List()[1]
	transport.push(joinFrame(4, uint64(other.ID)))
	requireCredentials(t, waitReply(t, transport, 4))

	request := func(requestID, channelID uint64) *rostalkv1.ClientFrame {
		return &rostalkv1.ClientFrame{
			RequestId: requestID,
			Payload: &rostalkv1.ClientFrame_RequestMediaCredentials{
				RequestMediaCredentials: &rostalkv1.RequestMediaCredentials{
					ChannelId: channelID,
					Kind:      rostalkv1.MediaKind_MEDIA_KIND_VOICE,
				},
			},
		}
	}
	// The new channel works without another move.
	transport.push(request(5, uint64(other.ID)))
	credentials := requireCredentials(t, waitReply(t, transport, 5))
	if credentials.GetChannelId() != uint64(other.ID) {
		t.Fatalf("credentials are for channel %d, want %d", credentials.GetChannelId(), other.ID)
	}
	// The channel the user left no longer matches the session.
	transport.push(request(6, uint64(fixture.lobby.ID)))
	reply := waitReply(t, transport, 6)
	if code := reply.GetError().GetCode(); code != rostalkv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatalf("credentials for the left channel = %s, want PERMISSION_DENIED", code)
	}
}

func TestReplacedSessionCannotMoveTheNewSession(t *testing.T) {
	fixture := newPlaneFixture(t)
	oldTransport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	fixture.start(t, oldTransport, 1, false)
	requireCredentials(t, waitReply(t, oldTransport, 3))

	// A newer connection of the same user replaces the session and inherits the
	// channel. The old loop keeps running for a moment, as it can on a real
	// connection that was already being closed.
	newTransport := newQueueTransport()
	replacement, err := state.NewSession(state.SessionParams{
		UserID:      1,
		PublicKeyID: "key-1-new",
		Nickname:    "user1",
		RoleIDs:     fixture.roles.RoleIDs(1),
		ConnectedAt: time.Unix(1_700_000_001, 0),
		Transport:   newTransport,
	})
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	if _, err := fixture.hub.Register(replacement); err != nil {
		t.Fatalf("Register replacement: %v", err)
	}
	if err := fixture.hub.Welcome(replacement, 2, func(users []state.Presence) *rostalkv1.ServerSnapshot {
		return fixture.plane.Snapshot(replacement, users, fixture.plane.PrepareSnapshot(context.Background(), replacement))
	}); err != nil {
		t.Fatalf("Welcome replacement: %v", err)
	}

	oldTransport.push(leaveFrame(4))
	reply := waitReply(t, oldTransport, 4)
	if code := reply.GetError().GetCode(); code != rostalkv1.ErrorCode_ERROR_CODE_UNAUTHENTICATED {
		t.Fatalf("leave from the replaced session = %s, want UNAUTHENTICATED", code)
	}
	presence, ok := fixture.hub.Presence(1)
	if !ok {
		t.Fatal("the new session is gone")
	}
	if presence.ChannelID != uint64(fixture.lobby.ID) {
		t.Fatalf("the replaced session left the new one in channel %d", presence.ChannelID)
	}
	if got := fixture.hub.ChannelCount(uint64(fixture.lobby.ID)); got != 1 {
		t.Fatalf("lobby count = %d, want 1", got)
	}

	// The same guard applies to JoinChannel.
	other := fixture.channels.List()[1]
	oldTransport.push(joinFrame(5, uint64(other.ID)))
	reply = waitReply(t, oldTransport, 5)
	if code := reply.GetError().GetCode(); code != rostalkv1.ErrorCode_ERROR_CODE_UNAUTHENTICATED {
		t.Fatalf("join from the replaced session = %s, want UNAUTHENTICATED", code)
	}
	if presence, _ := fixture.hub.Presence(1); presence.ChannelID != uint64(fixture.lobby.ID) {
		t.Fatalf("the replaced session moved the new one to channel %d", presence.ChannelID)
	}
}

func TestConvertingAnOccupiedVoiceChannelToTextIsRejected(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	session := fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))

	kind := rostalkv1.ChannelKind_CHANNEL_KIND_TEXT
	if _, err := fixture.plane.UpdateChannel(context.Background(), fixture.lobby.ID,
		channels.UpdateParams{Kind: &kind}); !errors.Is(err, ErrChannelOccupied) {
		t.Fatalf("converting an occupied voice channel = %v, want ErrChannelOccupied", err)
	}
	if got := fixture.hub.ChannelCount(uint64(fixture.lobby.ID)); got != 1 {
		t.Fatalf("channel count after the rejected update = %d, want 1", got)
	}
	if got := session.ChannelID(); got != uint64(fixture.lobby.ID) {
		t.Fatalf("the user was moved to %d by a rejected update", got)
	}
	if current, _ := fixture.channels.Get(fixture.lobby.ID); current.Kind != rostalkv1.ChannelKind_CHANNEL_KIND_VOICE {
		t.Fatalf("the channel kind changed to %v", current.Kind)
	}

	// Once empty, the same conversion is accepted.
	transport.push(leaveFrame(4))
	waitReply(t, transport, 4)
	if _, err := fixture.plane.UpdateChannel(context.Background(), fixture.lobby.ID,
		channels.UpdateParams{Kind: &kind}); err != nil {
		t.Fatalf("converting an empty voice channel: %v", err)
	}
	if current, _ := fixture.channels.Get(fixture.lobby.ID); current.Kind != kind {
		t.Fatalf("channel kind = %v, want TEXT", current.Kind)
	}
}

// TestTextChannelEvictsStragglers covers a join that won the race with the
// occupancy check in UpdateChannel: the channel is already text, the user is
// still a voice participant, and the update must remove them.
func TestTextChannelEvictsStragglers(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	session := fixture.start(t, transport, 1, false)
	requireCredentials(t, waitReply(t, transport, 3))
	if _, err := fixture.hub.SetStreaming(1, true); err != nil {
		t.Fatalf("SetStreaming: %v", err)
	}

	// Simulate the race: the channel service is already text while the user is
	// still present.
	kind := rostalkv1.ChannelKind_CHANNEL_KIND_TEXT
	if _, err := fixture.channels.Update(context.Background(), fixture.lobby.ID, channels.UpdateParams{Kind: &kind}); err != nil {
		t.Fatalf("channels.Update: %v", err)
	}
	channel, err := fixture.plane.UpdateChannel(context.Background(), fixture.lobby.ID,
		channels.UpdateParams{Kind: &kind})
	if err != nil {
		t.Fatalf("UpdateChannel: %v", err)
	}
	if channel.Kind != kind {
		t.Fatalf("channel kind = %v, want TEXT", channel.Kind)
	}
	if got := fixture.hub.ChannelCount(uint64(fixture.lobby.ID)); got != 0 {
		t.Fatalf("a text channel still has %d occupants", got)
	}
	presence, ok := fixture.hub.Presence(1)
	if !ok {
		t.Fatal("the user went offline")
	}
	if presence.ChannelID != 0 {
		t.Fatalf("the user is still in channel %d", presence.ChannelID)
	}
	if presence.Streaming {
		t.Fatal("the evicted user still carries the stream flag")
	}
	if got := session.ChannelID(); got != 0 {
		t.Fatalf("session channel = %d after eviction, want 0", got)
	}
}

func TestSnapshotContainsChannelsAndPermissions(t *testing.T) {
	fixture := newPlaneFixture(t)

	memberTransport := newQueueTransport()
	member := fixture.start(t, memberTransport, 1, false)
	snapshot := fixture.plane.Snapshot(member, fixture.hub.SnapshotUsers(), fixture.plane.PrepareSnapshot(context.Background(), member))
	if len(snapshot.GetChannels()) != 2 {
		t.Fatalf("member sees %d channels, want 2", len(snapshot.GetChannels()))
	}
	if len(snapshot.GetPermissions().GetChannels()) != len(snapshot.GetChannels()) {
		t.Fatal("per-channel permission sets do not match the visible channels")
	}
	memberCanJoin := false
	for _, permission := range snapshot.GetPermissions().GetChannels()[0].GetEffective().GetPermissions() {
		if permission == rostalkv1.Permission_PERMISSION_JOIN_CHANNEL {
			memberCanJoin = true
		}
		if permission == rostalkv1.Permission_PERMISSION_MANAGE_CHANNELS {
			t.Fatal("a member received manage_channels")
		}
	}
	if !memberCanJoin {
		t.Fatal("a member cannot join a visible channel")
	}
	if len(snapshot.GetPermissions().GetServer().GetPermissions()) != 2 {
		t.Fatalf("member server permissions = %v", snapshot.GetPermissions().GetServer().GetPermissions())
	}

	adminTransport := newQueueTransport()
	admin := fixture.start(t, adminTransport, 2, true)
	adminSnapshot := fixture.plane.Snapshot(admin, fixture.hub.SnapshotUsers(), fixture.plane.PrepareSnapshot(context.Background(), admin))
	found := false
	for _, permission := range adminSnapshot.GetPermissions().GetServer().GetPermissions() {
		if permission == rostalkv1.Permission_PERMISSION_MANAGE_SERVER {
			found = true
		}
	}
	if !found {
		t.Fatal("an administrator has no manage_server permission")
	}
}

// waitForFrames waits until the condition holds for the frames received so far.
// Event delivery is asynchronous: the hub queues frames and the session writer
// drains them, so a test cannot read them immediately after a mutation.
func waitForFrames(t *testing.T, transport *queueTransport, condition func([]*rostalkv1.ServerFrame) bool) []*rostalkv1.ServerFrame {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		frames := transport.sent()
		if condition(frames) {
			return frames
		}
		if time.Now().After(deadline) {
			t.Fatalf("event condition did not hold; received %d frames", len(frames))
		}
		time.Sleep(time.Millisecond)
	}
}

func channelEventID(frame *rostalkv1.ServerFrame) (string, uint64) {
	event := frame.GetEvent()
	switch payload := event.GetPayload().(type) {
	case *rostalkv1.Event_ChannelCreated:
		return "created", payload.ChannelCreated.GetChannel().GetId()
	case *rostalkv1.Event_ChannelUpdated:
		return "updated", payload.ChannelUpdated.GetChannel().GetId()
	case *rostalkv1.Event_ChannelDeleted:
		return "deleted", payload.ChannelDeleted.GetChannelId()
	default:
		return "", 0
	}
}

func countChannelEvents(frames []*rostalkv1.ServerFrame, kind string) int {
	count := 0
	for _, frame := range frames {
		if got, _ := channelEventID(frame); got == kind {
			count++
		}
	}
	return count
}

func TestCreateAndDeleteAnnouncePlacementChanges(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport()
	fixture.start(t, transport, 1, false)

	position := int32(0)
	created, err := fixture.plane.CreateChannel(context.Background(), channels.CreateParams{
		Name:     "First",
		ParentID: fixture.lobby.ID,
		Position: &position,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// ChannelCreated comes first, then ChannelUpdated for every channel: the
	// insertion renumbered the Lobby's children.
	frames := waitForFrames(t, transport, func(frames []*rostalkv1.ServerFrame) bool {
		return countChannelEvents(frames, "created") >= 1 &&
			countChannelEvents(frames, "updated") >= len(fixture.channels.List())
	})
	firstCreated, firstUpdated := -1, -1
	for i, frame := range frames {
		kind, _ := channelEventID(frame)
		if kind == "created" && firstCreated < 0 {
			firstCreated = i
		}
		if kind == "updated" && firstUpdated < 0 {
			firstUpdated = i
		}
	}
	if firstCreated < 0 || firstUpdated < 0 || firstCreated > firstUpdated {
		t.Fatalf("event order: created at %d, first update at %d; want created first", firstCreated, firstUpdated)
	}
	assertPlacementUpdates(t, fixture, frames[firstUpdated:])

	// Deleting the channel announces ChannelDeleted and then the renumbered
	// siblings.
	before := len(transport.sent())
	if err := fixture.plane.DeleteChannel(context.Background(), created.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	frames = waitForFrames(t, transport, func(frames []*rostalkv1.ServerFrame) bool {
		if len(frames) <= before {
			return false
		}
		return countChannelEvents(frames[before:], "deleted") >= 1 &&
			countChannelEvents(frames[before:], "updated") >= len(fixture.channels.List())
	})
	after := frames[before:]
	if kind, id := channelEventID(after[0]); kind != "deleted" || id != uint64(created.ID) {
		t.Fatalf("first event after delete = %s:%d, want deleted:%d", kind, id, created.ID)
	}
	for _, frame := range after[1:] {
		if kind, _ := channelEventID(frame); kind != "updated" {
			t.Fatalf("unexpected event after ChannelDeleted: %v", frame.GetEvent())
		}
	}
	assertPlacementUpdates(t, fixture, after[1:])
}

// assertPlacementUpdates checks that ChannelUpdated events carry the same
// parent and position as the server's channel tree.
func assertPlacementUpdates(t *testing.T, fixture *planeFixture, frames []*rostalkv1.ServerFrame) {
	t.Helper()
	expected := make(map[uint64]channels.Channel)
	for _, channel := range fixture.channels.List() {
		expected[uint64(channel.ID)] = channel
	}
	for _, frame := range frames {
		kind, id := channelEventID(frame)
		if kind != "updated" {
			continue
		}
		channel := frame.GetEvent().GetChannelUpdated().GetChannel()
		want, ok := expected[id]
		if !ok {
			t.Fatalf("ChannelUpdated for unknown channel %d", id)
		}
		if uint64(want.ParentID) != channel.GetParentId() || want.Position != channel.GetPosition() {
			t.Fatalf("channel %d announced parent %d position %d, want parent %d position %d",
				id, channel.GetParentId(), channel.GetPosition(), want.ParentID, want.Position)
		}
	}
}

func TestDeleteOccupiedChannelIsRejected(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport(joinFrame(3, uint64(fixture.lobby.ID)))
	fixture.start(t, transport, 1, false)
	if reply := waitReply(t, transport, 3); reply.GetMediaCredentials() == nil {
		t.Fatalf("join reply = %v, want MediaCredentials", reply.GetPayload())
	}

	if err := fixture.plane.DeleteChannel(context.Background(), fixture.lobby.ID); !errors.Is(err, ErrChannelOccupied) {
		t.Fatalf("deleting an occupied channel = %v, want ErrChannelOccupied", err)
	}
	if _, ok := fixture.channels.Get(fixture.lobby.ID); !ok {
		t.Fatal("the occupied channel was deleted anyway")
	}
	if presence, _ := fixture.hub.Presence(1); presence.ChannelID != uint64(fixture.lobby.ID) {
		t.Fatalf("the user was moved to %d", presence.ChannelID)
	}

	// Once the user leaves, the same delete succeeds.
	transport.push(&rostalkv1.ClientFrame{
		RequestId: 4,
		Payload:   &rostalkv1.ClientFrame_LeaveChannel{LeaveChannel: &rostalkv1.LeaveChannel{}},
	})
	if reply := waitReply(t, transport, 4); reply.GetAck() == nil {
		t.Fatalf("leave reply = %v, want Ack", reply.GetPayload())
	}
	before := len(transport.sent())
	if err := fixture.plane.DeleteChannel(context.Background(), fixture.lobby.ID); err != nil {
		t.Fatalf("delete after leave: %v", err)
	}
	if _, ok := fixture.channels.Get(fixture.lobby.ID); ok {
		t.Fatal("the empty channel was not deleted")
	}
	frames := waitForFrames(t, transport, func(frames []*rostalkv1.ServerFrame) bool {
		return countChannelEvents(frames[before:], "deleted") >= 1
	})
	if kind, id := channelEventID(frames[before]); kind != "deleted" || id != uint64(fixture.lobby.ID) {
		t.Fatalf("first event after delete = %s:%d, want deleted:%d", kind, id, fixture.lobby.ID)
	}
}

func TestTemporaryCleanupKeepsAChannelSomeoneJoined(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport()
	fixture.start(t, transport, 1, false)

	temporary, err := fixture.plane.CreateChannel(context.Background(), channels.CreateParams{
		Name:      "Временная",
		Temporary: true,
	})
	if err != nil {
		t.Fatalf("create temporary: %v", err)
	}

	// The user is already inside when the stale "channel is empty" cleanup
	// arrives: this is what happens when a JoinChannel wins the race with the
	// move that emptied the channel.
	transport.push(joinFrame(3, uint64(temporary.ID)))
	if reply := waitReply(t, transport, 3); reply.GetMediaCredentials() == nil {
		t.Fatalf("join reply = %v, want MediaCredentials", reply.GetPayload())
	}
	before := len(transport.sent())
	fixture.plane.removeEmptyTemporary([]uint64{uint64(temporary.ID)})

	if _, ok := fixture.channels.Get(temporary.ID); !ok {
		t.Fatal("the temporary channel was deleted with a user inside")
	}
	if presence, _ := fixture.hub.Presence(1); presence.ChannelID != uint64(temporary.ID) {
		t.Fatalf("the user is in channel %d, want the temporary channel", presence.ChannelID)
	}
	for _, frame := range transport.sent()[before:] {
		if deleted := frame.GetEvent().GetChannelDeleted(); deleted != nil &&
			deleted.GetChannelId() == uint64(temporary.ID) {
			t.Fatal("ChannelDeleted announced for a channel that is still occupied")
		}
	}

	// Once the channel really empties, the normal path deletes it.
	transport.push(leaveFrame(4))
	if reply := waitReply(t, transport, 4); reply.GetAck() == nil {
		t.Fatalf("leave reply = %v, want Ack", reply.GetPayload())
	}
	waitForFrames(t, transport, func([]*rostalkv1.ServerFrame) bool {
		_, ok := fixture.channels.Get(temporary.ID)
		return !ok
	})
}

// TestTemporaryCleanupRacingJoinLeavesNoDanglingChannel starts a join and a
// temporary-channel cleanup concurrently. Whichever order wins, the final state
// must be consistent: either the channel exists and the user is in it, or the
// channel is gone and the user is not in any channel.
func TestTemporaryCleanupRacingJoinLeavesNoDanglingChannel(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport()
	fixture.start(t, transport, 1, false)

	requestID := uint64(3)
	for i := 0; i < 20; i++ {
		temporary, err := fixture.plane.CreateChannel(context.Background(), channels.CreateParams{
			Name:      fmt.Sprintf("temp-%d", i),
			Temporary: true,
		})
		if err != nil {
			t.Fatalf("create temporary %d: %v", i, err)
		}

		transport.push(joinFrame(requestID, uint64(temporary.ID)))
		fixture.plane.removeEmptyTemporary([]uint64{uint64(temporary.ID)})
		reply := waitReply(t, transport, requestID)
		requestID++

		// The reply may be an Ack (the join won the race) or NOT_FOUND (the
		// cleanup won); either way the user must not point at a missing channel.
		if serverErr := reply.GetError(); serverErr != nil &&
			serverErr.GetCode() != rostalkv1.ErrorCode_ERROR_CODE_NOT_FOUND {
			t.Fatalf("iteration %d: unexpected join error %s", i, serverErr.GetCode())
		}

		presence, _ := fixture.hub.Presence(1)
		_, exists := fixture.channels.Get(temporary.ID)
		if !exists && presence.ChannelID != 0 {
			t.Fatalf("iteration %d: user points at deleted channel %d", i, presence.ChannelID)
		}
		if exists {
			if presence.ChannelID != uint64(temporary.ID) {
				t.Fatalf("iteration %d: channel exists but the user is in %d", i, presence.ChannelID)
			}
			// Leave so the next iteration starts from an empty channel; the
			// normal auto-delete then removes it.
			transport.push(leaveFrame(requestID))
			if leaveReply := waitReply(t, transport, requestID); leaveReply.GetAck() == nil {
				t.Fatalf("iteration %d: leave reply = %v", i, leaveReply.GetPayload())
			}
			requestID++
			waitForFrames(t, transport, func([]*rostalkv1.ServerFrame) bool {
				_, stillThere := fixture.channels.Get(temporary.ID)
				return !stillThere
			})
		}
	}
}

func TestJoinUnknownChannelIsNotFound(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport(joinFrame(3, 999999))
	fixture.start(t, transport, 1, false)

	reply := waitReply(t, transport, 3)
	if code := reply.GetError().GetCode(); code != rostalkv1.ErrorCode_ERROR_CODE_NOT_FOUND {
		t.Fatalf("join into a missing channel = %s, want NOT_FOUND", code)
	}
}

func TestEmptyFrameClosesTheConnection(t *testing.T) {
	fixture := newPlaneFixture(t)
	transport := newQueueTransport(&rostalkv1.ClientFrame{RequestId: 3})
	session := fixture.start(t, transport, 1, false)

	deadline := time.Now().Add(2 * time.Second)
	for {
		if session.Closed() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("an empty frame did not close the session")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestPlaneRequiresWiring(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Fatal("New accepted an empty configuration")
	}
}
