package newyear

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

var spinID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func (s *Service) Enroll(ctx context.Context, user int64) (result State, err error) {
	err = s.store.InTx(ctx, func(q *db.Queries) error {
		if _, err := q.LockNYPlayer(ctx, db.LockNYPlayerParams{Season: Season, UserID: user}); err != nil {
			return err
		}
		now := s.now()
		if s.phase(now) != Active {
			return ErrClosed
		}
		if _, err := q.EnrollNYPlayer(ctx, db.EnrollNYPlayerParams{Season: Season, UserID: user, EnrolledMs: now.UnixMilli()}); err != nil {
			return err
		}
		result, err = s.snapshot(ctx, q, user, now)
		return err
	})
	return result, eventError("enroll", err)
}

func (s *Service) mutate(ctx context.Context, user int64, apply func(*db.Queries, time.Time) error) (result State, err error) {
	err = s.store.InTx(ctx, func(q *db.Queries) error {
		locked, err := q.LockNYPlayer(ctx, db.LockNYPlayerParams{Season: Season, UserID: user})
		if err != nil {
			return err
		}
		now := s.now()
		if s.phase(now) != Active {
			return ErrClosed
		}
		if locked == 0 {
			return ErrNotEnrolled
		}
		if err := apply(q, now); err != nil {
			return err
		}
		result, err = s.snapshot(ctx, q, user, now)
		return err
	})
	return result, err
}

func (s *Service) Claim(ctx context.Context, user int64, day string) (ClaimResponse, error) {
	if !validDay(day) {
		return ClaimResponse{}, ErrInvalidRequest
	}
	var item string
	result, err := s.mutate(ctx, user, func(q *db.Queries, now time.Time) error {
		if day != now.In(s.zone).Format(dayFormat) {
			return ErrDayChanged
		}
		row, err := q.GetNYDay(ctx, db.GetNYDayParams{Season: Season, UserID: user, Day: day})
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if row.ClaimedItem.Valid {
			return ErrAlreadyClaimed
		}
		item, err = s.drawItem()
		if err != nil {
			return err
		}
		if _, err := q.EnsureNYDay(ctx, db.EnsureNYDayParams{Season: Season, UserID: user, Day: day}); err != nil {
			return err
		}
		if err := expectOne(q.ClaimNYDay(ctx, db.ClaimNYDayParams{Season: Season, UserID: user, Day: day, ClaimedItem: sql.NullString{String: item, Valid: true}})); err != nil {
			return err
		}
		if err := expectOne(q.CreditNYWater(ctx, db.CreditNYWaterParams{Season: Season, UserID: user})); err != nil {
			return err
		}
		return expectOne(q.IncrementNYInventory(ctx, db.IncrementNYInventoryParams{Season: Season, UserID: user, Item: item}))
	})
	return ClaimResponse{ItemID: item, State: result}, eventError("claim", err)
}

func (s *Service) Water(ctx context.Context, user int64, day string) (State, error) {
	if !validDay(day) {
		return State{}, ErrInvalidRequest
	}
	result, err := s.mutate(ctx, user, func(q *db.Queries, now time.Time) error {
		if day != now.In(s.zone).Format(dayFormat) {
			return ErrDayChanged
		}
		if _, err := q.EnsureNYDay(ctx, db.EnsureNYDayParams{Season: Season, UserID: user, Day: day}); err != nil {
			return err
		}
		rows, err := q.WaterNYDay(ctx, db.WaterNYDayParams{Season: Season, UserID: user, Day: day})
		if err != nil {
			return err
		}
		if rows == 0 {
			return ErrAlreadyWatered
		}
		rows, err = q.SpendNYWater(ctx, db.SpendNYWaterParams{Season: Season, UserID: user})
		if err != nil {
			return err
		}
		if rows == 0 {
			return ErrNoWater
		}
		return nil
	})
	return result, eventError("water", err)
}

func validDay(day string) bool {
	_, err := time.Parse(dayFormat, day)
	return len(day) == len(dayFormat) && err == nil
}

func (s *Service) Spin(ctx context.Context, user int64, request string) (result SpinResponse, err error) {
	if !spinID.MatchString(request) {
		return result, ErrInvalidRequest
	}
	err = s.store.InTx(ctx, func(q *db.Queries) error {
		locked, err := q.LockNYPlayer(ctx, db.LockNYPlayerParams{Season: Season, UserID: user})
		if err != nil {
			return err
		}
		now := s.now()
		phase := s.phase(now)
		if phase != Active && phase != Gallery {
			return ErrClosed
		}
		row, err := q.GetNYSpin(ctx, db.GetNYSpinParams{Season: Season, UserID: user, RequestID: request})
		if errors.Is(err, sql.ErrNoRows) {
			if phase != Active {
				return ErrClosed
			}
			if locked == 0 {
				return ErrNotEnrolled
			}
			row, err = s.openSpin(ctx, q, user, request, now)
		}
		if err != nil {
			return err
		}
		result.Receipt = Receipt{RequestID: row.RequestID, ItemID: row.Item, Duplicate: row.Duplicate != 0, Refund: row.Refund, Cost: SpinCost}
		result.State, err = s.snapshot(ctx, q, user, now)
		return err
	})
	return result, eventError("open spin", err)
}

func (s *Service) openSpin(ctx context.Context, q *db.Queries, user int64, request string, now time.Time) (db.NySpin, error) {
	rows, err := q.SpendNYFlakes(ctx, db.SpendNYFlakesParams{Season: Season, UserID: user, Amount: SpinCost})
	if err != nil {
		return db.NySpin{}, err
	}
	if rows == 0 {
		return db.NySpin{}, ErrInsufficientFlakes
	}
	item, err := s.drawItem()
	if err != nil {
		return db.NySpin{}, err
	}
	duplicate, err := q.HasNYItem(ctx, db.HasNYItemParams{Season: Season, UserID: user, Item: item})
	if err != nil {
		return db.NySpin{}, err
	}
	cost := db.AddNYLedgerParams{Season: Season, UserID: user, UtcMs: now.UnixMilli(), Kind: "spin", Delta: -SpinCost, Source: request}
	if err := expectOne(q.AddNYLedger(ctx, cost)); err != nil {
		return db.NySpin{}, err
	}
	receipt := db.NySpin{Season: Season, UserID: user, RequestID: request, Item: item, Duplicate: duplicate}
	if duplicate == 0 {
		if err := expectOne(q.IncrementNYInventory(ctx, db.IncrementNYInventoryParams{Season: Season, UserID: user, Item: item})); err != nil {
			return db.NySpin{}, err
		}
	} else {
		receipt.Refund = SpinRefund
		if err := expectOne(q.CreditNYFlakes(ctx, db.CreditNYFlakesParams{Season: Season, UserID: user, Amount: SpinRefund})); err != nil {
			return db.NySpin{}, err
		}
		refund := cost
		refund.Kind, refund.Delta = "duplicate", SpinRefund
		if err := expectOne(q.AddNYLedger(ctx, refund)); err != nil {
			return db.NySpin{}, err
		}
	}
	return receipt, expectOne(q.AddNYSpin(ctx, db.AddNYSpinParams(receipt)))
}
