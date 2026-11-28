// Package control executes authenticated requests: joining and leaving
// channels, voice flags, nicknames and the channel-tree operations that later
// stages expose through the admin API.
//
// Every handler asks internal/perms first and then mutates internal/state. The
// state hub owns ordering and broadcasting, so a request either fails before it
// touches state or produces one consistent sequence of events for all clients.
package control

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/chat"
	"github.com/v4dikos1/RosTalk/server/internal/media"
	"github.com/v4dikos1/RosTalk/server/internal/nickname"
	"github.com/v4dikos1/RosTalk/server/internal/perms"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/state"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

// DefaultDisconnectGrace is how long the media participants of a user survive a
// dropped control connection. A client that reconnects within this window keeps
// its audio session; after it the media plane is cleaned up (prompt item 5).
const DefaultDisconnectGrace = 10 * time.Second

// mediaTimeout bounds one media-plane call made from a request handler. The
// embedded backend answers from memory, so this only guards against a bug.
const mediaTimeout = 5 * time.Second

// Config wires the request handlers.
type Config struct {
	Store    *store.Store
	Channels *channels.Service
	Hub      *state.Hub
	Roles    *roles.Service
	Settings store.Settings
	ServerID [32]byte
	Version  string
	Protocol uint32
	Logger   *slog.Logger
	// InviteURL turns a plaintext invite token into a join link. It comes from
	// the server wiring because only there the host and certificate fingerprint
	// are known.
	InviteURL func(token string) string
	// OnSettingsChanged is called after ServerSettingsSet updates the database
	// so the auth manager and the hub pick up the new values without a restart.
	OnSettingsChanged func(store.Settings)
	// Media is the media plane the credentials are issued by.
	Media media.Backend
	// Chat stores and broadcasts messages (stage 4.1).
	Chat *chat.Service
	// MediaURL returns the WebSocket URL of the media gateway sent to clients,
	// for example "wss://192.168.1.10:7443/rtc" (design 4.6). It is a function
	// because the bound port is only known after the gateway starts.
	MediaURL func() string
	// DisconnectGrace overrides DefaultDisconnectGrace in tests.
	DisconnectGrace time.Duration
	// Now overrides the clock in tests.
	Now func() time.Time
}

// Plane is the authenticated control-plane request loop.
type Plane struct {
	store    *store.Store
	channels *channels.Service
	hub      *state.Hub
	roles    *roles.Service
	serverID [32]byte
	version  string
	protocol uint32
	logger   *slog.Logger
	now      func() time.Time

	inviteURL        func(token string) string
	onSettingsChange func(store.Settings)

	settingsMu sync.RWMutex
	settings   store.Settings

	media      media.Backend
	mediaURL   func() string
	mediaGrace time.Duration
	chat       *chat.Service

	// mediaMu guards muted, deafened and removals. It is never taken while the
	// hub lock is held: media calls may block, and the hub must stay
	// responsive.
	mediaMu sync.Mutex
	// muted holds users muted by the server, keyed by user id.
	muted map[int64]struct{}
	// deafened holds users deafened by the server, keyed by user id.
	deafened map[int64]struct{}
	// removals holds the pending media cleanup of a dropped connection.
	removals map[int64]*time.Timer

	// afkMu guards afkSelfMuted. It is only held for map access, never around
	// a hub or media call.
	afkMu sync.Mutex
	// afkSelfMuted remembers the microphone flag a user had before entering
	// the server's idle channel, so leaving restores their own preference
	// (ADR 0009). An entry exists only while the user is in such a channel.
	afkSelfMuted map[int64]bool

	// Keep eligibility edits and activity observations ordered without holding the Hub lock through SQL.
	activityMu sync.Mutex
}

// New validates the wiring.
func New(cfg Config) (*Plane, error) {
	if cfg.Store == nil || cfg.Channels == nil || cfg.Hub == nil || cfg.Roles == nil {
		return nil, errors.New("control: store, channels, hub and roles are required")
	}
	if cfg.Media == nil {
		return nil, errors.New("control: media backend is required")
	}
	mediaURL := cfg.MediaURL
	if mediaURL == nil {
		mediaURL = func() string { return "" }
	}
	inviteURL := cfg.InviteURL
	if inviteURL == nil {
		inviteURL = func(string) string { return "" }
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	grace := cfg.DisconnectGrace
	if grace <= 0 {
		grace = DefaultDisconnectGrace
	}
	return &Plane{
		store:            cfg.Store,
		channels:         cfg.Channels,
		hub:              cfg.Hub,
		roles:            cfg.Roles,
		settings:         cfg.Settings,
		serverID:         cfg.ServerID,
		version:          cfg.Version,
		protocol:         cfg.Protocol,
		logger:           logger,
		now:              now,
		inviteURL:        inviteURL,
		onSettingsChange: cfg.OnSettingsChanged,
		media:            cfg.Media,
		mediaURL:         mediaURL,
		mediaGrace:       grace,
		chat:             cfg.Chat,
		muted:            make(map[int64]struct{}),
		deafened:         make(map[int64]struct{}),
		removals:         make(map[int64]*time.Timer),
		afkSelfMuted:     make(map[int64]bool),
	}, nil
}

// settingsSnapshot returns the current settings without a race.
func (p *Plane) settingsSnapshot() store.Settings {
	p.settingsMu.RLock()
	defer p.settingsMu.RUnlock()
	return p.settings
}

// Settings returns the current settings snapshot. The chat service reads it on
// every upload and sweep so an administrator change applies without a restart.
func (p *Plane) Settings() store.Settings { return p.settingsSnapshot() }

// SubjectForUser returns the role-carrying subject of an authenticated user.
// The HTTP API uses it to serve a session token with the same permission model
// as the WebSocket.
func (p *Plane) SubjectForUser(userID int64) perms.Subject {
	return p.roles.Subject(userID)
}

// SnapshotReadTimeout bounds the database reads PrepareSnapshot performs before
// a client becomes visible. A stuck query must not keep a half-open handshake
// alive; the client gets an empty unread panel instead, and the first message
// event fills it in.
const SnapshotReadTimeout = 2 * time.Second

// PrepareSnapshot reads the expensive part of the Welcome snapshot outside the
// hub lock: the unread counters of every channel the user may see. Users,
// channels, roles and permissions are in memory and stay in Snapshot, which
// runs under the lock and must be quick. The parent context is the handshake
// context; a shorter deadline keeps a stuck query from delaying the login.
func (p *Plane) PrepareSnapshot(parent context.Context, self *state.Session) *state.PreparedSnapshot {
	prepared := &state.PreparedSnapshot{}
	if p.chat == nil {
		return prepared
	}
	userID := self.UserID()
	channelList := p.channels.List()
	visible := make([]uint64, 0, len(channelList))
	for _, channel := range channelList {
		if p.roles.CanView(userID, uint64(channel.ID)) {
			visible = append(visible, uint64(channel.ID))
		}
	}

	ctx, cancel := context.WithTimeout(parent, SnapshotReadTimeout)
	defer cancel()
	unread, err := p.chat.UnreadState(ctx, userID, visible)
	if err != nil {
		// A failure must not block a login: the chat panel then starts empty
		// and the first message event fills it in.
		p.logger.Warn("could not compute unread counters", "user_id", userID, "error", err)
		return prepared
	}
	prepared.Unread = make([]*rostalkv1.UnreadCounter, 0, len(unread))
	for _, counter := range unread {
		prepared.Unread = append(prepared.Unread, counter.Proto())
	}
	return prepared
}

// Snapshot builds the complete state sent in Welcome. It is called by the hub
// while the hub lock is held and receives the online users, so users and their
// channels always agree with each other. It does no database work: the unread
// counters arrive in prepared.
func (p *Plane) Snapshot(self *state.Session, users []state.Presence, prepared *state.PreparedSnapshot) *rostalkv1.ServerSnapshot {
	userID := self.UserID()
	settings := p.settingsSnapshot()

	counts := make(map[uint64]uint32, len(users))
	for _, user := range users {
		if user.ChannelID != 0 {
			counts[user.ChannelID]++
		}
	}

	channelList := p.channels.List()
	visibleChannels := make(map[uint64]bool, len(channelList))
	snapshotChannels := make([]*rostalkv1.Channel, 0, len(channelList))
	channelPermissions := make([]*rostalkv1.ChannelPermissions, 0, len(channelList))
	for _, channel := range channelList {
		channelID := uint64(channel.ID)
		if !p.roles.CanView(userID, channelID) {
			continue
		}
		visibleChannels[channelID] = true
		snapshotChannels = append(snapshotChannels, channel.Proto(counts[channelID]))
		channelPermissions = append(channelPermissions, &rostalkv1.ChannelPermissions{
			ChannelId: channelID,
			Effective: &rostalkv1.PermissionSet{Permissions: p.roles.ChannelPermissions(userID, channelID)},
		})
	}

	// Users in a channel the caller cannot see are hidden as well, so a channel
	// without view_channel does not leak through its user list either.
	snapshotUsers := make([]*rostalkv1.User, 0, len(users))
	for _, user := range users {
		if user.UserID != userID && user.ChannelID != 0 && !visibleChannels[user.ChannelID] {
			continue
		}
		snapshotUsers = append(snapshotUsers, user.Proto())
	}

	info := &rostalkv1.ServerInfo{
		Name:            settings.ServerName,
		Version:         p.version,
		ProtocolVersion: p.protocol,
		Id:              append([]byte(nil), p.serverID[:]...),
		LoginMode:       loginMode(settings.LoginMode),
		MaxUsers:        settings.MaxUsers,
		OnlineUsers:     uint32(len(users)),
		// The client checks this before uploading; it must be the effective
		// value, not the raw row that is empty before the admin picks one.
		MaxAttachmentBytes: uint64(settings.MaxAttachmentBytesOrDefault()),
	}

	roleList := p.roles.Roles()
	roleProtos := make([]*rostalkv1.Role, 0, len(roleList))
	for _, role := range roleList {
		roleProtos = append(roleProtos, roleProto(role))
	}

	// Unread counters were read by PrepareSnapshot before the hub lock was
	// taken (see there); here only the wire copy is assembled.
	var unreadProtos []*rostalkv1.UnreadCounter
	if prepared != nil {
		unreadProtos = prepared.Unread
	}

	return &rostalkv1.ServerSnapshot{
		Server:   info,
		Roles:    roleProtos,
		Channels: snapshotChannels,
		Users:    snapshotUsers,
		Permissions: &rostalkv1.MyPermissions{
			Server:   &rostalkv1.PermissionSet{Permissions: p.roles.ServerPermissions(userID)},
			Channels: channelPermissions,
		},
		Unread: &rostalkv1.UnreadState{Conversations: unreadProtos},
	}
}

// Serve runs the authenticated request loop until the client disconnects. It
// owns the session lifecycle: the session is unregistered and temporary
// channels it emptied are deleted before Serve returns.
func (p *Plane) Serve(ctx context.Context, session *state.Session) error {
	defer p.disconnect(session)

	transport := session.Transport()
	for {
		frame, err := transport.Read(ctx)
		if err != nil {
			return nil
		}
		if frame.GetPayload() == nil {
			p.replyError(session, frame.GetRequestId(),
				rostalkv1.ErrorCode_ERROR_CODE_INVALID_FRAME, "empty client frame")
			return nil
		}
		p.handle(ctx, session, frame)
		if session.Closed() {
			return nil
		}
	}
}

// disconnect removes the session and cleans up after it. Media participants are
// removed after a grace period: a client that reconnects within it keeps its
// audio session (design 4.2 replaces the session, it does not interrupt media).
func (p *Plane) disconnect(session *state.Session) {
	emptied, current := p.hub.UnregisterSession(session)
	if !current {
		// The session was replaced and finished after the new connection took
		// over. The presence, idle flags and media timers belong to the new
		// session now; cleaning them up here would break it.
		return
	}
	p.removeEmptyTemporary(emptied)
	p.forgetIdleChannelState(session.UserID())
	p.clearModerationFlags(session.UserID())
	p.scheduleMediaRemoval(session.UserID(), session.ChannelID())
}

// clearModerationFlags forgets a server mute and deafen when the session ends:
// both apply to the running session, not to the account forever.
func (p *Plane) clearModerationFlags(userID int64) {
	p.mediaMu.Lock()
	delete(p.muted, userID)
	delete(p.deafened, userID)
	p.mediaMu.Unlock()
}

func (p *Plane) handle(ctx context.Context, session *state.Session, frame *rostalkv1.ClientFrame) {
	requestID := frame.GetRequestId()
	if requestID == 0 {
		p.replyError(session, 0, rostalkv1.ErrorCode_ERROR_CODE_INVALID_FRAME,
			"request_id must not be zero")
		return
	}
	// A newer connection of the same user replaces the session. The old loop
	// may still hand us a frame it read before the replacement; acting on it by
	// user id would mutate the state that belongs to the new connection.
	if !p.hub.IsCurrent(session) {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_UNAUTHENTICATED,
			"this session was replaced by a newer connection")
		return
	}

	switch payload := frame.GetPayload().(type) {
	case *rostalkv1.ClientFrame_JoinChannel:
		p.handleJoin(ctx, session, requestID, payload.JoinChannel)
	case *rostalkv1.ClientFrame_LeaveChannel:
		p.handleLeave(ctx, session, requestID)
	case *rostalkv1.ClientFrame_SetVoiceState:
		p.handleSetVoiceState(session, requestID, payload.SetVoiceState)
	case *rostalkv1.ClientFrame_SetWatching:
		p.handleSetWatching(session, requestID, payload.SetWatching)
	case *rostalkv1.ClientFrame_SetNickname:
		p.handleSetNickname(ctx, session, requestID, payload.SetNickname)
	case *rostalkv1.ClientFrame_RequestMediaCredentials:
		p.handleRequestMediaCredentials(session, requestID, payload.RequestMediaCredentials)
	case *rostalkv1.ClientFrame_ChatSend, *rostalkv1.ClientFrame_EditMessage,
		*rostalkv1.ClientFrame_DeleteMessage, *rostalkv1.ClientFrame_ChatHistory,
		*rostalkv1.ClientFrame_MarkRead:
		// Chat is wired in production and in the chat tests; the control-plane
		// unit tests that predate stage 4.1 run without it.
		if p.chat == nil {
			p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST,
				"chat is not available on this server")
			return
		}
		switch chatPayload := payload.(type) {
		case *rostalkv1.ClientFrame_ChatSend:
			p.handleSendMessage(ctx, session, requestID, chatPayload.ChatSend)
		case *rostalkv1.ClientFrame_EditMessage:
			p.handleEditMessage(ctx, session, requestID, chatPayload.EditMessage)
		case *rostalkv1.ClientFrame_DeleteMessage:
			p.handleDeleteMessage(ctx, session, requestID, chatPayload.DeleteMessage)
		case *rostalkv1.ClientFrame_ChatHistory:
			p.handleChatHistory(ctx, session, requestID, chatPayload.ChatHistory)
		case *rostalkv1.ClientFrame_MarkRead:
			p.handleMarkRead(ctx, session, requestID, chatPayload.MarkRead)
		}
	case *rostalkv1.ClientFrame_AdminAction:
		p.handleAdmin(ctx, session, requestID, payload.AdminAction)
	case *rostalkv1.ClientFrame_Hello, *rostalkv1.ClientFrame_Authenticate:
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST,
			"the handshake is already complete")
	default:
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST,
			"request is not available in this server version")
	}
}

func (p *Plane) handleJoin(ctx context.Context, session *state.Session, requestID uint64, req *rostalkv1.JoinChannel) {
	userID := session.UserID()
	channelID := req.GetChannelId()
	channel, ok := p.channels.Get(int64(channelID))
	if !ok {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_NOT_FOUND,
			fmt.Sprintf("channel %d does not exist", channelID))
		return
	}
	if !p.roles.Can(userID, rostalkv1.Permission_PERMISSION_VIEW_CHANNEL, channelID) {
		// Do not reveal that the channel exists.
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_NOT_FOUND,
			fmt.Sprintf("channel %d does not exist", channelID))
		return
	}
	if !p.roles.Can(userID, rostalkv1.Permission_PERMISSION_JOIN_CHANNEL, channelID) {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED,
			"you may not join this channel")
		return
	}
	if channel.Kind != rostalkv1.ChannelKind_CHANNEL_KIND_VOICE {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_REJECTED,
			"text channels do not take voice participants")
		return
	}
	if channel.HasPassword() &&
		!p.roles.Can(userID, rostalkv1.Permission_PERMISSION_BYPASS_CHANNEL_PASSWORD, channelID) {
		switch {
		case req.GetPassword() == "":
			p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_CHANNEL_PASSWORD_REQUIRED,
				"this channel requires a password")
			return
		case !p.channels.VerifyPassword(channel.ID, req.GetPassword()):
			p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_CHANNEL_PASSWORD_INVALID,
				"wrong channel password")
			return
		}
	}

	// The room is created before the user becomes visible in the channel, so a
	// token always points at an existing room and a failed join leaves no room
	// behind that the presence map does not explain (the supervisor closes it).
	room := media.RoomName(channelID)
	mediaCtx, cancel := context.WithTimeout(ctx, mediaTimeout)
	err := p.media.EnsureRoom(mediaCtx, room)
	cancel()
	if err != nil {
		p.logger.Error("could not ensure the media room", "channel_id", channelID, "error", err)
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INTERNAL,
			"could not prepare the voice channel")
		return
	}

	limit := channel.UserLimit
	if limit > 0 && p.roles.Can(userID, rostalkv1.Permission_PERMISSION_BYPASS_USER_LIMIT, channelID) {
		limit = 0
	}
	result, err := p.hub.MoveSession(session, channelID, limit)
	switch {
	case errors.Is(err, state.ErrSessionReplaced):
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_UNAUTHENTICATED,
			"this session was replaced by a newer connection")
		return
	case errors.Is(err, state.ErrChannelFull):
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_CHANNEL_FULL,
			"the channel is full")
		return
	case errors.Is(err, state.ErrNotOnline):
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_UNAUTHENTICATED,
			"your session is not online")
		return
	case err != nil:
		p.logger.Error("join channel failed", "user_id", session.UserID(), "error", err)
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INTERNAL,
			"could not join the channel")
		return
	}

	// The channel may have been deleted between the lookup above and the move
	// (for example, an empty temporary channel was cleaned up concurrently).
	// Leaving the user in a channel that no longer exists would leave a
	// dangling channel id with no way for the client to recover.
	if _, ok := p.channels.Get(int64(channelID)); !ok {
		left, leaveErr := p.hub.LeaveSession(session)
		if leaveErr != nil && !errors.Is(leaveErr, state.ErrNotOnline) && !errors.Is(leaveErr, state.ErrSessionReplaced) {
			p.logger.Error("could not leave a deleted channel", "user_id", session.UserID(), "error", leaveErr)
		}
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_NOT_FOUND,
			fmt.Sprintf("channel %d was deleted", channelID))
		p.removeEmptyTemporary(left.EmptiedChannels)
		return
	}

	// The idle channel mutes its occupants on the server (ADR 0009). Applying
	// the policy before the token is issued keeps the credentials, the
	// broadcast flags and the media session consistent; a move anywhere else
	// restores the microphone flag the user had before.
	if channel.AFK {
		p.enterIdleChannel(ctx, session.UserID(), channelID)
	} else {
		p.leaveIdleChannel(ctx, session.UserID(), 0)
	}

	token, err := p.issueCredentials(session.UserID(), channelID, media.KindVoice)
	if err != nil {
		p.logger.Error("could not issue media credentials", "user_id", session.UserID(), "channel_id", channelID, "error", err)
		if left, leaveErr := p.hub.LeaveSession(session); leaveErr == nil {
			p.removeEmptyTemporary(left.EmptiedChannels)
		}
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INTERNAL,
			"could not issue media credentials")
		return
	}

	p.cancelMediaRemoval(session.UserID())
	p.send(session, &rostalkv1.ServerFrame{
		ReplyTo: requestID,
		Payload: &rostalkv1.ServerFrame_MediaCredentials{MediaCredentials: credentialsProto(p.mediaURL(), token)},
	})

	if from := result.FromChannelID; from != 0 && from != channelID {
		_ = p.removeMediaParticipants(ctx, from, session.UserID())
	}
	p.removeEmptyTemporary(result.EmptiedChannels)
}

func (p *Plane) handleLeave(ctx context.Context, session *state.Session, requestID uint64) {
	from := session.ChannelID()
	result, err := p.hub.LeaveSession(session)
	switch {
	case errors.Is(err, state.ErrSessionReplaced):
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_UNAUTHENTICATED,
			"this session was replaced by a newer connection")
		return
	case err != nil && !errors.Is(err, state.ErrNotOnline):
		p.logger.Error("leave channel failed", "user_id", session.UserID(), "error", err)
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INTERNAL,
			"could not leave the channel")
		return
	}
	p.cancelMediaRemoval(session.UserID())
	p.leaveIdleChannel(ctx, session.UserID(), 0)
	p.replyAck(session, requestID)
	if from != 0 {
		_ = p.removeMediaParticipants(ctx, from, session.UserID())
	}
	p.removeEmptyTemporary(result.EmptiedChannels)
}

func (p *Plane) handleSetVoiceState(session *state.Session, requestID uint64, req *rostalkv1.SetVoiceState) {
	// The idle channel keeps the microphone muted for as long as the user is
	// in it (ADR 0009). The client disables the control too, but the server
	// is the one that decides: the mute is not lifted by a request.
	if req.SelfMuted != nil && !*req.SelfMuted && p.channelIsAFK(session.ChannelID()) {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_REJECTED,
			"the microphone stays muted in the idle channel")
		return
	}
	patch := state.VoicePatch{
		SelfMuted:    req.SelfMuted,
		SelfDeafened: req.SelfDeafened,
		Away:         req.Away,
	}
	if _, err := p.hub.SetVoiceState(session.UserID(), patch); err != nil {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_UNAUTHENTICATED,
			"your session is not online")
		return
	}
	p.replyAck(session, requestID)
}

// handleSetWatching replaces the set of screen shares the caller watches
// (stage P12). The hub drops ids that are not a live share in the caller's own
// channel, so a click that races the end of a stream still leaves the rest of
// the list intact.
func (p *Plane) handleSetWatching(session *state.Session, requestID uint64, req *rostalkv1.SetWatching) {
	if _, err := p.hub.SetWatchingSession(session, req.GetStreamerIds()); err != nil {
		switch {
		case errors.Is(err, state.ErrSessionReplaced):
			p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_UNAUTHENTICATED,
				"this session was replaced by a newer connection")
		case errors.Is(err, state.ErrNotOnline):
			p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_UNAUTHENTICATED,
				"your session is not online")
		default:
			p.logger.Error("set watching failed", "user_id", session.UserID(), "error", err)
			p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INTERNAL,
				"could not update the viewer list")
		}
		return
	}
	p.replyAck(session, requestID)
}

func (p *Plane) handleSetNickname(ctx context.Context, session *state.Session, requestID uint64, req *rostalkv1.SetNickname) {
	if !p.roles.Can(session.UserID(), rostalkv1.Permission_PERMISSION_CHANGE_NICKNAME, 0) {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED,
			"you may not change your nickname")
		return
	}
	name, err := nickname.Validate(req.GetNickname())
	if err != nil {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST, err.Error())
		return
	}
	changed, err := p.hub.SetNickname(session.UserID(), name)
	switch {
	case errors.Is(err, state.ErrNicknameTaken):
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST,
			"nickname is already used by another online user")
		return
	case errors.Is(err, state.ErrNotOnline):
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_UNAUTHENTICATED,
			"your session is not online")
		return
	case err != nil:
		p.logger.Error("rename failed", "user_id", session.UserID(), "error", err)
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INTERNAL, "could not change the nickname")
		return
	}
	if changed {
		if err := p.store.UpdateUserNickname(ctx, session.UserID(), name, p.now()); err != nil {
			// The in-memory state is already announced; log the inconsistency and
			// let the next login restore the stored name.
			p.logger.Error("could not persist nickname", "user_id", session.UserID(), "error", err)
		}
	}
	p.replyAck(session, requestID)
}

// handleRequestMediaCredentials issues credentials for the other participant of
// the same user (design 4.7): the screen-share participant of a user who is
// already in a voice channel. It never changes channel membership, so the
// caller must already be in the channel the token is bound to.
func (p *Plane) handleRequestMediaCredentials(session *state.Session, requestID uint64, req *rostalkv1.RequestMediaCredentials) {
	channelID := req.GetChannelId()
	kind := mediaKind(req.GetKind())
	if kind == 0 {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST,
			"unknown media kind")
		return
	}
	if channelID == 0 {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST,
			"channel_id must not be zero")
		return
	}
	if session.ChannelID() != channelID {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED,
			"media credentials are only issued for the channel you are in")
		return
	}
	channel, ok := p.channels.Get(int64(channelID))
	if !ok || channel.Kind != rostalkv1.ChannelKind_CHANNEL_KIND_VOICE {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_NOT_FOUND,
			fmt.Sprintf("voice channel %d does not exist", channelID))
		return
	}
	if kind == media.KindStream {
		// The caller is already present in the channel, but permissions may have
		// been revoked since the join. Re-check visibility and access, not just
		// the stream right, before issuing a token for the screen-share
		// participant.
		if !p.roles.Can(session.UserID(), rostalkv1.Permission_PERMISSION_VIEW_CHANNEL, channelID) ||
			!p.roles.Can(session.UserID(), rostalkv1.Permission_PERMISSION_JOIN_CHANNEL, channelID) {
			p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED,
				"you may not view this channel")
			return
		}
		if !p.roles.Can(session.UserID(), rostalkv1.Permission_PERMISSION_STREAM, channelID) {
			p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED,
				"you may not share your screen in this channel")
			return
		}
	}

	token, err := p.issueCredentials(session.UserID(), channelID, kind)
	if err != nil {
		p.logger.Error("could not issue media credentials",
			"user_id", session.UserID(), "channel_id", channelID, "kind", kind.String(), "error", err)
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INTERNAL,
			"could not issue media credentials")
		return
	}
	credentials := credentialsProto(p.mediaURL(), token)
	if kind == media.KindStream {
		credentials.StreamPresets = p.streamPresets(session.UserID(), channelID)
	}
	p.send(session, &rostalkv1.ServerFrame{
		ReplyTo: requestID,
		Payload: &rostalkv1.ServerFrame_MediaCredentials{MediaCredentials: credentials},
	})
}

// Stream presets advertised with screen-share credentials. 1080p60 and the
// native "source" preset are the heavy ones and require PERMISSION_STREAM_HQ;
// the base presets only need the stream right, which was already checked by the
// caller.
func (p *Plane) streamPresets(userID int64, channelID uint64) []string {
	presets := []string{"720p30", "1080p30"}
	if p.roles.Can(userID, rostalkv1.Permission_PERMISSION_STREAM_HQ, channelID) {
		presets = append(presets, "1080p60", "source")
	}
	return presets
}

// issueCredentials asks the media plane for a token whose grants come from the
// permission model: speak becomes the microphone source, stream becomes the
// screen-share sources. The voice participant also gets screen_share_audio
// with the stream right, because the core captures and publishes the stream
// audio itself (ADR 0027). A server-side mute removes the microphone even when
// the permission is held (design 4.4); canPublish is set when any source is.
func (p *Plane) issueCredentials(userID int64, channelID uint64, kind media.Kind) (media.Token, error) {
	grants := media.Grants{CanSubscribe: !p.serverDeafened(userID)}
	switch kind {
	case media.KindStream:
		if p.roles.Can(userID, rostalkv1.Permission_PERMISSION_STREAM, channelID) {
			grants.PublishSources = []media.Source{media.SourceScreenShare, media.SourceScreenShareAudio}
		}
	default:
		if p.voiceMicrophoneAllowed(userID, channelID) {
			grants.PublishSources = append(grants.PublishSources, media.SourceMicrophone)
		}
		if p.voiceStreamAudioAllowed(userID, channelID) {
			grants.PublishSources = append(grants.PublishSources, media.SourceScreenShareAudio)
		}
	}
	grants.CanPublish = len(grants.PublishSources) > 0
	return p.media.IssueToken(media.TokenRequest{
		Room:      media.RoomName(channelID),
		ChannelID: channelID,
		UserID:    userID,
		Kind:      kind,
		Grants:    grants,
	})
}

// voiceMicrophoneAllowed reports whether the voice participant may publish the
// microphone: the speak right, no server mute and not an idle channel.
func (p *Plane) voiceMicrophoneAllowed(userID int64, channelID uint64) bool {
	return p.roles.Can(userID, rostalkv1.Permission_PERMISSION_SPEAK, channelID) &&
		!p.serverMuted(userID) && !p.channelIsAFK(channelID)
}

// voiceStreamAudioAllowed reports whether the voice participant may publish
// screen-share audio (ADR 0027): the same rights a screen-share token needs —
// view, join and stream in that channel.
func (p *Plane) voiceStreamAudioAllowed(userID int64, channelID uint64) bool {
	return p.roles.Can(userID, rostalkv1.Permission_PERMISSION_VIEW_CHANNEL, channelID) &&
		p.roles.Can(userID, rostalkv1.Permission_PERMISSION_JOIN_CHANNEL, channelID) &&
		p.roles.Can(userID, rostalkv1.Permission_PERMISSION_STREAM, channelID)
}

// SetServerMuted mutes or unmutes a user in the media plane and announces the
// new flag. The mute is remembered so a re-joined participant gets a token
// without canPublish.
func (p *Plane) SetServerMuted(ctx context.Context, userID int64, muted bool) error {
	p.mediaMu.Lock()
	if muted {
		p.muted[userID] = struct{}{}
	} else {
		delete(p.muted, userID)
	}
	p.mediaMu.Unlock()

	if _, err := p.hub.SetVoiceState(userID, state.VoicePatch{ServerMuted: &muted}); err != nil &&
		!errors.Is(err, state.ErrNotOnline) {
		return fmt.Errorf("control: announce server mute: %w", err)
	}

	presence, ok := p.hub.Presence(userID)
	if !ok || presence.ChannelID == 0 {
		// The user will get the flag with the next token.
		return nil
	}
	// Lifting a moderator mute must not lift the idle-channel mute (ADR 0009):
	// publishing stays off while the user is in such a channel.
	canPublish := !muted && !p.channelIsAFK(presence.ChannelID)
	err := p.media.SetPublishSource(ctx, media.RoomName(presence.ChannelID),
		media.IdentityFor(userID, media.KindVoice), media.SourceMicrophone, canPublish)
	if err != nil && !errors.Is(err, media.ErrNotFound) {
		return fmt.Errorf("control: apply server mute: %w", err)
	}
	p.logger.Info("server mute applied", "user_id", userID, "muted", muted)
	return nil
}

// SetServerDeafened deafens or undeafens a user in the media plane and
// announces the new flag.
func (p *Plane) SetServerDeafened(ctx context.Context, userID int64, deafened bool) error {
	p.mediaMu.Lock()
	if deafened {
		p.deafened[userID] = struct{}{}
	} else {
		delete(p.deafened, userID)
	}
	p.mediaMu.Unlock()

	if _, err := p.hub.SetVoiceState(userID, state.VoicePatch{ServerDeafened: &deafened}); err != nil &&
		!errors.Is(err, state.ErrNotOnline) {
		return fmt.Errorf("control: announce server deafen: %w", err)
	}

	presence, ok := p.hub.Presence(userID)
	if !ok || presence.ChannelID == 0 {
		return nil
	}
	err := p.media.SetCanSubscribe(ctx, media.RoomName(presence.ChannelID),
		media.IdentityFor(userID, media.KindVoice), !deafened)
	if err != nil && !errors.Is(err, media.ErrNotFound) {
		return fmt.Errorf("control: apply server deafen: %w", err)
	}
	p.logger.Info("server deafen applied", "user_id", userID, "deafened", deafened)
	return nil
}

// RemoveMediaParticipant disconnects every media participant of a user from the
// channel they are in. Kick and ban (stage 3.1) call it once they have decided;
// leaving, moving and a dropped connection go through the same path.
func (p *Plane) RemoveMediaParticipant(ctx context.Context, userID int64) error {
	presence, ok := p.hub.Presence(userID)
	if !ok || presence.ChannelID == 0 {
		return nil
	}
	return p.removeMediaParticipants(ctx, presence.ChannelID, userID)
}

func (p *Plane) serverMuted(userID int64) bool {
	p.mediaMu.Lock()
	defer p.mediaMu.Unlock()
	_, muted := p.muted[userID]
	return muted
}

// channelIsAFK reports whether the channel is the server's idle channel
// (ADR 0009). Membership is decided by the stored flag; the name never matters.
func (p *Plane) channelIsAFK(channelID uint64) bool {
	if channelID == 0 {
		return false
	}
	channel, ok := p.channels.Get(int64(channelID))
	return ok && channel.AFK
}

// enterIdleChannel enforces the idle-channel policy after the user has been
// moved into channelID: the server forces the microphone mute, remembers the
// value the user had before the first entry and turns publishing off on the
// live media participant.
//
// Re-entering the same channel keeps the remembered value, so leaving later
// still restores what the user chose before the first entry.
func (p *Plane) enterIdleChannel(ctx context.Context, userID int64, channelID uint64) {
	p.afkMu.Lock()
	if _, tracked := p.afkSelfMuted[userID]; !tracked {
		previous := false
		if presence, ok := p.hub.Presence(userID); ok {
			previous = presence.Voice.SelfMuted
		}
		p.afkSelfMuted[userID] = previous
	}
	p.afkMu.Unlock()

	muted := true
	if _, err := p.hub.SetVoiceState(userID, state.VoicePatch{SelfMuted: &muted}); err != nil {
		p.logger.Warn("could not force the idle-channel mute", "user_id", userID, "error", err)
	}
	p.setVoicePublishing(ctx, userID, channelID, false)
}

// leaveIdleChannel restores the microphone flag the user had before entering an
// idle channel and forgets it. It is a no-op for everyone else.
//
// channelID is the room whose participants must regain the publish grant, or 0
// when the user is leaving it anyway (a normal move, leave or disconnect: the
// participant is removed and gets a fresh token or none at all).
func (p *Plane) leaveIdleChannel(ctx context.Context, userID int64, channelID uint64) {
	p.afkMu.Lock()
	previous, tracked := p.afkSelfMuted[userID]
	delete(p.afkSelfMuted, userID)
	p.afkMu.Unlock()
	if !tracked {
		return
	}
	if _, err := p.hub.SetVoiceState(userID, state.VoicePatch{SelfMuted: &previous}); err != nil {
		// The user is offline: there is no presence to restore.
		p.logger.Debug("could not restore the microphone flag", "user_id", userID, "error", err)
	}
	if channelID != 0 && !p.serverMuted(userID) {
		p.setVoicePublishing(ctx, userID, channelID, true)
	}
}

// forgetIdleChannelState drops the remembered flag of a user who went offline.
// The next session starts from an empty presence, so nothing is restored.
func (p *Plane) forgetIdleChannelState(userID int64) {
	p.afkMu.Lock()
	delete(p.afkSelfMuted, userID)
	p.afkMu.Unlock()
}

// setVoicePublishing allows or forbids publishing for the voice participant of a
// user in a channel. A participant that has not connected yet is not an error:
// the token issued for the same join already carries the right grant.
func (p *Plane) setVoicePublishing(ctx context.Context, userID int64, channelID uint64, canPublish bool) {
	mediaCtx, cancel := context.WithTimeout(ctx, mediaTimeout)
	defer cancel()
	err := p.media.SetPublishSource(mediaCtx, media.RoomName(channelID),
		media.IdentityFor(userID, media.KindVoice), media.SourceMicrophone, canPublish)
	if err != nil && !errors.Is(err, media.ErrNotFound) {
		p.logger.Warn("could not change the publish grant",
			"user_id", userID, "channel_id", channelID, "can_publish", canPublish, "error", err)
	}
}

func (p *Plane) serverDeafened(userID int64) bool {
	p.mediaMu.Lock()
	defer p.mediaMu.Unlock()
	_, deafened := p.deafened[userID]
	return deafened
}

// scheduleMediaRemoval queues the cleanup of a dropped connection. The media
// participants stay for mediaGrace so a client that reconnects keeps audio.
func (p *Plane) scheduleMediaRemoval(userID int64, channelID uint64) {
	if channelID == 0 {
		return
	}
	p.mediaMu.Lock()
	if timer, ok := p.removals[userID]; ok {
		timer.Stop()
	}
	p.removals[userID] = time.AfterFunc(p.mediaGrace, func() {
		p.mediaMu.Lock()
		delete(p.removals, userID)
		p.mediaMu.Unlock()

		// A reconnected session inherits the channel; a user who is still in it
		// keeps their audio session.
		if presence, ok := p.hub.Presence(userID); ok && presence.ChannelID == channelID {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), mediaTimeout)
		defer cancel()
		if err := p.removeMediaParticipants(ctx, channelID, userID); err != nil {
			p.logger.Warn("could not remove media participants after a disconnect",
				"user_id", userID, "channel_id", channelID, "error", err)
		}
	})
	p.mediaMu.Unlock()
}

// cancelMediaRemoval cancels a pending cleanup after the user came back.
func (p *Plane) cancelMediaRemoval(userID int64) {
	p.mediaMu.Lock()
	defer p.mediaMu.Unlock()
	if timer, ok := p.removals[userID]; ok {
		timer.Stop()
		delete(p.removals, userID)
	}
}

// removeMediaParticipants disconnects both media participants of a user from a
// room. It is best effort: the supervisor repeats the removal if the media
// plane still reports the participant later.
func (p *Plane) removeMediaParticipants(ctx context.Context, channelID uint64, userID int64) error {
	room := media.RoomName(channelID)
	var errs []error
	for _, kind := range []media.Kind{media.KindVoice, media.KindStream} {
		mediaCtx, cancel := context.WithTimeout(ctx, mediaTimeout)
		err := p.media.RemoveParticipant(mediaCtx, room, media.IdentityFor(userID, kind))
		cancel()
		if err != nil && !errors.Is(err, media.ErrNotFound) {
			errs = append(errs, err)
		}
	}
	if err := errors.Join(errs...); err != nil {
		p.logger.Warn("could not remove media participants",
			"user_id", userID, "channel_id", channelID, "error", err)
		return err
	}
	return nil
}

func mediaKind(kind rostalkv1.MediaKind) media.Kind {
	switch kind {
	case rostalkv1.MediaKind_MEDIA_KIND_STREAM:
		return media.KindStream
	case rostalkv1.MediaKind_MEDIA_KIND_VOICE, rostalkv1.MediaKind_MEDIA_KIND_UNSPECIFIED:
		return media.KindVoice
	default:
		return 0
	}
}

func protoMediaKind(kind media.Kind) rostalkv1.MediaKind {
	if kind == media.KindStream {
		return rostalkv1.MediaKind_MEDIA_KIND_STREAM
	}
	return rostalkv1.MediaKind_MEDIA_KIND_VOICE
}

// credentialsProto converts a token into the wire message. The token itself is
// never logged anywhere.
func credentialsProto(url string, token media.Token) *rostalkv1.MediaCredentials {
	expires := uint32(token.ExpiresIn / time.Second)
	return &rostalkv1.MediaCredentials{
		Url:                 url,
		Room:                token.Room,
		Token:               token.Value,
		ParticipantIdentity: token.Identity,
		ExpiresInSeconds:    expires,
		Kind:                protoMediaKind(token.Kind),
		ChannelId:           token.ChannelID,
	}
}

// ErrChannelOccupied is returned when a channel or one of its descendants still
// has users. Deleting it would leave them in a channel that no longer exists,
// so the caller must move them out (or wait) first. Temporary channels are
// deleted automatically only when their subtree is empty.
var ErrChannelOccupied = errors.New("channel has users")

// CreateChannel adds a channel through the service and announces it to every
// client. Stage 3.2 exposes it through the admin protocol; stage 1.3 uses it
// directly (and in tests) because the wire contract has no admin messages yet.
//
// The event order is ChannelCreated and then ChannelUpdated for every channel:
// inserting in the middle renumbers the siblings, and clients replace their
// cached tree from those events instead of guessing new positions.
func (p *Plane) CreateChannel(ctx context.Context, params channels.CreateParams) (channels.Channel, error) {
	channel, err := p.channels.Create(ctx, params)
	if err != nil {
		return channels.Channel{}, err
	}
	p.hub.Broadcast(&rostalkv1.Event{
		Payload: &rostalkv1.Event_ChannelCreated{ChannelCreated: &rostalkv1.ChannelCreated{
			Channel: channel.Proto(0),
		}},
	})
	p.broadcastAllChannelsUpdated()
	return channel, nil
}

// UpdateChannel edits a channel and announces its new state with the current
// user count.
//
// A voice channel with people in it is not converted to text: its occupants
// would keep their media sessions in a channel that no longer accepts voice.
// The update is rejected with ErrChannelOccupied (the same answer DeleteChannel
// gives); the administrator moves them out first. Everyone who wins the race
// with the check is evicted afterwards, like after a delete.
func (p *Plane) UpdateChannel(ctx context.Context, id int64, params channels.UpdateParams) (channels.Channel, error) {
	if params.Kind != nil && *params.Kind == rostalkv1.ChannelKind_CHANNEL_KIND_TEXT {
		current, ok := p.channels.Get(id)
		if ok && current.Kind != rostalkv1.ChannelKind_CHANNEL_KIND_TEXT &&
			p.hub.ChannelCount(uint64(id)) != 0 {
			return channels.Channel{}, ErrChannelOccupied
		}
	}
	channel, err := p.updateChannelActivity(ctx, id, params)
	if err != nil {
		return channels.Channel{}, err
	}
	if channel.Kind == rostalkv1.ChannelKind_CHANNEL_KIND_TEXT {
		if evicted := p.hub.EvictFromChannels([]uint64{uint64(id)}); len(evicted) > 0 {
			for _, userID := range evicted {
				p.leaveIdleChannel(ctx, userID, 0)
			}
			// The room has nobody left in it; close it now instead of waiting
			// for the supervisor's empty-room grace.
			mediaCtx, cancel := context.WithTimeout(ctx, mediaTimeout)
			roomErr := p.media.DeleteRoom(mediaCtx, media.RoomName(uint64(id)))
			cancel()
			if roomErr != nil && !errors.Is(roomErr, media.ErrNotFound) {
				p.logger.Warn("could not close the media room of a text channel",
					"channel_id", id, "error", roomErr)
			}
		}
	}
	// The flag is the source of truth for the idle-channel policy (ADR 0009):
	// flipping it on an occupied channel takes effect for its occupants
	// immediately, in both directions.
	p.syncIdleChannel(ctx, channel)
	p.broadcastAllChannelsUpdated()
	return channel, nil
}

func (p *Plane) updateChannelActivity(ctx context.Context, id int64, params channels.UpdateParams) (channels.Channel, error) {
	if params.AFK == nil && params.Kind == nil {
		return p.channels.Update(ctx, id, params)
	}
	p.activityMu.Lock()
	defer p.activityMu.Unlock()
	previous, ok := p.channels.Get(id)
	channel, err := p.channels.Update(ctx, id, params)
	if err == nil && ok && (previous.AFK != channel.AFK || previous.Kind != channel.Kind) {
		p.hub.InvalidateVoiceActivity(uint64(id))
	}
	return channel, err
}

func (p *Plane) SnapshotVoiceActivity() []state.VoiceActivity {
	p.activityMu.Lock()
	defer p.activityMu.Unlock()
	return p.hub.SnapshotVoiceActivity()
}

// syncIdleChannel applies or lifts the idle-channel policy for everyone who is
// currently in the channel. Users in other channels are not touched.
func (p *Plane) syncIdleChannel(ctx context.Context, channel channels.Channel) {
	channelID := uint64(channel.ID)
	for _, user := range p.hub.SnapshotUsers() {
		if user.ChannelID != channelID {
			continue
		}
		if channel.AFK {
			p.enterIdleChannel(ctx, user.UserID, channelID)
		} else {
			p.leaveIdleChannel(ctx, user.UserID, channelID)
		}
	}
}

// MoveChannel re-parents a channel and announces the new placement of the
// whole tree: moving a node renumbers the siblings it left and the ones it
// joined.
func (p *Plane) MoveChannel(ctx context.Context, id, parentID int64, position *int32) (channels.Channel, error) {
	channel, err := p.channels.Move(ctx, id, parentID, position)
	if err != nil {
		return channels.Channel{}, err
	}
	p.broadcastAllChannelsUpdated()
	return channel, nil
}

// DeleteChannel removes a channel subtree and announces every removed channel,
// children first, followed by the new placement of the remaining siblings.
//
// A channel with users in its subtree is rejected with ErrChannelOccupied
// instead of silently leaving people in a channel that no longer exists.
// Temporary channels never reach this path occupied: the control plane deletes
// them only when their subtree is empty.
func (p *Plane) DeleteChannel(ctx context.Context, id int64) error {
	if p.subtreeOccupied(id) {
		return ErrChannelOccupied
	}
	removed, err := p.channels.Delete(ctx, id)
	if err != nil {
		return err
	}
	ids := make([]uint64, 0, len(removed))
	for _, removedID := range removed {
		ids = append(ids, uint64(removedID))
	}
	// Nothing should be occupied after the check above; this covers a user who
	// joined between the check and the delete.
	for _, userID := range p.hub.EvictFromChannels(ids) {
		p.leaveIdleChannel(ctx, userID, 0)
	}
	p.hub.BroadcastChannelDeleted(ids...)
	p.broadcastAllChannelsUpdated()
	// Rooms of removed channels have nobody left in them: close them now
	// instead of waiting for the supervisor's empty-room grace.
	for _, removedID := range removed {
		room := media.RoomName(uint64(removedID))
		mediaCtx, cancel := context.WithTimeout(ctx, mediaTimeout)
		err := p.media.DeleteRoom(mediaCtx, room)
		cancel()
		if err != nil && !errors.Is(err, media.ErrNotFound) {
			p.logger.Warn("could not close the media room of a deleted channel",
				"channel_id", removedID, "error", err)
		}
	}
	return nil
}

// broadcastAllChannelsUpdated sends the current placement and user count of
// every channel. Create, move and delete renumber siblings, and the tree is
// small (design 1: up to a few dozen channels), so sending all of them keeps
// clients exactly in sync without tracking which siblings were renumbered.
func (p *Plane) broadcastAllChannelsUpdated() {
	list := p.channels.List()
	ids := make([]uint64, 0, len(list))
	for _, channel := range list {
		ids = append(ids, uint64(channel.ID))
	}
	p.hub.BroadcastChannelUpdated(ids...)
}

// removeEmptyTemporary deletes temporary channels that just lost their last
// user (design 4.5: "temporary channels are removed when they become empty").
//
// The delete goes through DeleteChannel, which checks occupancy again and
// evicts anyone who joined between the move that emptied the channel and this
// cleanup. If the channel is occupied by then, it is left alone and removed
// the next time it becomes empty.
func (p *Plane) removeEmptyTemporary(channelIDs []uint64) {
	for _, id := range channelIDs {
		channel, ok := p.channels.Get(int64(id))
		if !ok || !channel.Temporary {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := p.DeleteChannel(ctx, int64(id))
		cancel()
		switch {
		case errors.Is(err, ErrChannelOccupied):
			// Somebody joined while the channel was being cleaned up. The
			// channel stays and will be removed once it is empty again.
			continue
		case err != nil:
			p.logger.Error("could not delete an empty temporary channel", "channel_id", id, "error", err)
			continue
		}
		p.logger.Info("deleted an empty temporary channel", "channel_id", id)
	}
}

// subtreeOccupied reports whether any channel in the subtree still has users.
func (p *Plane) subtreeOccupied(channelID int64) bool {
	for _, id := range p.channels.Subtree(channelID) {
		if p.hub.ChannelCount(uint64(id)) != 0 {
			return true
		}
	}
	return false
}

func (p *Plane) replyAck(session *state.Session, requestID uint64) {
	p.send(session, &rostalkv1.ServerFrame{
		ReplyTo: requestID,
		Payload: &rostalkv1.ServerFrame_Ack{Ack: &rostalkv1.Ack{}},
	})
}

func (p *Plane) replyError(session *state.Session, requestID uint64, code rostalkv1.ErrorCode, message string) {
	p.send(session, &rostalkv1.ServerFrame{
		ReplyTo: requestID,
		Payload: &rostalkv1.ServerFrame_Error{Error: &rostalkv1.Error{
			Code:    code,
			Message: message,
		}},
	})
}

func (p *Plane) send(session *state.Session, frame *rostalkv1.ServerFrame) {
	if err := session.Send(frame); err != nil && !errors.Is(err, state.ErrSessionClosed) {
		p.logger.Debug("could not queue a reply", "user_id", session.UserID(), "error", err)
	}
}

func loginMode(value string) rostalkv1.LoginMode {
	switch value {
	case "password":
		return rostalkv1.LoginMode_LOGIN_MODE_PASSWORD
	case "open":
		return rostalkv1.LoginMode_LOGIN_MODE_OPEN
	default:
		return rostalkv1.LoginMode_LOGIN_MODE_INVITE
	}
}
