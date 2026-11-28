package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/newyear"
)

func TestNewYearHandlerRejectsUncleanEventPaths(t *testing.T) {
	server := &Server{mux: http.NewServeMux(), newYear: &newyear.Service{}}
	for _, path := range []string{
		newYearBase + "//support",
		newYearBase + "/./support",
		newYearBase + "/trees/../support",
		"/api/v1/events/%6eew-year/support",
	} {
		reply := httptest.NewRecorder()
		server.Handler().ServeHTTP(reply, httptest.NewRequest(http.MethodGet, path, nil))
		if reply.Code != http.StatusNotFound || reply.Header().Get("Location") != "" {
			t.Errorf("%s = %d, want 404 without a redirect", path, reply.Code)
		}
	}
}

func TestNewYearMutationBudgetRefillsPerUser(t *testing.T) {
	now := time.Unix(0, 0)
	server := &Server{now: func() time.Time { return now }}
	for i := range newYearBurst {
		if !server.newYearAllow(1) {
			t.Fatalf("mutation %d inside the burst was denied", i+1)
		}
	}
	if server.newYearAllow(1) || !server.newYearAllow(2) {
		t.Fatal("burst was exceeded or budget was shared")
	}
	now = now.Add(time.Second - time.Millisecond)
	if server.newYearAllow(1) {
		t.Fatal("a token refilled in less than a second")
	}
	now = now.Add(time.Millisecond)
	if !server.newYearAllow(1) || server.newYearAllow(1) {
		t.Fatal("the budget did not refill exactly one token")
	}
}

func TestNewYearLayoutRejectsNoncanonicalFields(t *testing.T) {
	for _, input := range []string{
		`{"Version":0,"background":"dusk","placements":[]}`,
		`{"version":0,"version":1,"background":"dusk","placements":[]}`,
		`{"version":0,"background":"dusk","placements":null}`,
		`{"version":0,"background":"dusk","placements":[{"itemId":"ball-red","x":500,"X":501,"y":200,"rotation":0,"scale":100}]}`,
	} {
		req := httptest.NewRequest(http.MethodPut, newYearBase+"/me/layout", strings.NewReader(input))
		req.Header.Set("Content-Type", "application/json")
		reply := httptest.NewRecorder()
		if _, ok := decodeNewYearLayout(reply, req); ok || reply.Code != http.StatusBadRequest {
			t.Errorf("decode %s = %d, want 400", input, reply.Code)
		}
	}
}
