// Package state owns everything that lives only in memory: who is online, which
// channel each user is in, their voice flags, and the fan-out of events to
// connected clients (design 4.5: "online state lives in memory and is not
// written to the database").
//
// # Ordering
//
// Every mutation takes one hub lock, applies the change, builds the resulting
// events and queues them for all clients before releasing the lock. Clients
// therefore receive the same sequence of state changes, which makes their
// snapshots converge after any burst of concurrent joins and moves. The
// per-session queue is bounded: a client that falls behind is disconnected
// instead of slowing the hub down.
//
// # Locks
//
// Hub.mu may call into channels.Service.View (read-only). channels.Service
// never calls back into the hub, so the order hub → channels is safe. A session
// additionally has two small mutexes: one for its mutable presence fields and
// one for its outbound queue. The hub lock is always taken before those.
package state

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/sessionauth"
)

// DefaultQueueSize is the number of frames a slow client may fall behind before
// it is disconnected. Fifty online users generate a handful of frames per
// action, so this is several seconds of burst tolerance.
const DefaultQueueSize = 256

// writeTimeout bounds one frame write. A client that does not drain its socket
// cannot hold the writer forever.
const writeTimeout = 10 * time.Second

// ErrSessionClosed is returned when a frame is queued for a closed session.
var ErrSessionClosed = errors.New("session is closed")

// ErrQueueFull is returned when the bounded per-session queue overflows.
var ErrQueueFull = errors.New("session event queue is full")

// Transport is one authenticated connection as seen by the state layer. The
// gateway implements it; tests use an in-memory implementation.
type Transport interface {
	// Read returns the next decoded client frame.
	Read(ctx context.Context) (*rostalkv1.ClientFrame, error)
	// Write sends one server frame.
	Write(ctx context.Context, frame *rostalkv1.ServerFrame) error
	// Close closes the underlying connection.
	Close() error
}

// VoiceState is the mutable voice part of a presence.
type VoiceState struct {
	SelfMuted      bool
	SelfDeafened   bool
	ServerMuted    bool
	ServerDeafened bool
	Away           bool
}

// Presence is a consistent copy of one online user. Copies never share memory
// with the live session, so callers may keep them.
type Presence struct {
	UserID    int64
	Nickname  string
	Admin     bool
	RoleIDs   []int64
	ChannelID uint64
	Voice     VoiceState
	Streaming bool
	// Watching lists the screen shares the user watches, by streamer id
	// (stage P12). It never contains a stream outside the user's channel: the
	// hub keeps only live shares of the same channel and clears the list when
	// the viewer leaves, the stream stops or either session ends.
	Watching    []uint64
	ConnectedAt time.Time
	// AvatarHash is the SHA-256 hex of the re-encoded avatar, empty when the
	// user has none (stage P11).
	AvatarHash string
	// IP is the remote address the session authenticated from. It stays in
	// memory and is used only for moderation (ban by address), never sent to
	// other clients.
	IP string
}

// PreparedSnapshot is the part of the Welcome snapshot that is read before the
// hub lock is taken. Today it carries the unread counters, whose SQLite queries
// used to run under the global hub lock and serialised every connect, move and
// leave behind a history scan. The hub treats the contents as opaque.
type PreparedSnapshot struct {
	Unread []*rostalkv1.UnreadCounter
}

// Proto converts a presence to its wire form.
func (p Presence) Proto() *rostalkv1.User {
	roles := make([]uint64, 0, len(p.RoleIDs))
	for _, id := range p.RoleIDs {
		if id > 0 {
			roles = append(roles, uint64(id))
		}
	}
	return &rostalkv1.User{
		Id:        uint64(p.UserID),
		Nickname:  p.Nickname,
		RoleIds:   roles,
		ChannelId: p.ChannelID,
		VoiceState: &rostalkv1.VoiceState{
			SelfMuted:      p.Voice.SelfMuted,
			SelfDeafened:   p.Voice.SelfDeafened,
			ServerMuted:    p.Voice.ServerMuted,
			ServerDeafened: p.Voice.ServerDeafened,
			Away:           p.Voice.Away,
		},
		Streaming:         p.Streaming,
		WatchingUserIds:   append([]uint64(nil), p.Watching...),
		ConnectedAtUnixMs: p.ConnectedAt.UnixMilli(),
		AvatarHash:        p.AvatarHash,
	}
}

// SessionParams builds a session. Only the immutable identity and the transport
// are required; presence starts empty.
type SessionParams struct {
	UserID      int64
	PublicKeyID string
	Nickname    string
	Admin       bool
	RoleIDs     []int64
	ConnectedAt time.Time
	AvatarHash  string
	IP          string
	Transport   Transport
	QueueSize   int
}

// Session is one authenticated connection with its own bounded event queue and
// writer goroutine.
type Session struct {
	userID      int64
	publicKeyID string
	connectedAt time.Time
	ip          string
	transport   Transport
	queueSize   int

	// mu guards the mutable presence fields.
	mu        sync.RWMutex
	nickname  string
	admin     bool
	roleIDs   []int64
	channelID uint64
	voice     VoiceState
	streaming bool
	// watching lists the screen shares the user watches, by streamer id. It is
	// kept sorted and deduplicated (stage P12).
	watching []uint64
	// avatarHash is the content hash of the user's avatar (stage P11).
	avatarHash string
	// httpToken is the bearer token for the chat HTTP endpoints (stage 4.1).
	// It is issued in Welcome and revoked when the session ends; it is never
	// logged or returned by any other frame.
	httpToken string

	// qmu guards the outbound queue and the lifecycle flags.
	qmu     sync.Mutex
	queue   []*rostalkv1.ServerFrame
	pending bool // welcome not sent yet: broadcast events are skipped
	closing bool // a final frame was queued; close after flushing it
	closed  bool
	wake    chan struct{}
}

// NewSession creates a session. Call Hub.Register to make it visible and to
// start its writer.
func NewSession(params SessionParams) (*Session, error) {
	if params.Transport == nil {
		return nil, errors.New("state: session transport is required")
	}
	if params.UserID == 0 {
		return nil, errors.New("state: session user id must not be zero")
	}
	queueSize := params.QueueSize
	if queueSize <= 0 {
		queueSize = DefaultQueueSize
	}
	return &Session{
		userID:      params.UserID,
		publicKeyID: params.PublicKeyID,
		connectedAt: params.ConnectedAt,
		ip:          params.IP,
		transport:   params.Transport,
		queueSize:   queueSize,
		nickname:    params.Nickname,
		admin:       params.Admin,
		roleIDs:     append([]int64(nil), params.RoleIDs...),
		avatarHash:  params.AvatarHash,
		pending:     true,
		wake:        make(chan struct{}, 1),
	}, nil
}

// UserID returns the stable user id.
func (s *Session) UserID() int64 { return s.userID }

// PublicKeyID returns the hex-encoded public key that owns the session.
func (s *Session) PublicKeyID() string { return s.publicKeyID }

// ConnectedAt returns when the session was authenticated.
func (s *Session) ConnectedAt() time.Time { return s.connectedAt }

// Transport returns the underlying connection.
func (s *Session) Transport() Transport { return s.transport }

// HTTPToken returns the bearer token issued for the chat HTTP endpoints. It is
// empty before Welcome and after the session was revoked.
func (s *Session) HTTPToken() string {
	s.qmu.Lock()
	defer s.qmu.Unlock()
	return s.httpToken
}

func (s *Session) setHTTPToken(token string) {
	s.qmu.Lock()
	s.httpToken = token
	s.qmu.Unlock()
}

// Nickname returns the current display name.
func (s *Session) Nickname() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.nickname
}

// Admin reports whether the user holds the administrator flag.
func (s *Session) Admin() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.admin
}

// RoleIDs returns a copy of the roles held by the user.
func (s *Session) RoleIDs() []int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]int64(nil), s.roleIDs...)
}

// ChannelID returns the channel the user is in, 0 when none.
func (s *Session) ChannelID() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.channelID
}

// Streaming reports whether the user publishes a screen share. Always false in
// stage 1.3; the stream engine sets it later.
func (s *Session) Streaming() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.streaming
}

// Presence returns a copy of the session state.
func (s *Session) Presence() Presence {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return Presence{
		UserID:      s.userID,
		Nickname:    s.nickname,
		Admin:       s.admin,
		RoleIDs:     append([]int64(nil), s.roleIDs...),
		ChannelID:   s.channelID,
		Voice:       s.voice,
		Streaming:   s.streaming,
		Watching:    append([]uint64(nil), s.watching...),
		ConnectedAt: s.connectedAt,
		AvatarHash:  s.avatarHash,
		IP:          s.ip,
	}
}

func (s *Session) proto() *rostalkv1.User { return s.Presence().Proto() }

// Closed reports whether the session can no longer receive frames.
func (s *Session) Closed() bool {
	s.qmu.Lock()
	defer s.qmu.Unlock()
	return s.closed || s.closing
}

// enqueue appends a frame to the outbound queue. It reports ErrQueueFull when
// the client is too slow; the caller disconnects it.
func (s *Session) enqueue(frame *rostalkv1.ServerFrame) error {
	s.qmu.Lock()
	if s.closed || s.closing {
		s.qmu.Unlock()
		return ErrSessionClosed
	}
	if len(s.queue) >= s.queueSize {
		s.closed = true
		s.qmu.Unlock()
		_ = s.transport.Close()
		s.wakeUp()
		return ErrQueueFull
	}
	s.queue = append(s.queue, frame)
	s.qmu.Unlock()
	s.wakeUp()
	return nil
}

// Terminate queues a final error frame and closes the connection after it has
// been flushed. It is safe to call from another goroutine (session replacement).
func (s *Session) Terminate(code rostalkv1.ErrorCode, message string) {
	s.qmu.Lock()
	if s.closed || s.closing {
		s.qmu.Unlock()
		return
	}
	s.closing = true
	s.queue = append(s.queue, &rostalkv1.ServerFrame{
		Payload: &rostalkv1.ServerFrame_Error{Error: &rostalkv1.Error{
			Code:    code,
			Message: message,
		}},
	})
	s.qmu.Unlock()
	s.wakeUp()
}

// stop closes the session immediately. Pending frames are dropped: the peer is
// gone or too slow.
func (s *Session) stop() {
	s.qmu.Lock()
	s.closed = true
	s.qmu.Unlock()
	s.wakeUp()
	_ = s.transport.Close()
}

func (s *Session) markWelcomed() {
	s.qmu.Lock()
	s.pending = false
	s.qmu.Unlock()
}

func (s *Session) isPending() bool {
	s.qmu.Lock()
	defer s.qmu.Unlock()
	return s.pending
}

func (s *Session) wakeUp() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// pump is the only writer of the session after the handshake. It drains the
// queue in order and closes the transport when the session ends.
func (s *Session) pump() {
	defer func() { _ = s.transport.Close() }()
	for {
		frames, closing, closed := s.takeQueue()
		if closed {
			return
		}
		for _, frame := range frames {
			ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
			err := s.transport.Write(ctx, frame)
			cancel()
			if err != nil {
				return
			}
		}
		if closing {
			return
		}
		if len(frames) == 0 {
			<-s.wake
		}
	}
}

func (s *Session) takeQueue() (frames []*rostalkv1.ServerFrame, closing, closed bool) {
	s.qmu.Lock()
	defer s.qmu.Unlock()
	frames = s.queue
	s.queue = nil
	return frames, s.closing, s.closed
}

// Send queues one frame for the client. It is used by the handshake and by the
// control plane for replies and errors.
func (s *Session) Send(frame *rostalkv1.ServerFrame) error {
	if err := s.enqueue(frame); err != nil {
		if errors.Is(err, ErrQueueFull) {
			s.stop()
		}
		return err
	}
	return nil
}

// ErrNicknameTaken means another online user already uses the nickname.
var ErrNicknameTaken = errors.New("nickname is already used by another online user")

// ErrServerFull means max_users is reached and the user has no session to
// replace.
var ErrServerFull = errors.New("server is full")

// ErrNotOnline is returned by mutations for a user without a session.
var ErrNotOnline = errors.New("user is not online")

// ErrSessionReplaced is returned when a request comes from a session that a
// newer connection of the same user already replaced. Acting by user id would
// change the state of the new session, which the old connection does not own.
var ErrSessionReplaced = errors.New("session was replaced by a newer connection")

// ErrChannelFull is returned when a channel is at its user limit.
var ErrChannelFull = errors.New("channel is full")

// ChannelSource supplies channel descriptions without a user count; the hub
// fills user_count from its own presence map.
type ChannelSource interface {
	View(id uint64) (*rostalkv1.Channel, bool)
}

// Visibility reports whether a user may see a channel. It is implemented by
// the role model; a nil Visibility makes every channel visible.
type Visibility interface {
	CanView(userID int64, channelID uint64) bool
}

// Config wires a hub.
type Config struct {
	Logger     *slog.Logger
	MaxUsers   uint32
	QueueSize  int
	Channels   ChannelSource
	Visibility Visibility
	// Tokens issues the short-lived HTTP session tokens handed out in Welcome
	// (stage 4.1). Nil disables them, which tests that only use the control
	// plane rely on.
	Tokens *sessionauth.Registry
}

// Hub is the online state and the broadcast fan-out.
type Hub struct {
	mu sync.Mutex

	sessions map[int64]*Session
	order    []int64

	maxUsers   uint32
	queueSize  int
	channels   ChannelSource
	visibility Visibility
	tokens     *sessionauth.Registry
	logger     *slog.Logger
}

// NewHub creates an empty hub.
func NewHub(cfg Config) *Hub {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	queueSize := cfg.QueueSize
	if queueSize <= 0 {
		queueSize = DefaultQueueSize
	}
	return &Hub{
		sessions:   make(map[int64]*Session),
		maxUsers:   cfg.MaxUsers,
		queueSize:  queueSize,
		channels:   cfg.Channels,
		visibility: cfg.Visibility,
		tokens:     cfg.Tokens,
		logger:     logger,
	}
}

// Register inserts a session and starts its writer. At most one session per
// user exists: registering again returns the previous session so the caller can
// terminate it (design 4.2: a new connection replaces the old one).
//
// A replacement keeps the online presence of the old session: the new session
// inherits its channel and voice flags. The user never leaves the channel, so
// channel user counts stay correct and a temporary channel is not deleted only
// because its occupant reconnected. The nickname comes from the new handshake,
// because the user may have changed it.
//
// Nickname uniqueness is enforced among online users and compared
// case-insensitively, exactly as during the handshake.
func (h *Hub) Register(s *Session) (*Session, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	old := h.sessions[s.UserID()]
	nickname := s.Nickname()
	for id, existing := range h.sessions {
		if id == s.UserID() {
			continue
		}
		if strings.EqualFold(existing.Nickname(), nickname) {
			return nil, ErrNicknameTaken
		}
	}
	if old == nil && h.maxUsers > 0 && len(h.sessions) >= int(h.maxUsers) {
		return nil, ErrServerFull
	}

	if old != nil {
		previous := old.Presence()
		s.mu.Lock()
		s.channelID = previous.ChannelID
		s.voice = previous.Voice
		s.streaming = previous.Streaming
		// The viewer list belongs to the presence, not to the socket: the
		// screen-share participants survive the grace period, so the streamer
		// must not see its audience drop only because the viewer reconnected.
		// The fresh client re-sends the list after Welcome, which corrects it
		// if the user closed the tile while the socket was down.
		s.watching = append([]uint64(nil), previous.Watching...)
		s.mu.Unlock()
	}

	h.sessions[s.UserID()] = s
	if old == nil {
		h.order = append(h.order, s.UserID())
	}
	s.queueSize = h.queueSize
	go s.pump()
	h.logger.Info("user online",
		"user_id", s.UserID(),
		"nickname", nickname,
		"admin", s.Admin(),
		"replaced", old != nil,
	)
	return old, nil
}

// NicknameAvailable reports whether nickname is free among online users,
// ignoring exceptUserID. The handshake calls it before consuming an invite;
// Register repeats the check under the hub lock to close the race.
func (h *Hub) NicknameAvailable(nickname string, exceptUserID int64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, existing := range h.sessions {
		if id == exceptUserID {
			continue
		}
		if strings.EqualFold(existing.Nickname(), nickname) {
			return false
		}
	}
	return true
}

// HasPublicKey reports whether the key already has an online session.
func (h *Hub) HasPublicKey(publicKeyID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, s := range h.sessions {
		if s.PublicKeyID() == publicKeyID {
			return true
		}
	}
	return false
}

// Count returns the number of online users.
func (h *Hub) Count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.sessions)
}

// SnapshotUsers returns a consistent copy of every online user, in connection
// order.
func (h *Hub) SnapshotUsers() []Presence {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.presencesLocked()
}

// Presence returns a copy of one online user.
func (h *Hub) Presence(userID int64) (Presence, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[userID]
	if !ok {
		return Presence{}, false
	}
	return s.Presence(), true
}

// ChannelCount returns how many users are in a channel.
func (h *Hub) ChannelCount(channelID uint64) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.countLocked(channelID)
}

// InChannel reports whether userID is online and currently in channelID. The
// media supervisor asks it to decide whether a media participant still has a
// presence record (prompt item 6).
func (h *Hub) InChannel(userID int64, channelID uint64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[userID]
	return ok && s.ChannelID() == channelID
}

// Welcome builds a snapshot while holding the hub lock, queues the Welcome
// frame and only then announces the user to everyone else. The build callback
// receives the online users and must not call back into the hub or touch the
// database: the expensive snapshot reads happen before Welcome
// (auth.Handler.PrepareSnapshot), so the lock only covers in-memory work.
func (h *Hub) Welcome(s *Session, replyTo uint64, build func(users []Presence) *rostalkv1.ServerSnapshot) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	if current, ok := h.sessions[s.UserID()]; !ok || current != s {
		// The session was replaced between Register and Welcome; it will never
		// become visible, so release its writer.
		s.stop()
		return ErrNotOnline
	}
	snapshot := build(h.presencesLocked())
	welcome := &rostalkv1.Welcome{
		Snapshot:   snapshot,
		SelfUserId: uint64(s.UserID()),
	}
	// The chat HTTP endpoints authenticate with this token. It is issued here,
	// inside Welcome, so the client never sees a session without it; a failure
	// to generate 32 random bytes is fatal for the session.
	if h.tokens != nil {
		token, expiresAt, err := h.tokens.Issue(s.UserID())
		if err != nil {
			return fmt.Errorf("issue session token: %w", err)
		}
		s.setHTTPToken(token)
		welcome.HttpToken = token
		welcome.HttpTokenExpiresInSeconds = uint32(time.Until(expiresAt).Seconds())
	}
	frame := &rostalkv1.ServerFrame{
		ReplyTo: replyTo,
		Payload: &rostalkv1.ServerFrame_Welcome{Welcome: welcome},
	}
	if err := s.enqueue(frame); err != nil {
		return fmt.Errorf("queue welcome: %w", err)
	}
	s.markWelcomed()

	h.broadcastLocked(&rostalkv1.ServerFrame{
		Payload: &rostalkv1.ServerFrame_Event{Event: &rostalkv1.Event{
			Payload: &rostalkv1.Event_UserJoined{UserJoined: &rostalkv1.UserJoined{User: s.proto()}},
		}},
	}, s.UserID())
	return nil
}

// Unregister removes a session and returns the channels that became empty. The
// caller deletes temporary channels from that list.
//
// Every other client receives UserLeft followed by ChannelUpdated for the
// channel the user was in, so its user count drops to zero even for a
// permanent channel (a temporary channel is then deleted by the control
// plane).
func (h *Hub) Unregister(s *Session) []uint64 {
	emptied, _ := h.UnregisterSession(s)
	return emptied
}

// UnregisterSession is Unregister with a report of whether s was still the
// current session. A replaced session that finishes after the new one took over
// must not drive per-user cleanup (idle flags, media timers) for its user.
func (h *Hub) UnregisterSession(s *Session) ([]uint64, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// The token belongs to this authenticated session, not to the user: even a
	// replaced session must lose it immediately.
	if h.tokens != nil {
		h.tokens.Revoke(s.HTTPToken())
	}
	if current, ok := h.sessions[s.UserID()]; !ok || current != s {
		return nil, false
	}
	channelID := s.ChannelID()
	delete(h.sessions, s.UserID())
	for i, id := range h.order {
		if id == s.UserID() {
			h.order = append(h.order[:i], h.order[i+1:]...)
			break
		}
	}
	emptied := h.channelBecameEmptyLocked(channelID)

	h.broadcastLocked(&rostalkv1.ServerFrame{
		Payload: &rostalkv1.ServerFrame_Event{Event: &rostalkv1.Event{
			Payload: &rostalkv1.Event_UserLeft{UserLeft: &rostalkv1.UserLeft{UserId: uint64(s.UserID())}},
		}},
	}, 0)
	// A stream ends with its publisher: whoever watched it must not keep an id
	// of an offline user in the presence, so the watchers are announced again.
	h.clearWatchersLocked(s.UserID())
	h.broadcastChannelCountsLocked(channelID)

	s.stop()
	h.logger.Info("user offline", "user_id", s.UserID(), "nickname", s.Nickname())
	return emptied, true
}

// EvictFromChannels moves every user who is still in one of channelIDs to no
// channel and announces the moves. Control calls it after deleting a channel:
// normally a delete is rejected while the subtree has users, so this only
// handles a user who joined between the check and the delete.
func (h *Hub) EvictFromChannels(channelIDs []uint64) []int64 {
	if len(channelIDs) == 0 {
		return nil
	}
	removed := make(map[uint64]struct{}, len(channelIDs))
	for _, id := range channelIDs {
		removed[id] = struct{}{}
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	var evicted []int64
	for _, userID := range h.order {
		s, ok := h.sessions[userID]
		if !ok {
			continue
		}
		from := s.ChannelID()
		if _, gone := removed[from]; !gone {
			continue
		}
		s.mu.Lock()
		s.channelID = 0
		streamReset := s.streaming
		s.streaming = false
		watchingReset := len(s.watching) > 0
		s.watching = nil
		s.mu.Unlock()
		evicted = append(evicted, userID)
		h.broadcastLocked(&rostalkv1.ServerFrame{
			Payload: &rostalkv1.ServerFrame_Event{Event: &rostalkv1.Event{
				Payload: &rostalkv1.Event_UserMoved{UserMoved: &rostalkv1.UserMoved{
					UserId:        uint64(userID),
					FromChannelId: from,
					ToChannelId:   0,
				}},
			}},
		}, 0)
		if streamReset {
			h.broadcastUserUpdatedLocked(s)
			h.clearWatchersLocked(userID)
		} else if watchingReset {
			h.broadcastUserUpdatedLocked(s)
		}
	}
	return evicted
}

// Move changes the channel of a user and announces the move. A move into the
// current channel is a no-op that produces no events. userLimit is enforced
// inside the hub lock (0 means unlimited), so two users cannot both take the
// last seat.
func (h *Hub) Move(userID int64, channelID uint64, userLimit uint32) (MoveResult, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.moveLocked(userID, channelID, userLimit)
}

// IsCurrent reports whether s is still the online session of its user. A
// replacement makes the old session stale; its request loop may still deliver
// a frame that was read before the replacement.
func (h *Hub) IsCurrent(s *Session) bool {
	if s == nil {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	current, ok := h.sessions[s.UserID()]
	return ok && current == s
}

// MoveSession moves the user only if s is still the current session. The check
// and the move happen under the hub lock, so a request from a replaced session
// cannot move the user who now owns the connection.
func (h *Hub) MoveSession(s *Session, channelID uint64, userLimit uint32) (MoveResult, error) {
	if s == nil {
		return MoveResult{}, ErrSessionReplaced
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if current, ok := h.sessions[s.UserID()]; !ok || current != s {
		return MoveResult{}, ErrSessionReplaced
	}
	return h.moveLocked(s.UserID(), channelID, userLimit)
}

// LeaveSession removes the user from their channel only if s is current.
func (h *Hub) LeaveSession(s *Session) (MoveResult, error) {
	return h.MoveSession(s, 0, 0)
}

// MoveResult describes a channel change.
type MoveResult struct {
	Moved           bool
	FromChannelID   uint64
	ToChannelID     uint64
	EmptiedChannels []uint64
}

// Leave removes a user from their channel.
func (h *Hub) Leave(userID int64) (MoveResult, error) {
	return h.Move(userID, 0, 0)
}

func (h *Hub) moveLocked(userID int64, channelID uint64, userLimit uint32) (MoveResult, error) {
	s, ok := h.sessions[userID]
	if !ok {
		return MoveResult{}, ErrNotOnline
	}
	s.mu.Lock()
	from := s.channelID
	s.mu.Unlock()
	if from == channelID {
		return MoveResult{FromChannelID: from, ToChannelID: channelID}, nil
	}
	// The hub lock serialises every move, so the count cannot change between
	// this check and the assignment below.
	if channelID != 0 && userLimit > 0 && h.countLocked(channelID) >= int(userLimit) {
		return MoveResult{FromChannelID: from, ToChannelID: from}, ErrChannelFull
	}
	s.mu.Lock()
	s.channelID = channelID
	// A screen share belongs to one voice channel: leaving it or moving to
	// another one invalidates the media participant, so the flag must not
	// follow the user and leave a phantom LIVE badge behind.
	streamReset := from != channelID && s.streaming
	if streamReset {
		s.streaming = false
	}
	// The same holds for the viewer list: it only names streams of the current
	// channel, so a move starts with an empty list.
	watchingReset := from != channelID && len(s.watching) > 0
	if watchingReset {
		s.watching = nil
	}
	s.mu.Unlock()

	result := MoveResult{Moved: true, FromChannelID: from, ToChannelID: channelID}
	h.broadcastLocked(&rostalkv1.ServerFrame{
		Payload: &rostalkv1.ServerFrame_Event{Event: &rostalkv1.Event{
			Payload: &rostalkv1.Event_UserMoved{UserMoved: &rostalkv1.UserMoved{
				UserId:        uint64(userID),
				FromChannelId: from,
				ToChannelId:   channelID,
			}},
		}},
	}, 0)
	if streamReset {
		h.broadcastUserUpdatedLocked(s)
		// The stream ended with the move, so its audience goes with it.
		h.clearWatchersLocked(userID)
	} else if watchingReset {
		h.broadcastUserUpdatedLocked(s)
	}

	if from != 0 && h.countLocked(from) == 0 {
		result.EmptiedChannels = append(result.EmptiedChannels, from)
	}
	h.broadcastChannelCountsLocked(from, channelID)
	return result, nil
}

// VoicePatch carries the flags a SetVoiceState request changes; nil fields keep
// the current value.
type VoicePatch struct {
	SelfMuted      *bool
	SelfDeafened   *bool
	ServerMuted    *bool
	ServerDeafened *bool
	Away           *bool
}

// SetVoiceState updates the voice flags of a user and announces the change.
func (h *Hub) SetVoiceState(userID int64, patch VoicePatch) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	s, ok := h.sessions[userID]
	if !ok {
		return false, ErrNotOnline
	}
	s.mu.Lock()
	changed := false
	if patch.SelfMuted != nil && s.voice.SelfMuted != *patch.SelfMuted {
		s.voice.SelfMuted = *patch.SelfMuted
		changed = true
	}
	if patch.SelfDeafened != nil && s.voice.SelfDeafened != *patch.SelfDeafened {
		s.voice.SelfDeafened = *patch.SelfDeafened
		changed = true
	}
	if patch.ServerMuted != nil && s.voice.ServerMuted != *patch.ServerMuted {
		s.voice.ServerMuted = *patch.ServerMuted
		changed = true
	}
	if patch.ServerDeafened != nil && s.voice.ServerDeafened != *patch.ServerDeafened {
		s.voice.ServerDeafened = *patch.ServerDeafened
		changed = true
	}
	if patch.Away != nil && s.voice.Away != *patch.Away {
		s.voice.Away = *patch.Away
		changed = true
	}
	s.mu.Unlock()
	if !changed {
		return false, nil
	}
	h.broadcastUserUpdatedLocked(s)
	return true, nil
}

// SetNickname renames a user and announces the change. Uniqueness is checked
// again under the hub lock.
func (h *Hub) SetNickname(userID int64, nickname string) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	s, ok := h.sessions[userID]
	if !ok {
		return false, ErrNotOnline
	}
	for id, existing := range h.sessions {
		if id == userID {
			continue
		}
		if strings.EqualFold(existing.Nickname(), nickname) {
			return false, ErrNicknameTaken
		}
	}
	s.mu.Lock()
	changed := s.nickname != nickname
	s.nickname = nickname
	s.mu.Unlock()
	if !changed {
		return false, nil
	}
	h.broadcastUserUpdatedLocked(s)
	return true, nil
}

// SetAvatarHash stores a user's avatar content hash and announces the change.
// It reports false when the user is offline: the database is still updated by
// the caller, and the next handshake picks the hash up.
func (h *Hub) SetAvatarHash(userID int64, hash string) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	s, ok := h.sessions[userID]
	if !ok {
		return false, ErrNotOnline
	}
	s.mu.Lock()
	changed := s.avatarHash != hash
	s.avatarHash = hash
	s.mu.Unlock()
	if !changed {
		return false, nil
	}
	h.broadcastUserUpdatedLocked(s)
	return true, nil
}

// SetStreaming updates the screen-share flag and announces the change.
func (h *Hub) SetStreaming(userID int64, streaming bool) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[userID]
	if !ok {
		return false, ErrNotOnline
	}
	s.mu.Lock()
	changed := s.streaming != streaming
	s.streaming = streaming
	s.mu.Unlock()
	if !changed {
		return false, nil
	}
	h.broadcastUserUpdatedLocked(s)
	if !streaming {
		// The audience belongs to a live share: a stopped stream must not keep
		// a viewer count for a tile that no longer exists (stage P12).
		h.clearWatchersLocked(userID)
	}
	return true, nil
}

// SetWatching replaces the set of screen shares the user watches and announces
// the change (stage P12).
//
// The server is the authority: an id survives only when that user is online, is
// in the caller's voice channel and is publishing a screen share right now.
// Other ids are dropped instead of failing the request, so a click that races
// the end of a stream does not wipe the rest of the list. Ids of the caller
// itself and duplicates are ignored; the result is sorted.
func (h *Hub) SetWatching(userID int64, streamerIDs []uint64) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[userID]
	if !ok {
		return false, ErrNotOnline
	}
	return h.setWatchingLocked(s, streamerIDs), nil
}

// SetWatchingSession is SetWatching that refuses a session another connection
// already replaced: a stale request must not change the new session's audience.
func (h *Hub) SetWatchingSession(s *Session, streamerIDs []uint64) (bool, error) {
	if s == nil {
		return false, ErrSessionReplaced
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if current, ok := h.sessions[s.UserID()]; !ok || current != s {
		return false, ErrSessionReplaced
	}
	return h.setWatchingLocked(s, streamerIDs), nil
}

func (h *Hub) setWatchingLocked(s *Session, streamerIDs []uint64) bool {
	next := h.liveStreamsLocked(s, streamerIDs)
	s.mu.Lock()
	changed := !equalUint64IDs(s.watching, next)
	s.watching = next
	s.mu.Unlock()
	if changed {
		h.broadcastUserUpdatedLocked(s)
	}
	return changed
}

// liveStreamsLocked keeps the ids that name a live screen share of the
// session's own voice channel, sorted and deduplicated.
func (h *Hub) liveStreamsLocked(s *Session, streamerIDs []uint64) []uint64 {
	s.mu.RLock()
	channelID := s.channelID
	s.mu.RUnlock()
	if channelID == 0 {
		return nil
	}
	seen := make(map[uint64]struct{}, len(streamerIDs))
	out := make([]uint64, 0, len(streamerIDs))
	for _, id := range streamerIDs {
		if id == 0 || id > math.MaxInt64 || id == uint64(s.UserID()) {
			continue
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		target, ok := h.sessions[int64(id)]
		if !ok || target.ChannelID() != channelID || !target.Streaming() {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// clearWatchersLocked drops streamerID from every viewer's list and announces
// each change, so no client keeps a count for a stream that is gone.
func (h *Hub) clearWatchersLocked(streamerID int64) {
	id := uint64(streamerID)
	if id == 0 {
		return
	}
	for _, userID := range h.order {
		s, ok := h.sessions[userID]
		if !ok {
			continue
		}
		s.mu.Lock()
		if !watchingContains(s.watching, id) {
			s.mu.Unlock()
			continue
		}
		next := make([]uint64, 0, len(s.watching))
		for _, watched := range s.watching {
			if watched != id {
				next = append(next, watched)
			}
		}
		s.watching = next
		s.mu.Unlock()
		h.broadcastUserUpdatedLocked(s)
	}
}

func watchingContains(ids []uint64, id uint64) bool {
	for _, candidate := range ids {
		if candidate == id {
			return true
		}
	}
	return false
}

func equalUint64IDs(left, right []uint64) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

// SetRoles replaces the roles of an online user and announces the change.
func (h *Hub) SetRoles(userID int64, roleIDs []int64) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[userID]
	if !ok {
		return false, ErrNotOnline
	}
	s.mu.Lock()
	changed := !equalIDs(s.roleIDs, roleIDs)
	s.roleIDs = append([]int64(nil), roleIDs...)
	s.mu.Unlock()
	if !changed {
		return false, nil
	}
	h.broadcastUserUpdatedLocked(s)
	return true, nil
}

// SetMaxUsers updates the online-user cap without a restart.
func (h *Hub) SetMaxUsers(max uint32) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.maxUsers = max
}

// TerminateUser disconnects one online user with a final error frame. It is
// used by kick, ban and session replacement.
func (h *Hub) TerminateUser(userID int64, code rostalkv1.ErrorCode, message string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[userID]
	if !ok {
		return false
	}
	s.Terminate(code, message)
	return true
}

// RevokeHTTPTokens drops every chat HTTP bearer token of a user. Kick and ban
// call it before the control connection finishes closing: the session token is
// a separate credential, and a banned client must not keep reading history
// while the final frame is still being flushed.
func (h *Hub) RevokeHTTPTokens(userID int64) {
	if h.tokens == nil {
		return
	}
	h.tokens.RevokeUser(userID)
}

// SendToUser queues one event for one online user without the channel filter.
// It is used for personal events such as the caller's own permission update.
func (h *Hub) SendToUser(userID int64, event *rostalkv1.Event) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[userID]
	if !ok || s.isPending() {
		return ErrNotOnline
	}
	return s.enqueue(&rostalkv1.ServerFrame{
		Payload: &rostalkv1.ServerFrame_Event{Event: event},
	})
}

// Broadcast queues one event for every client.
func (h *Hub) Broadcast(events ...*rostalkv1.Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, event := range events {
		h.broadcastLocked(&rostalkv1.ServerFrame{
			Payload: &rostalkv1.ServerFrame_Event{Event: event},
		}, 0)
	}
}

// BroadcastChannelUpdated announces the current state of the given channels,
// including their user counts.
func (h *Hub) BroadcastChannelUpdated(channelIDs ...uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.broadcastChannelCountsLocked(channelIDs...)
}

// BroadcastChannelDeleted announces removed channels. The gateway drops a
// channel subtree children-first, so clients never infer the tree.
func (h *Hub) BroadcastChannelDeleted(channelIDs ...uint64) {
	events := make([]*rostalkv1.Event, 0, len(channelIDs))
	for _, id := range channelIDs {
		events = append(events, &rostalkv1.Event{
			Payload: &rostalkv1.Event_ChannelDeleted{ChannelDeleted: &rostalkv1.ChannelDeleted{
				ChannelId: id,
			}},
		})
	}
	h.Broadcast(events...)
}

func equalIDs(left, right []int64) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func (h *Hub) presencesLocked() []Presence {
	out := make([]Presence, 0, len(h.sessions))
	for _, id := range h.order {
		if s, ok := h.sessions[id]; ok {
			out = append(out, s.Presence())
		}
	}
	return out
}

func (h *Hub) countLocked(channelID uint64) int {
	if channelID == 0 {
		return 0
	}
	count := 0
	for _, s := range h.sessions {
		if s.ChannelID() == channelID {
			count++
		}
	}
	return count
}

// channelBecameEmptyLocked appends the channel to the emptied list when it has
// no users left.
func (h *Hub) channelBecameEmptyLocked(channelID uint64) []uint64 {
	if channelID == 0 || h.countLocked(channelID) != 0 {
		return nil
	}
	return []uint64{channelID}
}

// broadcastChannelCountsLocked sends ChannelUpdated for channels whose user
// count clients can see.
func (h *Hub) broadcastChannelCountsLocked(channelIDs ...uint64) {
	if h.channels == nil {
		return
	}
	for _, id := range channelIDs {
		if id == 0 {
			continue
		}
		view, ok := h.channels.View(id)
		if !ok {
			continue
		}
		view.UserCount = uint32(h.countLocked(id))
		h.broadcastLocked(&rostalkv1.ServerFrame{
			Payload: &rostalkv1.ServerFrame_Event{Event: &rostalkv1.Event{
				Payload: &rostalkv1.Event_ChannelUpdated{ChannelUpdated: &rostalkv1.ChannelUpdated{
					Channel: view,
				}},
			}},
		}, 0)
	}
}

func (h *Hub) broadcastUserUpdatedLocked(s *Session) {
	h.broadcastLocked(&rostalkv1.ServerFrame{
		Payload: &rostalkv1.ServerFrame_Event{Event: &rostalkv1.Event{
			Payload: &rostalkv1.Event_UserUpdated{UserUpdated: &rostalkv1.UserUpdated{User: s.proto()}},
		}},
	}, 0)
}

// broadcastLocked queues one frame for every welcomed client, skipping
// skipUserID when it is non-zero. Events that reference a channel the recipient
// may not see are filtered out (or rewritten for UserMoved), so a hidden
// channel never leaks through the event stream. A user with a full queue is
// disconnected.
func (h *Hub) broadcastLocked(frame *rostalkv1.ServerFrame, skipUserID int64) {
	event := frame.GetEvent()
	for _, id := range h.order {
		if id == skipUserID {
			continue
		}
		s, ok := h.sessions[id]
		if !ok || s.isPending() {
			continue
		}
		out := frame
		if event != nil {
			filtered := h.filterEventLocked(id, event)
			if filtered == nil {
				continue
			}
			if filtered != event {
				out = &rostalkv1.ServerFrame{
					ReplyTo: frame.GetReplyTo(),
					Payload: &rostalkv1.ServerFrame_Event{Event: filtered},
				}
			}
		}
		if err := s.enqueue(out); err != nil {
			if errors.Is(err, ErrQueueFull) {
				h.logger.Warn("disconnecting a slow client",
					"user_id", id,
					"queue_size", s.queueSize,
				)
			}
		}
	}
}

// filterEventLocked returns the event as seen by viewer, or nil when the viewer
// may not see anything it references.
func (h *Hub) filterEventLocked(viewer int64, event *rostalkv1.Event) *rostalkv1.Event {
	switch payload := event.GetPayload().(type) {
	case *rostalkv1.Event_UserJoined:
		if !h.visibleLocked(viewer, payload.UserJoined.GetUser().GetChannelId()) {
			return nil
		}
	case *rostalkv1.Event_UserUpdated:
		if !h.visibleLocked(viewer, payload.UserUpdated.GetUser().GetChannelId()) {
			return nil
		}
	case *rostalkv1.Event_UserMoved:
		moved := payload.UserMoved
		fromVisible := h.visibleLocked(viewer, moved.GetFromChannelId()) || moved.GetFromChannelId() == 0
		toVisible := h.visibleLocked(viewer, moved.GetToChannelId()) || moved.GetToChannelId() == 0
		switch {
		case !fromVisible && !toVisible:
			return nil
		case fromVisible && !toVisible:
			// The user left the viewer's visible world. Reporting "no channel"
			// keeps the cached user list consistent without revealing where the
			// user went.
			return &rostalkv1.Event{Payload: &rostalkv1.Event_UserMoved{UserMoved: &rostalkv1.UserMoved{
				UserId:        moved.GetUserId(),
				FromChannelId: moved.GetFromChannelId(),
				ToChannelId:   0,
			}}}
		case !fromVisible && toVisible:
			return &rostalkv1.Event{Payload: &rostalkv1.Event_UserMoved{UserMoved: &rostalkv1.UserMoved{
				UserId:        moved.GetUserId(),
				FromChannelId: 0,
				ToChannelId:   moved.GetToChannelId(),
			}}}
		}
	case *rostalkv1.Event_ChannelCreated:
		if !h.visibleLocked(viewer, payload.ChannelCreated.GetChannel().GetId()) {
			return nil
		}
	case *rostalkv1.Event_ChannelUpdated:
		if !h.visibleLocked(viewer, payload.ChannelUpdated.GetChannel().GetId()) {
			return nil
		}
	case *rostalkv1.Event_UserLeft, *rostalkv1.Event_ChannelDeleted,
		*rostalkv1.Event_ServerUpdated, *rostalkv1.Event_RolesUpdated,
		*rostalkv1.Event_PermissionsUpdated:
		// No channel payload to filter. A user id or channel id alone does not
		// reveal a hidden channel.
	}
	return event
}

// visibleLocked reports whether viewer may see channelID. Channel 0 (not in a
// channel) is always visible.
func (h *Hub) visibleLocked(viewer int64, channelID uint64) bool {
	if channelID == 0 || h.visibility == nil {
		return true
	}
	return h.visibility.CanView(viewer, channelID)
}
