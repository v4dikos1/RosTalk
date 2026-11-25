package state

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"
)

// fakeTransport is an in-memory connection for hub tests.
type fakeTransport struct {
	incoming chan *rostalkv1.ClientFrame

	mu     sync.Mutex
	frames []*rostalkv1.ServerFrame

	closeOnce sync.Once
	closed    chan struct{}
}

func newFakeTransport() *fakeTransport {
	return &fakeTransport{
		incoming: make(chan *rostalkv1.ClientFrame, 8),
		closed:   make(chan struct{}),
	}
}

func (t *fakeTransport) Read(ctx context.Context) (*rostalkv1.ClientFrame, error) {
	select {
	case frame := <-t.incoming:
		return frame, nil
	case <-t.closed:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (t *fakeTransport) Write(_ context.Context, frame *rostalkv1.ServerFrame) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	select {
	case <-t.closed:
		return errors.New("transport is closed")
	default:
	}
	t.frames = append(t.frames, frame)
	return nil
}

func (t *fakeTransport) Close() error {
	t.closeOnce.Do(func() { close(t.closed) })
	return nil
}

func (t *fakeTransport) sent() []*rostalkv1.ServerFrame {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]*rostalkv1.ServerFrame(nil), t.frames...)
}

func (t *fakeTransport) isClosed() bool {
	select {
	case <-t.closed:
		return true
	default:
		return false
	}
}

type fakeChannels struct{}

func (fakeChannels) View(id uint64) (*rostalkv1.Channel, bool) {
	return &rostalkv1.Channel{Id: id}, true
}

func newTestHub() *Hub { return NewHub(Config{Channels: fakeChannels{}, QueueSize: 1024}) }

func newTestSession(t *testing.T, userID int64, nickname string, admin bool, transport *fakeTransport) *Session {
	t.Helper()
	session, err := NewSession(SessionParams{
		UserID:      userID,
		PublicKeyID: fmt.Sprintf("key-%d", userID),
		Nickname:    nickname,
		Admin:       admin,
		ConnectedAt: time.Unix(1_700_000_000, 0),
		Transport:   transport,
	})
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	return session
}

func mustWelcome(t *testing.T, hub *Hub, session *Session) {
	t.Helper()
	err := hub.Welcome(session, 7, func(users []Presence) *rostalkv1.ServerSnapshot {
		return &rostalkv1.ServerSnapshot{
			Server: &rostalkv1.ServerInfo{OnlineUsers: uint32(len(users))},
		}
	})
	if err != nil {
		t.Fatalf("Welcome: %v", err)
	}
}

// waitFrames waits until the transport has at least n frames.
func waitFrames(t *testing.T, transport *fakeTransport, n int) []*rostalkv1.ServerFrame {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		frames := transport.sent()
		if len(frames) >= n {
			return frames
		}
		if time.Now().After(deadline) {
			t.Fatalf("transport received %d frames, want %d", len(frames), n)
		}
		time.Sleep(time.Millisecond)
	}
}

// waitDrained waits until every transport stopped receiving frames: the hub
// queues events and its writer goroutines deliver them asynchronously.
func waitDrained(t *testing.T, transports []*fakeTransport) {
	t.Helper()
	counts := make([]int, len(transports))
	for i, transport := range transports {
		counts[i] = len(transport.sent())
	}
	deadline := time.Now().Add(10 * time.Second)
	stableSince := time.Now()
	for {
		time.Sleep(5 * time.Millisecond)
		next := make([]int, len(transports))
		changed := false
		for i, transport := range transports {
			next[i] = len(transport.sent())
			if next[i] != counts[i] {
				changed = true
			}
		}
		if changed {
			counts = next
			stableSince = time.Now()
			continue
		}
		if time.Since(stableSince) >= 100*time.Millisecond {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("event delivery did not settle")
		}
	}
}

func TestWelcomeIsFirstAndIncludesTheUsers(t *testing.T) {
	hub := newTestHub()
	aliceTransport := newFakeTransport()
	alice := newTestSession(t, 1, "alice", false, aliceTransport)
	if _, err := hub.Register(alice); err != nil {
		t.Fatalf("register alice: %v", err)
	}
	mustWelcome(t, hub, alice)

	if frames := waitFrames(t, aliceTransport, 1); frames[0].GetWelcome() == nil {
		t.Fatalf("first frame = %T, want Welcome", frames[0].GetPayload())
	}

	bobTransport := newFakeTransport()
	bob := newTestSession(t, 2, "bob", false, bobTransport)
	if _, err := hub.Register(bob); err != nil {
		t.Fatalf("register bob: %v", err)
	}
	mustWelcome(t, hub, bob)

	// Bob learns about Alice from the snapshot only.
	bobFrames := waitFrames(t, bobTransport, 1)
	if len(bobFrames) != 1 || bobFrames[0].GetWelcome() == nil {
		t.Fatalf("bob received %d frames before Welcome", len(bobFrames))
	}

	// Alice receives Welcome and then UserJoined for Bob, never the other way
	// around.
	frames := waitFrames(t, aliceTransport, 2)
	if frames[0].GetWelcome() == nil {
		t.Fatal("Welcome is not the first frame for the first client")
	}
	joined := frames[1].GetEvent().GetUserJoined()
	if joined == nil || joined.GetUser().GetId() != 2 {
		t.Fatalf("second frame = %v, want UserJoined for bob", frames[1].GetPayload())
	}
}

func TestRegisterEnforcesNicknamesAndCapacity(t *testing.T) {
	hub := NewHub(Config{MaxUsers: 1})

	alice := newTestSession(t, 1, "alice", false, newFakeTransport())
	if _, err := hub.Register(alice); err != nil {
		t.Fatalf("register alice: %v", err)
	}

	// A second user does not fit.
	other := newTestSession(t, 2, "bob", false, newFakeTransport())
	if _, err := hub.Register(other); !errors.Is(err, ErrServerFull) {
		t.Fatalf("register at capacity = %v, want ErrServerFull", err)
	}

	// The same user may reconnect at the limit; the old session is returned.
	reconnect := newTestSession(t, 1, "alice", false, newFakeTransport())
	old, err := hub.Register(reconnect)
	if err != nil {
		t.Fatalf("reconnect at capacity: %v", err)
	}
	if old != alice {
		t.Fatal("reconnect did not return the previous session")
	}
	if got := hub.Count(); got != 1 {
		t.Fatalf("online = %d, want 1", got)
	}

	// Nicknames are unique regardless of case.
	carol := newTestSession(t, 3, "ALICE", false, newFakeTransport())
	if _, err := hub.Register(carol); !errors.Is(err, ErrNicknameTaken) {
		t.Fatalf("duplicate nickname = %v, want ErrNicknameTaken", err)
	}
	if hub.NicknameAvailable("alice", 3) {
		t.Fatal("NicknameAvailable accepted an online nickname")
	}
	if !hub.NicknameAvailable("alice", 1) {
		t.Fatal("a user conflicts with their own nickname")
	}
}

func TestMoveAndLeaveProduceOrderedEvents(t *testing.T) {
	hub := newTestHub()
	transports := make([]*fakeTransport, 2)
	sessions := make([]*Session, 2)
	for i := range sessions {
		transports[i] = newFakeTransport()
		sessions[i] = newTestSession(t, int64(i+1), fmt.Sprintf("user%d", i+1), false, transports[i])
		if _, err := hub.Register(sessions[i]); err != nil {
			t.Fatalf("register %d: %v", i, err)
		}
		mustWelcome(t, hub, sessions[i])
	}
	// Both writers are asynchronous: wait until each Welcome has been written
	// before recording the baseline. The first client also gets the second
	// client's UserJoined; the second gets only its own Welcome. Otherwise a
	// late Welcome can be mistaken for the first post-move frame.
	waitFrames(t, transports[0], 2)
	waitFrames(t, transports[1], 1)
	before := map[*fakeTransport]int{
		transports[0]: len(transports[0].sent()),
		transports[1]: len(transports[1].sent()),
	}

	result, err := hub.Move(sessions[0].UserID(), 10, 0)
	if err != nil {
		t.Fatalf("move: %v", err)
	}
	if !result.Moved || result.FromChannelID != 0 || result.ToChannelID != 10 {
		t.Fatalf("move result = %+v", result)
	}

	// Both clients get UserMoved and then the new channel count.
	for i, transport := range transports {
		frames := waitFrames(t, transport, before[transport]+2)[before[transport]:]
		moved := frames[0].GetEvent().GetUserMoved()
		if moved == nil || moved.GetToChannelId() != 10 {
			t.Fatalf("client %d: frame after the move = %v, want UserMoved", i, frames[0].GetPayload())
		}
		updated := frames[1].GetEvent().GetChannelUpdated()
		if updated == nil || updated.GetChannel().GetUserCount() != 1 {
			t.Fatalf("client %d: second frame = %v, want ChannelUpdated with count 1", i, frames[1].GetPayload())
		}
	}

	result, err = hub.Leave(sessions[0].UserID())
	if err != nil {
		t.Fatalf("leave: %v", err)
	}
	if len(result.EmptiedChannels) != 1 || result.EmptiedChannels[0] != 10 {
		t.Fatalf("emptied channels = %v, want [10]", result.EmptiedChannels)
	}
}

func TestChannelChangeClearsStreaming(t *testing.T) {
	hub := newTestHub()
	transport := newFakeTransport()
	session := newTestSession(t, 1, "alice", false, transport)
	if _, err := hub.Register(session); err != nil {
		t.Fatalf("register: %v", err)
	}
	mustWelcome(t, hub, session)

	// A screen share in channel 3.
	if _, err := hub.Move(1, 3, 0); err != nil {
		t.Fatalf("move: %v", err)
	}
	if _, err := hub.SetStreaming(1, true); err != nil {
		t.Fatalf("set streaming: %v", err)
	}
	waitDrained(t, []*fakeTransport{transport})
	if presence, _ := hub.Presence(1); !presence.Streaming {
		t.Fatal("the stream flag was not set")
	}

	// Moving to another channel invalidates the share and announces the new
	// user state, so no client keeps a phantom LIVE badge.
	before := len(transport.sent())
	if _, err := hub.Move(1, 4, 0); err != nil {
		t.Fatalf("move to another channel: %v", err)
	}
	waitDrained(t, []*fakeTransport{transport})
	if presence, _ := hub.Presence(1); presence.Streaming {
		t.Fatal("the stream flag survived a channel change")
	}
	var sawMoved, sawStreamCleared bool
	for _, frame := range transport.sent()[before:] {
		if moved := frame.GetEvent().GetUserMoved(); moved != nil &&
			moved.GetUserId() == 1 && moved.GetToChannelId() == 4 {
			sawMoved = true
		}
		if updated := frame.GetEvent().GetUserUpdated(); updated != nil &&
			updated.GetUser().GetId() == 1 && !updated.GetUser().GetStreaming() {
			sawStreamCleared = true
		}
	}
	if !sawMoved || !sawStreamCleared {
		t.Fatalf("move frames: moved=%t stream_cleared=%t", sawMoved, sawStreamCleared)
	}

	// A new share started after the transition is allowed and sticks.
	if _, err := hub.SetStreaming(1, true); err != nil {
		t.Fatalf("start a new stream: %v", err)
	}
	waitDrained(t, []*fakeTransport{transport})
	if presence, _ := hub.Presence(1); !presence.Streaming {
		t.Fatal("a stream started in the new channel was not recorded")
	}

	// Re-entering the same channel is not a transition.
	if _, err := hub.Move(1, 4, 0); err != nil {
		t.Fatalf("move within the same channel: %v", err)
	}
	waitDrained(t, []*fakeTransport{transport})
	if presence, _ := hub.Presence(1); !presence.Streaming {
		t.Fatal("a no-op move cleared the stream flag")
	}

	// Leaving clears it as well.
	if _, err := hub.Leave(1); err != nil {
		t.Fatalf("leave: %v", err)
	}
	waitDrained(t, []*fakeTransport{transport})
	if presence, _ := hub.Presence(1); presence.Streaming {
		t.Fatal("the stream flag survived leaving the channel")
	}

	// Eviction, used when a channel is deleted or turns into text, clears it.
	if _, err := hub.Move(1, 9, 0); err != nil {
		t.Fatalf("move to 9: %v", err)
	}
	if _, err := hub.SetStreaming(1, true); err != nil {
		t.Fatalf("set streaming again: %v", err)
	}
	waitDrained(t, []*fakeTransport{transport})
	if evicted := hub.EvictFromChannels([]uint64{9}); len(evicted) != 1 || evicted[0] != 1 {
		t.Fatalf("evicted = %v, want [1]", evicted)
	}
	waitDrained(t, []*fakeTransport{transport})
	if presence, _ := hub.Presence(1); presence.Streaming {
		t.Fatal("the stream flag survived an eviction")
	}
}

// watchingOf returns the viewer list of an online user.
func watchingOf(t *testing.T, hub *Hub, userID int64) []uint64 {
	t.Helper()
	presence, ok := hub.Presence(userID)
	if !ok {
		t.Fatalf("user %d is offline", userID)
	}
	return presence.Watching
}

// lastUserUpdated returns the last UserUpdated frame for userID, or nil.
func lastUserUpdated(frames []*rostalkv1.ServerFrame, userID uint64) *rostalkv1.User {
	var found *rostalkv1.User
	for _, frame := range frames {
		updated := frame.GetEvent().GetUserUpdated()
		if updated != nil && updated.GetUser().GetId() == userID {
			found = updated.GetUser()
		}
	}
	return found
}

func TestSetWatchingKeepsOnlyLiveSharesOfTheOwnChannel(t *testing.T) {
	hub := newTestHub()
	streamerTransport := newFakeTransport()
	watcherTransport := newFakeTransport()
	otherTransport := newFakeTransport()
	streamer := newTestSession(t, 1, "streamer", false, streamerTransport)
	watcher := newTestSession(t, 2, "watcher", false, watcherTransport)
	other := newTestSession(t, 3, "other", false, otherTransport)
	for _, session := range []*Session{streamer, watcher, other} {
		if _, err := hub.Register(session); err != nil {
			t.Fatalf("register %d: %v", session.UserID(), err)
		}
		mustWelcome(t, hub, session)
	}
	if _, err := hub.Move(1, 3, 0); err != nil {
		t.Fatalf("move streamer: %v", err)
	}
	if _, err := hub.Move(2, 3, 0); err != nil {
		t.Fatalf("move watcher: %v", err)
	}
	if _, err := hub.Move(3, 4, 0); err != nil {
		t.Fatalf("move other: %v", err)
	}
	if _, err := hub.SetStreaming(1, true); err != nil {
		t.Fatalf("streamer streams: %v", err)
	}
	if _, err := hub.SetStreaming(3, true); err != nil {
		t.Fatalf("other streams: %v", err)
	}
	waitDrained(t, []*fakeTransport{streamerTransport, watcherTransport, otherTransport})

	// A stream in another channel, the caller itself, an offline id and a
	// duplicate are all dropped; the live share of the own channel stays.
	before := len(watcherTransport.sent())
	cases := []struct {
		name    string
		ids     []uint64
		want    []uint64
		changed bool
	}{
		{"live share of the own channel", []uint64{1}, []uint64{1}, true},
		{"deduplicated and sorted", []uint64{1, 1, 3, 2, 0, 999}, []uint64{1}, false},
		{"another channel only", []uint64{3}, nil, true},
		{"empty list stops watching", []uint64{}, nil, false},
	}
	for _, test := range cases {
		changed, err := hub.SetWatching(2, test.ids)
		if err != nil {
			t.Fatalf("%s: %v", test.name, err)
		}
		if got := watchingOf(t, hub, 2); !equalUint64IDs(got, test.want) {
			t.Fatalf("%s: watching = %v, want %v", test.name, got, test.want)
		}
		if changed != test.changed {
			t.Fatalf("%s: changed = %t, want %t", test.name, changed, test.changed)
		}
	}

	// A stream that is not live cannot be watched, even in the own channel.
	if _, err := hub.SetStreaming(1, false); err != nil {
		t.Fatalf("stop streaming: %v", err)
	}
	if _, err := hub.SetWatching(2, []uint64{1}); err != nil {
		t.Fatalf("watch a stopped stream: %v", err)
	}
	if got := watchingOf(t, hub, 2); len(got) != 0 {
		t.Fatalf("watching = %v after a stopped stream", got)
	}

	// Watching outside a channel is impossible as well.
	if _, err := hub.Leave(2); err != nil {
		t.Fatalf("leave: %v", err)
	}
	if _, err := hub.SetWatching(2, []uint64{1}); err != nil {
		t.Fatalf("watch with no channel: %v", err)
	}
	if got := watchingOf(t, hub, 2); len(got) != 0 {
		t.Fatalf("watching = %v outside a channel", got)
	}
	waitDrained(t, []*fakeTransport{streamerTransport, watcherTransport, otherTransport})

	// The watcher's change is announced so everyone in the channel sees it.
	frames := watcherTransport.sent()[before:]
	updated := lastUserUpdated(frames, 2)
	if updated == nil {
		t.Fatal("no UserUpdated for the watcher")
	}
	if got := updated.GetWatchingUserIds(); len(got) != 0 {
		t.Fatalf("announced viewer list = %v, want empty", got)
	}
}

func TestStreamStopClearsItsViewers(t *testing.T) {
	hub := newTestHub()
	streamerTransport := newFakeTransport()
	watcherTransport := newFakeTransport()
	streamer := newTestSession(t, 1, "streamer", false, streamerTransport)
	watcher := newTestSession(t, 2, "watcher", false, watcherTransport)
	for _, session := range []*Session{streamer, watcher} {
		if _, err := hub.Register(session); err != nil {
			t.Fatalf("register %d: %v", session.UserID(), err)
		}
		mustWelcome(t, hub, session)
	}
	for _, id := range []int64{1, 2} {
		if _, err := hub.Move(id, 3, 0); err != nil {
			t.Fatalf("move %d: %v", id, err)
		}
	}
	if _, err := hub.SetStreaming(1, true); err != nil {
		t.Fatalf("stream: %v", err)
	}
	if _, err := hub.SetWatching(2, []uint64{1}); err != nil {
		t.Fatalf("watch: %v", err)
	}
	if got := watchingOf(t, hub, 2); !equalUint64IDs(got, []uint64{1}) {
		t.Fatalf("watching = %v, want [1]", got)
	}
	waitDrained(t, []*fakeTransport{streamerTransport, watcherTransport})

	// Stopping the share must not leave a phantom audience behind.
	before := len(streamerTransport.sent())
	if _, err := hub.SetStreaming(1, false); err != nil {
		t.Fatalf("stop the stream: %v", err)
	}
	if got := watchingOf(t, hub, 2); len(got) != 0 {
		t.Fatalf("watching = %v after the stream stopped", got)
	}
	waitDrained(t, []*fakeTransport{streamerTransport, watcherTransport})
	updated := lastUserUpdated(streamerTransport.sent()[before:], 2)
	if updated == nil {
		t.Fatal("the streamer was not told that the audience is gone")
	}
	if got := updated.GetWatchingUserIds(); len(got) != 0 {
		t.Fatalf("announced viewer list = %v, want empty", got)
	}
}

func TestWatchingEndsWithTheSession(t *testing.T) {
	hub := newTestHub()
	streamerTransport := newFakeTransport()
	watcherTransport := newFakeTransport()
	streamer := newTestSession(t, 1, "streamer", false, streamerTransport)
	watcher := newTestSession(t, 2, "watcher", false, watcherTransport)
	for _, session := range []*Session{streamer, watcher} {
		if _, err := hub.Register(session); err != nil {
			t.Fatalf("register %d: %v", session.UserID(), err)
		}
		mustWelcome(t, hub, session)
	}
	for _, id := range []int64{1, 2} {
		if _, err := hub.Move(id, 3, 0); err != nil {
			t.Fatalf("move %d: %v", id, err)
		}
	}
	if _, err := hub.SetStreaming(1, true); err != nil {
		t.Fatalf("stream: %v", err)
	}
	if _, err := hub.SetWatching(2, []uint64{1}); err != nil {
		t.Fatalf("watch: %v", err)
	}

	// A replaced session keeps the audience: the media participant survives the
	// reconnect grace period, so the count must not flicker to zero.
	replacementTransport := newFakeTransport()
	replacement := newTestSession(t, 2, "watcher", false, replacementTransport)
	if _, err := hub.Register(replacement); err != nil {
		t.Fatalf("replace the viewer: %v", err)
	}
	mustWelcome(t, hub, replacement)
	if got := watchingOf(t, hub, 2); !equalUint64IDs(got, []uint64{1}) {
		t.Fatalf("watching after a reconnect = %v, want [1]", got)
	}

	// The streamer disconnects: the share is gone, so the watcher's list is
	// cleared and announced before the user disappears.
	waitDrained(t, []*fakeTransport{replacementTransport, streamerTransport})
	before := len(replacementTransport.sent())
	hub.Unregister(streamer)
	if online, _ := hub.Presence(1); online.UserID != 0 {
		t.Fatal("the streamer is still online")
	}
	if got := watchingOf(t, hub, 2); len(got) != 0 {
		t.Fatalf("watching = %v after the streamer left", got)
	}
	waitDrained(t, []*fakeTransport{replacementTransport})
	updated := lastUserUpdated(replacementTransport.sent()[before:], 2)
	if updated == nil || len(updated.GetWatchingUserIds()) != 0 {
		t.Fatalf("the viewer was not told about the end of the stream: %v", updated)
	}
}

func TestMoveEnforcesUserLimit(t *testing.T) {
	hub := newTestHub()
	first := newTestSession(t, 1, "alice", false, newFakeTransport())
	second := newTestSession(t, 2, "bob", false, newFakeTransport())
	for _, session := range []*Session{first, second} {
		if _, err := hub.Register(session); err != nil {
			t.Fatalf("register: %v", err)
		}
		mustWelcome(t, hub, session)
	}

	if _, err := hub.Move(first.UserID(), 5, 1); err != nil {
		t.Fatalf("first join: %v", err)
	}
	if _, err := hub.Move(second.UserID(), 5, 1); !errors.Is(err, ErrChannelFull) {
		t.Fatalf("second join = %v, want ErrChannelFull", err)
	}
	if presence, _ := hub.Presence(second.UserID()); presence.ChannelID != 0 {
		t.Fatal("a rejected join moved the user")
	}
	// Bypassing the limit (0) succeeds.
	if _, err := hub.Move(second.UserID(), 5, 0); err != nil {
		t.Fatalf("join with bypass: %v", err)
	}
}

func TestSetVoiceStateAndNickname(t *testing.T) {
	hub := newTestHub()
	transport := newFakeTransport()
	alice := newTestSession(t, 1, "alice", false, transport)
	if _, err := hub.Register(alice); err != nil {
		t.Fatalf("register: %v", err)
	}
	mustWelcome(t, hub, alice)

	muted := true
	changed, err := hub.SetVoiceState(1, VoicePatch{SelfMuted: &muted})
	if err != nil || !changed {
		t.Fatalf("SetVoiceState = %v, %v", changed, err)
	}
	frames := waitFrames(t, transport, 2)
	updated := frames[1].GetEvent().GetUserUpdated()
	if updated == nil || !updated.GetUser().GetVoiceState().GetSelfMuted() {
		t.Fatalf("frame = %v, want UserUpdated with self_muted", frames[1].GetPayload())
	}

	// A patch with the same value changes nothing and emits nothing.
	changed, err = hub.SetVoiceState(1, VoicePatch{SelfMuted: &muted})
	if err != nil || changed {
		t.Fatalf("repeated SetVoiceState = %v, %v", changed, err)
	}
	if frames := transport.sent(); len(frames) != 2 {
		t.Fatalf("frames after a no-op update = %d, want 2", len(frames))
	}

	if _, err := hub.SetNickname(1, "alice2"); err != nil {
		t.Fatalf("SetNickname: %v", err)
	}
	if got := alice.Nickname(); got != "alice2" {
		t.Fatalf("nickname = %q", got)
	}

	// Another user cannot take an online nickname.
	bob := newTestSession(t, 2, "bob", false, newFakeTransport())
	if _, err := hub.Register(bob); err != nil {
		t.Fatalf("register bob: %v", err)
	}
	if _, err := hub.SetNickname(2, "ALICE2"); !errors.Is(err, ErrNicknameTaken) {
		t.Fatalf("SetNickname duplicate = %v, want ErrNicknameTaken", err)
	}
}

func TestUnregisterRemovesUserAndAnnouncesIt(t *testing.T) {
	hub := newTestHub()
	observerTransport := newFakeTransport()
	observer := newTestSession(t, 1, "observer", false, observerTransport)
	leaverTransport := newFakeTransport()
	leaver := newTestSession(t, 2, "leaver", false, leaverTransport)
	for _, session := range []*Session{observer, leaver} {
		if _, err := hub.Register(session); err != nil {
			t.Fatalf("register: %v", err)
		}
		mustWelcome(t, hub, session)
	}
	waitFrames(t, observerTransport, 2)
	if _, err := hub.Move(leaver.UserID(), 3, 0); err != nil {
		t.Fatalf("move: %v", err)
	}

	emptied := hub.Unregister(leaver)
	if len(emptied) != 1 || emptied[0] != 3 {
		t.Fatalf("emptied = %v, want [3]", emptied)
	}
	if hub.Count() != 1 {
		t.Fatalf("online = %d, want 1", hub.Count())
	}
	if !leaverTransport.isClosed() {
		t.Fatal("the removed session transport is still open")
	}

	frames := waitFrames(t, observerTransport, 6)
	left := frames[4].GetEvent().GetUserLeft()
	if left == nil || left.GetUserId() != 2 {
		t.Fatalf("frame after move = %v, want UserLeft for user 2", frames[4].GetPayload())
	}
	updated := frames[5].GetEvent().GetChannelUpdated()
	if updated == nil || updated.GetChannel().GetId() != 3 {
		t.Fatalf("last frame = %v, want ChannelUpdated for channel 3", frames[5].GetPayload())
	}
	if got := updated.GetChannel().GetUserCount(); got != 0 {
		t.Fatalf("channel 3 user count = %d after disconnect, want 0", got)
	}

	// Unregistering the old session again is a no-op.
	if emptied := hub.Unregister(leaver); emptied != nil {
		t.Fatalf("second Unregister = %v", emptied)
	}
}

func TestReconnectKeepsPresenceAndChannelCount(t *testing.T) {
	hub := newTestHub()
	observerTransport := newFakeTransport()
	observer := newTestSession(t, 1, "observer", false, observerTransport)
	aliceTransport := newFakeTransport()
	alice := newTestSession(t, 2, "alice", false, aliceTransport)
	for _, session := range []*Session{observer, alice} {
		if _, err := hub.Register(session); err != nil {
			t.Fatalf("register: %v", err)
		}
		mustWelcome(t, hub, session)
	}
	if _, err := hub.Move(alice.UserID(), 7, 0); err != nil {
		t.Fatalf("move: %v", err)
	}
	waitDrained(t, []*fakeTransport{observerTransport, aliceTransport})
	before := len(observerTransport.sent())

	// The same user reconnects: the new session takes over the channel and the
	// voice flags, so nobody sees the user leave or a count drop.
	reconnectTransport := newFakeTransport()
	reconnect := newTestSession(t, 2, "alice2", false, reconnectTransport)
	old, err := hub.Register(reconnect)
	if err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	if old != alice {
		t.Fatal("reconnect did not return the previous session")
	}
	mustWelcome(t, hub, reconnect)

	presence, ok := hub.Presence(2)
	if !ok {
		t.Fatal("the reconnected user is not online")
	}
	if presence.ChannelID != 7 {
		t.Fatalf("reconnected user is in channel %d, want 7", presence.ChannelID)
	}
	if got := hub.ChannelCount(7); got != 1 {
		t.Fatalf("channel 7 count = %d after reconnect, want 1", got)
	}
	// The replaced session may finish after the new one took over; ending it
	// must not be treated as the user going offline.
	if emptied, removed := hub.UnregisterSession(alice); removed || emptied != nil {
		t.Fatalf("a replaced session was unregistered as current: emptied=%v removed=%t", emptied, removed)
	}

	frames := waitFrames(t, observerTransport, before+1)
	after := frames[before:]
	if joined := after[0].GetEvent().GetUserJoined(); joined == nil ||
		joined.GetUser().GetId() != 2 || joined.GetUser().GetChannelId() != 7 {
		t.Fatalf("frame after reconnect = %v, want UserJoined in channel 7", after[0].GetPayload())
	}
	for _, frame := range after {
		if frame.GetEvent().GetUserLeft() != nil {
			t.Fatal("a session replacement announced UserLeft")
		}
		if updated := frame.GetEvent().GetChannelUpdated(); updated != nil &&
			updated.GetChannel().GetId() == 7 && updated.GetChannel().GetUserCount() == 0 {
			t.Fatal("a session replacement announced an empty channel 7")
		}
	}
	if len(after) != 1 {
		t.Fatalf("replacement produced %d frames, want only UserJoined", len(after))
	}
}

func TestEvictFromChannelsAnnouncesMoves(t *testing.T) {
	hub := newTestHub()
	observerTransport := newFakeTransport()
	observer := newTestSession(t, 1, "observer", false, observerTransport)
	alice := newTestSession(t, 2, "alice", false, newFakeTransport())
	for _, session := range []*Session{observer, alice} {
		if _, err := hub.Register(session); err != nil {
			t.Fatalf("register: %v", err)
		}
		mustWelcome(t, hub, session)
	}
	if _, err := hub.Move(alice.UserID(), 9, 0); err != nil {
		t.Fatalf("move: %v", err)
	}
	waitDrained(t, []*fakeTransport{observerTransport})
	before := len(observerTransport.sent())

	evicted := hub.EvictFromChannels([]uint64{9, 10})
	if len(evicted) != 1 || evicted[0] != 2 {
		t.Fatalf("evicted = %v, want [2]", evicted)
	}
	if presence, _ := hub.Presence(2); presence.ChannelID != 0 {
		t.Fatalf("user is still in channel %d", presence.ChannelID)
	}
	frames := waitFrames(t, observerTransport, before+1)
	moved := frames[before].GetEvent().GetUserMoved()
	if moved == nil || moved.GetFromChannelId() != 9 || moved.GetToChannelId() != 0 {
		t.Fatalf("frame = %v, want UserMoved 9 -> 0", frames[before].GetPayload())
	}
}

func TestSlowClientIsDisconnected(t *testing.T) {
	hub := NewHub(Config{QueueSize: 2, Channels: fakeChannels{}})
	slowTransport := newFakeTransport()
	slow := newTestSession(t, 1, "slow", false, slowTransport)
	if _, err := hub.Register(slow); err != nil {
		t.Fatalf("register: %v", err)
	}
	mustWelcome(t, hub, slow)

	for i := 0; i < 20; i++ {
		hub.Broadcast(&rostalkv1.Event{
			Payload: &rostalkv1.Event_UserMoved{UserMoved: &rostalkv1.UserMoved{UserId: 99}},
		})
		if slowTransport.isClosed() {
			break
		}
	}
	deadline := time.Now().Add(2 * time.Second)
	for !slowTransport.isClosed() {
		if time.Now().After(deadline) {
			t.Fatal("the slow client was not disconnected")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestConcurrentMovesLeaveEveryObserverWithTheSameState(t *testing.T) {
	hub := newTestHub()
	const clients = 10
	const rounds = 40

	transports := make([]*fakeTransport, clients)
	sessions := make([]*Session, clients)
	for i := 0; i < clients; i++ {
		transports[i] = newFakeTransport()
		sessions[i] = newTestSession(t, int64(i+1), fmt.Sprintf("user%d", i+1), false, transports[i])
		if _, err := hub.Register(sessions[i]); err != nil {
			t.Fatalf("register %d: %v", i, err)
		}
		mustWelcome(t, hub, sessions[i])
	}

	var wg sync.WaitGroup
	for round := 0; round < rounds; round++ {
		for i := 0; i < clients; i++ {
			wg.Add(1)
			go func(i, round int) {
				defer wg.Done()
				channel := uint64(round%3 + 1)
				if (i+round)%4 == 0 {
					_, _ = hub.Leave(sessions[i].UserID())
					return
				}
				_, _ = hub.Move(sessions[i].UserID(), channel, 0)
			}(i, round)
		}
		wg.Wait()
	}

	// Every observer applies the events it received on top of its Welcome.
	// Mutations only queue frames; wait until the writer goroutines catch up.
	waitDrained(t, transports)
	expected := hub.SnapshotUsers()
	for i, transport := range transports {
		if transport.isClosed() {
			t.Fatalf("observer %d was disconnected during the burst", i)
		}
		channels := make(map[int64]uint64)
		for _, frame := range transport.sent() {
			if moved := frame.GetEvent().GetUserMoved(); moved != nil {
				channels[int64(moved.GetUserId())] = moved.GetToChannelId()
			}
		}
		for _, presence := range expected {
			if got := channels[presence.UserID]; got != presence.ChannelID {
				t.Fatalf("observer %d thinks user %d is in channel %d, hub says %d",
					i, presence.UserID, got, presence.ChannelID)
			}
		}
	}
}
