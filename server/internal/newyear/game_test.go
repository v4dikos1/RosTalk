package newyear

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/store"
	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func wantError(t *testing.T, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("got %v, want %v", err, want)
	}
}

func fixture(t *testing.T, cfg Config) (*Service, *store.Store, int64) {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "rostalk.db"))
	check(t, err)
	t.Cleanup(func() { check(t, st.Close()) })
	user, err := st.UpsertUser(ctx, make([]byte, 32), "fixture", time.Time{})
	check(t, err)
	if cfg.Draw == nil {
		cfg.Draw = func(int) (int, error) { return 0, nil }
	}
	s, err := New(ctx, st, cfg)
	check(t, err)
	return s, st, user.ID
}

func raceTwo(t *testing.T, mutate func(int) error, lost error) {
	t.Helper()
	start := make(chan struct{})
	results := make(chan error, 2)
	for i := range 2 {
		go func() {
			<-start
			results <- mutate(i)
		}()
	}
	close(start)
	first, second := <-results, <-results
	if first != nil {
		first, second = second, first
	}
	check(t, first)
	wantError(t, second, lost)
}

func TestDailyMutationsAndZone(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 11, 30, 15, 59, 59, 0, time.UTC)
	s, st, user := fixture(t, Config{Zone: "Asia/Singapore", Now: func() time.Time { return now }})
	preview, err := s.Me(ctx, user)
	check(t, err)
	if preview.Enrolled || preview.Phase != Upcoming || preview.NextDayAt != "2026-11-30T16:00:00Z" {
		t.Fatalf("unexpected preview: %+v", preview)
	}
	_, err = s.Enroll(ctx, user)
	wantError(t, err, ErrClosed)
	now = now.Add(time.Second)
	_, err = s.Claim(ctx, user, "2026-12-01")
	wantError(t, err, ErrNotEnrolled)
	_, err = s.Enroll(ctx, user)
	check(t, err)
	_, err = s.Water(ctx, user, "2026-12-01")
	wantError(t, err, ErrNoWater)
	_, err = s.Claim(ctx, user, "2026-11-30")
	wantError(t, err, ErrDayChanged)

	raceTwo(t, func(int) error {
		_, err := s.Claim(ctx, user, "2026-12-01")
		return err
	}, ErrAlreadyClaimed)
	raceTwo(t, func(int) error {
		_, err := s.Water(ctx, user, "2026-12-01")
		return err
	}, ErrAlreadyWatered)

	for d := 2; d <= 31; d++ {
		now = now.AddDate(0, 0, 1)
		day := fmt.Sprintf("2026-12-%02d", d)
		_, err := s.Claim(ctx, user, day)
		check(t, err)
		_, err = s.Water(ctx, user, day)
		check(t, err)
	}
	restarted, err := New(ctx, st, Config{Zone: "UTC", Now: func() time.Time { return now }})
	check(t, err)
	now = now.AddDate(0, 0, 1)
	state, err := restarted.Me(ctx, user)
	check(t, err)
	if state.Zone != "Asia/Singapore" || state.Phase != Gallery || state.Day != "2027-01-01" ||
		state.Water != 0 || state.GrowthDays != 31 || state.Inventory[0].Qty != 31 || len(state.Claims) != 31 {
		t.Fatalf("unexpected gallery state: %+v", state)
	}
	_, err = restarted.Claim(ctx, user, "2026-12-31")
	wantError(t, err, ErrClosed)
	now = now.AddDate(0, 0, 7)
	_, err = restarted.Me(ctx, user)
	wantError(t, err, ErrClosed)

	now = now.AddDate(0, 0, 24)
	for range 2 {
		closed, err := New(ctx, st, Config{Zone: "UTC", Now: func() time.Time { return now }})
		check(t, err)
		if closed.Support().Phase != Closed {
			t.Fatal("expired season reopened")
		}
		_, err = st.Queries().GetNYSeason(ctx, Season)
		wantError(t, err, sql.ErrNoRows)
	}
}

func TestSpinSpendReplayRefundAndRollback(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)
	drawFailure := errors.New("fixture draw failure")
	badDraw := false
	s, st, user := fixture(t, Config{
		Now: func() time.Time { return now },
		Draw: func(int) (int, error) {
			if badDraw {
				return 0, drawFailure
			}
			return 0, nil
		},
	})
	id := func(n int) string { return fmt.Sprintf("f2d19398-48d3-4c89-a3a6-%012d", n) }
	credit := func() {
		t.Helper()
		check(t, expectOne(st.Queries().CreditNYFlakes(ctx, db.CreditNYFlakesParams{Season: Season, UserID: user, Amount: 6})))
	}
	_, err := s.Enroll(ctx, user)
	check(t, err)
	credit()

	raceTwo(t, func(i int) error {
		_, err := s.Spin(ctx, user, id(i))
		return err
	}, ErrInsufficientFlakes)
	state, err := s.Me(ctx, user)
	check(t, err)
	if state.Flakes != 0 || len(state.History) != 1 || state.Inventory[0].Qty != 1 {
		t.Fatalf("last flakes spent incorrectly: %+v", state)
	}

	credit()
	badDraw = true
	_, err = s.Spin(ctx, user, id(2))
	wantError(t, err, drawFailure)
	state, err = s.Me(ctx, user)
	check(t, err)
	if state.Flakes != 6 || len(state.History) != 1 {
		t.Fatalf("RNG failure committed a partial spend: %+v", state)
	}
	badDraw = false
	replies := make(chan SpinResponse, 2)
	raceTwo(t, func(int) error {
		reply, err := s.Spin(ctx, user, id(2))
		replies <- reply
		return err
	}, nil)
	for range 2 {
		reply := <-replies
		if reply.Receipt.ItemID != "ball-red" || !reply.Receipt.Duplicate || reply.Receipt.Refund != 2 ||
			reply.State.Flakes != 2 || reply.State.Inventory[0].Qty != 1 || len(reply.State.History) != 3 {
			t.Fatalf("incorrect duplicate receipt: %+v", reply)
		}
	}
	now = now.AddDate(0, 1, 0)
	replay, err := s.Spin(ctx, user, id(2))
	check(t, err)
	if replay.Receipt.RequestID != id(2) || replay.State.Phase != Gallery || replay.State.Flakes != 2 {
		t.Fatalf("gallery receipt changed: %+v", replay)
	}
	_, err = s.Spin(ctx, user, id(3))
	wantError(t, err, ErrClosed)
}

func TestLayoutAndTreeProjection(t *testing.T) {
	ctx := context.Background()
	s, _, user := fixture(t, Config{Now: func() time.Time { return time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC) }})
	empty, err := s.Tree(ctx, user)
	check(t, err)
	if empty.Tree != nil {
		t.Fatal("unplayed tree is not null")
	}
	_, err = s.Enroll(ctx, user)
	check(t, err)
	_, err = s.Claim(ctx, user, "2026-12-01")
	check(t, err)

	point := Placement{ItemID: "ball-red", X: 523, Y: 140, Scale: 100}
	for _, p := range []Placement{
		{X: 524, Y: 140, Scale: 100}, {X: 476, Y: 140, Scale: 100},
		{X: 500, Y: 139, Scale: 100}, {X: 500, Y: 931, Scale: 100},
		{X: 500, Y: 140, Scale: 59}, {X: 500, Y: 140, Scale: 141},
		{X: 500, Y: 140, Scale: 100, Rotation: 46}, {X: 500, Y: 140, Scale: 100, Rotation: -46},
	} {
		p.ItemID = point.ItemID
		_, err := s.SaveLayout(ctx, user, Layout{Background: "dusk", Placements: []Placement{p}})
		wantError(t, err, ErrInvalidLayout)
	}
	_, err = s.SaveLayout(ctx, user, Layout{Background: "dusk", Placements: []Placement{point, point}})
	wantError(t, err, ErrNotOwned)
	_, err = s.SaveLayout(ctx, user, Layout{Background: "aurora", Placements: []Placement{point}})
	wantError(t, err, ErrBackgroundLocked)
	layout := Layout{Background: "dusk", Placements: []Placement{point}}
	for range 2 {
		state, err := s.SaveLayout(ctx, user, layout)
		check(t, err)
		if state.Layout.Version != 1 {
			t.Fatalf("layout version = %d, want 1", state.Layout.Version)
		}
	}
	_, err = s.SaveLayout(ctx, user, Layout{Background: "dusk", Placements: []Placement{}})
	wantError(t, err, ErrLayoutConflict)
	projected, err := s.Tree(ctx, user)
	check(t, err)
	data, err := json.Marshal(projected)
	check(t, err)
	if string(data) != `{"tree":{"growthDays":0,"background":"dusk","placements":[{"itemId":"ball-red","x":523,"y":140,"scale":100,"rotation":0}]}}` {
		t.Fatalf("unexpected peer projection: %s", data)
	}
}

func TestCatalogWeightBoundaries(t *testing.T) {
	for _, tc := range []struct {
		roll int
		item string
	}{
		{0, "ball-red"}, {59, "ball-red"}, {60, "ball-glass-house"}, {84, "ball-glass-house"},
		{85, "ball-aurora"}, {96, "ball-aurora"}, {97, "star-topper"}, {99, "star-topper"},
	} {
		s := &Service{draw: func(bound int) (int, error) {
			if bound == 100 {
				return tc.roll, nil
			}
			return 0, nil
		}}
		item, err := s.drawItem()
		check(t, err)
		if item != tc.item {
			t.Fatalf("roll %d = %s, want %s", tc.roll, item, tc.item)
		}
	}
	_, err := resolveZone("invalid/zone", "")
	if err == nil || !strings.Contains(err.Error(), "ROSTALK_NEW_YEAR_TZ") {
		t.Fatalf("invalid zone diagnostic = %v", err)
	}
}
