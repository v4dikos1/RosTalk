package newyear

const (
	Season     = "2026-12"
	APIVersion = 1
	SpinCost   = 6
	SpinRefund = 2
)

type Phase string

const (
	Upcoming Phase = "upcoming"
	Active   Phase = "active"
	Gallery  Phase = "gallery"
	Closed   Phase = "closed"
)

type RuleError string

func (e RuleError) Error() string { return string(e) }

const (
	ErrClosed             RuleError = "event_closed"
	ErrNotEnrolled        RuleError = "not_enrolled"
	ErrDayChanged         RuleError = "day_changed"
	ErrAlreadyClaimed     RuleError = "already_claimed"
	ErrAlreadyWatered     RuleError = "already_watered"
	ErrNoWater            RuleError = "no_water"
	ErrInsufficientFlakes RuleError = "insufficient_flakes"
	ErrLayoutConflict     RuleError = "layout_conflict"
	ErrInvalidRequest     RuleError = "invalid_request"
	ErrInvalidLayout      RuleError = "invalid_layout"
	ErrNotOwned           RuleError = "not_owned"
	ErrBackgroundLocked   RuleError = "background_locked"
)

type Support struct {
	APIVersion int    `json:"apiVersion"`
	Season     string `json:"season"`
	Phase      Phase  `json:"phase"`
}

type State struct {
	Season              string   `json:"season"`
	Phase               Phase    `json:"phase"`
	Zone                string   `json:"zone"`
	Day                 string   `json:"day"`
	NextDayAt           string   `json:"nextDayAt"`
	Enrolled            bool     `json:"enrolled"`
	Water               int64    `json:"water"`
	Flakes              int64    `json:"flakes"`
	Claims              []Claim  `json:"claims"`
	WateredDays         []string `json:"wateredDays"`
	GrowthDays          int64    `json:"growthDays"`
	Inventory           []Item   `json:"inventory"`
	Layout              Layout   `json:"layout"`
	UnlockedBackgrounds []string `json:"unlockedBackgrounds"`
	History             []Change `json:"history"`
}

type Claim struct {
	Day    string `json:"day"`
	ItemID string `json:"itemId"`
}

type Item struct {
	ItemID string `json:"itemId"`
	Qty    int64  `json:"qty"`
}

type Change struct {
	Kind  string `json:"kind"`
	Delta int64  `json:"delta"`
	At    string `json:"at"`
}

type Placement struct {
	ItemID   string `json:"itemId"`
	X        int64  `json:"x"`
	Y        int64  `json:"y"`
	Scale    int64  `json:"scale"`
	Rotation int64  `json:"rotation"`
}

type Layout struct {
	Version    int64       `json:"version"`
	Background string      `json:"background"`
	Placements []Placement `json:"placements"`
}

type Tree struct {
	GrowthDays int64       `json:"growthDays"`
	Background string      `json:"background"`
	Placements []Placement `json:"placements"`
}

type TreeResponse struct {
	Tree *Tree `json:"tree"`
}

type ClaimResponse struct {
	ItemID string `json:"itemId"`
	State  State  `json:"state"`
}

type Receipt struct {
	RequestID string `json:"requestId"`
	ItemID    string `json:"itemId"`
	Duplicate bool   `json:"duplicate"`
	Refund    int64  `json:"refund"`
	Cost      int64  `json:"cost"`
}

type SpinResponse struct {
	Receipt Receipt `json:"receipt"`
	State   State   `json:"state"`
}
