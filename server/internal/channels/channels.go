// Package channels owns the channel tree: parent/child links, sibling order,
// channel settings (topic, password, user limit, voice profile) and temporary
// channels that disappear once they are empty (design 4.5).
//
// The database is the source of truth; the service keeps a small in-memory copy
// so reading the tree never hits SQLite. Every mutation runs in one transaction
// and reloads the copy afterwards, which keeps parent links and sibling
// positions consistent even when several changes are applied at once.
//
// Lock order: state.Hub may call View under its own lock, so this package must
// never call back into state. A mutation takes s.mu, writes the database and
// reloads the cache; broadcasting its events is the caller's job.
package channels

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
	"unicode/utf8"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/secret"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

// Default channel names created on the very first start (design 7: no questions
// on the first run).
const (
	LobbyName = "Лобби"
	AFKName   = "AFK"
)

// Limits for user-supplied text. They match what the UI can reasonably show.
const (
	maxNameRunes  = 100
	maxTopicRunes = 512
)

// Tree errors. Callers map them to protocol error codes.
var (
	// ErrNotFound means the channel does not exist.
	ErrNotFound = errors.New("channel not found")
	// ErrParentNotFound means the requested parent does not exist.
	ErrParentNotFound = errors.New("parent channel not found")
	// ErrCycle means the move would make a channel its own ancestor.
	ErrCycle = errors.New("channel cannot be moved into its own subtree")
	// ErrInvalidName means the name is empty or malformed.
	ErrInvalidName = errors.New("invalid channel name")
	// ErrInvalidTopic means the topic contains control characters.
	ErrInvalidTopic = errors.New("invalid channel topic")
	// ErrInvalidKind means the channel kind is unknown.
	ErrInvalidKind = errors.New("invalid channel kind")
	// ErrInvalidVoiceProfile means the voice profile is unknown.
	ErrInvalidVoiceProfile = errors.New("invalid voice profile")
)

// Channel is one node of the tree. The password hash never leaves the server.
type Channel struct {
	ID           int64
	ParentID     int64
	Position     int32
	Name         string
	Topic        string
	Kind         rostalkv1.ChannelKind
	UserLimit    uint32
	VoiceProfile rostalkv1.VoiceProfile
	Temporary    bool
	// AFK marks the server's idle channel: its occupants are muted by the
	// server (ADR 0009). The name has no meaning.
	AFK bool

	passwordHash string
}

// HasPassword reports whether joining requires a password.
func (c Channel) HasPassword() bool { return c.passwordHash != "" }

// PasswordHash exposes the stored hash for tests and for the store round trip.
// It is never sent to clients.
func (c Channel) PasswordHash() string { return c.passwordHash }

// Proto converts the channel to its wire form. userCount is the number of
// users currently in the channel; the count lives in internal/state.
func (c Channel) Proto(userCount uint32) *rostalkv1.Channel {
	return &rostalkv1.Channel{
		Id:                uint64(c.ID),
		ParentId:          uint64(c.ParentID),
		Position:          c.Position,
		Name:              c.Name,
		Topic:             c.Topic,
		Kind:              c.Kind,
		UserLimit:         c.UserLimit,
		PasswordProtected: c.HasPassword(),
		VoiceProfile:      c.VoiceProfile,
		Temporary:         c.Temporary,
		UserCount:         userCount,
		Afk:               c.AFK,
	}
}

// CreateParams describes a new channel.
type CreateParams struct {
	ParentID     int64
	Name         string
	Topic        string
	Kind         rostalkv1.ChannelKind
	UserLimit    uint32
	VoiceProfile rostalkv1.VoiceProfile
	Temporary    bool
	// AFK makes the channel the server's idle channel (ADR 0009).
	AFK bool
	// Password is the plain channel password; empty means no password. Only its
	// argon2id hash is stored.
	Password string
	// Position places the channel among its siblings; nil appends. Values out
	// of range are clamped.
	Position *int32
}

// UpdateParams changes the mutable fields of a channel. Nil fields keep their
// current value; SetPassword with an empty Password removes the password.
type UpdateParams struct {
	Name         *string
	Topic        *string
	Kind         *rostalkv1.ChannelKind
	UserLimit    *uint32
	VoiceProfile *rostalkv1.VoiceProfile
	Temporary    *bool
	AFK          *bool
	SetPassword  bool
	Password     string
}

// Service is the channel tree.
type Service struct {
	mu     sync.RWMutex
	store  *store.Store
	byID   map[int64]Channel
	logger *slog.Logger
	now    func() time.Time
}

// Config wires the service.
type Config struct {
	Store  *store.Store
	Logger *slog.Logger
	// Now overrides the clock in tests.
	Now func() time.Time
}

// Open loads the tree and creates the default channels when the server starts
// with an empty database.
func Open(ctx context.Context, cfg Config) (*Service, error) {
	if cfg.Store == nil {
		return nil, errors.New("channels: store is required")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	s := &Service{
		store:  cfg.Store,
		byID:   make(map[int64]Channel),
		logger: logger,
		now:    now,
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	count, err := s.store.CountChannels(ctx)
	if err != nil {
		return nil, err
	}
	if count == 0 {
		if err := s.bootstrapLocked(ctx); err != nil {
			return nil, err
		}
	}
	if err := s.reloadLocked(ctx); err != nil {
		return nil, err
	}
	// Presence lives in memory, so after a restart every temporary channel is
	// empty by definition. Remove leftovers from a previous run.
	if err := s.removeTemporaryLocked(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// removeTemporaryLocked deletes every temporary channel at startup. The caller
// holds s.mu.
func (s *Service) removeTemporaryLocked(ctx context.Context) error {
	var temporary []int64
	for id, ch := range s.byID {
		if ch.Temporary {
			temporary = append(temporary, id)
		}
	}
	sort.Slice(temporary, func(i, j int) bool { return temporary[i] < temporary[j] })
	for _, id := range temporary {
		if _, ok := s.byID[id]; !ok {
			continue // removed together with a temporary parent
		}
		if _, err := s.deleteLocked(ctx, id); err != nil {
			return fmt.Errorf("remove a stale temporary channel %d: %w", id, err)
		}
	}
	return nil
}

// bootstrapLocked creates the channels every server starts with. Both are
// ordinary persistent voice channels an administrator can rename or delete.
func (s *Service) bootstrapLocked(ctx context.Context) error {
	defaults := []CreateParams{
		{Name: LobbyName, Kind: rostalkv1.ChannelKind_CHANNEL_KIND_VOICE, VoiceProfile: rostalkv1.VoiceProfile_VOICE_PROFILE_VOICE},
		{Name: AFKName, Kind: rostalkv1.ChannelKind_CHANNEL_KIND_VOICE, VoiceProfile: rostalkv1.VoiceProfile_VOICE_PROFILE_VOICE, AFK: true},
	}
	tx, err := s.store.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	for i := range defaults {
		name, validateErr := validateName(defaults[i].Name)
		if validateErr != nil {
			return validateErr
		}
		if _, err := tx.InsertChannel(ctx, store.Channel{
			Name:         name,
			Position:     int32(i),
			Kind:         int32(rostalkv1.ChannelKind_CHANNEL_KIND_VOICE),
			VoiceProfile: int32(rostalkv1.VoiceProfile_VOICE_PROFILE_VOICE),
			AFK:          defaults[i].AFK,
			CreatedAt:    s.now(),
		}); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.logger.Info("created default channels", "names", []string{LobbyName, AFKName})
	return nil
}

// List returns the tree ordered by parent, then position. A parent always sorts
// before its children because top-level channels come first.
func (s *Service) List() []Channel {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sortedLocked()
}

// Get returns one channel.
func (s *Service) Get(id int64) (Channel, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ch, ok := s.byID[id]
	return ch, ok
}

// View returns the wire form of a channel without a user count. It implements
// the lookup that internal/state uses to announce user-count changes.
func (s *Service) View(id uint64) (*rostalkv1.Channel, bool) {
	if id > uint64(math.MaxInt64) {
		return nil, false
	}
	ch, ok := s.Get(int64(id))
	if !ok {
		return nil, false
	}
	return ch.Proto(0), true
}

// Children returns the direct children of parentID (0 for top-level channels)
// in sibling order.
func (s *Service) Children(parentID int64) []Channel {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.childrenLocked(parentID)
}

// Subtree returns id and all its descendants, children before parents. It is
// the set of channels a delete removes.
func (s *Service) Subtree(id int64) []int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ch, ok := s.byID[id]
	if !ok {
		return nil
	}
	return s.subtreeLocked(ch)
}

// VerifyPassword reports whether password matches the channel password. A
// channel without a password accepts everything.
func (s *Service) VerifyPassword(id int64, password string) bool {
	ch, ok := s.Get(id)
	if !ok {
		return false
	}
	if !ch.HasPassword() {
		return true
	}
	return secret.VerifyPassword(ch.passwordHash, password)
}

// Create adds a channel. Its position is clamped to the sibling range, and the
// siblings are renumbered so positions stay 0..n-1.
func (s *Service) Create(ctx context.Context, params CreateParams) (Channel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	ch, err := s.buildLocked(params)
	if err != nil {
		return Channel{}, err
	}
	siblings := s.childrenLocked(ch.ParentID)
	position := len(siblings)
	if params.Position != nil {
		position = clampPosition(int(*params.Position), len(siblings))
	}

	tx, err := s.store.Begin(ctx)
	if err != nil {
		return Channel{}, err
	}
	defer func() { _ = tx.Rollback() }()

	ch.Position = int32(position)
	inserted, err := tx.InsertChannel(ctx, toStoreChannel(ch))
	if err != nil {
		return Channel{}, err
	}
	order := make([]int64, 0, len(siblings)+1)
	for i, sibling := range siblings {
		if i == position {
			order = append(order, inserted.ID)
		}
		order = append(order, sibling.ID)
	}
	if position == len(siblings) {
		order = append(order, inserted.ID)
	}
	if err := renumber(ctx, tx, ch.ParentID, order); err != nil {
		return Channel{}, err
	}
	if err := tx.Commit(); err != nil {
		return Channel{}, err
	}
	if err := s.reloadLocked(ctx); err != nil {
		return Channel{}, err
	}
	result, ok := s.byID[inserted.ID]
	if !ok {
		return Channel{}, fmt.Errorf("channel %d disappeared after insert", inserted.ID)
	}
	return result, nil
}

// Update changes the settings of a channel without touching its place in the
// tree.
func (s *Service) Update(ctx context.Context, id int64, params UpdateParams) (Channel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	ch, ok := s.byID[id]
	if !ok {
		return Channel{}, ErrNotFound
	}
	if params.Name != nil {
		name, err := validateName(*params.Name)
		if err != nil {
			return Channel{}, err
		}
		ch.Name = name
	}
	if params.Topic != nil {
		topic, err := validateTopic(*params.Topic)
		if err != nil {
			return Channel{}, err
		}
		ch.Topic = topic
	}
	if params.Kind != nil {
		kind, err := normalizeKind(*params.Kind)
		if err != nil {
			return Channel{}, err
		}
		ch.Kind = kind
	}
	if params.UserLimit != nil {
		ch.UserLimit = *params.UserLimit
	}
	if params.VoiceProfile != nil {
		profile, err := normalizeVoiceProfile(*params.VoiceProfile)
		if err != nil {
			return Channel{}, err
		}
		ch.VoiceProfile = profile
	}
	if params.Temporary != nil {
		ch.Temporary = *params.Temporary
	}
	if params.AFK != nil {
		ch.AFK = *params.AFK
	}
	if params.SetPassword {
		hash := ""
		if params.Password != "" {
			var err error
			hash, err = secret.HashPassword(params.Password)
			if err != nil {
				return Channel{}, err
			}
		}
		ch.passwordHash = hash
	}

	tx, err := s.store.Begin(ctx)
	if err != nil {
		return Channel{}, err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.UpdateChannel(ctx, toStoreChannel(ch)); err != nil {
		return Channel{}, err
	}
	if err := tx.Commit(); err != nil {
		return Channel{}, err
	}
	if err := s.reloadLocked(ctx); err != nil {
		return Channel{}, err
	}
	return s.byID[id], nil
}

// Move re-parents a channel and/or changes its position. Moving a channel into
// its own subtree is rejected, so the tree can never contain a cycle.
func (s *Service) Move(ctx context.Context, id, parentID int64, position *int32) (Channel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	ch, ok := s.byID[id]
	if !ok {
		return Channel{}, ErrNotFound
	}
	if parentID != 0 {
		if _, ok := s.byID[parentID]; !ok {
			return Channel{}, ErrParentNotFound
		}
	}
	if parentID == id || s.isDescendantLocked(parentID, id) {
		return Channel{}, ErrCycle
	}

	oldParent := ch.ParentID
	oldOrder := without(s.childIDsLocked(oldParent), id)
	newSiblings := s.childIDsLocked(parentID)
	if oldParent == parentID {
		newSiblings = oldOrder
	}
	pos := len(newSiblings)
	if position != nil {
		pos = clampPosition(int(*position), len(newSiblings))
	}
	newOrder := make([]int64, 0, len(newSiblings)+1)
	for i, sibling := range newSiblings {
		if i == pos {
			newOrder = append(newOrder, id)
		}
		newOrder = append(newOrder, sibling)
	}
	if pos == len(newSiblings) {
		newOrder = append(newOrder, id)
	}

	tx, err := s.store.Begin(ctx)
	if err != nil {
		return Channel{}, err
	}
	defer func() { _ = tx.Rollback() }()

	if oldParent != parentID {
		if err := renumber(ctx, tx, oldParent, oldOrder); err != nil {
			return Channel{}, err
		}
	}
	ch.ParentID = parentID
	if err := renumber(ctx, tx, parentID, newOrder); err != nil {
		return Channel{}, err
	}
	if err := tx.SetChannelPlacement(ctx, id, parentID, int32(pos)); err != nil {
		return Channel{}, err
	}
	if err := tx.Commit(); err != nil {
		return Channel{}, err
	}
	if err := s.reloadLocked(ctx); err != nil {
		return Channel{}, err
	}
	return s.byID[id], nil
}

// Delete removes a channel and its whole subtree. The returned ids are the
// removed channels, children before parents; the caller announces them.
func (s *Service) Delete(ctx context.Context, id int64) ([]int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deleteLocked(ctx, id)
}

func (s *Service) deleteLocked(ctx context.Context, id int64) ([]int64, error) {
	ch, ok := s.byID[id]
	if !ok {
		return nil, ErrNotFound
	}
	removed := s.subtreeLocked(ch)
	remaining := without(s.childIDsLocked(ch.ParentID), id)

	tx, err := s.store.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	if err := tx.DeleteChannel(ctx, id); err != nil {
		return nil, err
	}
	if err := renumber(ctx, tx, ch.ParentID, remaining); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if err := s.reloadLocked(ctx); err != nil {
		return nil, err
	}
	return removed, nil
}

func (s *Service) buildLocked(params CreateParams) (Channel, error) {
	name, err := validateName(params.Name)
	if err != nil {
		return Channel{}, err
	}
	topic, err := validateTopic(params.Topic)
	if err != nil {
		return Channel{}, err
	}
	kind, err := normalizeKind(params.Kind)
	if err != nil {
		return Channel{}, err
	}
	profile, err := normalizeVoiceProfile(params.VoiceProfile)
	if err != nil {
		return Channel{}, err
	}
	if params.ParentID != 0 {
		if _, ok := s.byID[params.ParentID]; !ok {
			return Channel{}, ErrParentNotFound
		}
	}
	hash := ""
	if params.Password != "" {
		hash, err = secret.HashPassword(params.Password)
		if err != nil {
			return Channel{}, err
		}
	}
	return Channel{
		ParentID:     params.ParentID,
		Name:         name,
		Topic:        topic,
		Kind:         kind,
		UserLimit:    params.UserLimit,
		VoiceProfile: profile,
		Temporary:    params.Temporary,
		AFK:          params.AFK,
		passwordHash: hash,
	}, nil
}

// reloadLocked replaces the in-memory tree with the database contents.
func (s *Service) reloadLocked(ctx context.Context) error {
	rows, err := s.store.ListChannels(ctx)
	if err != nil {
		return err
	}
	byID := make(map[int64]Channel, len(rows))
	for _, row := range rows {
		byID[row.ID] = fromStoreChannel(row)
	}
	s.byID = byID
	return nil
}

// sortedLocked returns the tree in display order: parent before children,
// siblings by position. The recursive walk keeps the output stable even when
// positions are temporarily equal.
func (s *Service) sortedLocked() []Channel {
	out := make([]Channel, 0, len(s.byID))
	var walk func(parentID int64)
	walk = func(parentID int64) {
		for _, child := range s.childrenLocked(parentID) {
			out = append(out, child)
			walk(child.ID)
		}
	}
	walk(0)
	return out
}

// childrenLocked returns the direct children in sibling order.
func (s *Service) childrenLocked(parentID int64) []Channel {
	out := make([]Channel, 0)
	for _, ch := range s.byID {
		if ch.ParentID == parentID {
			out = append(out, ch)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Position != out[j].Position {
			return out[i].Position < out[j].Position
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func (s *Service) childIDsLocked(parentID int64) []int64 {
	children := s.childrenLocked(parentID)
	ids := make([]int64, 0, len(children))
	for _, ch := range children {
		ids = append(ids, ch.ID)
	}
	return ids
}

// subtreeLocked returns id and its descendants, children before parents.
func (s *Service) subtreeLocked(ch Channel) []int64 {
	out := make([]int64, 0, 4)
	for _, child := range s.childrenLocked(ch.ID) {
		out = append(out, s.subtreeLocked(child)...)
	}
	return append(out, ch.ID)
}

// isDescendantLocked reports whether candidate is in the subtree of ancestor.
func (s *Service) isDescendantLocked(candidate, ancestor int64) bool {
	if candidate == 0 {
		return false
	}
	seen := map[int64]bool{}
	for candidate != 0 {
		if candidate == ancestor {
			return true
		}
		if seen[candidate] {
			return false
		}
		seen[candidate] = true
		ch, ok := s.byID[candidate]
		if !ok {
			return false
		}
		candidate = ch.ParentID
	}
	return false
}

func renumber(ctx context.Context, tx *store.Tx, parentID int64, order []int64) error {
	for i, id := range order {
		if err := tx.SetChannelPlacement(ctx, id, parentID, int32(i)); err != nil {
			return err
		}
	}
	return nil
}

func without(ids []int64, id int64) []int64 {
	out := make([]int64, 0, len(ids))
	for _, candidate := range ids {
		if candidate != id {
			out = append(out, candidate)
		}
	}
	return out
}

func clampPosition(position, length int) int {
	if position < 0 {
		return 0
	}
	if position > length {
		return length
	}
	return position
}

func validateName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", fmt.Errorf("%w: name must not be empty", ErrInvalidName)
	}
	if utf8.RuneCountInString(name) > maxNameRunes {
		return "", fmt.Errorf("%w: name is longer than %d characters", ErrInvalidName, maxNameRunes)
	}
	if strings.ContainsAny(name, "\x00\r\n\t") {
		return "", fmt.Errorf("%w: name contains control characters", ErrInvalidName)
	}
	return name, nil
}

func validateTopic(raw string) (string, error) {
	topic := strings.TrimSpace(raw)
	if utf8.RuneCountInString(topic) > maxTopicRunes {
		return "", fmt.Errorf("%w: topic is longer than %d characters", ErrInvalidTopic, maxTopicRunes)
	}
	if strings.ContainsAny(topic, "\x00\r") {
		return "", fmt.Errorf("%w: topic contains control characters", ErrInvalidTopic)
	}
	return topic, nil
}

func normalizeKind(kind rostalkv1.ChannelKind) (rostalkv1.ChannelKind, error) {
	switch kind {
	case rostalkv1.ChannelKind_CHANNEL_KIND_UNSPECIFIED:
		return rostalkv1.ChannelKind_CHANNEL_KIND_VOICE, nil
	case rostalkv1.ChannelKind_CHANNEL_KIND_VOICE, rostalkv1.ChannelKind_CHANNEL_KIND_TEXT:
		return kind, nil
	default:
		return rostalkv1.ChannelKind_CHANNEL_KIND_UNSPECIFIED, fmt.Errorf("%w: %d", ErrInvalidKind, kind)
	}
}

func normalizeVoiceProfile(profile rostalkv1.VoiceProfile) (rostalkv1.VoiceProfile, error) {
	switch profile {
	case rostalkv1.VoiceProfile_VOICE_PROFILE_UNSPECIFIED:
		return rostalkv1.VoiceProfile_VOICE_PROFILE_VOICE, nil
	case rostalkv1.VoiceProfile_VOICE_PROFILE_VOICE,
		rostalkv1.VoiceProfile_VOICE_PROFILE_VOICE_HQ,
		rostalkv1.VoiceProfile_VOICE_PROFILE_MUSIC:
		return profile, nil
	default:
		return rostalkv1.VoiceProfile_VOICE_PROFILE_UNSPECIFIED, fmt.Errorf("%w: %d", ErrInvalidVoiceProfile, profile)
	}
}

func toStoreChannel(ch Channel) store.Channel {
	return store.Channel{
		ID:           ch.ID,
		ParentID:     ch.ParentID,
		Position:     ch.Position,
		Name:         ch.Name,
		Topic:        ch.Topic,
		Kind:         int32(ch.Kind),
		UserLimit:    ch.UserLimit,
		PasswordHash: ch.passwordHash,
		VoiceProfile: int32(ch.VoiceProfile),
		Temporary:    ch.Temporary,
		AFK:          ch.AFK,
		CreatedAt:    time.Time{},
	}
}

func fromStoreChannel(row store.Channel) Channel {
	return Channel{
		ID:           row.ID,
		ParentID:     row.ParentID,
		Position:     row.Position,
		Name:         row.Name,
		Topic:        row.Topic,
		Kind:         rostalkv1.ChannelKind(row.Kind),
		UserLimit:    row.UserLimit,
		VoiceProfile: rostalkv1.VoiceProfile(row.VoiceProfile),
		Temporary:    row.Temporary,
		AFK:          row.AFK,
		passwordHash: row.PasswordHash,
	}
}
