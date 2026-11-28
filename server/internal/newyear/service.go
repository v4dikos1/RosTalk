package newyear

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/store"
	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

const dayFormat = "2006-01-02"

type Config struct {
	Zone     string
	ServerTZ string
	Now      func() time.Time
	Draw     func(bound int) (int, error)
}

type Service struct {
	store      *store.Store
	zone       *time.Location
	now        func() time.Time
	draw       func(int) (int, error)
	start      time.Time
	end        time.Time
	galleryEnd time.Time
	expiry     time.Time
}

func New(ctx context.Context, st *store.Store, cfg Config) (*Service, error) {
	zone, err := resolveZone(cfg.Zone, cfg.ServerTZ)
	if err != nil {
		return nil, err
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Draw == nil {
		cfg.Draw = secureDraw
	}
	s := &Service{store: st, now: cfg.Now, draw: cfg.Draw}
	err = st.InTx(ctx, func(q *db.Queries) error {
		if _, err := q.LockNYSeason(ctx, Season); err != nil {
			return err
		}
		persisted, err := q.GetNYSeason(ctx, Season)
		exists := err == nil
		switch {
		case err == nil:
			zone, err = time.LoadLocation(persisted)
			if err != nil {
				return fmt.Errorf("load persisted season zone %q: %w", persisted, err)
			}
		case !errors.Is(err, sql.ErrNoRows):
			return err
		}
		s.zone = zone
		s.start = time.Date(2026, 12, 1, 0, 0, 0, 0, zone)
		s.end = s.start.AddDate(0, 1, 0)
		s.galleryEnd = s.end.AddDate(0, 0, 7)
		s.expiry = s.end.AddDate(0, 1, 0)
		now := s.now()
		if !now.Before(s.expiry) {
			_, err := q.DeleteNYSeason(ctx, Season)
			return err
		}
		if exists || s.phase(now) == Closed {
			return nil
		}
		_, err = q.InsertNYSeason(ctx, db.InsertNYSeasonParams{Season: Season, Zone: zone.String()})
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("initialize New Year season: %w", err)
	}
	return s, nil
}

func resolveZone(configured, serverTZ string) (*time.Location, error) {
	if configured != "" {
		zone, err := time.LoadLocation(configured)
		if configured == "Local" || err != nil {
			return nil, fmt.Errorf("ROSTALK_NEW_YEAR_TZ %q must name an IANA timezone", configured)
		}
		return zone, nil
	}
	if serverTZ != "" && serverTZ != "Local" {
		if zone, err := time.LoadLocation(serverTZ); err == nil {
			return zone, nil
		}
	}
	return time.UTC, nil
}

func (s *Service) phase(now time.Time) Phase {
	switch {
	case now.Before(s.start):
		return Upcoming
	case now.Before(s.end):
		return Active
	case now.Before(s.galleryEnd):
		return Gallery
	default:
		return Closed
	}
}

func (s *Service) Support() Support {
	return Support{APIVersion: APIVersion, Season: Season, Phase: s.phase(s.now())}
}

func (s *Service) Zone() string { return s.zone.String() }

func (s *Service) Me(ctx context.Context, user int64) (result State, err error) {
	err = s.store.InTx(ctx, func(q *db.Queries) error {
		result, err = s.snapshot(ctx, q, user, s.now())
		return err
	})
	return result, eventError("read state", err)
}

func (s *Service) snapshot(ctx context.Context, q *db.Queries, user int64, now time.Time) (State, error) {
	phase := s.phase(now)
	if phase == Closed {
		return State{}, ErrClosed
	}
	local := now.In(s.zone)
	y, m, d := local.Date()
	result := State{
		Season: Season, Phase: phase, Zone: s.Zone(), Day: local.Format(dayFormat),
		NextDayAt: time.Date(y, m, d+1, 0, 0, 0, 0, s.zone).UTC().Format(time.RFC3339),
		Claims:    []Claim{}, WateredDays: []string{}, Inventory: []Item{}, History: []Change{},
		Layout:              Layout{Background: "dusk", Placements: []Placement{}},
		UnlockedBackgrounds: []string{"dusk"},
	}
	player, err := q.GetNYPlayer(ctx, db.GetNYPlayerParams{Season: Season, UserID: user})
	if errors.Is(err, sql.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return State{}, err
	}
	result.Enrolled, result.Water, result.Flakes = true, player.Water, player.Flakes
	days, err := q.ListNYDays(ctx, db.ListNYDaysParams{Season: Season, UserID: user})
	if err != nil {
		return State{}, err
	}
	for _, day := range days {
		if day.ClaimedItem.Valid {
			result.Claims = append(result.Claims, Claim{Day: day.Day, ItemID: day.ClaimedItem.String})
		}
		if day.Watered != 0 {
			result.WateredDays = append(result.WateredDays, day.Day)
		}
	}
	result.GrowthDays = int64(len(result.WateredDays))
	if result.GrowthDays >= 8 {
		result.UnlockedBackgrounds = append(result.UnlockedBackgrounds, "aurora")
	}
	inventory, err := q.ListNYInventory(ctx, db.ListNYInventoryParams{Season: Season, UserID: user})
	if err != nil {
		return State{}, err
	}
	for _, item := range inventory {
		result.Inventory = append(result.Inventory, Item{ItemID: item.Item, Qty: item.Qty})
	}
	placements, err := listPlacements(ctx, q, user)
	if err != nil {
		return State{}, err
	}
	result.Layout = Layout{Version: player.LayoutVersion, Background: player.Background, Placements: placements}
	history, err := q.ListNYLedger(ctx, db.ListNYLedgerParams{Season: Season, UserID: user})
	if err != nil {
		return State{}, err
	}
	for _, entry := range history {
		result.History = append(result.History, Change{Kind: entry.Kind, Delta: entry.Delta, At: time.UnixMilli(entry.UtcMs).UTC().Format(time.RFC3339Nano)})
	}
	return result, nil
}

// Tree returns the public projection. The caller authorizes the target profile.
func (s *Service) Tree(ctx context.Context, target int64) (result TreeResponse, err error) {
	err = s.store.InTx(ctx, func(q *db.Queries) error {
		phase := s.phase(s.now())
		if phase != Active && phase != Gallery {
			return ErrClosed
		}
		player, err := q.GetNYPlayer(ctx, db.GetNYPlayerParams{Season: Season, UserID: target})
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		growth, err := q.CountNYWateredDays(ctx, db.CountNYWateredDaysParams{Season: Season, UserID: target})
		if err != nil {
			return err
		}
		placements, err := listPlacements(ctx, q, target)
		if err != nil {
			return err
		}
		result.Tree = &Tree{GrowthDays: growth, Background: player.Background, Placements: placements}
		return nil
	})
	return result, eventError("read tree", err)
}

func eventError(op string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("New Year %s: %w", op, err)
}

func expectOne(rows int64, err error) error {
	if err != nil {
		return err
	}
	if rows != 1 {
		return fmt.Errorf("expected one changed row, got %d", rows)
	}
	return nil
}
