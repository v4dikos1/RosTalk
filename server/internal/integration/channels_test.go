package integration

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/control"
	"github.com/v4dikos1/RosTalk/server/internal/server"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

// testClient is a control-plane client with a background reader. It keeps the
// events it receives and the channel of every user it knows about, which is
// what an application state would look like.
type testClient struct {
	conn  *testSession
	state *clientState

	mu      sync.Mutex
	nextID  uint64
	pending map[uint64]chan *rostalkv1.ServerFrame
	err     error
	done    chan struct{}
}

type clientState struct {
	mu       sync.Mutex
	users    map[uint64]uint64 // user id -> channel id
	watching map[uint64][]uint64
	channels map[uint64]channelPlacement
}

// channelPlacement is the part of a channel the tree order depends on.
type channelPlacement struct {
	parent   uint64
	position int32
}

func newTestClient(session *testSession) *testClient {
	c := &testClient{
		conn: session,
		state: &clientState{
			users:    make(map[uint64]uint64),
			watching: make(map[uint64][]uint64),
			channels: make(map[uint64]channelPlacement),
		},
		nextID:  2,
		pending: make(map[uint64]chan *rostalkv1.ServerFrame),
		done:    make(chan struct{}),
	}
	c.applyWelcome(session.welcome)
	go c.readLoop()
	return c
}

func (c *testClient) close() {
	c.conn.close()
}

func (c *testClient) readLoop() {
	defer close(c.done)
	for {
		frame, err := c.conn.next(context.Background())
		if err != nil {
			c.mu.Lock()
			c.err = err
			c.mu.Unlock()
			return
		}
		if frame.GetReplyTo() != 0 {
			c.mu.Lock()
			waiter := c.pending[frame.GetReplyTo()]
			delete(c.pending, frame.GetReplyTo())
			c.mu.Unlock()
			if waiter != nil {
				waiter <- frame
			}
			continue
		}
		if event := frame.GetEvent(); event != nil {
			c.applyEvent(event)
		}
	}
}

func (c *testClient) applyWelcome(welcome *rostalkv1.Welcome) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	for _, user := range welcome.GetSnapshot().GetUsers() {
		c.state.users[user.GetId()] = user.GetChannelId()
		c.state.watching[user.GetId()] = append([]uint64(nil), user.GetWatchingUserIds()...)
	}
	for _, channel := range welcome.GetSnapshot().GetChannels() {
		c.state.channels[channel.GetId()] = channelPlacement{
			parent:   channel.GetParentId(),
			position: channel.GetPosition(),
		}
	}
}

func (c *testClient) applyEvent(event *rostalkv1.Event) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	switch payload := event.GetPayload().(type) {
	case *rostalkv1.Event_UserJoined:
		c.state.users[payload.UserJoined.GetUser().GetId()] = payload.UserJoined.GetUser().GetChannelId()
		c.state.watching[payload.UserJoined.GetUser().GetId()] = append(
			[]uint64(nil), payload.UserJoined.GetUser().GetWatchingUserIds()...)
	case *rostalkv1.Event_UserUpdated:
		c.state.users[payload.UserUpdated.GetUser().GetId()] = payload.UserUpdated.GetUser().GetChannelId()
		c.state.watching[payload.UserUpdated.GetUser().GetId()] = append(
			[]uint64(nil), payload.UserUpdated.GetUser().GetWatchingUserIds()...)
	case *rostalkv1.Event_UserMoved:
		c.state.users[payload.UserMoved.GetUserId()] = payload.UserMoved.GetToChannelId()
	case *rostalkv1.Event_UserLeft:
		delete(c.state.users, payload.UserLeft.GetUserId())
		delete(c.state.watching, payload.UserLeft.GetUserId())
	case *rostalkv1.Event_ChannelCreated:
		channel := payload.ChannelCreated.GetChannel()
		c.state.channels[channel.GetId()] = channelPlacement{
			parent:   channel.GetParentId(),
			position: channel.GetPosition(),
		}
	case *rostalkv1.Event_ChannelUpdated:
		channel := payload.ChannelUpdated.GetChannel()
		c.state.channels[channel.GetId()] = channelPlacement{
			parent:   channel.GetParentId(),
			position: channel.GetPosition(),
		}
	case *rostalkv1.Event_ChannelDeleted:
		delete(c.state.channels, payload.ChannelDeleted.GetChannelId())
	}
}

func (c *testClient) placements() map[uint64]channelPlacement {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	out := make(map[uint64]channelPlacement, len(c.state.channels))
	for id, placement := range c.state.channels {
		out[id] = placement
	}
	return out
}

func (c *testClient) channels() map[uint64]uint64 {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	out := make(map[uint64]uint64, len(c.state.users))
	for userID, channelID := range c.state.users {
		out[userID] = channelID
	}
	return out
}

// viewersOf returns the users this client believes are watching streamerID.
func (c *testClient) viewersOf(streamerID uint64) []uint64 {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	var out []uint64
	for userID, watching := range c.state.watching {
		for _, id := range watching {
			if id == streamerID {
				out = append(out, userID)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func (c *testClient) readErr() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *testClient) request(ctx context.Context, payload any) (*rostalkv1.ServerFrame, error) {
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	reply := make(chan *rostalkv1.ServerFrame, 1)
	c.pending[id] = reply
	c.mu.Unlock()

	frame := &rostalkv1.ClientFrame{RequestId: id}
	switch p := payload.(type) {
	case *rostalkv1.JoinChannel:
		frame.Payload = &rostalkv1.ClientFrame_JoinChannel{JoinChannel: p}
	case *rostalkv1.LeaveChannel:
		frame.Payload = &rostalkv1.ClientFrame_LeaveChannel{LeaveChannel: p}
	case *rostalkv1.SetVoiceState:
		frame.Payload = &rostalkv1.ClientFrame_SetVoiceState{SetVoiceState: p}
	case *rostalkv1.SetWatching:
		frame.Payload = &rostalkv1.ClientFrame_SetWatching{SetWatching: p}
	case *rostalkv1.SetNickname:
		frame.Payload = &rostalkv1.ClientFrame_SetNickname{SetNickname: p}
	case *rostalkv1.RequestMediaCredentials:
		frame.Payload = &rostalkv1.ClientFrame_RequestMediaCredentials{RequestMediaCredentials: p}
	default:
		return nil, fmt.Errorf("unsupported test payload %T", payload)
	}
	if err := writeClientFrame(ctx, c.conn.conn, frame); err != nil {
		return nil, err
	}
	select {
	case replyFrame := <-reply:
		return replyFrame, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.done:
		return nil, errors.New("connection closed")
	}
}

func (c *testClient) join(ctx context.Context, channelID uint64, password string) error {
	reply, err := c.request(ctx, &rostalkv1.JoinChannel{ChannelId: channelID, Password: password})
	if err != nil {
		return err
	}
	if serverErr := reply.GetError(); serverErr != nil {
		return &clientServerError{code: serverErr.GetCode(), message: serverErr.GetMessage()}
	}
	if reply.GetAck() == nil && reply.GetMediaCredentials() == nil {
		return fmt.Errorf("join reply has neither an ack nor media credentials: %T", reply.GetPayload())
	}
	return nil
}

func (c *testClient) leave(ctx context.Context) error {
	reply, err := c.request(ctx, &rostalkv1.LeaveChannel{})
	if err != nil {
		return err
	}
	if serverErr := reply.GetError(); serverErr != nil {
		return &clientServerError{code: serverErr.GetCode(), message: serverErr.GetMessage()}
	}
	return nil
}

type clientServerError struct {
	code    rostalkv1.ErrorCode
	message string
}

func (e *clientServerError) Error() string {
	return fmt.Sprintf("%s: %s", e.code, e.message)
}

func errorCode(err error) rostalkv1.ErrorCode {
	var serverErr *clientServerError
	if errors.As(err, &serverErr) {
		return serverErr.code
	}
	return rostalkv1.ErrorCode_ERROR_CODE_UNSPECIFIED
}

// newChannelsTestApp starts a server in open mode: 50 test clients log in
// without spending invites, and the per-IP rate limiter is out of the way.
func newChannelsTestApp(t *testing.T) *server.App {
	t.Helper()
	return newTestApp(t, func(st *store.Store) {
		ctx := context.Background()
		if err := st.SetSetting(ctx, "login_mode", "open"); err != nil {
			t.Fatalf("SetSetting login_mode: %v", err)
		}
		if err := st.SetSetting(ctx, "auth_attempts_limit", "10000"); err != nil {
			t.Fatalf("SetSetting auth_attempts_limit: %v", err)
		}
	})
}

func connectTestClient(t *testing.T, app *server.App, nickname string) *testClient {
	t.Helper()
	identity, err := newTestIdentity()
	if err != nil {
		t.Fatalf("newTestIdentity: %v", err)
	}
	return connectTestClientAs(t, app, identity, nickname)
}

// connectTestClientAs connects with a specific identity, which lets a test
// reconnect as the same user and exercise session replacement.
func connectTestClientAs(t *testing.T, app *server.App, identity *testIdentity, nickname string) *testClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	session, err := testConnect(ctx, app.Addr().String(), connectOptions{
		identity:    identity,
		nickname:    nickname,
		fingerprint: app.TLS.FingerprintHex,
	})
	if err != nil {
		t.Fatalf("connect %s: %v", nickname, err)
	}
	client := newTestClient(session)
	t.Cleanup(client.close)
	return client
}

func createChannel(t *testing.T, app *server.App, params channels.CreateParams) channels.Channel {
	t.Helper()
	channel, err := app.Control.CreateChannel(context.Background(), params)
	if err != nil {
		t.Fatalf("create channel %q: %v", params.Name, err)
	}
	return channel
}

// waitStatesAgree waits until every client has the same user→channel map and
// returns it. Delivery is asynchronous, so agreement is checked with a small
// stability window.
func waitStatesAgree(t *testing.T, clients []*testClient) map[uint64]uint64 {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	stableSince := time.Now()
	var previous map[uint64]uint64
	for {
		states := make([]map[uint64]uint64, len(clients))
		for i, client := range clients {
			states[i] = client.channels()
		}
		agree := true
		for i := 1; i < len(states); i++ {
			if !sameChannels(states[0], states[i]) {
				agree = false
				break
			}
		}
		if agree && sameChannels(states[0], previous) {
			if time.Since(stableSince) >= 200*time.Millisecond {
				return states[0]
			}
		} else {
			previous = states[0]
			stableSince = time.Now()
		}
		if time.Now().After(deadline) {
			t.Fatalf("clients did not agree on the final state; client 0 has %v", states[0])
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func sameChannels(a, b map[uint64]uint64) bool {
	if len(a) != len(b) {
		return false
	}
	for userID, channelID := range a {
		if b[userID] != channelID {
			return false
		}
	}
	return true
}

func TestFiftyClientsJoinMoveAndLeaveWithTheSameFinalState(t *testing.T) {
	if testing.Short() {
		t.Skip("50 concurrent clients are slow in -short mode")
	}
	app := newChannelsTestApp(t)

	lobby := app.Channels.List()[0]
	other := createChannel(t, app, channels.CreateParams{Name: "Разговорная"})
	third := createChannel(t, app, channels.CreateParams{Name: "Музыка"})
	targets := []uint64{uint64(lobby.ID), uint64(other.ID), uint64(third.ID)}

	const clients = 50
	const rounds = 3
	sessions := make([]*testClient, clients)
	for i := 0; i < clients; i++ {
		sessions[i] = connectTestClient(t, app, fmt.Sprintf("user%02d", i))
	}

	var wg sync.WaitGroup
	errs := make(chan error, clients*rounds)
	for i := 0; i < clients; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			client := sessions[i]
			for round := 0; round < rounds; round++ {
				target := targets[(i+round)%len(targets)]
				if err := client.join(ctx, target, ""); err != nil {
					errs <- fmt.Errorf("client %d round %d join: %w", i, round, err)
					return
				}
				if round == 1 {
					if err := client.leave(ctx); err != nil {
						errs <- fmt.Errorf("client %d round %d leave: %w", i, round, err)
						return
					}
				}
			}
			// Half of the clients end up outside any channel.
			if i%2 == 0 {
				if err := client.leave(ctx); err != nil {
					errs <- fmt.Errorf("client %d final leave: %w", i, err)
				}
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("client request failed: %v", err)
	}

	final := waitStatesAgree(t, sessions)

	// The server's own view must match what the clients converged on.
	presence := app.Hub.SnapshotUsers()
	if len(presence) != len(final) {
		t.Fatalf("hub has %d users, clients see %d", len(presence), len(final))
	}
	for _, user := range presence {
		if final[uint64(user.UserID)] != user.ChannelID {
			t.Fatalf("hub says user %d is in channel %d, clients see %d",
				user.UserID, user.ChannelID, final[uint64(user.UserID)])
		}
	}
	for i, client := range sessions {
		if err := client.readErr(); err != nil {
			t.Fatalf("client %d was disconnected: %v", i, err)
		}
	}

	// A client that reconnects gets a fresh snapshot with the same state.
	probe := connectTestClient(t, app, "probe")
	fresh := make(map[uint64]uint64)
	for _, user := range app.Hub.SnapshotUsers() {
		fresh[uint64(user.UserID)] = user.ChannelID
	}
	if got := probe.channels(); !sameChannels(got, fresh) {
		t.Fatalf("a fresh snapshot differs from the server state: %v vs %v", got, fresh)
	}
}

func TestChannelPasswordAndUserLimit(t *testing.T) {
	app := newChannelsTestApp(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	protected := createChannel(t, app, channels.CreateParams{Name: "Секретная", Password: "open sesame"})
	limited := createChannel(t, app, channels.CreateParams{Name: "Одна", UserLimit: 1})
	text := createChannel(t, app, channels.CreateParams{
		Name: "Текстовая",
		Kind: rostalkv1.ChannelKind_CHANNEL_KIND_TEXT,
	})

	alice := connectTestClient(t, app, "alice")
	bob := connectTestClient(t, app, "bob")

	if code := errorCode(alice.join(ctx, uint64(protected.ID), "")); code != rostalkv1.ErrorCode_ERROR_CODE_CHANNEL_PASSWORD_REQUIRED {
		t.Fatalf("join without a password = %v, want CHANNEL_PASSWORD_REQUIRED", code)
	}
	if code := errorCode(alice.join(ctx, uint64(protected.ID), "wrong")); code != rostalkv1.ErrorCode_ERROR_CODE_CHANNEL_PASSWORD_INVALID {
		t.Fatalf("join with a wrong password = %v, want CHANNEL_PASSWORD_INVALID", code)
	}
	if err := alice.join(ctx, uint64(protected.ID), "open sesame"); err != nil {
		t.Fatalf("join with the right password: %v", err)
	}
	if err := alice.leave(ctx); err != nil {
		t.Fatalf("leave: %v", err)
	}

	if err := alice.join(ctx, uint64(limited.ID), ""); err != nil {
		t.Fatalf("first join into a limited channel: %v", err)
	}
	if code := errorCode(bob.join(ctx, uint64(limited.ID), "")); code != rostalkv1.ErrorCode_ERROR_CODE_CHANNEL_FULL {
		t.Fatalf("second join = %v, want CHANNEL_FULL", code)
	}
	if err := alice.leave(ctx); err != nil {
		t.Fatalf("leave the limited channel: %v", err)
	}
	if err := bob.join(ctx, uint64(limited.ID), ""); err != nil {
		t.Fatalf("join after the seat was freed: %v", err)
	}

	if code := errorCode(alice.join(ctx, uint64(text.ID), "")); code != rostalkv1.ErrorCode_ERROR_CODE_REJECTED {
		t.Fatalf("join into a text channel = %v, want REJECTED", code)
	}
	if code := errorCode(alice.join(ctx, 999999, "")); code != rostalkv1.ErrorCode_ERROR_CODE_NOT_FOUND {
		t.Fatalf("join into a missing channel = %v, want NOT_FOUND", code)
	}
}

func TestTemporaryChannelDisappearsWhenEmpty(t *testing.T) {
	app := newChannelsTestApp(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	temporary := createChannel(t, app, channels.CreateParams{Name: "Временная", Temporary: true})
	permanent := createChannel(t, app, channels.CreateParams{Name: "Постоянная"})

	alice := connectTestClient(t, app, "alice")
	bob := connectTestClient(t, app, "bob")

	if err := alice.join(ctx, uint64(temporary.ID), ""); err != nil {
		t.Fatalf("join temporary: %v", err)
	}
	// A second user keeps it alive.
	if err := bob.join(ctx, uint64(temporary.ID), ""); err != nil {
		t.Fatalf("second join temporary: %v", err)
	}
	if err := alice.leave(ctx); err != nil {
		t.Fatalf("first leave: %v", err)
	}
	waitFor(t, func() bool {
		_, ok := app.Channels.Get(temporary.ID)
		return ok
	}, "the temporary channel disappeared while still occupied")

	if err := bob.leave(ctx); err != nil {
		t.Fatalf("second leave: %v", err)
	}
	waitFor(t, func() bool {
		_, ok := app.Channels.Get(temporary.ID)
		return !ok
	}, "the empty temporary channel was not deleted")

	// The permanent channel stays even when empty.
	if err := alice.join(ctx, uint64(permanent.ID), ""); err != nil {
		t.Fatalf("join permanent: %v", err)
	}
	if err := alice.leave(ctx); err != nil {
		t.Fatalf("leave permanent: %v", err)
	}
	waitFor(t, func() bool {
		_, ok := app.Channels.Get(permanent.ID)
		return ok
	}, "an empty permanent channel was deleted")

	// A temporary channel is deleted when its last user disconnects, too.
	third := createChannel(t, app, channels.CreateParams{Name: "Временная 2", Temporary: true})
	carol := connectTestClient(t, app, "carol")
	if err := carol.join(ctx, uint64(third.ID), ""); err != nil {
		t.Fatalf("join third: %v", err)
	}
	carol.close()
	waitFor(t, func() bool {
		_, ok := app.Channels.Get(third.ID)
		return !ok
	}, "the temporary channel of a disconnected user was not deleted")
}

// createChannelAt is createChannel with an optional explicit position.
func createChannelAt(t *testing.T, app *server.App, params channels.CreateParams, position *int32) channels.Channel {
	t.Helper()
	params.Position = position
	return createChannel(t, app, params)
}

func serverPlacements(app *server.App) map[uint64]channelPlacement {
	out := make(map[uint64]channelPlacement)
	for _, channel := range app.Channels.List() {
		out[uint64(channel.ID)] = channelPlacement{
			parent:   uint64(channel.ParentID),
			position: channel.Position,
		}
	}
	return out
}

func samePlacements(a, b map[uint64]channelPlacement) bool {
	if len(a) != len(b) {
		return false
	}
	for id, placement := range a {
		if b[id] != placement {
			return false
		}
	}
	return true
}

// waitPlacementsMatch waits until the client's cached tree equals the server's
// and has been stable for a moment (events are delivered asynchronously).
func waitPlacementsMatch(t *testing.T, client *testClient, app *server.App) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	stableSince := time.Now()
	for {
		if samePlacements(client.placements(), serverPlacements(app)) {
			if time.Since(stableSince) >= 150*time.Millisecond {
				return
			}
		} else {
			stableSince = time.Now()
		}
		if time.Now().After(deadline) {
			t.Fatalf("channel placements diverged:\nclient: %v\nserver: %v",
				client.placements(), serverPlacements(app))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestReconnectKeepsTemporaryChannelAndPresence(t *testing.T) {
	app := newChannelsTestApp(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	temporary := createChannelAt(t, app, channels.CreateParams{Name: "Временная", Temporary: true}, nil)
	identity, err := newTestIdentity()
	if err != nil {
		t.Fatalf("newTestIdentity: %v", err)
	}
	first := connectTestClientAs(t, app, identity, "alice")
	observer := connectTestClient(t, app, "bob")
	if err := first.join(ctx, uint64(temporary.ID), ""); err != nil {
		t.Fatalf("join temporary: %v", err)
	}

	// The same key reconnects: the session is replaced, but the user stays in
	// the temporary channel, so the channel must not be deleted and the count
	// stays 1.
	second := connectTestClientAs(t, app, identity, "alice")
	self := second.conn.welcome.GetSelfUserId()
	if self == 0 {
		t.Fatal("the reconnected client has no self user id")
	}
	if got := second.channels()[self]; got != uint64(temporary.ID) {
		t.Fatalf("the reconnected user is in channel %d, want the temporary channel %d", got, temporary.ID)
	}
	if got := app.Hub.ChannelCount(uint64(temporary.ID)); got != 1 {
		t.Fatalf("temporary channel count after reconnect = %d, want 1", got)
	}
	waitFor(t, func() bool {
		_, ok := app.Channels.Get(temporary.ID)
		return ok
	}, "the temporary channel was deleted after a reconnect")
	if got := app.Hub.ChannelCount(uint64(temporary.ID)); got != 1 {
		t.Fatalf("temporary channel count = %d after the replacement settled, want 1", got)
	}
	if len(app.Hub.SnapshotUsers()) != 2 {
		t.Fatalf("online users = %d, want 2", len(app.Hub.SnapshotUsers()))
	}
	if err := observer.readErr(); err != nil {
		t.Fatalf("the observer was disconnected by the replacement: %v", err)
	}

	// Once the reconnected user leaves, the now empty temporary channel is
	// removed as usual.
	if err := second.leave(ctx); err != nil {
		t.Fatalf("leave temporary: %v", err)
	}
	waitFor(t, func() bool {
		_, ok := app.Channels.Get(temporary.ID)
		return !ok
	}, "the empty temporary channel was not deleted")
}

func TestChannelPlacementStaysInSync(t *testing.T) {
	app := newChannelsTestApp(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	lobby := app.Channels.List()[0]
	alice := connectTestClient(t, app, "alice")
	waitPlacementsMatch(t, alice, app)

	// Inserting at position 0 renumbers the existing children.
	zero := int32(0)
	createChannelAt(t, app, channels.CreateParams{Name: "Первый", ParentID: lobby.ID}, &zero)
	waitPlacementsMatch(t, alice, app)

	// Deleting from the middle renumbers the channels after it.
	second := createChannelAt(t, app, channels.CreateParams{Name: "Второй", ParentID: lobby.ID}, nil)
	createChannelAt(t, app, channels.CreateParams{Name: "Третий", ParentID: lobby.ID}, nil)
	waitPlacementsMatch(t, alice, app)
	if err := app.Control.DeleteChannel(ctx, second.ID); err != nil {
		t.Fatalf("delete the middle channel: %v", err)
	}
	waitPlacementsMatch(t, alice, app)

	// An automatically deleted temporary channel also renumbers its siblings.
	temporary := createChannelAt(t, app, channels.CreateParams{Name: "Временная", ParentID: lobby.ID, Temporary: true}, nil)
	bob := connectTestClient(t, app, "bob")
	if err := bob.join(ctx, uint64(temporary.ID), ""); err != nil {
		t.Fatalf("join temporary: %v", err)
	}
	if err := bob.leave(ctx); err != nil {
		t.Fatalf("leave temporary: %v", err)
	}
	waitPlacementsMatch(t, alice, app)
	if _, ok := app.Channels.Get(temporary.ID); ok {
		t.Fatal("the temporary channel was not deleted")
	}

	// A channel with users cannot be deleted; the client never sees a dangling
	// channel id.
	if err := bob.join(ctx, uint64(lobby.ID), ""); err != nil {
		t.Fatalf("join lobby: %v", err)
	}
	if err := app.Control.DeleteChannel(ctx, lobby.ID); !errors.Is(err, control.ErrChannelOccupied) {
		t.Fatalf("deleting an occupied channel = %v, want ErrChannelOccupied", err)
	}
	waitPlacementsMatch(t, alice, app)
	if got := bob.channels()[bob.conn.welcome.GetSelfUserId()]; got != uint64(lobby.ID) {
		t.Fatalf("bob is in channel %d, want the lobby", got)
	}
}

func waitFor(t *testing.T, condition func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if condition() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal(message)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWelcomeContainsChannelTreeAndVoiceState(t *testing.T) {
	app := newChannelsTestApp(t)
	lobby := app.Channels.List()[0]
	createChannel(t, app, channels.CreateParams{Name: "Вложенная", ParentID: lobby.ID})

	client := connectTestClient(t, app, "alice")
	snapshot := client.conn.welcome.GetSnapshot()
	if len(snapshot.GetChannels()) != 3 {
		t.Fatalf("snapshot has %d channels, want 3", len(snapshot.GetChannels()))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	muted := true
	reply, err := client.request(ctx, &rostalkv1.SetVoiceState{SelfMuted: &muted})
	if err != nil {
		t.Fatalf("set voice state: %v", err)
	}
	if reply.GetAck() == nil {
		t.Fatalf("SetVoiceState reply = %T, want Ack", reply.GetPayload())
	}
	waitFor(t, func() bool {
		for _, user := range app.Hub.SnapshotUsers() {
			if user.UserID != int64(client.conn.welcome.GetSelfUserId()) {
				continue
			}
			return user.Voice.SelfMuted
		}
		return false
	}, "the voice state was not applied")

	if err := client.leave(ctx); err != nil {
		t.Fatalf("leave without a channel: %v", err)
	}
}

func TestNicknameChangeIsPersistedAndAnnounced(t *testing.T) {
	app := newChannelsTestApp(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	alice := connectTestClient(t, app, "alice")
	bob := connectTestClient(t, app, "bob")

	reply, err := alice.request(ctx, &rostalkv1.SetNickname{Nickname: "alice-2"})
	if err != nil {
		t.Fatalf("set nickname: %v", err)
	}
	if reply.GetError() != nil {
		t.Fatalf("set nickname failed: %v", reply.GetError())
	}
	waitFor(t, func() bool {
		for _, user := range app.Hub.SnapshotUsers() {
			if user.Nickname == "alice-2" {
				return true
			}
		}
		return false
	}, "the nickname change was not applied")

	bobReply, err := bob.request(ctx, &rostalkv1.SetNickname{Nickname: "ALICE-2"})
	if err != nil {
		t.Fatalf("set duplicate nickname: %v", err)
	}
	if code := bobReply.GetError().GetCode(); code != rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST {
		t.Fatalf("duplicate nickname = %s, want INVALID_REQUEST", code)
	}
}
