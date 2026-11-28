package newyear

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/state"
	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

func TestChatActivityCooldownCapDedupeAndRollback(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 12, 1, 1, 0, 0, 0, time.UTC)
	s, st, user := fixture(t, Config{Now: func() time.Time { return now }})
	reward := func(message int64) {
		t.Helper()
		check(t, st.InTx(ctx, func(q *db.Queries) error { return s.RewardChat(ctx, q, user, message) }))
	}
	reward(1)
	_, err := s.Enroll(ctx, user)
	check(t, err)
	reward(2)
	reward(3)
	now = now.Add(time.Minute)
	reward(2)
	reward(3)

	rollback := errors.New("fixture transaction rollback")
	err = st.InTx(ctx, func(q *db.Queries) error {
		now = now.Add(time.Minute)
		if err := s.RewardChat(ctx, q, user, 4); err != nil {
			return err
		}
		return rollback
	})
	wantError(t, err, rollback)
	for message := int64(4); message <= 10; message++ {
		reward(message)
		now = now.Add(time.Minute)
	}
	result, err := s.Me(ctx, user)
	check(t, err)
	if result.Flakes != 6 || len(result.History) != 6 {
		t.Fatalf("actor %d: wallet %d, ledger %d, want 6 and 6", user, result.Flakes, len(result.History))
	}
	rows, err := st.Queries().GetNYDay(ctx, db.GetNYDayParams{Season: Season, UserID: user, Day: "2026-12-01"})
	check(t, err)
	if rows.ChatFlakes != 6 {
		t.Fatalf("daily chat = %d, want 6", rows.ChatFlakes)
	}
}

func TestVoiceActivityTenureAdjacencyAndRestartBaseline(t *testing.T) {
	boundary := time.Date(2026, 12, 1, 12, 0, 0, 0, time.UTC)
	user := state.VoiceActivity{UserID: 1, ChannelID: 2, Tenure: 3}
	var observations checkpoints
	checkObservation := func(offset int, want bool, users ...state.VoiceActivity) {
		t.Helper()
		got := observations.observe(boundary.Add(time.Duration(offset)*voiceInterval), users)
		if (len(got) == 1 && got[0] == user.UserID) != want {
			t.Fatalf("checkpoint %d = %v, want eligible=%v", offset, got, want)
		}
	}
	checkObservation(0, false, user)
	checkObservation(1, true, user)
	checkObservation(1, false)
	checkObservation(0, false)
	checkObservation(2, true, user)
	user.Tenure++
	checkObservation(3, false, user)
	checkObservation(4, false)
	checkObservation(5, false, user)
	checkObservation(7, false, user)
	checkObservation(8, true, user)
	observations = checkpoints{}
	checkObservation(9, false, user)
}

func TestVoiceActivityBucketAndCap(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 12, 1, 12, 0, 0, 0, time.UTC)
	s, st, user := fixture(t, Config{Now: func() time.Time { return now }})
	check(t, s.creditVoice(ctx, user, now))
	_, err := s.Enroll(ctx, user)
	check(t, err)
	// Enrollment at the end of this interval does not qualify.
	check(t, s.creditVoice(ctx, user, now))
	now = now.Add(voiceInterval)
	raceTwo(t, func(int) error { return s.creditVoice(ctx, user, now) }, nil)
	for range 13 {
		now = now.Add(voiceInterval)
		check(t, s.creditVoice(ctx, user, now))
	}
	result, err := s.Me(ctx, user)
	check(t, err)
	if result.Flakes != 24 || len(result.History) != 12 {
		t.Fatalf("actor %d: wallet %d, ledger %d, want 24 and 12", user, result.Flakes, len(result.History))
	}
	for i := 1; i <= 6; i++ {
		now = now.Add(time.Minute)
		check(t, st.InTx(ctx, func(q *db.Queries) error { return s.RewardChat(ctx, q, user, int64(i)) }))
	}
	result, err = s.Me(ctx, user)
	check(t, err)
	if result.Flakes != 30 || len(result.History) != 18 {
		t.Fatalf("actor %d: wallet %d, ledger %d, want 30 and 18", user, result.Flakes, len(result.History))
	}
	now = time.Date(2026, 12, 2, 0, 0, 0, 0, time.UTC)
	check(t, s.creditVoice(ctx, user, now))
	now = now.Add(voiceInterval)
	check(t, s.creditVoice(ctx, user, now))
	result, err = s.Me(ctx, user)
	check(t, err)
	if result.Flakes != 32 || len(result.History) != 19 {
		t.Fatalf("actor %d: wallet %d, ledger %d, want 32 and 19", user, result.Flakes, len(result.History))
	}
}

func TestActivityLoopCancelsWhileWaiting(t *testing.T) {
	for _, day := range []string{"2026-11-30", "2026-12-02", "2027-01-09"} {
		t.Run(day, func(t *testing.T) {
			at, err := time.Parse(dayFormat, day)
			check(t, err)
			started := make(chan struct{})
			var once sync.Once
			s, _, _ := fixture(t, Config{Now: func() time.Time { return at }})
			s.now = func() time.Time {
				once.Do(func() { close(started) })
				return at
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan struct{})
			go func() {
				s.RunActivity(ctx, func() []state.VoiceActivity {
					t.Error("unexpected observation before a boundary")
					return nil
				}, slog.Default())
				close(done)
			}()
			<-started
			cancel()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("activity loop did not join")
			}
		})
	}
}

func TestVoiceActivityRejectsExpiredCheckpoint(t *testing.T) {
	ctx := context.Background()
	start := time.Date(2026, 12, 1, 1, 0, 0, 0, time.UTC)
	now := start
	s, st, user := fixture(t, Config{Now: func() time.Time { return now }})
	_, err := s.Enroll(ctx, user)
	check(t, err)
	now = now.Add(2 * voiceInterval)
	check(t, s.creditVoice(ctx, user, start.Add(voiceInterval)))
	entries, err := st.Queries().ListNYLedger(ctx, db.ListNYLedgerParams{Season: Season, UserID: user})
	check(t, err)
	if len(entries) != 0 {
		t.Fatalf("actor %s: stale bucket added %d entries", strconv.FormatInt(user, 10), len(entries))
	}
}
