package integration

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	_ "image/jpeg"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/v4dikos1/RosTalk/server/internal/avatars"
)

// TestAvatarsOverHTTPS covers the whole P11 path on a real server: upload,
// re-encoding, read with another user's session, permissions and removal.
func TestAvatarsOverHTTPS(t *testing.T) {
	app := newTestApp(t, nil)
	admin := connectAdmin(t, app)
	member := connectAs(t, app, "Member", "avatar-reader")
	base := "https://" + app.Addr().String()
	client := apiClient(t)

	call := func(method, path, token, contentType string, body []byte) (int, http.Header, []byte) {
		t.Helper()
		var reader io.Reader
		if body != nil {
			reader = bytes.NewReader(body)
		}
		request, err := http.NewRequest(method, base+path, reader)
		if err != nil {
			t.Fatalf("new %s %s: %v", method, path, err)
		}
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		if contentType != "" {
			request.Header.Set("Content-Type", contentType)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer func() { _ = response.Body.Close() }()
		raw, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatalf("read %s %s: %v", method, path, err)
		}
		return response.StatusCode, response.Header, raw
	}

	adminID := admin.welcome.GetSelfUserId()
	adminToken := admin.welcome.GetHttpToken()

	status, _, body := call(http.MethodPut, "/api/v1/avatars/me", adminToken, "image/png", testPNG(t))
	if status != http.StatusOK {
		t.Fatalf("upload status = %d: %s", status, body)
	}
	var created struct {
		AvatarHash string `json:"avatarHash"`
	}
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatalf("decode upload: %v", err)
	}
	if !avatars.ValidHash(created.AvatarHash) {
		t.Fatalf("avatar hash = %q, want a sha256 hex digest", created.AvatarHash)
	}

	// The other client reads the picture with its own session token.
	status, headers, stored := call(http.MethodGet, "/api/v1/avatars/"+created.AvatarHash, member.welcome.GetHttpToken(), "", nil)
	if status != http.StatusOK {
		t.Fatalf("read status = %d: %s", status, stored)
	}
	if !strings.Contains(headers.Get("Cache-Control"), "immutable") {
		t.Fatalf("Cache-Control = %q, want immutable", headers.Get("Cache-Control"))
	}
	if headers.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("avatar is missing nosniff")
	}
	contentType := headers.Get("Content-Type")
	if contentType != "image/png" && contentType != "image/jpeg" {
		t.Fatalf("content type = %q", contentType)
	}
	decoded, _, err := image.Decode(bytes.NewReader(stored))
	if err != nil {
		t.Fatalf("decode served avatar: %v", err)
	}
	if decoded.Bounds().Dx() != avatars.Size || decoded.Bounds().Dy() != avatars.Size {
		t.Fatalf("served size = %v, want %dx%d", decoded.Bounds(), avatars.Size, avatars.Size)
	}

	// The change reaches the online state the other clients see.
	waitFor(t, func() bool {
		for _, user := range app.Hub.SnapshotUsers() {
			if user.UserID == int64(adminID) {
				return user.AvatarHash == created.AvatarHash
			}
		}
		return false
	}, "the avatar hash never reached the online presence")

	// A file that is not a picture is refused, and the server stays alive.
	status, _, _ = call(http.MethodPut, "/api/v1/avatars/me", member.welcome.GetHttpToken(), "image/png",
		[]byte("<html><script>alert(1)</script></html>"))
	if status != http.StatusUnsupportedMediaType && status != http.StatusBadRequest {
		t.Fatalf("garbage status = %d, want 415 or 400", status)
	}
	status, _, body = call(http.MethodPut, "/api/v1/avatars/me", member.welcome.GetHttpToken(), "image/png", testPNGRed(t))
	if status != http.StatusOK {
		t.Fatalf("valid upload after garbage = %d: %s", status, body)
	}

	// An oversized body is rejected before decoding.
	oversized := bytes.Repeat([]byte{0x89}, avatars.MaxBytes+1)
	status, _, _ = call(http.MethodPut, "/api/v1/avatars/me", member.welcome.GetHttpToken(), "image/png", oversized)
	if status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status = %d, want 413", status)
	}

	// A member may not reset someone else's picture.
	status, _, _ = call(http.MethodDelete, fmt.Sprintf("/api/v1/members/%d/avatar", adminID),
		member.welcome.GetHttpToken(), "", nil)
	if status != http.StatusForbidden {
		t.Fatalf("member reset status = %d, want 403", status)
	}

	// An administrator may.
	status, _, _ = call(http.MethodDelete, fmt.Sprintf("/api/v1/members/%d/avatar", adminID), adminToken, "", nil)
	if status != http.StatusNoContent {
		t.Fatalf("admin reset status = %d, want 204", status)
	}
	status, _, _ = call(http.MethodGet, "/api/v1/avatars/"+created.AvatarHash, member.welcome.GetHttpToken(), "", nil)
	if status != http.StatusNotFound {
		t.Fatalf("read of a reset avatar = %d, want 404", status)
	}
	waitFor(t, func() bool {
		for _, user := range app.Hub.SnapshotUsers() {
			if user.UserID == int64(adminID) {
				return user.AvatarHash == ""
			}
		}
		return false
	}, "the reset avatar hash stayed in the presence")

	// Unknown and malformed hashes are 404, never a path lookup.
	for _, hash := range []string{strings.Repeat("0", 64), "..", "not-a-hash"} {
		status, _, _ = call(http.MethodGet, "/api/v1/avatars/"+hash, member.welcome.GetHttpToken(), "", nil)
		if status != http.StatusNotFound {
			t.Fatalf("GET /avatars/%s = %d, want 404", hash, status)
		}
	}

	// The owner removes the picture.
	status, _, body = call(http.MethodPut, "/api/v1/avatars/me", member.welcome.GetHttpToken(), "image/png", testPNGRed(t))
	if status != http.StatusOK {
		t.Fatalf("member upload status = %d: %s", status, body)
	}
	memberHash := struct {
		AvatarHash string `json:"avatarHash"`
	}{}
	if err := json.Unmarshal(body, &memberHash); err != nil {
		t.Fatalf("decode member upload: %v", err)
	}
	status, _, _ = call(http.MethodDelete, "/api/v1/avatars/me", member.welcome.GetHttpToken(), "", nil)
	if status != http.StatusNoContent {
		t.Fatalf("clear status = %d, want 204", status)
	}
	status, _, _ = call(http.MethodGet, "/api/v1/avatars/"+memberHash.AvatarHash, member.welcome.GetHttpToken(), "", nil)
	if status != http.StatusNotFound {
		t.Fatalf("read after clear = %d, want 404", status)
	}
}

// testPNGRed is a picture that differs from testPNG, so the two users do not
// share one content-addressed file.
func testPNGRed(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 3, 3))
	for x := 0; x < 3; x++ {
		for y := 0; y < 3; y++ {
			img.Set(x, y, color.RGBA{R: 255, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buffer.Bytes()
}
