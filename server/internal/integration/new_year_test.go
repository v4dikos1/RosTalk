package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"
	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/newyear"
	"github.com/v4dikos1/RosTalk/server/internal/perms"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/server"
)

const eventPath = "/api/v1/events/new-year"

func eventTime(month time.Month, day int) time.Time {
	year := 2026
	if month == time.January {
		year++
	}
	return time.Date(year, month, day, 12, 0, 0, 0, time.UTC)
}

func eventApp(t *testing.T, at time.Time) (*server.App, func(time.Time)) {
	t.Helper()
	var clock atomic.Int64
	set := func(at time.Time) { clock.Store(at.UnixMilli()) }
	set(at)
	app := newTestAppWithConfig(t, nil, func(cfg *server.Config) {
		cfg.NewYearTZ = "UTC"
		cfg.NewYearNow = func() time.Time { return time.UnixMilli(clock.Load()) }
		cfg.NewYearDraw = func(int) (int, error) { return 0, nil }
	})
	return app, set
}

func eventRequest(t *testing.T, app *server.App, client *http.Client, method, path, token, contentType string, body io.Reader) (apiReply, http.Header) {
	t.Helper()
	req, err := http.NewRequest(method, "https://"+app.Addr().String()+eventPath+path, body)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	reply := apiReply{status: res.StatusCode, raw: raw}
	_ = json.Unmarshal(raw, &reply.body)
	return reply, res.Header
}

func expectEvent(t *testing.T, reply apiReply, status int, code string) {
	t.Helper()
	requireStatus(t, reply, status)
	if code != "" && apiErrorCode(reply) != code {
		t.Fatalf("error code = %q, want %q", apiErrorCode(reply), code)
	}
}

func eventDecode[T any](t *testing.T, reply apiReply) T {
	t.Helper()
	requireStatus(t, reply, http.StatusOK)
	var value T
	if err := json.Unmarshal(reply.raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestNewYearHTTPSSeasonAndPeerVisibility(t *testing.T) {
	day := eventTime(time.December, 1)
	app, set := eventApp(t, day.AddDate(0, 0, -1))
	channel := chatChannel(t, app)
	admin := connectAdmin(t, app)
	member := connectAs(t, app, roles.MemberName, "new-year-member")
	client := apiClient(t)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	adminToken, memberToken := admin.welcome.GetHttpToken(), member.welcome.GetHttpToken()
	call := func(method, path, token, body string) apiReply {
		t.Helper()
		var reader io.Reader
		if body != "" {
			reader = strings.NewReader(body)
		}
		reply, headers := eventRequest(t, app, client, method, path, token, "application/json", reader)
		if reply.status == http.StatusOK && (headers.Get("Cache-Control") != "no-store" ||
			!strings.HasPrefix(headers.Get("Content-Type"), "application/json")) {
			t.Fatalf("%s %s success headers = %v", method, path, headers)
		}
		return reply
	}
	adminTree := fmt.Sprintf("/trees/%d", admin.welcome.GetSelfUserId())
	preview := eventDecode[newyear.State](t, call("GET", "/me", memberToken, ""))
	if preview.Phase != newyear.Upcoming || preview.Enrolled || preview.Layout.Placements == nil ||
		preview.Claims == nil || preview.WateredDays == nil || preview.Inventory == nil || preview.History == nil {
		t.Fatalf("unexpected upcoming state: %+v", preview)
	}
	expectEvent(t, call("GET", adminTree, memberToken, ""), 409, "event_closed")
	expectEvent(t, call("PUT", "/me/enrollment", memberToken, "{}"), 409, "event_closed")

	set(day)
	support := call("GET", "/support", memberToken, "")
	if got := eventDecode[newyear.Support](t, support); got != (newyear.Support{
		APIVersion: 1, Season: "2026-12", Phase: newyear.Active,
	}) || len(support.body) != 3 || len(support.raw) >= 256 {
		t.Fatalf("unexpected support response: %s", support.raw)
	}
	if got := call("GET", adminTree, memberToken, ""); got.status != 200 || string(got.raw) != "{\"tree\":null}\n" {
		t.Fatalf("unenrolled peer = %d %s", got.status, got.raw)
	}
	if got := eventDecode[newyear.State](t, call("PUT", "/me/enrollment", adminToken, "{}")); !got.Enrolled || got.Flakes != 0 {
		t.Fatalf("new enrollment = %+v", got)
	}
	expectedDay := `{"day":"2026-12-01"}`
	claim := eventDecode[newyear.ClaimResponse](t, call("POST", "/me/claim", adminToken, expectedDay))
	if claim.ItemID != "ball-red" || claim.State.Water != 1 || len(claim.State.Claims) != 1 {
		t.Fatalf("claim = %+v", claim)
	}
	expectEvent(t, call("POST", "/me/claim", adminToken, expectedDay), 409, "already_claimed")
	water := eventDecode[newyear.State](t, call("POST", "/me/water", adminToken, expectedDay))
	if water.GrowthDays != 1 || water.Water != 0 {
		t.Fatalf("water = %+v", water)
	}
	expectEvent(t, call("POST", "/me/water", adminToken, expectedDay), 409, "already_watered")
	layout := `{"version":0,"background":"dusk","placements":[{"itemId":"ball-red","x":523,"y":140,"scale":100,"rotation":0}]}`
	saved := eventDecode[newyear.State](t, call("PUT", "/me/layout", adminToken, layout))
	if saved.Layout.Version != 1 || len(saved.Layout.Placements) != 1 {
		t.Fatalf("save = %+v", saved.Layout)
	}
	identical := eventDecode[newyear.State](t, call("PUT", "/me/layout", adminToken, layout))
	if !reflect.DeepEqual(identical, saved) {
		t.Fatal("replaying the same layout changed state")
	}
	expectEvent(t, call("PUT", "/me/layout", adminToken, `{"version":0,"background":"dusk","placements":[]}`), 409, "layout_conflict")
	treeReply := call("GET", adminTree, memberToken, "")
	tree := eventDecode[newyear.TreeResponse](t, treeReply).Tree
	keys, ok := treeReply.body["tree"].(map[string]any)
	if tree == nil || !ok || len(treeReply.body) != 1 || len(keys) != 3 || tree.GrowthDays != 1 ||
		tree.Background != "dusk" || !reflect.DeepEqual(tree.Placements, saved.Layout.Placements) {
		t.Fatalf("peer projection = %s", treeReply.raw)
	}

	// Reading support or a peer tree must leave the member un-enrolled.
	if got := eventDecode[newyear.State](t, call("GET", "/me", memberToken, "")); got.Enrolled || got.Flakes != 0 {
		t.Fatal("a read enrolled the viewer")
	}
	expectEvent(t, call("POST", "/me/claim", memberToken, expectedDay), 409, "not_enrolled")
	expectEvent(t, call("PUT", "/me/enrollment", memberToken, "{}"), 200, "")
	request := `{"requestId":"f2d19398-48d3-4c89-a3a6-eb60eda2eeb2"}`
	expectEvent(t, call("POST", "/me/spins", memberToken, request), 409, "insufficient_flakes")
	for i := range 6 {
		if i == 5 {
			// The chat send limiter uses real time and permits a burst of five.
			time.Sleep(500 * time.Millisecond)
		}
		set(day.Add(time.Duration(i) * time.Minute))
		reply := sendChat(t, member, uint64(100+i), &rostalkv1.ChatSend{Target: channelTarget(channel), Body: "event fixture"})
		if reply.GetMessage() == nil {
			t.Fatalf("channel send %d was not accepted", i)
		}
	}
	spin := eventDecode[newyear.SpinResponse](t, call("POST", "/me/spins", memberToken, request))
	if spin.Receipt.ItemID != "ball-red" || spin.Receipt.Cost != 6 || spin.Receipt.Duplicate ||
		spin.State.Flakes != 0 || len(spin.State.History) != 7 {
		t.Fatalf("spin = %+v", spin)
	}

	set(eventTime(time.January, 7))
	replay := eventDecode[newyear.SpinResponse](t, call("POST", "/me/spins", memberToken, request))
	if replay.Receipt != spin.Receipt || replay.State.Phase != newyear.Gallery ||
		!reflect.DeepEqual(replay.State.History, spin.State.History) {
		t.Fatal("gallery replay failed to recover the unchanged receipt and wallet")
	}
	expectEvent(t, call("POST", "/me/spins", memberToken, `{"requestId":"a2d19398-48d3-4c89-a3a6-eb60eda2eeb2"}`), 409, "event_closed")
	expectEvent(t, call("GET", adminTree, memberToken, ""), 200, "")

	ctx := context.Background()
	hidden, err := app.Control.CreateChannel(ctx, channels.CreateParams{
		Name: "hidden", Kind: rostalkv1.ChannelKind_CHANNEL_KIND_VOICE,
	})
	if err != nil {
		t.Fatal(err)
	}
	role, ok := app.Roles.RoleByName(roles.MemberName)
	if !ok {
		t.Fatal("missing member role")
	}
	if _, err := app.Roles.SetOverride(ctx, roles.System, hidden.ID, role.ID, 0,
		perms.Mask(rostalkv1.Permission_PERMISSION_VIEW_CHANNEL)); err != nil {
		t.Fatal(err)
	}
	if _, err := app.Hub.Move(int64(admin.welcome.GetSelfUserId()), uint64(hidden.ID), 0); err != nil {
		t.Fatal(err)
	}
	hiddenReply := call("GET", adminTree, memberToken, "")
	expectEvent(t, hiddenReply, 404, "not_found")
	expectEvent(t, call("GET", adminTree, adminToken, ""), 200, "")
	unknown := call("GET", "/trees/9223372036854775807", memberToken, "")
	if string(hiddenReply.raw) != string(unknown.raw) {
		t.Fatal("a hidden tree and an unknown tree have different responses")
	}
	admin.close()
	waitFor(t, func() bool {
		_, online := app.Hub.Presence(int64(admin.welcome.GetSelfUserId()))
		return !online
	}, "admin still online after disconnect")
	waitFor(t, func() bool {
		_, err := app.Tokens.Lookup(adminToken)
		return err != nil
	}, "admin token still valid after disconnect")
	offline := call("GET", adminTree, memberToken, "")
	if string(offline.raw) != string(unknown.raw) {
		t.Fatal("an offline tree and an unknown tree have different responses")
	}
	expectEvent(t, call("GET", "/support", adminToken, ""), 401, "unauthenticated")

	set(eventTime(time.January, 8))
	if got := eventDecode[newyear.Support](t, call("GET", "/support", memberToken, "")); got.Phase != newyear.Closed {
		t.Fatalf("support phase = %q, want closed", got.Phase)
	}
	expectEvent(t, call("GET", "/me", memberToken, ""), 409, "event_closed")
}

func TestNewYearHTTPSRequestLimits(t *testing.T) {
	app, _ := eventApp(t, eventTime(time.December, 1))
	user := connectAdmin(t, app)
	token := user.welcome.GetHttpToken()
	_, roleToken := createAPIToken(t, app, uint64(app.Roles.AdminRoleID()), 0)
	client := apiClient(t)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	get := func(method, path, token string) apiReply {
		t.Helper()
		res, _ := eventRequest(t, app, client, method, path, token, "", nil)
		return res
	}
	expectEvent(t, get("GET", "/support", ""), 401, "unauthenticated")
	expectEvent(t, get("GET", "/support", roleToken), 403, "permission_denied")
	for _, tc := range []struct{ method, path string }{
		{"HEAD", "/support"}, {"POST", "/support"}, {"GET", "/me/claim"},
		{"GET", "/support?x=1"}, {"GET", "/support?"},
		{"GET", "/%73upport"}, {"GET", "/support/"}, {"GET", "/missing"},
		{"GET", "/trees/0"}, {"GET", "/trees/01"}, {"GET", "/trees/%31"},
		{"GET", "/trees/+1"}, {"GET", "/trees/9223372036854775808"}, {"GET", "/trees/1/2"},
	} {
		if tc.method == "HEAD" {
			requireStatus(t, get(tc.method, tc.path, token), 404)
		} else {
			expectEvent(t, get(tc.method, tc.path, token), 404, "not_found")
		}
	}
	reply, _ := eventRequest(t, app, client, "GET", "/me", token, "", strings.NewReader("{}"))
	expectEvent(t, reply, 400, "invalid_request")

	for _, tc := range []struct {
		method, path, contentType, body, code string
		status                                int
		streamed                              bool
	}{
		{"PUT", "/me/enrollment", "text/plain", "{}", "unsupported_media_type", 415, false},
		{"PUT", "/me/enrollment", "application/json", strings.Repeat(" ", 257), "file_too_large", 413, false},
		{"PUT", "/me/layout", "application/json", "{}" + strings.Repeat(" ", 4095), "file_too_large", 413, true},
		{"PUT", "/me/enrollment", "application/json", "null", "invalid_request", 400, false},
		{"PUT", "/me/enrollment", "application/json", "{} {}", "invalid_request", 400, false},
		{"POST", "/me/claim", "application/json", "{}", "invalid_request", 400, false},
		{"POST", "/me/water", "application/json", `{"day":"2026-12-01","actor":1}`, "invalid_request", 400, false},
		{"PUT", "/me/layout", "application/json", `{"version":0.1,"background":"dusk","placements":[]}`, "invalid_request", 400, false},
	} {
		reader := strings.NewReader(tc.body)
		var body io.Reader = reader
		if tc.streamed {
			body = struct{ io.Reader }{reader}
		}
		res, _ := eventRequest(t, app, client, tc.method, tc.path, token, tc.contentType, body)
		expectEvent(t, res, tc.status, tc.code)
	}
	reply, headers := eventRequest(t, app, client, "PUT", "/me/enrollment", token, "application/json", strings.NewReader("{}"))
	expectEvent(t, reply, 429, "rate_limited")
	if headers.Get("Retry-After") != "1" {
		t.Fatalf("Retry-After = %q", headers.Get("Retry-After"))
	}
	if got := eventDecode[newyear.State](t, get("GET", "/me", token)); got.Enrolled {
		t.Fatal("a denied mutation enrolled a player")
	}
}

func TestNewYearHTTPSRuleErrorsAndRollback(t *testing.T) {
	app := newTestAppWithConfig(t, nil, func(cfg *server.Config) {
		cfg.NewYearTZ = "UTC"
		cfg.NewYearNow = func() time.Time { return eventTime(time.December, 1) }
		cfg.NewYearDraw = func(int) (int, error) { return 0, errors.New("draw fixture failed") }
	})
	user := connectAdmin(t, app)
	token := user.welcome.GetHttpToken()
	client := apiClient(t)
	for _, tc := range []struct {
		method, path, body, code string
		status                   int
	}{
		{"PUT", "/me/enrollment", "{}", "", 200},
		{"PUT", "/me/enrollment", "{}", "", 200},
		{"POST", "/me/water", `{"day":"2026-12-01"}`, "no_water", 409},
		{"POST", "/me/claim", `{"day":"2026-12-02"}`, "day_changed", 409},
		{"PUT", "/me/layout", `{"version":0,"background":"dusk","placements":[{"itemId":"ball-red","x":524,"y":140,"scale":100,"rotation":0}]}`, "invalid_layout", 400},
		{"PUT", "/me/layout", `{"version":0,"background":"dusk","placements":[{"itemId":"ball-red","x":523,"y":140,"scale":100,"rotation":0}]}`, "not_owned", 409},
		{"PUT", "/me/layout", `{"version":0,"background":"aurora","placements":[]}`, "background_locked", 409},
		{"POST", "/me/claim", `{"day":"2026-12-01"}`, "internal", 500},
	} {
		reply, _ := eventRequest(t, app, client, tc.method, tc.path, token, "application/json", strings.NewReader(tc.body))
		expectEvent(t, reply, tc.status, tc.code)
	}
	reply, _ := eventRequest(t, app, client, "GET", "/me", token, "", nil)
	got := eventDecode[newyear.State](t, reply)
	if !got.Enrolled || got.Water != 0 || got.Flakes != 0 || len(got.Claims) != 0 ||
		len(got.Inventory) != 0 || got.Layout.Version != 0 || len(got.Layout.Placements) != 0 {
		t.Fatalf("rejected writes changed state: %+v", got)
	}
}

func TestNewYearDisabledOrInvalidZoneKeepsChatWorking(t *testing.T) {
	for _, zone := range []string{"UTC", "Invalid/TestZone"} {
		t.Run(zone, func(t *testing.T) {
			app := newTestAppWithConfig(t, nil, func(cfg *server.Config) {
				cfg.NewYearDisabled = zone == "UTC"
				cfg.NewYearTZ = zone
			})
			member := connectAdmin(t, app)
			reply, _ := eventRequest(t, app, apiClient(t), "GET", "/support", member.welcome.GetHttpToken(), "", nil)
			requireStatus(t, reply, 404)
			if app.NewYear != nil {
				t.Fatal("an unavailable event service was started")
			}
			sent := sendChat(t, member, 100, &rostalkv1.ChatSend{
				Target: channelTarget(chatChannel(t, app)), Body: "event fixture",
			})
			if sent.GetMessage() == nil {
				t.Fatal("chat did not accept a channel send")
			}
		})
	}
}
