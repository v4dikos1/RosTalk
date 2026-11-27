// Package chat owns channel and direct messages, attachments and unread
// counters (stage 4.1).
//
// The service checks permissions before every mutation (the client only hides
// controls), stores messages in SQLite and broadcasts events through the state
// hub. Attachments live in the data directory under server-generated names;
// the display name is never a path component and content types are detected
// from the bytes (see files.go).
//
// Conversations are either a channel or a pair of users. An unread marker is
// kept per user and conversation; the counters are derived from the messages
// newer than the marker, so they cannot drift from the history.
package chat

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/state"
	"github.com/v4dikos1/RosTalk/server/internal/store"
	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

const (
	// MaxBodyRunes bounds one message. The column is text, so the limit is
	// enforced before anything is written.
	MaxBodyRunes = 4000
	// MaxAttachments bounds attachments of one message.
	MaxAttachments = 10
	// MaxMentions bounds how many distinct users one message can notify. The
	// body is bounded too, but a line of "@user" tokens should not turn one
	// send into an unbounded fan-out of mention rows.
	MaxMentions = 20
	// DefaultPageSize is used when the client asks for no specific size.
	DefaultPageSize = 50
	// MaxPageSize bounds a history request.
	MaxPageSize = 100
	// UploadGrace is how long an unclaimed upload may stay before the sweeper
	// deletes it.
	UploadGrace = time.Hour
	// MaxConcurrentUploads bounds how many attachment bodies are read into
	// memory at once. One body is at most max_attachment_bytes (8 MiB by
	// default), so this caps the transient memory a crowd of simultaneous
	// uploads can allocate; the body is read before the quota lock is taken.
	MaxConcurrentUploads = 8
	// rateBurst and rateInterval define the per-user send limiter: a burst of
	// five messages, then one message every 500 ms (120 per minute).
	rateBurst    = 5
	rateInterval = 500 * time.Millisecond
)

// Errors callers map to protocol or HTTP status codes.
var (
	ErrNotFound           = errors.New("chat: message or attachment not found")
	ErrPermissionDenied   = errors.New("chat: permission denied")
	ErrInvalidTarget      = errors.New("chat: invalid conversation")
	ErrEmptyBody          = errors.New("chat: a message needs text or an attachment")
	ErrBodyTooLong        = errors.New("chat: message is too long")
	ErrTooManyAttachments = errors.New("chat: too many attachments")
	ErrRateLimited        = errors.New("chat: you are sending messages too quickly")
	ErrAttachmentInvalid  = errors.New("chat: attachment is unknown, already used or too old")
	ErrUploadTooLarge     = errors.New("chat: the file is larger than the allowed size")
	ErrQuotaExceeded      = errors.New("chat: the server attachment quota is exhausted")
	ErrUnsupportedType    = errors.New("chat: this file type is not allowed")
	ErrInvalidCursor      = errors.New("chat: invalid history cursor")
)

// Conversation is a channel or a direct-message peer.
type Conversation struct {
	// ChannelID is non-zero for a channel conversation.
	ChannelID uint64
	// PeerID is the other participant of a direct conversation.
	PeerID int64
}

// Validate reports whether exactly one target is set.
func (c Conversation) Validate() error {
	if (c.ChannelID != 0) == (c.PeerID != 0) {
		return ErrInvalidTarget
	}
	if c.PeerID < 0 {
		return ErrInvalidTarget
	}
	return nil
}

// IsDM reports whether the conversation is a direct message.
func (c Conversation) IsDM() bool { return c.PeerID != 0 }

// key is the stable conversation key used by history cursors.
func (c Conversation) key() string {
	if c.IsDM() {
		return "d" + strconv.FormatInt(c.PeerID, 10)
	}
	return "c" + strconv.FormatUint(c.ChannelID, 10)
}

// Message is one stored message with everything needed for the wire form.
type Message struct {
	ID             int64
	ChannelID      uint64
	SenderID       int64
	RecipientID    int64
	SenderNickname string
	Body           string
	CreatedAt      int64
	EditedAt       int64
	Attachments    []Attachment
	MentionIDs     []int64
}

// ConversationOf derives the conversation from the message as seen by viewer.
// A direct message between two users must be presented with the other user as
// the peer, never with the author for both sides.
func (m Message) ConversationOf(viewerID int64) Conversation {
	if m.ChannelID != 0 {
		return Conversation{ChannelID: m.ChannelID}
	}
	peer := m.SenderID
	if m.SenderID == viewerID {
		peer = m.RecipientID
	}
	return Conversation{PeerID: peer}
}

// Proto converts a message to the wire form. recipient_id is the stored
// recipient, not a peer rewritten for the viewer: both sides need to know who
// authored the message to render their own messages on the right.
func (m Message) Proto() *rostalkv1.Message {
	attachments := make([]*rostalkv1.Attachment, 0, len(m.Attachments))
	for _, attachment := range m.Attachments {
		attachments = append(attachments, attachment.Proto())
	}
	mentions := make([]uint64, 0, len(m.MentionIDs))
	for _, id := range m.MentionIDs {
		if id > 0 {
			mentions = append(mentions, uint64(id))
		}
	}
	return &rostalkv1.Message{
		Id:              uint64(m.ID),
		ChannelId:       m.ChannelID,
		SenderId:        uint64(m.SenderID),
		RecipientId:     uint64(m.RecipientID),
		SenderNickname:  m.SenderNickname,
		Body:            m.Body,
		CreatedAtUnixMs: m.CreatedAt,
		EditedAtUnixMs:  m.EditedAt,
		Attachments:     attachments,
		MentionUserIds:  mentions,
	}
}

// Attachment is one uploaded file.
type Attachment struct {
	ID          int64
	MessageID   int64
	UploaderID  int64
	FileName    string
	ContentType string
	SizeBytes   int64
	Width       int64
	Height      int64
	Image       bool
	// Sha256 is the lowercase hex digest of the stored bytes, computed while
	// the upload was streamed to disk. It is not part of the wire form.
	Sha256 string
}

// Proto converts an attachment.
func (a Attachment) Proto() *rostalkv1.Attachment {
	return &rostalkv1.Attachment{
		Id:          uint64(a.ID),
		FileName:    a.FileName,
		ContentType: a.ContentType,
		SizeBytes:   uint64(a.SizeBytes),
		Width:       uint32(a.Width),
		Height:      uint32(a.Height),
		Image:       a.Image,
	}
}

// Unread is the counter of one conversation for one user.
type Unread struct {
	Conversation  Conversation
	Unread        uint32
	Mentions      uint32
	LastReadID    uint64
	LastMessageID uint64
	PeerNickname  string
}

// Proto converts an unread counter.
func (u Unread) Proto() *rostalkv1.UnreadCounter {
	return &rostalkv1.UnreadCounter{
		ChannelId:         u.Conversation.ChannelID,
		PeerUserId:        uint64(u.Conversation.PeerID),
		Unread:            u.Unread,
		Mentions:          u.Mentions,
		LastReadMessageId: u.LastReadID,
		PeerNickname:      u.PeerNickname,
		LastMessageId:     u.LastMessageID,
	}
}

// Config wires the service.
type Config struct {
	Store *store.Store
	Roles *roles.Service
	Hub   *state.Hub
	// FilesDir is the directory for uploaded files. It is created on start.
	FilesDir string
	Logger   *slog.Logger
	// Settings returns the current server settings; it is called on every
	// upload and sweep so an administrator change applies without a restart.
	Settings func() store.Settings
	// Now overrides the clock in tests.
	Now func() time.Time
	// RateInterval overrides the send limiter in tests.
	RateInterval time.Duration
}

// Service is the chat model.
type Service struct {
	store    *store.Store
	roles    *roles.Service
	hub      *state.Hub
	filesDir string
	logger   *slog.Logger
	now      func() time.Time
	settings func() store.Settings
	interval time.Duration

	limitMu sync.Mutex
	buckets map[int64]*bucket

	// quotaMu serialises "check the quota, insert the row" so two uploads
	// cannot both pass the last free bytes.
	quotaMu sync.Mutex

	// uploadSlots bounds concurrent upload reads; see MaxConcurrentUploads.
	uploadSlots chan struct{}
}

type bucket struct {
	tokens float64
	last   time.Time
}

// New validates the wiring and creates the files directory.
func New(cfg Config) (*Service, error) {
	if cfg.Store == nil || cfg.Roles == nil || cfg.Hub == nil {
		return nil, errors.New("chat: store, roles and hub are required")
	}
	if strings.TrimSpace(cfg.FilesDir) == "" {
		return nil, errors.New("chat: files directory is required")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	settings := cfg.Settings
	if settings == nil {
		settings = func() store.Settings { return store.Settings{} }
	}
	interval := cfg.RateInterval
	if interval <= 0 {
		interval = rateInterval
	}
	if err := ensureDir(cfg.FilesDir); err != nil {
		return nil, err
	}
	return &Service{
		store:       cfg.Store,
		roles:       cfg.Roles,
		hub:         cfg.Hub,
		filesDir:    cfg.FilesDir,
		logger:      logger,
		now:         now,
		settings:    settings,
		interval:    interval,
		buckets:     make(map[int64]*bucket),
		uploadSlots: make(chan struct{}, MaxConcurrentUploads),
	}, nil
}

// Send stores a message, claims its attachments and broadcasts it.
func (s *Service) Send(ctx context.Context, userID int64, conv Conversation, body string, attachmentIDs []uint64) (Message, error) {
	if err := s.requireSend(ctx, userID, conv); err != nil {
		return Message{}, err
	}
	body = strings.TrimSpace(body)
	if body == "" && len(attachmentIDs) == 0 {
		return Message{}, ErrEmptyBody
	}
	if utf8.RuneCountInString(body) > MaxBodyRunes {
		return Message{}, ErrBodyTooLong
	}
	if len(attachmentIDs) > MaxAttachments {
		return Message{}, ErrTooManyAttachments
	}
	// Uploading is checked against the conversation the file was uploaded to;
	// attaching it to a message needs the right in the target conversation too.
	// Otherwise a user allowed to attach in channel A could post the file in
	// channel B where attachments are forbidden.
	if len(attachmentIDs) > 0 {
		if err := s.requireAttach(ctx, userID, conv); err != nil {
			return Message{}, err
		}
	}
	if !s.allowMessage(userID) {
		return Message{}, ErrRateLimited
	}
	if err := s.checkAttachments(ctx, userID, attachmentIDs); err != nil {
		return Message{}, err
	}
	mentions, err := s.resolveMentions(ctx, userID, conv, body)
	if err != nil {
		return Message{}, err
	}

	now := s.now().UnixMilli()
	var stored db.Message
	err = s.store.InTx(ctx, func(q *db.Queries) error {
		params := db.InsertMessageParams{
			SenderID:  userID,
			Body:      body,
			CreatedAt: now,
		}
		if conv.IsDM() {
			params.RecipientID = sql.NullInt64{Int64: conv.PeerID, Valid: true}
		} else {
			params.ChannelID = sql.NullInt64{Int64: int64(conv.ChannelID), Valid: true}
		}
		row, insertErr := q.InsertMessage(ctx, params)
		if insertErr != nil {
			return fmt.Errorf("insert message: %w", insertErr)
		}
		stored = row
		for _, attachmentID := range attachmentIDs {
			claimed, claimErr := q.ClaimAttachment(ctx, db.ClaimAttachmentParams{
				MessageID:  sql.NullInt64{Int64: row.ID, Valid: true},
				ID:         int64(attachmentID),
				UploaderID: userID,
			})
			if claimErr != nil {
				return fmt.Errorf("claim attachment %d: %w", attachmentID, claimErr)
			}
			if claimed != 1 {
				// Two concurrent sends can both pass checkAttachments; only one
				// UPDATE matches message_id IS NULL. Rolling the transaction back
				// removes the message inserted above.
				return ErrAttachmentInvalid
			}
		}
		for _, mentioned := range mentions {
			if mentionErr := q.InsertMention(ctx, db.InsertMentionParams{
				MessageID: row.ID,
				UserID:    mentioned,
			}); mentionErr != nil {
				return fmt.Errorf("insert mention: %w", mentionErr)
			}
		}
		return nil
	})
	if err != nil {
		return Message{}, err
	}

	message, err := s.loadMessage(ctx, stored.ID)
	if err != nil {
		return Message{}, err
	}
	s.broadcastCreated(ctx, userID, message)
	return message, nil
}

// Edit replaces the body of a message.
func (s *Service) Edit(ctx context.Context, userID, messageID int64, body string) (Message, error) {
	existing, err := s.loadMessage(ctx, messageID)
	if err != nil {
		return Message{}, err
	}
	if err := s.requireOwn(userID, existing); err != nil {
		return Message{}, err
	}
	body = strings.TrimSpace(body)
	if body == "" {
		return Message{}, ErrEmptyBody
	}
	if utf8.RuneCountInString(body) > MaxBodyRunes {
		return Message{}, ErrBodyTooLong
	}
	mentions, err := s.resolveMentions(ctx, userID, existing.ConversationOf(userID), body)
	if err != nil {
		return Message{}, err
	}
	now := s.now().UnixMilli()
	err = s.store.InTx(ctx, func(q *db.Queries) error {
		if updateErr := q.UpdateMessageBody(ctx, db.UpdateMessageBodyParams{
			Body:     body,
			EditedAt: sql.NullInt64{Int64: now, Valid: true},
			ID:       messageID,
		}); updateErr != nil {
			return fmt.Errorf("update message: %w", updateErr)
		}
		if deleteErr := q.DeleteMentions(ctx, messageID); deleteErr != nil {
			return fmt.Errorf("clear mentions: %w", deleteErr)
		}
		for _, mentioned := range mentions {
			if insertErr := q.InsertMention(ctx, db.InsertMentionParams{
				MessageID: messageID,
				UserID:    mentioned,
			}); insertErr != nil {
				return fmt.Errorf("insert mention: %w", insertErr)
			}
		}
		return nil
	})
	if err != nil {
		return Message{}, err
	}
	updated, err := s.loadMessage(ctx, messageID)
	if err != nil {
		return Message{}, err
	}
	s.broadcastMessage(updated, func(recipient int64) *rostalkv1.Event {
		return &rostalkv1.Event{Payload: &rostalkv1.Event_MessageUpdated{MessageUpdated: &rostalkv1.MessageUpdated{
			Message: updated.Proto(),
		}}}
	})
	return updated, nil
}

// Delete removes a message and its attachments and announces it.
func (s *Service) Delete(ctx context.Context, userID, messageID int64) error {
	existing, err := s.loadMessage(ctx, messageID)
	if err != nil {
		return err
	}
	if err := s.requireManage(userID, existing); err != nil {
		return err
	}
	files, err := s.store.Queries().ListMessageAttachmentFiles(ctx, sql.NullInt64{Int64: messageID, Valid: true})
	if err != nil {
		return fmt.Errorf("list attachment files: %w", err)
	}
	if err := s.store.Queries().DeleteMessage(ctx, messageID); err != nil {
		return fmt.Errorf("delete message: %w", err)
	}
	for _, file := range files {
		if removeErr := s.removeStored(file.StoredName); removeErr != nil {
			s.logger.Warn("could not remove an attachment file", "attachment_id", file.ID, "error", removeErr)
		}
	}
	conversation := existing.ConversationOf(userID)
	s.broadcastMessage(existing, func(recipient int64) *rostalkv1.Event {
		copy := existing
		copy.Body = ""
		copy.Attachments = nil
		copy.MentionIDs = nil
		return &rostalkv1.Event{Payload: &rostalkv1.Event_MessageDeleted{MessageDeleted: &rostalkv1.MessageDeleted{
			Message: copy.Proto(),
		}}}
	})
	// The deleted message may have been the newest one in the conversation;
	// refresh every participant's counter so the badge cannot stay stale.
	s.refreshUnread(ctx, conversation, existing.SenderID)
	return nil
}

// History returns one page of messages, oldest first.
func (s *Service) History(ctx context.Context, userID int64, conv Conversation, cursor string, limit uint32) ([]Message, string, bool, error) {
	if err := s.requireView(ctx, userID, conv); err != nil {
		return nil, "", false, err
	}
	if limit == 0 {
		limit = DefaultPageSize
	}
	if limit > MaxPageSize {
		limit = MaxPageSize
	}
	before, err := decodeCursor(cursor, conv)
	if err != nil {
		return nil, "", false, err
	}
	if before == 0 {
		before = int64(^uint64(0) >> 1)
	}
	fetch := int64(limit) + 1
	var rows []db.ListChannelMessagesBeforeRow
	if conv.IsDM() {
		dmRows, queryErr := s.store.Queries().ListDMMessagesBefore(ctx, db.ListDMMessagesBeforeParams{
			SenderID:      userID,
			RecipientID:   sql.NullInt64{Int64: conv.PeerID, Valid: true},
			SenderID_2:    conv.PeerID,
			RecipientID_2: sql.NullInt64{Int64: userID, Valid: true},
			ID:            before,
			Limit:         fetch,
		})
		if queryErr != nil {
			return nil, "", false, fmt.Errorf("list direct messages: %w", queryErr)
		}
		rows = make([]db.ListChannelMessagesBeforeRow, 0, len(dmRows))
		for _, row := range dmRows {
			rows = append(rows, db.ListChannelMessagesBeforeRow(row))
		}
	} else {
		rows, err = s.store.Queries().ListChannelMessagesBefore(ctx, db.ListChannelMessagesBeforeParams{
			ChannelID: sql.NullInt64{Int64: int64(conv.ChannelID), Valid: true},
			ID:        before,
			Limit:     fetch,
		})
		if err != nil {
			return nil, "", false, fmt.Errorf("list channel messages: %w", err)
		}
	}
	hasMore := len(rows) > int(limit)
	if hasMore {
		rows = rows[:limit]
	}
	next := ""
	if hasMore && len(rows) > 0 {
		next = encodeCursor(conv, rows[len(rows)-1].ID)
	}
	page := make([]Message, 0, len(rows))
	for index := len(rows) - 1; index >= 0; index-- {
		message, loadErr := s.decorate(ctx, rows[index].ID)
		if loadErr != nil {
			return nil, "", false, loadErr
		}
		page = append(page, message)
	}
	return page, next, hasMore, nil
}

// MarkRead advances the read marker of a conversation and returns the new
// counter. upTo 0 means "everything currently stored".
func (s *Service) MarkRead(ctx context.Context, userID int64, conv Conversation, upTo uint64) (Unread, error) {
	if err := s.requireView(ctx, userID, conv); err != nil {
		return Unread{}, err
	}
	q := s.store.Queries()
	var maxID int64
	var err error
	if conv.IsDM() {
		maxID, err = q.MaxDMMessageID(ctx, db.MaxDMMessageIDParams{
			SenderID:      userID,
			RecipientID:   sql.NullInt64{Int64: conv.PeerID, Valid: true},
			SenderID_2:    conv.PeerID,
			RecipientID_2: sql.NullInt64{Int64: userID, Valid: true},
		})
	} else {
		maxID, err = q.MaxChannelMessageID(ctx, sql.NullInt64{Int64: int64(conv.ChannelID), Valid: true})
	}
	if err != nil {
		return Unread{}, fmt.Errorf("read the newest message id: %w", err)
	}
	target := int64(upTo)
	if upTo == 0 || target > maxID {
		target = maxID
	}
	params := db.UpsertReadMarkerParams{
		UserID:            userID,
		LastReadMessageID: target,
		UpdatedAt:         s.now().UnixMilli(),
	}
	if conv.IsDM() {
		params.PeerID = conv.PeerID
	} else {
		params.ChannelID = int64(conv.ChannelID)
	}
	if err := q.UpsertReadMarker(ctx, params); err != nil {
		return Unread{}, fmt.Errorf("upsert read marker: %w", err)
	}
	counter, err := s.unreadFor(ctx, userID, conv)
	if err != nil {
		return Unread{}, err
	}
	// Marking read never awards a badge; skip the event when the counter is
	// already empty and there is nothing to clear in the UI.
	_ = s.hub.SendToUser(userID, &rostalkv1.Event{
		Payload: &rostalkv1.Event_UnreadUpdated{UnreadUpdated: &rostalkv1.UnreadUpdated{Counter: counter.Proto()}},
	})
	return counter, nil
}

// UnreadFor returns the counter of one conversation.
func (s *Service) UnreadFor(ctx context.Context, userID int64, conv Conversation) (Unread, error) {
	if err := s.requireView(ctx, userID, conv); err != nil {
		return Unread{}, err
	}
	return s.unreadFor(ctx, userID, conv)
}

// UnreadState returns every conversation that should carry a badge (channels)
// or be listed in the direct-message sidebar (all direct conversations).
//
// This is the hot path of Welcome: two aggregate queries (visible channels and
// direct conversations) instead of a marker lookup and two counts per
// conversation. The query layer bounds every message scan by the read marker,
// so the covering messages index pays for itself even with a long history.
func (s *Service) UnreadState(ctx context.Context, userID int64, visibleChannels []uint64) ([]Unread, error) {
	q := s.store.Queries()
	out := make([]Unread, 0, len(visibleChannels))

	if len(visibleChannels) > 0 {
		channelIDs := make([]int64, 0, len(visibleChannels))
		for _, channelID := range visibleChannels {
			channelIDs = append(channelIDs, int64(channelID))
		}
		rows, err := q.ListChannelUnread(ctx, db.ListChannelUnreadParams{
			UserID:     userID,
			ChannelIds: channelIDs,
		})
		if err != nil {
			return nil, fmt.Errorf("list channel unread counters: %w", err)
		}
		byChannel := make(map[uint64]db.ListChannelUnreadRow, len(rows))
		for _, row := range rows {
			byChannel[uint64(row.ChannelID)] = row
		}
		// Keep the caller's channel order (the channel tree order) instead of
		// the id order the aggregate uses.
		for _, channelID := range visibleChannels {
			row, ok := byChannel[channelID]
			if !ok {
				continue
			}
			counter := Unread{
				Conversation: Conversation{ChannelID: channelID},
				Unread:       uint32(row.Unread),
				Mentions:     uint32(row.Mentions),
				LastReadID:   uint64(row.LastReadMessageID),
			}
			if counter.Unread > 0 || counter.Mentions > 0 || row.HasMarker != 0 {
				out = append(out, counter)
			}
		}
	}

	peers, err := q.ListDMUnread(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list direct unread counters: %w", err)
	}
	for _, peer := range peers {
		if peer.PeerID <= 0 {
			continue
		}
		out = append(out, Unread{
			Conversation:  Conversation{PeerID: peer.PeerID},
			Unread:        uint32(peer.Unread),
			Mentions:      uint32(peer.Mentions),
			LastReadID:    uint64(peer.LastReadMessageID),
			LastMessageID: uint64(peer.LastMessageID),
			PeerNickname:  peer.Nickname,
		})
	}
	return out, nil
}

// ------------------------------------------------------------------ access ---

func (s *Service) requireSend(ctx context.Context, userID int64, conv Conversation) error {
	if err := conv.Validate(); err != nil {
		return err
	}
	if conv.IsDM() {
		if err := s.requirePeer(ctx, userID, conv); err != nil {
			return err
		}
		if !s.roles.Can(userID, rostalkv1.Permission_PERMISSION_SEND_MESSAGES, 0) {
			return ErrPermissionDenied
		}
		return nil
	}
	if !s.roles.Can(userID, rostalkv1.Permission_PERMISSION_VIEW_CHANNEL, conv.ChannelID) {
		return ErrInvalidTarget
	}
	if !s.roles.Can(userID, rostalkv1.Permission_PERMISSION_SEND_MESSAGES, conv.ChannelID) {
		return ErrPermissionDenied
	}
	return nil
}

func (s *Service) requireView(ctx context.Context, userID int64, conv Conversation) error {
	if err := conv.Validate(); err != nil {
		return err
	}
	if conv.IsDM() {
		return s.requirePeer(ctx, userID, conv)
	}
	if !s.roles.Can(userID, rostalkv1.Permission_PERMISSION_VIEW_CHANNEL, conv.ChannelID) {
		return ErrInvalidTarget
	}
	return nil
}

// CheckView reports whether the user may read the conversation. The HTTP
// export uses it before it writes a 200: a streaming handler cannot change the
// status after the first byte, so the check must happen first.
func (s *Service) CheckView(ctx context.Context, userID int64, conv Conversation) error {
	return s.requireView(ctx, userID, conv)
}

func (s *Service) requirePeer(ctx context.Context, userID int64, conv Conversation) error {
	if conv.PeerID == userID {
		return ErrInvalidTarget
	}
	if _, err := s.store.Queries().GetUserByID(ctx, conv.PeerID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrInvalidTarget
		}
		return fmt.Errorf("look up direct-message peer: %w", err)
	}
	return nil
}

// requireManage allows the author, or a moderator with manage_messages for a
// channel message. Direct messages have no moderators.
func (s *Service) requireManage(userID int64, message Message) error {
	if message.SenderID == userID {
		return nil
	}
	if message.ChannelID == 0 {
		return ErrPermissionDenied
	}
	if !s.roles.Can(userID, rostalkv1.Permission_PERMISSION_MANAGE_MESSAGES, message.ChannelID) {
		return ErrPermissionDenied
	}
	return nil
}

// requireOwn allows only the author to change the content of a message.
//
// manage_messages is a moderation right: it removes messages and keeps a
// channel in order. It does not let a moderator write in another user's name,
// because an edited message is still presented as that user's words (ADR 0025).
func (s *Service) requireOwn(userID int64, message Message) error {
	if message.SenderID != userID {
		return ErrPermissionDenied
	}
	return nil
}

// ------------------------------------------------------------------ limits ---

func (s *Service) allowMessage(userID int64) bool {
	now := s.now()
	s.limitMu.Lock()
	defer s.limitMu.Unlock()
	current, ok := s.buckets[userID]
	if !ok {
		current = &bucket{tokens: rateBurst, last: now}
		s.buckets[userID] = current
	}
	elapsed := now.Sub(current.last)
	if elapsed > 0 {
		current.tokens += elapsed.Seconds() / s.interval.Seconds()
		if current.tokens > rateBurst {
			current.tokens = rateBurst
		}
	}
	current.last = now
	if current.tokens < 1 {
		return false
	}
	current.tokens -= 1
	// Keep the map bounded: drop entries that refilled completely.
	if len(s.buckets) > 1024 {
		for id, entry := range s.buckets {
			if now.Sub(entry.last) > time.Minute {
				delete(s.buckets, id)
			}
		}
	}
	return true
}

// ------------------------------------------------------------------ events ---

func (s *Service) broadcastCreated(ctx context.Context, senderID int64, message Message) {
	conversation := message.ConversationOf(senderID)
	for _, recipient := range s.recipients(conversation, senderID) {
		proto := message.Proto()
		_ = s.hub.SendToUser(recipient, &rostalkv1.Event{
			Payload: &rostalkv1.Event_MessageCreated{MessageCreated: &rostalkv1.MessageCreated{Message: proto}},
		})
		if recipient == senderID {
			// The author's own badge does not grow; the client adds the
			// message from the reply and the event.
			continue
		}
		viewerConversation := conversation
		if conversation.IsDM() {
			// The stored conversation is expressed from the author's point of
			// view; the peer sees the author as the other participant.
			viewerConversation = Conversation{PeerID: senderID}
		}
		counter, err := s.unreadFor(ctx, recipient, viewerConversation)
		if err != nil {
			s.logger.Warn("could not compute unread counters", "user_id", recipient, "error", err)
			continue
		}
		_ = s.hub.SendToUser(recipient, &rostalkv1.Event{
			Payload: &rostalkv1.Event_UnreadUpdated{UnreadUpdated: &rostalkv1.UnreadUpdated{Counter: counter.Proto()}},
		})
	}
}

// conversationFor rewrites the peer of a direct conversation for one viewer.
// The stored conversation is expressed from the caller's point of view; the
// other participant sees themselves as the owner and the caller as the peer.
func (s *Service) broadcastMessage(message Message, build func(int64) *rostalkv1.Event) {
	conversation := message.ConversationOf(message.SenderID)
	for _, recipient := range s.recipients(conversation, message.SenderID) {
		_ = s.hub.SendToUser(recipient, build(recipient))
	}
}

func (s *Service) refreshUnread(ctx context.Context, conversation Conversation, senderID int64) {
	for _, recipient := range s.recipients(conversation, senderID) {
		viewerConversation := conversation
		if conversation.IsDM() && recipient != senderID {
			viewerConversation = Conversation{PeerID: senderID}
		}
		counter, err := s.unreadFor(ctx, recipient, viewerConversation)
		if err != nil {
			s.logger.Warn("could not refresh unread counters", "user_id", recipient, "error", err)
			continue
		}
		_ = s.hub.SendToUser(recipient, &rostalkv1.Event{
			Payload: &rostalkv1.Event_UnreadUpdated{UnreadUpdated: &rostalkv1.UnreadUpdated{Counter: counter.Proto()}},
		})
	}
}

// recipients returns the online users that must receive a conversation event.
func (s *Service) recipients(conversation Conversation, senderID int64) []int64 {
	if conversation.IsDM() {
		out := make([]int64, 0, 2)
		for _, presence := range s.hub.SnapshotUsers() {
			if presence.UserID == senderID || presence.UserID == conversation.PeerID {
				out = append(out, presence.UserID)
			}
		}
		return out
	}
	users := s.hub.SnapshotUsers()
	out := make([]int64, 0, len(users))
	for _, presence := range users {
		if s.roles.CanView(presence.UserID, conversation.ChannelID) {
			out = append(out, presence.UserID)
		}
	}
	return out
}

// ------------------------------------------------------------------ loading ---

func (s *Service) loadMessage(ctx context.Context, messageID int64) (Message, error) {
	row, err := s.store.Queries().GetMessageView(ctx, messageID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Message{}, ErrNotFound
		}
		return Message{}, fmt.Errorf("get message: %w", err)
	}
	return s.decorateRow(ctx, row.ID, row.ChannelID, row.SenderID, row.RecipientID,
		row.Body, row.CreatedAt, row.EditedAt, row.SenderNickname)
}

func (s *Service) decorate(ctx context.Context, messageID int64) (Message, error) {
	return s.loadMessage(ctx, messageID)
}

func (s *Service) decorateRow(
	ctx context.Context,
	id int64,
	channelID sql.NullInt64,
	senderID int64,
	recipientID sql.NullInt64,
	body string,
	createdAt int64,
	editedAt sql.NullInt64,
	nickname string,
) (Message, error) {
	message := Message{
		ID:             id,
		SenderID:       senderID,
		SenderNickname: nickname,
		Body:           body,
		CreatedAt:      createdAt,
	}
	if channelID.Valid {
		message.ChannelID = uint64(channelID.Int64)
	}
	if recipientID.Valid {
		message.RecipientID = recipientID.Int64
	}
	if editedAt.Valid {
		message.EditedAt = editedAt.Int64
	}
	attachments, err := s.store.Queries().ListMessageAttachments(ctx, sql.NullInt64{Int64: id, Valid: true})
	if err != nil {
		return Message{}, fmt.Errorf("list message attachments: %w", err)
	}
	message.Attachments = make([]Attachment, 0, len(attachments))
	for _, row := range attachments {
		message.Attachments = append(message.Attachments, attachmentFromRow(row))
	}
	mentions, err := s.store.Queries().ListMessageMentions(ctx, id)
	if err != nil {
		return Message{}, fmt.Errorf("list message mentions: %w", err)
	}
	message.MentionIDs = mentions
	return message, nil
}

// mentionCandidate is one user name prepared for the mention index.
type mentionCandidate struct {
	id     int64
	name   []rune
	online bool
}

// mentionKey indexes candidates by their case-folded first rune and their
// length in runes. Nicknames are at most nickname.MaxRunes long, so a lookup
// walks a handful of tiny buckets instead of every user of the server once per
// '@'.
type mentionKey struct {
	first  rune
	length int
}

// resolveMentions finds "@nickname" references in the body. Nicknames may
// contain spaces, so the longest known name wins, and a mention must end at a
// word boundary ("@Ann" does not match a user named "Anna"). Only users who can
// see the channel (or the direct-message peer) are mentioned, and one message
// produces at most MaxMentions notifications.
func (s *Service) resolveMentions(ctx context.Context, senderID int64, conv Conversation, body string) ([]int64, error) {
	if !strings.ContainsRune(body, '@') {
		return nil, nil
	}
	users, err := s.store.Queries().ListUsers(ctx)
	if err != nil {
		return nil, fmt.Errorf("list users for mentions: %w", err)
	}
	// Nicknames are unique among the online users, but ListUsers also returns
	// old records: an offline namesake with a smaller id would otherwise take
	// the tag from the person the author picked in the editor.
	online := make(map[int64]struct{}, 8)
	for _, presence := range s.hub.SnapshotUsers() {
		online[presence.UserID] = struct{}{}
	}
	index := make(map[mentionKey][]mentionCandidate, len(users))
	maxName := 0
	for _, user := range users {
		if user.ID == senderID {
			continue
		}
		name := []rune(user.Nickname)
		if len(name) == 0 {
			continue
		}
		key := mentionKey{first: foldMentionRune(name[0]), length: len(name)}
		_, isOnline := online[user.ID]
		index[key] = append(index[key], mentionCandidate{id: user.ID, name: name, online: isOnline})
		if len(name) > maxName {
			maxName = len(name)
		}
	}

	runes := []rune(body)
	seen := make(map[int64]struct{}, 4)
	out := make([]int64, 0, 4)
	for position, value := range runes {
		if len(out) >= MaxMentions {
			break
		}
		if value != '@' {
			continue
		}
		if position > 0 && !isMentionBoundaryBefore(runes[position-1]) {
			continue
		}
		rest := runes[position+1:]
		if len(rest) == 0 {
			continue
		}
		first := foldMentionRune(rest[0])
		limit := len(rest)
		if limit > maxName {
			limit = maxName
		}
		// The longest known name wins. Of names of the same length, an online
		// user who may receive the mention beats an offline record. A name that
		// exists but cannot receive the mention still shadows shorter names
		// ("@Anna" is not "@Ann" plus text).
		matched := false
		var chosen *mentionCandidate
		for length := limit; length >= 1 && !matched; length-- {
			bucket := index[mentionKey{first: first, length: length}]
			for candidateIndex := range bucket {
				candidate := &bucket[candidateIndex]
				if !strings.EqualFold(string(rest[:length]), string(candidate.name)) {
					continue
				}
				after := rest[length:]
				if len(after) > 0 && isMentionWordRune(after[0]) {
					continue
				}
				matched = true
				if conv.IsDM() {
					if candidate.id != conv.PeerID {
						continue
					}
				} else if !s.roles.CanView(candidate.id, conv.ChannelID) {
					continue
				}
				if chosen == nil || (candidate.online && !chosen.online) {
					chosen = candidate
				}
			}
		}
		if chosen == nil {
			continue
		}
		if _, duplicate := seen[chosen.id]; duplicate {
			continue
		}
		seen[chosen.id] = struct{}{}
		out = append(out, chosen.id)
	}
	return out, nil
}

// foldMentionRune maps a rune to a canonical member of its case-folding cycle,
// so a bucket key agrees with strings.EqualFold.
func foldMentionRune(r rune) rune {
	canonical := r
	for folded := unicode.SimpleFold(r); folded != r; folded = unicode.SimpleFold(folded) {
		if folded < canonical {
			canonical = folded
		}
	}
	return canonical
}

func isMentionBoundaryBefore(r rune) bool {
	return unicode.IsSpace(r) || strings.ContainsRune("([{<,;:.!?", r)
}

func isMentionWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-'
}

// ------------------------------------------------------------------ unread ---

func (s *Service) unreadFor(ctx context.Context, userID int64, conversation Conversation) (Unread, error) {
	q := s.store.Queries()
	readID := int64(0)
	marker, err := q.GetReadMarker(ctx, db.GetReadMarkerParams{
		UserID:    userID,
		ChannelID: int64(conversation.ChannelID),
		PeerID:    conversation.PeerID,
	})
	switch {
	case err == nil:
		readID = marker.LastReadMessageID
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return Unread{}, fmt.Errorf("get read marker: %w", err)
	}
	var unread, mentions int64
	if conversation.IsDM() {
		unread, err = q.CountUnreadDM(ctx, db.CountUnreadDMParams{
			SenderID:      conversation.PeerID,
			RecipientID:   sql.NullInt64{Int64: userID, Valid: true},
			SenderID_2:    userID,
			RecipientID_2: sql.NullInt64{Int64: conversation.PeerID, Valid: true},
			ID:            readID,
			SenderID_3:    userID,
		})
		if err != nil {
			return Unread{}, fmt.Errorf("count unread direct messages: %w", err)
		}
		mentions, err = q.CountDMMentions(ctx, db.CountDMMentionsParams{
			UserID:        userID,
			SenderID:      conversation.PeerID,
			RecipientID:   sql.NullInt64{Int64: userID, Valid: true},
			SenderID_2:    userID,
			RecipientID_2: sql.NullInt64{Int64: conversation.PeerID, Valid: true},
			ID:            readID,
		})
	} else {
		unread, err = q.CountUnreadChannel(ctx, db.CountUnreadChannelParams{
			ChannelID: sql.NullInt64{Int64: int64(conversation.ChannelID), Valid: true},
			ID:        readID,
			SenderID:  userID,
		})
		if err != nil {
			return Unread{}, fmt.Errorf("count unread channel messages: %w", err)
		}
		mentions, err = q.CountChannelMentions(ctx, db.CountChannelMentionsParams{
			UserID:    userID,
			ChannelID: sql.NullInt64{Int64: int64(conversation.ChannelID), Valid: true},
			ID:        readID,
		})
	}
	if err != nil {
		return Unread{}, fmt.Errorf("count mentions: %w", err)
	}
	counter := Unread{
		Conversation: conversation,
		Unread:       uint32(unread),
		Mentions:     uint32(mentions),
		LastReadID:   uint64(readID),
	}
	if conversation.IsDM() {
		if user, userErr := q.GetUserByID(ctx, conversation.PeerID); userErr == nil {
			counter.PeerNickname = user.Nickname
		}
		if last, lastErr := q.MaxDMMessageID(ctx, db.MaxDMMessageIDParams{
			SenderID:      userID,
			RecipientID:   sql.NullInt64{Int64: conversation.PeerID, Valid: true},
			SenderID_2:    conversation.PeerID,
			RecipientID_2: sql.NullInt64{Int64: userID, Valid: true},
		}); lastErr == nil {
			counter.LastMessageID = uint64(last)
		}
	}
	return counter, nil
}

// Export walks the history of one conversation in ascending id order in small
// batches and calls emit for every message. The caller streams the output, so
// exporting a long history never loads it into memory or holds one long
// transaction (stage 4.1 requirement 5).
func (s *Service) Export(ctx context.Context, userID int64, conv Conversation, emit func(Message) error) error {
	if err := s.requireView(ctx, userID, conv); err != nil {
		return err
	}
	const batch = 200
	lastID := int64(0)
	for {
		rows, err := s.exportBatch(ctx, userID, conv, lastID, batch)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}
		for _, row := range rows {
			message, loadErr := s.decorateRow(ctx, row.id, row.channelID, row.senderID,
				row.recipientID, row.body, row.createdAt, row.editedAt, row.nickname)
			if loadErr != nil {
				return loadErr
			}
			if err := emit(message); err != nil {
				return err
			}
			lastID = row.id
		}
		if len(rows) < batch {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
	}
}

type exportRow struct {
	id          int64
	channelID   sql.NullInt64
	senderID    int64
	recipientID sql.NullInt64
	body        string
	createdAt   int64
	editedAt    sql.NullInt64
	nickname    string
}

func (s *Service) exportBatch(ctx context.Context, userID int64, conv Conversation, after int64, limit int) ([]exportRow, error) {
	if conv.IsDM() {
		rows, err := s.store.Queries().ListDMMessagesAfter(ctx, db.ListDMMessagesAfterParams{
			SenderID:      userID,
			RecipientID:   sql.NullInt64{Int64: conv.PeerID, Valid: true},
			SenderID_2:    conv.PeerID,
			RecipientID_2: sql.NullInt64{Int64: userID, Valid: true},
			ID:            after,
			Limit:         int64(limit),
		})
		if err != nil {
			return nil, fmt.Errorf("list direct messages for export: %w", err)
		}
		out := make([]exportRow, 0, len(rows))
		for _, row := range rows {
			out = append(out, exportRow{
				id: row.ID, channelID: row.ChannelID, senderID: row.SenderID,
				recipientID: row.RecipientID, body: row.Body, createdAt: row.CreatedAt,
				editedAt: row.EditedAt, nickname: row.SenderNickname,
			})
		}
		return out, nil
	}
	rows, err := s.store.Queries().ListChannelMessagesAfter(ctx, db.ListChannelMessagesAfterParams{
		ChannelID: sql.NullInt64{Int64: int64(conv.ChannelID), Valid: true},
		ID:        after,
		Limit:     int64(limit),
	})
	if err != nil {
		return nil, fmt.Errorf("list channel messages for export: %w", err)
	}
	out := make([]exportRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, exportRow{
			id: row.ID, channelID: row.ChannelID, senderID: row.SenderID,
			recipientID: row.RecipientID, body: row.Body, createdAt: row.CreatedAt,
			editedAt: row.EditedAt, nickname: row.SenderNickname,
		})
	}
	return out, nil
}

// ------------------------------------------------------------------- cursor ---

func encodeCursor(conversation Conversation, id int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte("v1:" + conversation.key() + ":" + strconv.FormatInt(id, 10)))
}

func decodeCursor(cursor string, conversation Conversation) (int64, error) {
	if strings.TrimSpace(cursor) == "" {
		return 0, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, ErrInvalidCursor
	}
	parts := strings.Split(string(raw), ":")
	if len(parts) != 3 || parts[0] != "v1" || parts[1] != conversation.key() {
		return 0, ErrInvalidCursor
	}
	id, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil || id <= 0 {
		return 0, ErrInvalidCursor
	}
	return id, nil
}
