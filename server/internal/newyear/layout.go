package newyear

import (
	"context"
	"slices"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

func (s *Service) SaveLayout(ctx context.Context, user int64, layout Layout) (State, error) {
	if layout.Version < 0 || (layout.Background != "dusk" && layout.Background != "aurora") || layout.Placements == nil {
		return State{}, ErrInvalidRequest
	}
	if len(layout.Placements) > 20 {
		return State{}, ErrInvalidLayout
	}
	for _, p := range layout.Placements {
		if !knownItem(p.ItemID) {
			return State{}, ErrInvalidRequest
		}
		if !fitsCrown(p) {
			return State{}, ErrInvalidLayout
		}
	}
	result, err := s.mutate(ctx, user, func(q *db.Queries, _ time.Time) error {
		return saveLayout(ctx, q, user, layout)
	})
	return result, eventError("save layout", err)
}

func fitsCrown(p Placement) bool {
	if p.Y < 140 || p.Y > 930 || p.Scale < 60 || p.Scale > 140 || p.Rotation < -45 || p.Rotation > 45 {
		return false
	}
	inset := 42*p.Y/100 - 35
	return p.X >= 500-inset && p.X <= 500+inset
}

func saveLayout(ctx context.Context, q *db.Queries, user int64, layout Layout) error {
	player, err := q.GetNYPlayer(ctx, db.GetNYPlayerParams{Season: Season, UserID: user})
	if err != nil {
		return err
	}
	current, err := listPlacements(ctx, q, user)
	if err != nil {
		return err
	}
	if player.Background == layout.Background && slices.Equal(current, layout.Placements) {
		return nil
	}
	if player.LayoutVersion != layout.Version {
		return ErrLayoutConflict
	}
	if layout.Background == "aurora" {
		growth, err := q.CountNYWateredDays(ctx, db.CountNYWateredDaysParams{Season: Season, UserID: user})
		if err != nil {
			return err
		}
		if growth < 8 {
			return ErrBackgroundLocked
		}
	}
	inventory, err := q.ListNYInventory(ctx, db.ListNYInventoryParams{Season: Season, UserID: user})
	if err != nil {
		return err
	}
	remaining := make(map[string]int64, len(inventory))
	for _, item := range inventory {
		remaining[item.Item] = item.Qty
	}
	for _, p := range layout.Placements {
		if remaining[p.ItemID] <= 0 {
			return ErrNotOwned
		}
		remaining[p.ItemID]--
	}
	rows, err := q.UpdateNYLayout(ctx, db.UpdateNYLayoutParams{Season: Season, UserID: user, Background: layout.Background, LayoutVersion: layout.Version})
	if err != nil {
		return err
	}
	if rows == 0 {
		return ErrLayoutConflict
	}
	if err := q.ClearNYLayout(ctx, db.ClearNYLayoutParams{Season: Season, UserID: user}); err != nil {
		return err
	}
	for slot, p := range layout.Placements {
		if err := expectOne(q.AddNYPlacement(ctx, db.AddNYPlacementParams{
			Season: Season, UserID: user, Slot: int64(slot), Item: p.ItemID,
			X: p.X, Y: p.Y, Scale: p.Scale, Rotation: p.Rotation,
		})); err != nil {
			return err
		}
	}
	return nil
}

func listPlacements(ctx context.Context, q *db.Queries, user int64) ([]Placement, error) {
	rows, err := q.ListNYLayout(ctx, db.ListNYLayoutParams{Season: Season, UserID: user})
	if err != nil {
		return nil, err
	}
	placements := make([]Placement, 0, len(rows))
	for _, row := range rows {
		placements = append(placements, Placement{ItemID: row.Item, X: row.X, Y: row.Y, Scale: row.Scale, Rotation: row.Rotation})
	}
	return placements, nil
}
