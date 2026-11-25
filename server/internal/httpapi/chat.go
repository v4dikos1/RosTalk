package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"strconv"

	"github.com/v4dikos1/RosTalk/server/internal/chat"
)

// The chat endpoints are the HTTP half of stage 4.1. The WebView never calls
// them directly: the Rust core runs a loopback proxy pinned to the server
// certificate and adds the session bearer token, so a self-signed certificate
// and the token stay out of the page (design 4.3, ADR 0022).

// requireChatUser authenticates a request and rejects role-only API tokens:
// messages belong to a user, not to a role.
func (s *Server) requireChatUser(r *http.Request) (principal, *apiError) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		return principal{}, authErr
	}
	if p.userID == 0 {
		return principal{}, &apiError{
			status:  http.StatusForbidden,
			code:    "permission_denied",
			message: "chat requires an authenticated user session",
		}
	}
	return p, nil
}

func conversationFromQuery(r *http.Request) (chat.Conversation, *apiError) {
	query := r.URL.Query()
	rawChannel := query.Get("channelId")
	rawPeer := query.Get("peerId")
	if (rawChannel == "") == (rawPeer == "") {
		return chat.Conversation{}, &apiError{
			status:  http.StatusBadRequest,
			code:    "invalid_request",
			message: "exactly one of channelId or peerId is required",
		}
	}
	if rawChannel != "" {
		channelID, err := strconv.ParseUint(rawChannel, 10, 64)
		if err != nil || channelID == 0 {
			return chat.Conversation{}, &apiError{status: http.StatusBadRequest, code: "invalid_request", message: "channelId must be a positive integer"}
		}
		return chat.Conversation{ChannelID: channelID}, nil
	}
	peerID, err := strconv.ParseInt(rawPeer, 10, 64)
	if err != nil || peerID <= 0 {
		return chat.Conversation{}, &apiError{status: http.StatusBadRequest, code: "invalid_request", message: "peerId must be a positive integer"}
	}
	return chat.Conversation{PeerID: peerID}, nil
}

func (s *Server) handleChatHistory(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.requireChatUser(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	conversation, convErr := conversationFromQuery(r)
	if convErr != nil {
		writeAPIError(w, convErr)
		return
	}
	limit, _ := strconv.ParseUint(r.URL.Query().Get("limit"), 10, 32)
	messages, next, hasMore, err := s.chat.History(r.Context(), p.userID, conversation, r.URL.Query().Get("cursor"), uint32(limit))
	if err != nil {
		writeChatError(w, err)
		return
	}
	out := make([]messageJSON, 0, len(messages))
	for _, message := range messages {
		out = append(out, messageToJSON(message))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"messages":   out,
		"nextCursor": next,
		"hasMore":    hasMore,
	})
}

// handleChatExport streams the whole conversation as JSON Lines. It walks the
// history in batches, so exporting a long channel does not block the server or
// load everything into memory.
func (s *Server) handleChatExport(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.requireChatUser(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	conversation, convErr := conversationFromQuery(r)
	if convErr != nil {
		writeAPIError(w, convErr)
		return
	}
	// The export streams after a 200, so authorization must succeed before the
	// first header is written. Export repeats the check for direct callers.
	if err := s.chat.CheckView(r.Context(), p.userID, conversation); err != nil {
		writeChatError(w, err)
		return
	}
	name := fmt.Sprintf("channel-%d", conversation.ChannelID)
	if conversation.IsDM() {
		name = fmt.Sprintf("dm-%d", conversation.PeerID)
	}
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="rostalk-%s-%s.jsonl"`,
		name, s.now().UTC().Format("20060102-150405")))
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	encoder := json.NewEncoder(w)
	written := 0
	err := s.chat.Export(r.Context(), p.userID, conversation, func(message chat.Message) error {
		if err := encoder.Encode(messageToJSON(message)); err != nil {
			return err
		}
		written++
		if written%50 == 0 && flusher != nil {
			flusher.Flush()
		}
		return nil
	})
	if err != nil {
		// The status is already sent; a truncated export is visible to the
		// client and the reason is logged without message content.
		s.logger.Warn("chat export stopped", "user_id", p.userID, "error", err)
	}
	if flusher != nil {
		flusher.Flush()
	}
}

func (s *Server) handleAttachmentUpload(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.requireChatUser(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	conversation, convErr := conversationFromQuery(r)
	if convErr != nil {
		writeAPIError(w, convErr)
		return
	}
	maxFile := s.chat.MaxAttachmentBytes()
	r.Body = http.MaxBytesReader(w, r.Body, maxFile+1)
	attachment, err := s.chat.Upload(r.Context(), p.userID, conversation, r.URL.Query().Get("name"), r.Body)
	if err != nil {
		writeChatError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"attachment": attachmentToJSON(attachment)})
}

func (s *Server) handleAttachmentGet(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.requireChatUser(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	id, parseErr := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if parseErr != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "invalid_request", "the id must be a positive integer")
		return
	}
	attachment, path, err := s.chat.Open(r.Context(), p.userID, id)
	if err != nil {
		writeChatError(w, err)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, "not_found", "the attachment is gone")
			return
		}
		s.logger.Error("could not open an attachment", "attachment_id", id, "error", err)
		writeError(w, http.StatusInternalServerError, "internal", "the attachment could not be read")
		return
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		s.logger.Error("could not stat an attachment", "attachment_id", id, "error", err)
		writeError(w, http.StatusInternalServerError, "internal", "the attachment could not be read")
		return
	}

	disposition := "attachment"
	if chat.IsInlineType(attachment.ContentType) {
		// Raster images, video and audio may render inline: the message shows
		// them with <img> or a media player. Content sniffing at upload and
		// nosniff here make sure the browser never reinterprets the bytes.
		// Archives, PDF, text and anything else stay downloads.
		disposition = "inline"
	}
	value := mime.FormatMediaType(disposition, map[string]string{"filename": attachment.FileName})
	if value == "" {
		value = disposition
	}
	w.Header().Set("Content-Type", attachment.ContentType)
	w.Header().Set("Content-Disposition", value)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cache-Control", "private, max-age=300")
	http.ServeContent(w, r, "", info.ModTime(), file)
}

// ---------------------------------------------------------------- json ---

type attachmentJSON struct {
	ID          uint64 `json:"id"`
	FileName    string `json:"fileName"`
	ContentType string `json:"contentType"`
	SizeBytes   uint64 `json:"sizeBytes"`
	Width       uint32 `json:"width"`
	Height      uint32 `json:"height"`
	Image       bool   `json:"image"`
}

type messageJSON struct {
	ID              uint64           `json:"id"`
	ChannelID       uint64           `json:"channelId"`
	SenderID        uint64           `json:"senderId"`
	RecipientID     uint64           `json:"recipientId"`
	SenderNickname  string           `json:"senderNickname"`
	Body            string           `json:"body"`
	CreatedAtUnixMs int64            `json:"createdAtUnixMs"`
	EditedAtUnixMs  int64            `json:"editedAtUnixMs"`
	Attachments     []attachmentJSON `json:"attachments"`
	MentionUserIDs  []uint64         `json:"mentionUserIds"`
}

func messageToJSON(message chat.Message) messageJSON {
	out := messageJSON{
		ID:              uint64(message.ID),
		ChannelID:       message.ChannelID,
		SenderID:        uint64(message.SenderID),
		SenderNickname:  message.SenderNickname,
		Body:            message.Body,
		CreatedAtUnixMs: message.CreatedAt,
		EditedAtUnixMs:  message.EditedAt,
		RecipientID:     uint64(message.RecipientID),
		Attachments:     make([]attachmentJSON, 0, len(message.Attachments)),
		MentionUserIDs:  make([]uint64, 0, len(message.MentionIDs)),
	}
	for _, attachment := range message.Attachments {
		out.Attachments = append(out.Attachments, attachmentToJSON(attachment))
	}
	for _, id := range message.MentionIDs {
		if id > 0 {
			out.MentionUserIDs = append(out.MentionUserIDs, uint64(id))
		}
	}
	return out
}

func attachmentToJSON(attachment chat.Attachment) attachmentJSON {
	return attachmentJSON{
		ID:          uint64(attachment.ID),
		FileName:    attachment.FileName,
		ContentType: attachment.ContentType,
		SizeBytes:   uint64(attachment.SizeBytes),
		Width:       uint32(attachment.Width),
		Height:      uint32(attachment.Height),
		Image:       attachment.Image,
	}
}

func writeChatError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, chat.ErrNotFound), errors.Is(err, chat.ErrInvalidTarget):
		writeError(w, http.StatusNotFound, "not_found", "the message or conversation does not exist")
	case errors.Is(err, chat.ErrPermissionDenied):
		writeError(w, http.StatusForbidden, "permission_denied", "you may not do that here")
	case errors.Is(err, chat.ErrRateLimited):
		writeError(w, http.StatusTooManyRequests, "rate_limited", "you are sending messages too quickly")
	case errors.Is(err, chat.ErrUploadTooLarge), errors.Is(err, io.ErrUnexpectedEOF):
		writeError(w, http.StatusRequestEntityTooLarge, "file_too_large", "the file is larger than the allowed size")
	case errors.Is(err, chat.ErrQuotaExceeded):
		writeError(w, http.StatusInsufficientStorage, "quota_exceeded", "the server attachment quota is exhausted")
	case errors.Is(err, chat.ErrUnsupportedType):
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_type", "this file type is not allowed")
	case errors.Is(err, chat.ErrEmptyBody), errors.Is(err, chat.ErrBodyTooLong),
		errors.Is(err, chat.ErrTooManyAttachments), errors.Is(err, chat.ErrAttachmentInvalid),
		errors.Is(err, chat.ErrInvalidCursor):
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "internal", "the request could not be completed")
	}
}
