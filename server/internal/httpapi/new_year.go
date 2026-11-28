package httpapi

import (
	"encoding/json/v2"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/newyear"
)

// The New Year event routes are served by one exact dispatcher instead of the
// ServeMux: a wrong verb, a query, a percent escape or a stray segment is a
// plain 404 here and never a redirect, a 405 or an implicit HEAD.
// Only the session of the caller selects the actor.

const (
	newYearBase = "/api/v1/events/new-year"

	// Request bodies are single small JSON objects.
	newYearSmallBody  = 256
	newYearLayoutBody = 4096

	// A mutation burst of 8 refills one call per second, per user.
	newYearBurst    = 8
	newYearInterval = time.Second
)

type newYearRoute int

const (
	nySupport newYearRoute = iota
	nyMe
	nyEnroll
	nyClaim
	nyWater
	nySpin
	nyLayout
	nyTree
)

var newYearPeerID = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)

var newYearMessages = map[string]string{
	"event_closed":        "the New Year event is not running",
	"not_enrolled":        "join the New Year event first",
	"day_changed":         "the event day has changed",
	"already_claimed":     "today's gift is already claimed",
	"already_watered":     "the tree is already watered today",
	"no_water":            "there is no water left",
	"insufficient_flakes": "not enough snowflakes",
	"layout_conflict":     "the tree layout changed elsewhere",
	"not_owned":           "an ornament is not in the inventory",
	"background_locked":   "the background is still locked",
	"invalid_request":     "the request is not valid",
	"invalid_layout":      "the tree layout is not valid",
}

// Handler returns the router. With the event enabled, its paths bypass the
// ServeMux so the escaped path is inspected before any cleaning.
func (s *Server) Handler() http.Handler {
	if s.newYear == nil {
		return s.mux
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p := r.URL.Path; p == newYearBase || strings.HasPrefix(p, newYearBase+"/") {
			s.serveNewYear(w, r)
			return
		}
		s.mux.ServeHTTP(w, r)
	})
}

func matchNewYear(r *http.Request) (newYearRoute, int64, bool) {
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		return 0, 0, false
	}
	path := r.URL.EscapedPath()
	if !strings.HasPrefix(path, newYearBase+"/") {
		return 0, 0, false
	}
	suffix := strings.TrimPrefix(path, newYearBase)
	switch {
	case suffix == "/support" && r.Method == http.MethodGet:
		return nySupport, 0, true
	case suffix == "/me" && r.Method == http.MethodGet:
		return nyMe, 0, true
	case suffix == "/me/enrollment" && r.Method == http.MethodPut:
		return nyEnroll, 0, true
	case suffix == "/me/claim" && r.Method == http.MethodPost:
		return nyClaim, 0, true
	case suffix == "/me/water" && r.Method == http.MethodPost:
		return nyWater, 0, true
	case suffix == "/me/spins" && r.Method == http.MethodPost:
		return nySpin, 0, true
	case suffix == "/me/layout" && r.Method == http.MethodPut:
		return nyLayout, 0, true
	case strings.HasPrefix(suffix, "/trees/") && r.Method == http.MethodGet:
		raw := strings.TrimPrefix(suffix, "/trees/")
		if !newYearPeerID.MatchString(raw) {
			return 0, 0, false
		}
		id, err := strconv.ParseInt(raw, 10, 64)
		return nyTree, id, err == nil
	}
	return 0, 0, false
}

func (s *Server) serveNewYear(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	route, peer, ok := matchNewYear(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "the endpoint does not exist")
		return
	}
	p, authErr := s.requireChatUser(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	if r.Method == http.MethodGet && (r.ContentLength != 0 || len(r.TransferEncoding) != 0) {
		writeNewYearError(w, newyear.ErrInvalidRequest)
		return
	}
	ctx := r.Context()
	switch route {
	case nySupport:
		writeJSON(w, http.StatusOK, s.newYear.Support())
	case nyMe:
		state, err := s.newYear.Me(ctx, p.userID)
		s.writeNewYear(w, state, err)
	case nyTree:
		if !s.newYearCanSee(p.userID, peer) {
			writeError(w, http.StatusNotFound, "not_found", "the object does not exist")
			return
		}
		tree, err := s.newYear.Tree(ctx, peer)
		s.writeNewYear(w, tree, err)
	default:
		s.serveNewYearMutation(w, r, route, p.userID)
	}
}

func (s *Server) serveNewYearMutation(w http.ResponseWriter, r *http.Request, route newYearRoute, user int64) {
	if !s.newYearAllow(user) {
		w.Header().Set("Retry-After", "1")
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many New Year requests, retry in a second")
		return
	}
	ctx := r.Context()
	switch route {
	case nyEnroll:
		var body *struct{}
		if !decodeNewYear(w, r, newYearSmallBody, &body) {
			return
		}
		if body == nil {
			writeNewYearError(w, newyear.ErrInvalidRequest)
			return
		}
		state, err := s.newYear.Enroll(ctx, user)
		s.writeNewYear(w, state, err)
	case nyClaim, nyWater:
		var body *struct {
			Day *string `json:"day"`
		}
		if !decodeNewYear(w, r, newYearSmallBody, &body) {
			return
		}
		if body == nil || body.Day == nil {
			writeNewYearError(w, newyear.ErrInvalidRequest)
			return
		}
		if route == nyWater {
			state, err := s.newYear.Water(ctx, user, *body.Day)
			s.writeNewYear(w, state, err)
			return
		}
		claim, err := s.newYear.Claim(ctx, user, *body.Day)
		s.writeNewYear(w, claim, err)
	case nySpin:
		var body *struct {
			RequestID *string `json:"requestId"`
		}
		if !decodeNewYear(w, r, newYearSmallBody, &body) {
			return
		}
		if body == nil || body.RequestID == nil {
			writeNewYearError(w, newyear.ErrInvalidRequest)
			return
		}
		spin, err := s.newYear.Spin(ctx, user, *body.RequestID)
		s.writeNewYear(w, spin, err)
	case nyLayout:
		layout, ok := decodeNewYearLayout(w, r)
		if !ok {
			return
		}
		state, err := s.newYear.SaveLayout(ctx, user, layout)
		s.writeNewYear(w, state, err)
	}
}

type newYearPlacementBody struct {
	ItemID   *string `json:"itemId"`
	X        *int64  `json:"x"`
	Y        *int64  `json:"y"`
	Scale    *int64  `json:"scale"`
	Rotation *int64  `json:"rotation"`
}

func decodeNewYearLayout(w http.ResponseWriter, r *http.Request) (newyear.Layout, bool) {
	var body *struct {
		Version    *int64                  `json:"version"`
		Background *string                 `json:"background"`
		Placements *[]newYearPlacementBody `json:"placements"`
	}
	if !decodeNewYear(w, r, newYearLayoutBody, &body) {
		return newyear.Layout{}, false
	}
	if body == nil || body.Version == nil || body.Background == nil || body.Placements == nil {
		writeNewYearError(w, newyear.ErrInvalidRequest)
		return newyear.Layout{}, false
	}
	layout := newyear.Layout{Version: *body.Version, Background: *body.Background, Placements: []newyear.Placement{}}
	for _, p := range *body.Placements {
		if p.ItemID == nil || p.X == nil || p.Y == nil || p.Scale == nil || p.Rotation == nil {
			writeNewYearError(w, newyear.ErrInvalidRequest)
			return newyear.Layout{}, false
		}
		layout.Placements = append(layout.Placements, newyear.Placement{
			ItemID: *p.ItemID, X: *p.X, Y: *p.Y, Scale: *p.Scale, Rotation: *p.Rotation,
		})
	}
	return layout, true
}

// decodeNewYear reads exactly one JSON object of at most limit bytes. It
// writes the rejection itself and reports false.
func decodeNewYear(w http.ResponseWriter, r *http.Request, limit int64, target any) bool {
	if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "the body must be application/json")
		return false
	}
	if r.ContentLength > limit {
		writeError(w, http.StatusRequestEntityTooLarge, "file_too_large", "the request body is too large")
		return false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, "file_too_large", "the request body is too large")
		return false
	}
	if err == nil && json.Unmarshal(body, target, json.RejectUnknownMembers(true)) == nil {
		return true
	}
	writeNewYearError(w, newyear.ErrInvalidRequest)
	return false
}

func (s *Server) writeNewYear(w http.ResponseWriter, value any, err error) {
	if err == nil {
		writeJSON(w, http.StatusOK, value)
		return
	}
	var rule newyear.RuleError
	if errors.As(err, &rule) {
		writeNewYearError(w, rule)
		return
	}
	s.logger.Error("New Year request failed", "code", "internal")
	writeError(w, http.StatusInternalServerError, "internal", "the request could not be completed")
}

func writeNewYearError(w http.ResponseWriter, rule newyear.RuleError) {
	status := http.StatusConflict
	if rule == newyear.ErrInvalidRequest || rule == newyear.ErrInvalidLayout {
		status = http.StatusBadRequest
	}
	writeError(w, status, string(rule), newYearMessages[string(rule)])
}

func (s *Server) newYearCanSee(viewer, target int64) bool {
	if viewer == target {
		return true
	}
	return s.newYearVisible != nil && s.newYearVisible(viewer, target)
}

func (s *Server) newYearAllow(user int64) bool {
	now := s.now()
	s.newYearMu.Lock()
	defer s.newYearMu.Unlock()
	if s.newYearBuckets == nil {
		s.newYearBuckets = make(map[int64]*newYearBucket)
	}
	bucket, ok := s.newYearBuckets[user]
	if !ok {
		bucket = &newYearBucket{tokens: newYearBurst, last: now}
		s.newYearBuckets[user] = bucket
	}
	if elapsed := now.Sub(bucket.last); elapsed > 0 {
		bucket.tokens = min(newYearBurst, bucket.tokens+elapsed.Seconds()/newYearInterval.Seconds())
	}
	bucket.last = now
	if len(s.newYearBuckets) > 1024 {
		for id, entry := range s.newYearBuckets {
			// Past the refill time an entry equals a fresh one.
			if id != user && now.Sub(entry.last) > newYearBurst*newYearInterval {
				delete(s.newYearBuckets, id)
			}
		}
	}
	if bucket.tokens < 1 {
		return false
	}
	bucket.tokens--
	return true
}

type newYearBucket struct {
	tokens float64
	last   time.Time
}
