package integration

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/server"
)

func chatChannel(t *testing.T, app *server.App) uint64 {
	t.Helper()
	channel, err := app.Channels.Create(context.Background(), channels.CreateParams{
		Name: "chat",
		Kind: rostalkv1.ChannelKind_CHANNEL_KIND_TEXT,
	})
	if err != nil {
		t.Fatalf("create a text channel: %v", err)
	}
	return uint64(channel.ID)
}

func sendChat(t *testing.T, session *testSession, requestID uint64, payload any) *rostalkv1.ServerFrame {
	t.Helper()
	var frame *rostalkv1.ClientFrame
	switch value := payload.(type) {
	case *rostalkv1.ChatSend:
		frame = &rostalkv1.ClientFrame{RequestId: requestID, Payload: &rostalkv1.ClientFrame_ChatSend{ChatSend: value}}
	case *rostalkv1.EditMessage:
		frame = &rostalkv1.ClientFrame{RequestId: requestID, Payload: &rostalkv1.ClientFrame_EditMessage{EditMessage: value}}
	case *rostalkv1.DeleteMessage:
		frame = &rostalkv1.ClientFrame{RequestId: requestID, Payload: &rostalkv1.ClientFrame_DeleteMessage{DeleteMessage: value}}
	case *rostalkv1.ChatHistoryRequest:
		frame = &rostalkv1.ClientFrame{RequestId: requestID, Payload: &rostalkv1.ClientFrame_ChatHistory{ChatHistory: value}}
	case *rostalkv1.MarkRead:
		frame = &rostalkv1.ClientFrame{RequestId: requestID, Payload: &rostalkv1.ClientFrame_MarkRead{MarkRead: value}}
	default:
		t.Fatalf("unsupported chat payload %T", payload)
	}
	ctx, cancel := connectContext(t)
	defer cancel()
	if err := writeClientFrame(ctx, session.conn, frame); err != nil {
		t.Fatalf("write chat request: %v", err)
	}
	for {
		reply := waitFrame(t, session)
		if reply.GetReplyTo() == requestID {
			return reply
		}
	}
}

func channelTarget(id uint64) *rostalkv1.ChatTarget {
	return &rostalkv1.ChatTarget{Target: &rostalkv1.ChatTarget_ChannelId{ChannelId: id}}
}

func TestChatMessagesHistoryAndPermissions(t *testing.T) {
	app := newTestApp(t, nil)
	channelID := chatChannel(t, app)
	admin := connectAdmin(t, app)
	member := connectAs(t, app, roles.MemberName, "member")
	guest := connectAs(t, app, roles.GuestName, "guest")

	requestID := uint64(10)
	send := func(session *testSession, body string) *rostalkv1.ServerFrame {
		requestID++
		return sendChat(t, session, requestID, &rostalkv1.ChatSend{
			Target: channelTarget(channelID),
			Body:   body,
		})
	}

	first := send(admin, "hello from the admin")
	if serverErr := first.GetError(); serverErr != nil {
		t.Fatalf("admin send failed: %s: %s", serverErr.GetCode(), serverErr.GetMessage())
	}
	stored := first.GetMessage()
	if stored == nil || stored.GetChannelId() != channelID || stored.GetBody() != "hello from the admin" {
		t.Fatalf("unexpected stored message: %+v", stored)
	}

	// A guest has view_channel but no send_messages.
	denied := send(guest, "guest should not write")
	if denied.GetError().GetCode() != rostalkv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatalf("guest send = %v, want PERMISSION_DENIED", denied.GetError())
	}

	// The member does have send_messages after the 4.1 role migration.
	var memberMessage *rostalkv1.Message
	for index := 0; index < 3; index++ {
		reply := send(member, fmt.Sprintf("member %d", index))
		if reply.GetError() != nil {
			t.Fatalf("member send %d: %v", index, reply.GetError())
		}
		memberMessage = reply.GetMessage()
	}

	requestID++
	historyReply := sendChat(t, member, requestID, &rostalkv1.ChatHistoryRequest{
		Target: channelTarget(channelID),
		Limit:  2,
	})
	page := historyReply.GetChatHistory()
	if page == nil || len(page.GetMessages()) != 2 || !page.GetHasMore() || page.GetNextCursor() == "" {
		t.Fatalf("unexpected newest page: %+v", page)
	}
	if page.GetMessages()[1].GetBody() != "member 2" {
		t.Fatalf("newest page is not in ascending order: %+v", page.GetMessages())
	}

	requestID++
	olderReply := sendChat(t, member, requestID, &rostalkv1.ChatHistoryRequest{
		Target: channelTarget(channelID),
		Limit:  2,
		Cursor: page.GetNextCursor(),
	})
	older := olderReply.GetChatHistory()
	if older == nil || len(older.GetMessages()) != 2 || older.GetMessages()[1].GetBody() != "member 0" {
		t.Fatalf("unexpected older page: %+v", older)
	}

	// A cursor is bound to its conversation.
	requestID++
	peer := &rostalkv1.ChatTarget{Target: &rostalkv1.ChatTarget_PeerUserId{PeerUserId: admin.welcome.GetSelfUserId()}}
	badCursor := sendChat(t, member, requestID, &rostalkv1.ChatHistoryRequest{
		Target: peer,
		Limit:  2,
		Cursor: page.GetNextCursor(),
	})
	if badCursor.GetError().GetCode() != rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST {
		t.Fatalf("foreign cursor = %v, want INVALID_REQUEST", badCursor.GetError())
	}

	// A member that connects after the burst sees the unread counters in the
	// snapshot: the history is not replayed, only the counters are sent.
	late := connectAs(t, app, roles.MemberName, "late-reader")
	unread := unreadForChannel(late.welcome.GetSnapshot(), channelID)
	if unread == nil || unread.GetUnread() < 4 {
		t.Fatalf("late member unread = %+v", unread)
	}

	// Editing is limited to the author; manage_messages only moderates and
	// deletes (ADR 0025).
	requestID++
	edit := sendChat(t, admin, requestID, &rostalkv1.EditMessage{
		MessageId: stored.GetId(),
		Body:      "edited by the admin",
	})
	if edit.GetError() != nil || edit.GetMessage().GetBody() != "edited by the admin" {
		t.Fatalf("admin edit failed: %v %+v", edit.GetError(), edit.GetMessage())
	}
	requestID++
	foreignEdit := sendChat(t, member, requestID, &rostalkv1.EditMessage{
		MessageId: stored.GetId(),
		Body:      "hijack",
	})
	if foreignEdit.GetError().GetCode() != rostalkv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatalf("member foreign edit = %v, want PERMISSION_DENIED", foreignEdit.GetError())
	}
	// The admin holds manage_messages; that still does not allow editing a
	// member's message, but it does allow deleting it.
	requestID++
	moderatedEdit := sendChat(t, admin, requestID, &rostalkv1.EditMessage{
		MessageId: memberMessage.GetId(),
		Body:      "words in someone else's name",
	})
	if moderatedEdit.GetError().GetCode() != rostalkv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatalf("moderator foreign edit = %v, want PERMISSION_DENIED", moderatedEdit.GetError())
	}
	requestID++
	moderatedDelete := sendChat(t, admin, requestID, &rostalkv1.DeleteMessage{
		MessageId: memberMessage.GetId(),
	})
	if moderatedDelete.GetError() != nil {
		t.Fatalf("moderator delete failed: %v", moderatedDelete.GetError())
	}
}

func TestChatRateLimit(t *testing.T) {
	app := newTestApp(t, nil)
	channelID := chatChannel(t, app)
	member := connectAs(t, app, roles.MemberName, "fast")

	var last *rostalkv1.ServerFrame
	for index := 0; index < 6; index++ {
		last = sendChat(t, member, uint64(20+index), &rostalkv1.ChatSend{
			Target: channelTarget(channelID),
			Body:   fmt.Sprintf("burst %d", index),
		})
	}
	if last.GetError().GetCode() != rostalkv1.ErrorCode_ERROR_CODE_RATE_LIMITED {
		t.Fatalf("sixth message = %v, want RATE_LIMITED", last.GetError())
	}
}

func TestChatAttachmentsOverHTTPS(t *testing.T) {
	app := newTestApp(t, nil)
	channelID := chatChannel(t, app)
	admin := connectAdmin(t, app)
	member := connectAs(t, app, roles.MemberName, "reader")

	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}}
	base := "https://" + app.Addr().String()

	pngBytes := testPNG(t)
	upload := func(token, name string, body []byte) *http.Response {
		request, err := http.NewRequest(http.MethodPost,
			fmt.Sprintf("%s/api/v1/chat/attachments?channelId=%d&name=%s", base, channelID, name),
			bytes.NewReader(body))
		if err != nil {
			t.Fatalf("new upload request: %v", err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/octet-stream")
		response, err := client.Do(request)
		if err != nil {
			t.Fatalf("upload: %v", err)
		}
		return response
	}

	response := upload(admin.welcome.GetHttpToken(), "cat.png", pngBytes)
	if response.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("upload status = %d: %s", response.StatusCode, body)
	}
	var created struct {
		Attachment struct {
			ID          uint64 `json:"id"`
			ContentType string `json:"contentType"`
			Image       bool   `json:"image"`
			FileName    string `json:"fileName"`
		} `json:"attachment"`
	}
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatalf("decode upload: %v", err)
	}
	_ = response.Body.Close()
	if created.Attachment.ID == 0 || created.Attachment.ContentType != "image/png" || !created.Attachment.Image {
		t.Fatalf("unexpected attachment: %+v", created.Attachment)
	}

	// HTML is rejected whatever the name says.
	html := upload(admin.welcome.GetHttpToken(), "page.png", []byte("<html><script>alert(1)</script></html>"))
	_ = html.Body.Close()
	if html.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("html upload status = %d, want 415", html.StatusCode)
	}

	// A guest has no attach_files.
	guest := connectAs(t, app, roles.GuestName, "guest-upload")
	denied := upload(guest.welcome.GetHttpToken(), "x.png", pngBytes)
	_ = denied.Body.Close()
	if denied.StatusCode != http.StatusForbidden {
		t.Fatalf("guest upload status = %d, want 403", denied.StatusCode)
	}

	// Send the attachment and read it back with another member's token.
	reply := sendChat(t, admin, 40, &rostalkv1.ChatSend{
		Target:        channelTarget(channelID),
		AttachmentIds: []uint64{created.Attachment.ID},
	})
	if reply.GetError() != nil {
		t.Fatalf("send with attachment: %v", reply.GetError())
	}

	get, err := http.NewRequest(http.MethodGet,
		fmt.Sprintf("%s/api/v1/chat/attachments/%d", base, created.Attachment.ID), nil)
	if err != nil {
		t.Fatalf("new attachment request: %v", err)
	}
	get.Header.Set("Authorization", "Bearer "+member.welcome.GetHttpToken())
	file, err := client.Do(get)
	if err != nil {
		t.Fatalf("get attachment: %v", err)
	}
	defer func() { _ = file.Body.Close() }()
	if file.StatusCode != http.StatusOK {
		t.Fatalf("attachment status = %d", file.StatusCode)
	}
	if file.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("attachment content type = %q", file.Header.Get("Content-Type"))
	}
	if file.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("attachment is missing nosniff")
	}
	if !strings.HasPrefix(file.Header.Get("Content-Disposition"), "inline") {
		t.Fatalf("image disposition = %q, want inline", file.Header.Get("Content-Disposition"))
	}

	// An API token acts as a role, not as a user, and may not read chat.
	memberRole := roleIDForTest(admin.welcome.GetSnapshot(), roles.MemberName)
	tokenReply := requireAdminOK(t, sendAdmin(t, admin, 41, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_ApiTokenCreate{ApiTokenCreate: &rostalkv1.ApiTokenCreate{
			Name:   "chat-probe",
			RoleId: memberRole,
		}},
	}))
	apiRequest, err := http.NewRequest(http.MethodGet,
		fmt.Sprintf("%s/api/v1/chat/history?channelId=%d", base, channelID), nil)
	if err != nil {
		t.Fatalf("new api-token request: %v", err)
	}
	apiRequest.Header.Set("Authorization", "Bearer "+tokenReply.GetApiToken().GetToken())
	apiResponse, err := client.Do(apiRequest)
	if err != nil {
		t.Fatalf("api-token history: %v", err)
	}
	_ = apiResponse.Body.Close()
	if apiResponse.StatusCode != http.StatusForbidden {
		t.Fatalf("api token history status = %d, want 403", apiResponse.StatusCode)
	}

	// The same conversation is exportable as JSON Lines.
	exportRequest, err := http.NewRequest(http.MethodGet,
		fmt.Sprintf("%s/api/v1/chat/export?channelId=%d", base, channelID), nil)
	if err != nil {
		t.Fatalf("new export request: %v", err)
	}
	exportRequest.Header.Set("Authorization", "Bearer "+member.welcome.GetHttpToken())
	exported, err := client.Do(exportRequest)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	exportedBody, _ := io.ReadAll(exported.Body)
	_ = exported.Body.Close()
	if exported.StatusCode != http.StatusOK || !bytes.Contains(exportedBody, []byte(`"channelId"`)) {
		t.Fatalf("export status %d body %s", exported.StatusCode, exportedBody)
	}

	// Without a token the attachment is invisible.
	anonymous, err := client.Get(fmt.Sprintf("%s/api/v1/chat/attachments/%d", base, created.Attachment.ID))
	if err == nil {
		_ = anonymous.Body.Close()
		if anonymous.StatusCode != http.StatusUnauthorized {
			t.Fatalf("anonymous attachment status = %d, want 401", anonymous.StatusCode)
		}
	}
}

// TestAttachmentMediaAndArchiveHTTP covers the wire behaviour added in stage
// P3: video is playable inline and supports Range (seeking), while archives are
// always a download. HTML and SVG stay rejected at the same endpoint.
func TestAttachmentMediaAndArchiveHTTP(t *testing.T) {
	app := newTestApp(t, nil)
	channelID := chatChannel(t, app)
	member := connectAs(t, app, roles.MemberName, "media-reader")

	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}}
	base := "https://" + app.Addr().String()

	mp4 := make([]byte, 4096)
	mp4[3] = 0x18 // box size 24, big endian
	copy(mp4[4:], "ftypmp42")
	copy(mp4[16:], "mp41")
	zipBytes := append([]byte("PK\x03\x04"), bytes.Repeat([]byte{0}, 512)...)

	upload := func(name string, body []byte) (uint64, string) {
		request, err := http.NewRequest(http.MethodPost,
			fmt.Sprintf("%s/api/v1/chat/attachments?channelId=%d&name=%s", base, channelID, name),
			bytes.NewReader(body))
		if err != nil {
			t.Fatalf("new upload request: %v", err)
		}
		request.Header.Set("Authorization", "Bearer "+member.welcome.GetHttpToken())
		request.Header.Set("Content-Type", "application/octet-stream")
		response, err := client.Do(request)
		if err != nil {
			t.Fatalf("upload %s: %v", name, err)
		}
		defer func() { _ = response.Body.Close() }()
		if response.StatusCode != http.StatusCreated {
			payload, _ := io.ReadAll(response.Body)
			t.Fatalf("upload %s status = %d: %s", name, response.StatusCode, payload)
		}
		var created struct {
			Attachment struct {
				ID          uint64 `json:"id"`
				ContentType string `json:"contentType"`
			} `json:"attachment"`
		}
		if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
			t.Fatalf("decode upload %s: %v", name, err)
		}
		return created.Attachment.ID, created.Attachment.ContentType
	}

	videoID, videoType := upload("clip.mp4", mp4)
	if videoType != "video/mp4" {
		t.Fatalf("video content type = %q", videoType)
	}
	archiveID, archiveType := upload("pack.zip", zipBytes)
	if archiveType != "application/zip" {
		t.Fatalf("archive content type = %q", archiveType)
	}
	reply := sendChat(t, member, 70, &rostalkv1.ChatSend{
		Target:        channelTarget(channelID),
		AttachmentIds: []uint64{videoID, archiveID},
	})
	if reply.GetError() != nil {
		t.Fatalf("send with media: %v", reply.GetError())
	}

	get := func(id uint64, rangeHeader string) *http.Response {
		request, err := http.NewRequest(http.MethodGet,
			fmt.Sprintf("%s/api/v1/chat/attachments/%d", base, id), nil)
		if err != nil {
			t.Fatalf("new get request: %v", err)
		}
		request.Header.Set("Authorization", "Bearer "+member.welcome.GetHttpToken())
		if rangeHeader != "" {
			request.Header.Set("Range", rangeHeader)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatalf("get attachment %d: %v", id, err)
		}
		return response
	}

	video := get(videoID, "")
	videoBody, _ := io.ReadAll(video.Body)
	_ = video.Body.Close()
	if video.StatusCode != http.StatusOK || len(videoBody) != len(mp4) {
		t.Fatalf("video status %d, %d bytes", video.StatusCode, len(videoBody))
	}
	if disposition := video.Header.Get("Content-Disposition"); !strings.HasPrefix(disposition, "inline") {
		t.Fatalf("video disposition = %q, want inline", disposition)
	}
	if ranges := video.Header.Get("Accept-Ranges"); ranges != "bytes" {
		t.Fatalf("video accept-ranges = %q, want bytes", ranges)
	}

	// Range is what makes seeking in <video> work; http.ServeContent answers
	// 206 with the requested slice.
	partial := get(videoID, "bytes=16-31")
	partialBody, _ := io.ReadAll(partial.Body)
	_ = partial.Body.Close()
	if partial.StatusCode != http.StatusPartialContent {
		t.Fatalf("range status = %d, want 206", partial.StatusCode)
	}
	if got := partial.Header.Get("Content-Range"); got != fmt.Sprintf("bytes 16-31/%d", len(mp4)) {
		t.Fatalf("content-range = %q", got)
	}
	if !bytes.Equal(partialBody, mp4[16:32]) {
		t.Fatalf("range body = %d bytes, want the 16 requested", len(partialBody))
	}

	archive := get(archiveID, "")
	_ = archive.Body.Close()
	if disposition := archive.Header.Get("Content-Disposition"); !strings.HasPrefix(disposition, "attachment") {
		t.Fatalf("archive disposition = %q, want attachment", disposition)
	}
	if archive.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("archive is missing nosniff")
	}
}

func TestChatExportPermissions(t *testing.T) {
	app := newTestApp(t, nil)
	channelID := chatChannel(t, app)
	admin := connectAdmin(t, app)
	member := connectAs(t, app, roles.MemberName, "exporter")
	guest := connectAs(t, app, roles.GuestName, "export-guest")

	reply := sendChat(t, admin, 60, &rostalkv1.ChatSend{
		Target: channelTarget(channelID),
		Body:   "export me",
	})
	if reply.GetError() != nil {
		t.Fatalf("send before export: %v", reply.GetError())
	}

	guestRole := roleIDForTest(admin.welcome.GetSnapshot(), roles.GuestName)
	requireAdminOK(t, sendAdmin(t, admin, 61, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_ChannelOverrideSet{
			ChannelOverrideSet: &rostalkv1.ChannelOverrideSet{
				ChannelId: channelID,
				RoleId:    guestRole,
				Deny: &rostalkv1.PermissionSet{
					Permissions: []rostalkv1.Permission{rostalkv1.Permission_PERMISSION_VIEW_CHANNEL},
				},
			},
		},
	}))

	base := "https://" + app.Addr().String()
	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}}
	export := func(token, query string) (int, []byte) {
		t.Helper()
		request, err := http.NewRequest(http.MethodGet, base+"/api/v1/chat/export?"+query, nil)
		if err != nil {
			t.Fatalf("new export request: %v", err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := client.Do(request)
		if err != nil {
			t.Fatalf("export %s: %v", query, err)
		}
		defer func() { _ = response.Body.Close() }()
		body, _ := io.ReadAll(response.Body)
		return response.StatusCode, body
	}

	// Denied view_channel must be a 404 before the streaming 200 starts.
	if status, body := export(guest.welcome.GetHttpToken(), fmt.Sprintf("channelId=%d", channelID)); status != http.StatusNotFound {
		t.Fatalf("guest export status = %d (%s), want 404", status, body)
	}

	status, body := export(member.welcome.GetHttpToken(), fmt.Sprintf("channelId=%d", channelID))
	if status != http.StatusOK {
		t.Fatalf("member export status = %d (%s), want 200", status, body)
	}
	if !bytes.Contains(body, []byte(`"channelId":`+fmt.Sprint(channelID))) ||
		!bytes.Contains(body, []byte("export me")) {
		t.Fatalf("export body does not contain the message: %s", body)
	}

	// A direct conversation with the caller and with an unknown user is 404.
	if status, _ := export(member.welcome.GetHttpToken(),
		fmt.Sprintf("peerId=%d", member.welcome.GetSelfUserId())); status != http.StatusNotFound {
		t.Fatalf("self direct export status = %d, want 404", status)
	}
	if status, _ := export(member.welcome.GetHttpToken(), "peerId=999999"); status != http.StatusNotFound {
		t.Fatalf("unknown direct export status = %d, want 404", status)
	}
}

func roleIDForTest(snapshot *rostalkv1.ServerSnapshot, name string) uint64 {
	for _, role := range snapshot.GetRoles() {
		if role.GetName() == name {
			return role.GetId()
		}
	}
	return 0
}

func unreadForChannel(snapshot *rostalkv1.ServerSnapshot, channelID uint64) *rostalkv1.UnreadCounter {
	for _, counter := range snapshot.GetUnread().GetConversations() {
		if counter.GetChannelId() == channelID {
			return counter
		}
	}
	return nil
}

func testPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	for x := 0; x < 2; x++ {
		for y := 0; y < 2; y++ {
			img.Set(x, y, color.RGBA{G: 255, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buffer.Bytes()
}
