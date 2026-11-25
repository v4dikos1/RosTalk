package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

// Channel is the typed view of one row of the channels table. ParentID is 0 for
// a top-level channel; the database stores NULL for the same.
type Channel struct {
	ID           int64
	ParentID     int64
	Position     int32
	Name         string
	Topic        string
	Kind         int32
	UserLimit    uint32
	PasswordHash string
	VoiceProfile int32
	Temporary    bool
	// AFK marks the server's idle channel (ADR 0009).
	AFK       bool
	CreatedAt time.Time
}

func channelFromRow(row db.Channel) Channel {
	parent := int64(0)
	if row.ParentID.Valid {
		parent = row.ParentID.Int64
	}
	return Channel{
		ID:           row.ID,
		ParentID:     parent,
		Position:     int32(row.Position),
		Name:         row.Name,
		Topic:        row.Topic,
		Kind:         int32(row.Kind),
		UserLimit:    uint32(row.UserLimit),
		PasswordHash: row.PasswordHash,
		VoiceProfile: int32(row.VoiceProfile),
		Temporary:    row.Temporary != 0,
		AFK:          row.Afk != 0,
		CreatedAt:    time.UnixMilli(row.CreatedAt).UTC(),
	}
}

func (c Channel) insertParams() db.InsertChannelParams {
	var parent sql.NullInt64
	if c.ParentID != 0 {
		parent = sql.NullInt64{Int64: c.ParentID, Valid: true}
	}
	temporary := int64(0)
	if c.Temporary {
		temporary = 1
	}
	afk := int64(0)
	if c.AFK {
		afk = 1
	}
	return db.InsertChannelParams{
		ParentID:     parent,
		Position:     int64(c.Position),
		Name:         c.Name,
		Topic:        c.Topic,
		Kind:         int64(c.Kind),
		UserLimit:    int64(c.UserLimit),
		PasswordHash: c.PasswordHash,
		VoiceProfile: int64(c.VoiceProfile),
		Temporary:    temporary,
		Afk:          afk,
		CreatedAt:    c.CreatedAt.UnixMilli(),
	}
}

func (c Channel) updateParams() db.UpdateChannelParams {
	params := c.insertParams()
	return db.UpdateChannelParams{
		ParentID:     params.ParentID,
		Position:     params.Position,
		Name:         params.Name,
		Topic:        params.Topic,
		Kind:         params.Kind,
		UserLimit:    params.UserLimit,
		PasswordHash: params.PasswordHash,
		VoiceProfile: params.VoiceProfile,
		Temporary:    params.Temporary,
		Afk:          params.Afk,
		ID:           c.ID,
	}
}

func channelPosition(parentID int64, position int32) (sql.NullInt64, int64) {
	var parent sql.NullInt64
	if parentID != 0 {
		parent = sql.NullInt64{Int64: parentID, Valid: true}
	}
	return parent, int64(position)
}

// Tx is a channel-tree transaction. Channel mutations touch several rows
// (positions, parents, the node itself), so the channels package performs them
// through one Tx.
type Tx struct {
	q  *db.Queries
	tx *sql.Tx
}

// Begin starts a write transaction.
func (s *Store) Begin(ctx context.Context) (*Tx, error) {
	tx, err := s.sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin transaction: %w", err)
	}
	return &Tx{q: s.q.WithTx(tx), tx: tx}, nil
}

// Commit commits the transaction.
func (t *Tx) Commit() error {
	if err := t.tx.Commit(); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}

// Rollback discards the transaction. Rolling back a committed transaction is
// harmless, so callers can defer it unconditionally.
func (t *Tx) Rollback() error {
	if err := t.tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
		return fmt.Errorf("rollback transaction: %w", err)
	}
	return nil
}

// ListChannels returns the whole tree ordered by parent, then position.
func (t *Tx) ListChannels(ctx context.Context) ([]Channel, error) {
	rows, err := t.q.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("list channels: %w", err)
	}
	return channelsFromRows(rows), nil
}

// GetChannel returns one channel or ErrNotFound.
func (t *Tx) GetChannel(ctx context.Context, id int64) (Channel, error) {
	row, err := t.q.GetChannel(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	if err != nil {
		return Channel{}, fmt.Errorf("get channel %d: %w", id, err)
	}
	return channelFromRow(row), nil
}

// InsertChannel inserts one channel and returns it with the assigned id.
func (t *Tx) InsertChannel(ctx context.Context, channel Channel) (Channel, error) {
	row, err := t.q.InsertChannel(ctx, channel.insertParams())
	if err != nil {
		return Channel{}, fmt.Errorf("insert channel %q: %w", channel.Name, err)
	}
	return channelFromRow(row), nil
}

// UpdateChannel replaces every mutable field of one channel.
func (t *Tx) UpdateChannel(ctx context.Context, channel Channel) (Channel, error) {
	row, err := t.q.UpdateChannel(ctx, channel.updateParams())
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	if err != nil {
		return Channel{}, fmt.Errorf("update channel %d: %w", channel.ID, err)
	}
	return channelFromRow(row), nil
}

// SetChannelPlacement changes the parent and position of one channel.
func (t *Tx) SetChannelPlacement(ctx context.Context, id, parentID int64, position int32) error {
	parent, pos := channelPosition(parentID, position)
	if err := t.q.SetChannelPlacement(ctx, db.SetChannelPlacementParams{
		ParentID: parent,
		Position: pos,
		ID:       id,
	}); err != nil {
		return fmt.Errorf("set channel %d placement: %w", id, err)
	}
	return nil
}

// DeleteChannel removes one channel; the schema cascades to its subtree.
func (t *Tx) DeleteChannel(ctx context.Context, id int64) error {
	if err := t.q.DeleteChannel(ctx, id); err != nil {
		return fmt.Errorf("delete channel %d: %w", id, err)
	}
	return nil
}

func channelsFromRows(rows []db.Channel) []Channel {
	out := make([]Channel, 0, len(rows))
	for _, row := range rows {
		out = append(out, channelFromRow(row))
	}
	return out
}

// ListChannels returns every channel without opening a transaction.
func (s *Store) ListChannels(ctx context.Context) ([]Channel, error) {
	rows, err := s.q.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("list channels: %w", err)
	}
	return channelsFromRows(rows), nil
}

// CountChannels reports how many channels exist.
func (s *Store) CountChannels(ctx context.Context) (int64, error) {
	n, err := s.q.CountChannels(ctx)
	if err != nil {
		return 0, fmt.Errorf("count channels: %w", err)
	}
	return n, nil
}

// UpdateUserNickname persists a new display name. Nicknames are unique among
// online users only (design 4.2), so the database keeps the last one used.
func (s *Store) UpdateUserNickname(ctx context.Context, userID int64, nickname string, now time.Time) error {
	if err := s.q.UpdateUserNickname(ctx, db.UpdateUserNicknameParams{
		Nickname:   nickname,
		LastSeenAt: now.UnixMilli(),
		ID:         userID,
	}); err != nil {
		return fmt.Errorf("update nickname of user %d: %w", userID, err)
	}
	return nil
}

// SetUserAvatar stores the content hash of a user's avatar (stage P11). An
// empty hash removes it.
func (s *Store) SetUserAvatar(ctx context.Context, userID int64, hash string) error {
	if err := s.q.SetUserAvatar(ctx, db.SetUserAvatarParams{
		AvatarHash: hash,
		ID:         userID,
	}); err != nil {
		return fmt.Errorf("set avatar of user %d: %w", userID, err)
	}
	return nil
}

// CountUsersWithAvatar reports how many users still reference one avatar hash.
// Identical pictures share the bytes on disk, so a file is only removed when
// the last user drops it.
func (s *Store) CountUsersWithAvatar(ctx context.Context, hash string) (int64, error) {
	count, err := s.q.CountUsersWithAvatar(ctx, hash)
	if err != nil {
		return 0, fmt.Errorf("count users with avatar %q: %w", hash, err)
	}
	return count, nil
}
