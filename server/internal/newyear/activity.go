package newyear

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"strconv"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/state"
	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

const voiceInterval = 5 * time.Minute

// RewardChat runs inside the transaction of an accepted channel text message.
func (s *Service) RewardChat(ctx context.Context, q *db.Queries, user, message int64) error {
	return eventError("credit chat", s.rewardChat(ctx, q, user, message))
}

func (s *Service) rewardChat(ctx context.Context, q *db.Queries, user, message int64) error {
	now := s.now()
	if s.phase(now) != Active {
		return nil
	}
	player, err := q.GetNYPlayer(ctx, db.GetNYPlayerParams{Season: Season, UserID: user})
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	cutoff := now.Add(-time.Minute).UnixMilli()
	if player.LastChatMs.Valid && player.LastChatMs.Int64 > cutoff {
		return nil
	}

	day := now.In(s.zone).Format(dayFormat)
	credited, err := addActivityEntry(ctx, q, user, day, "chat", strconv.FormatInt(message, 10), now, 1)
	if err != nil || !credited {
		return err
	}
	if err := expectOne(q.CreditNYChatDay(ctx, db.CreditNYChatDayParams{Season: Season, UserID: user, Day: day})); err != nil {
		return err
	}
	return expectOne(q.MarkNYChatReward(ctx, db.MarkNYChatRewardParams{
		Season: Season, UserID: user,
		UtcMs:    sql.NullInt64{Int64: now.UnixMilli(), Valid: true},
		CutoffMs: sql.NullInt64{Int64: cutoff, Valid: true},
	}))
}

func addActivityEntry(ctx context.Context, q *db.Queries, user int64, day, kind, source string, at time.Time, amount int64) (bool, error) {
	row, err := q.GetNYDay(ctx, db.GetNYDayParams{Season: Season, UserID: user, Day: day})
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	if (kind == "chat" && row.ChatFlakes >= 6) || (kind == "voice" && row.VoiceFlakes > 22) {
		return false, nil
	}
	added, err := q.AddNYLedger(ctx, db.AddNYLedgerParams{
		Season: Season, UserID: user, UtcMs: at.UnixMilli(), Kind: kind, Delta: amount, Source: source,
	})
	if err != nil || added == 0 {
		return false, err
	}
	if _, err := q.EnsureNYDay(ctx, db.EnsureNYDayParams{Season: Season, UserID: user, Day: day}); err != nil {
		return false, err
	}
	return true, expectOne(q.CreditNYFlakes(ctx, db.CreditNYFlakesParams{Season: Season, UserID: user, Amount: amount}))
}

type checkpoints struct {
	boundary time.Time
	users    map[int64]state.VoiceActivity
}

func (c *checkpoints) observe(boundary time.Time, users []state.VoiceActivity) []int64 {
	if !boundary.After(c.boundary) {
		return nil
	}
	adjacent := boundary.Sub(c.boundary) == voiceInterval
	current := make(map[int64]state.VoiceActivity, len(users))
	var eligible []int64
	for _, user := range users {
		current[user.UserID] = user
		if prev, ok := c.users[user.UserID]; adjacent && ok && prev == user {
			eligible = append(eligible, user.UserID)
		}
	}
	c.boundary, c.users = boundary, current
	return eligible
}

func (s *Service) creditVoice(ctx context.Context, user int64, boundary time.Time) error {
	start := boundary.Add(-voiceInterval)
	day := boundary.In(s.zone).Format(dayFormat)
	if !boundary.Equal(boundary.Truncate(voiceInterval)) || s.phase(boundary) != Active ||
		s.phase(start) != Active || start.In(s.zone).Format(dayFormat) != day {
		return nil
	}
	return s.store.InTx(ctx, func(q *db.Queries) error {
		locked, err := q.LockNYPlayer(ctx, db.LockNYPlayerParams{Season: Season, UserID: user})
		if err != nil || locked == 0 {
			return err
		}
		now := s.now()
		if now.Before(boundary) || !now.Before(boundary.Add(voiceInterval)) ||
			s.phase(now) != Active || now.In(s.zone).Format(dayFormat) != day {
			return nil
		}
		player, err := q.GetNYPlayer(ctx, db.GetNYPlayerParams{Season: Season, UserID: user})
		if err != nil || player.EnrolledMs > start.UnixMilli() {
			return err
		}
		key := strconv.FormatInt(boundary.Unix()/int64(voiceInterval/time.Second), 10)
		credited, err := addActivityEntry(ctx, q, user, day, "voice", key, boundary, 2)
		if err != nil || !credited {
			return err
		}
		return expectOne(q.CreditNYVoiceDay(ctx, db.CreditNYVoiceDayParams{Season: Season, UserID: user, Day: day}))
	})
}

// RunActivity takes one baseline after startup and no samples outside December.
func (s *Service) RunActivity(ctx context.Context, snapshot func() []state.VoiceActivity, logger *slog.Logger) {
	var previous checkpoints
	for ctx.Err() == nil {
		now := s.now()
		switch s.phase(now) {
		case Upcoming, Active:
			next := now.Truncate(voiceInterval).Add(voiceInterval)
			if next.Before(s.start) {
				next = s.start.Truncate(voiceInterval)
				if next.Before(s.start) {
					next = next.Add(voiceInterval)
				}
			}
			if next.After(s.end) {
				next = s.end
			}
			if !waitForActivity(ctx, next.Sub(now)) {
				return
			}
			now = s.now()
			if s.phase(now) != Active || now.Before(next) {
				continue
			}
			boundary := now.Truncate(voiceInterval)
			pending := previous.observe(boundary, snapshot())
			s.settleVoice(ctx, logger, boundary, pending)
		default:
			previous = checkpoints{}
			if now.Before(s.expiry) {
				if !waitForActivity(ctx, s.expiry.Sub(now)) {
					return
				}
				continue
			}
			if _, err := s.store.Queries().DeleteNYSeason(ctx, Season); err == nil {
				return
			}
			if ctx.Err() != nil {
				return
			}
			logger.Warn("New Year expiry failed", "code", "store_error")
			if !waitForActivity(ctx, time.Minute) {
				return
			}
		}
	}
}

func (s *Service) settleVoice(ctx context.Context, logger *slog.Logger, boundary time.Time, pending []int64) {
	for len(pending) > 0 && ctx.Err() == nil {
		failed := pending[:0]
		for _, user := range pending {
			if ctx.Err() != nil {
				return
			}
			if err := s.creditVoice(ctx, user, boundary); err != nil {
				failed = append(failed, user)
			}
		}
		if len(failed) == 0 || ctx.Err() != nil {
			return
		}
		logger.Warn("New Year voice checkpoint failed", "count", len(failed), "code", "store_error")
		now := s.now()
		if !now.Add(time.Second).Before(boundary.Add(voiceInterval)) || s.phase(now) != Active ||
			now.In(s.zone).Format(dayFormat) != boundary.In(s.zone).Format(dayFormat) ||
			!waitForActivity(ctx, time.Second) {
			return
		}
		pending = failed
	}
}

func waitForActivity(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return ctx.Err() == nil
	}
}
