package integration

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/server"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

// apiClient talks to the real HTTPS gateway with a self-signed dev certificate.
// The fingerprint pinning itself is covered by the WebSocket tests; these tests
// exercise the bearer-token layer.
func apiClient(t *testing.T) *http.Client {
	t.Helper()
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			// The test server uses a self-signed development certificate.
			InsecureSkipVerify: true,
		}},
	}
}

type apiReply struct {
	status int
	body   map[string]any
	raw    []byte
}

func apiCall(t *testing.T, client *http.Client, addr, method, path, token string, body any) apiReply {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, "https://"+addr+path, reader)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	reply := apiReply{status: response.StatusCode, raw: raw}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &reply.body)
	}
	return reply
}

func requireStatus(t *testing.T, reply apiReply, want int) {
	t.Helper()
	if reply.status != want {
		t.Fatalf("status = %d, want %d; body = %s", reply.status, want, reply.raw)
	}
}

func createAPIToken(t *testing.T, app *server.App, roleID uint64, expires time.Duration) (uint64, string) {
	t.Helper()
	var expiresIn uint32
	if expires > 0 {
		expiresIn = uint32(expires / time.Second)
	}
	result, err := app.Control.Apply(context.Background(), roles.System, "test", &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_ApiTokenCreate{ApiTokenCreate: &rostalkv1.ApiTokenCreate{
			Name:             fmt.Sprintf("test-%d", time.Now().UnixNano()),
			RoleId:           roleID,
			ExpiresInSeconds: expiresIn,
		}},
	})
	if err != nil {
		t.Fatalf("create api token: %v", err)
	}
	token := result.GetApiToken()
	if token.GetToken() == "" {
		t.Fatal("create reply has no plaintext token")
	}
	return token.GetId(), token.GetToken()
}

func TestAPITokenAuthenticationAndPermissions(t *testing.T) {
	app := newTestApp(t, nil)
	client := apiClient(t)
	addr := app.Addr().String()
	adminTokenID, adminToken := createAPIToken(t, app, uint64(app.Roles.AdminRoleID()), 0)
	memberTokenID, memberToken := createAPIToken(t, app, uint64(app.Roles.DefaultRoleID()), 0)
	_ = memberTokenID

	// No token and a bogus token are both 401 and never reveal a reason.
	requireStatus(t, apiCall(t, client, addr, http.MethodGet, "/api/v1/users", "", nil), http.StatusUnauthorized)
	requireStatus(t, apiCall(t, client, addr, http.MethodGet, "/api/v1/users", "not-a-token", nil), http.StatusUnauthorized)

	// A valid admin token sees the member list.
	reply := apiCall(t, client, addr, http.MethodGet, "/api/v1/users", adminToken, nil)
	requireStatus(t, reply, http.StatusOK)
	if _, ok := reply.body["users"]; !ok {
		t.Fatalf("users reply = %s", reply.raw)
	}

	// A Member token may not kick (403) even though the token itself is valid.
	reply = apiCall(t, client, addr, http.MethodPost, "/api/v1/members/1/kick", memberToken,
		map[string]any{"reason": "test"})
	requireStatus(t, reply, http.StatusForbidden)
	if code := apiErrorCode(reply); code != "permission_denied" && code != "hierarchy" {
		t.Fatalf("error code = %q, body = %s", code, reply.raw)
	}

	// An unknown user is 404, not 500 and not a leak.
	reply = apiCall(t, client, addr, http.MethodPost, "/api/v1/members/999999/kick", adminToken, nil)
	requireStatus(t, reply, http.StatusNotFound)

	// An unknown destination channel is 404.
	reply = apiCall(t, client, addr, http.MethodPost, "/api/v1/members/1/move", adminToken,
		map[string]any{"channelId": 999999})
	requireStatus(t, reply, http.StatusNotFound)

	// Revoking the admin token invalidates it immediately (401).
	reply = apiCall(t, client, addr, http.MethodDelete,
		fmt.Sprintf("/api/v1/tokens/%d", adminTokenID), adminToken, nil)
	requireStatus(t, reply, http.StatusNoContent)
	requireStatus(t, apiCall(t, client, addr, http.MethodGet, "/api/v1/users", adminToken, nil), http.StatusUnauthorized)
}

func TestExpiredAPITokenIsUnauthorized(t *testing.T) {
	app := newTestApp(t, nil)
	client := apiClient(t)
	// Create an already-expired token directly through the store: the admin
	// action refuses a zero lifetime only by convention, not by design.
	expired := time.Now().Add(-time.Minute)
	_, plaintext, err := app.Store.CreateAPIToken(context.Background(), store.APITokenOptions{
		Name:      "expired",
		RoleID:    app.Roles.AdminRoleID(),
		ExpiresAt: &expired,
	})
	if err != nil {
		t.Fatalf("create expired token: %v", err)
	}
	reply := apiCall(t, client, app.Addr().String(), http.MethodGet, "/api/v1/users", plaintext, nil)
	requireStatus(t, reply, http.StatusUnauthorized)
}

func TestAPIAuditAndInvites(t *testing.T) {
	app := newTestApp(t, nil)
	client := apiClient(t)
	addr := app.Addr().String()
	_, token := createAPIToken(t, app, uint64(app.Roles.AdminRoleID()), 0)

	reply := apiCall(t, client, addr, http.MethodPost, "/api/v1/invites", token, map[string]any{
		"roleId":           app.Roles.DefaultRoleID(),
		"maxUses":          2,
		"expiresInSeconds": 3600,
	})
	requireStatus(t, reply, http.StatusCreated)
	invite, ok := reply.body["invite"].(map[string]any)
	if !ok {
		t.Fatalf("invite reply = %s", reply.raw)
	}
	url, _ := invite["url"].(string)
	if url == "" || invite["id"] == nil {
		t.Fatalf("invite = %v", invite)
	}

	reply = apiCall(t, client, addr, http.MethodGet, "/api/v1/invites", token, nil)
	requireStatus(t, reply, http.StatusOK)
	if list, ok := reply.body["invites"].([]any); !ok || len(list) == 0 {
		t.Fatalf("invite list = %s", reply.raw)
	}

	inviteID := uint64(invite["id"].(float64))
	requireStatus(t, apiCall(t, client, addr, http.MethodDelete,
		fmt.Sprintf("/api/v1/invites/%d", inviteID), token, nil), http.StatusNoContent)

	// The audit log records both API actions with the token name.
	reply = apiCall(t, client, addr, http.MethodGet, "/api/v1/audit?action=invite", token, nil)
	requireStatus(t, reply, http.StatusOK)
	entries, ok := reply.body["entries"].([]any)
	if !ok || len(entries) < 2 {
		t.Fatalf("audit reply = %s", reply.raw)
	}
	actions := map[string]bool{}
	for _, item := range entries {
		entry, _ := item.(map[string]any)
		action, _ := entry["action"].(string)
		actions[action] = true
		actor, _ := entry["actorName"].(string)
		if actor == "" || actor == "api:" {
			t.Fatalf("audit entry has no API actor name: %v", entry)
		}
	}
	if !actions["invite.create"] || !actions["invite.revoke"] {
		t.Fatalf("audit actions = %v", actions)
	}
}

func TestAPITokenRoleDeletedMeansForbidden(t *testing.T) {
	app := newTestApp(t, nil)
	client := apiClient(t)
	_, _ = createAPIToken(t, app, uint64(app.Roles.AdminRoleID()), 0)
	// Delete a temporary role that a second token acts as.
	result, err := app.Control.Apply(context.Background(), roles.System, "test", &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_RoleCreate{RoleCreate: &rostalkv1.RoleCreate{
			Name: "Temp API",
			Permissions: &rostalkv1.PermissionSet{Permissions: []rostalkv1.Permission{
				rostalkv1.Permission_PERMISSION_VIEW_CHANNEL,
			}},
		}},
	})
	if err != nil {
		t.Fatalf("create role: %v", err)
	}
	roleID := result.GetRole().GetId()
	_, tempToken := createAPIToken(t, app, roleID, 0)
	if _, err := app.Control.Apply(context.Background(), roles.System, "test", &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_RoleDelete{RoleDelete: &rostalkv1.RoleDelete{RoleId: roleID}},
	}); err != nil {
		t.Fatalf("delete role: %v", err)
	}
	reply := apiCall(t, client, app.Addr().String(), http.MethodGet, "/api/v1/channels", tempToken, nil)
	requireStatus(t, reply, http.StatusForbidden)
	if code := apiErrorCode(reply); code != "permission_denied" {
		t.Fatalf("error code = %q, body = %s", code, reply.raw)
	}
}

func TestAPITokenIsNeverReturnedByList(t *testing.T) {
	app := newTestApp(t, nil)
	client := apiClient(t)
	addr := app.Addr().String()
	_, adminToken := createAPIToken(t, app, uint64(app.Roles.AdminRoleID()), 0)
	_, plain := createAPIToken(t, app, uint64(app.Roles.DefaultRoleID()), 0)
	reply := apiCall(t, client, addr, http.MethodGet, "/api/v1/tokens", adminToken, nil)
	requireStatus(t, reply, http.StatusOK)
	if bytes.Contains(reply.raw, []byte(plain)) {
		t.Fatal("token list leaked a plaintext token")
	}
	for _, item := range reply.body["tokens"].([]any) {
		entry := item.(map[string]any)
		if value, ok := entry["token"].(string); ok && value != "" {
			t.Fatalf("token list entry has a token: %v", entry)
		}
	}
}

func TestAPIMigrationsCreateTokenTable(t *testing.T) {
	app := newTestApp(t, nil)
	tokens, err := app.Store.ListAPITokens(context.Background())
	if err != nil {
		t.Fatalf("ListAPITokens: %v", err)
	}
	if len(tokens) != 0 {
		t.Fatalf("fresh server has %d tokens", len(tokens))
	}
}

func apiErrorCode(reply apiReply) string {
	body, _ := reply.body["error"].(map[string]any)
	code, _ := body["code"].(string)
	return code
}
