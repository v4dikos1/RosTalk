package httpapi

import (
	"context"
	"errors"
	"net/http"
	"os"

	"github.com/v4dikos1/RosTalk/server/internal/avatars"
	"github.com/v4dikos1/RosTalk/server/internal/perms"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

// Avatars are user pictures (stage P11). The owner sets and removes their own
// picture with a user session token; an administrator may reset someone else's.
// The service decodes and re-encodes the bytes, so the endpoints accept only a
// PNG, JPEG, WebP or GIF body and never a file name.

func (s *Server) handleAvatarSet(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.requireChatUser(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, avatars.MaxBytes+1)
	hash, err := s.avatars.Set(r.Context(), p.userID, r.Body)
	if err != nil {
		writeAvatarError(w, err)
		return
	}
	s.auditAvatar(r.Context(), p, "avatar.update", p.userID, "sha256="+hash)
	writeJSON(w, http.StatusOK, map[string]any{"avatarHash": hash})
}

func (s *Server) handleAvatarClear(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.requireChatUser(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	if err := s.avatars.Clear(r.Context(), p.userID); err != nil {
		writeAvatarError(w, err)
		return
	}
	s.auditAvatar(r.Context(), p, "avatar.clear", p.userID, "")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAvatarGet(w http.ResponseWriter, r *http.Request) {
	if _, authErr := s.requireChatUser(r); authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	avatar, err := s.avatars.Open(r.Context(), r.PathValue("hash"))
	if err != nil {
		writeAvatarError(w, err)
		return
	}
	file, err := os.Open(avatar.Path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, "not_found", "the avatar is gone")
			return
		}
		s.logger.Error("could not open an avatar", "error", err)
		writeError(w, http.StatusInternalServerError, "internal", "the avatar could not be read")
		return
	}
	defer func() { _ = file.Close() }()

	// The name is the content hash: these bytes never change for this URL, so
	// the client and the core's loopback proxy may keep them indefinitely.
	w.Header().Set("Content-Type", avatar.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", `"`+avatar.Hash+`"`)
	http.ServeContent(w, r, "", avatar.ModTime, file)
}

// handleMemberAvatarReset lets an administrator remove another user's picture.
// The target may be offline: the database is the source of the hash.
func (s *Server) handleMemberAvatarReset(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	if !perms.HasManageServer(p.subject) {
		writeError(w, http.StatusForbidden, "permission_denied", "you may not reset another user's avatar")
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := s.avatars.Clear(r.Context(), int64(id)); err != nil {
		writeAvatarError(w, err)
		return
	}
	s.auditAvatar(r.Context(), p, "member.avatar_reset", int64(id), "")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) auditAvatar(ctx context.Context, p principal, action string, targetUser int64, details string) {
	if _, err := s.store.AddAuditEntry(ctx, store.AuditOptions{
		ActorID:      p.userID,
		ActorName:    p.actorName,
		Action:       action,
		TargetUserID: targetUser,
		Details:      details,
	}); err != nil {
		s.logger.Error("could not write the audit log", "action", action, "error", err)
	}
}

func writeAvatarError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge), errors.Is(err, avatars.ErrTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "file_too_large", "the picture is larger than 4 MiB")
	case errors.Is(err, avatars.ErrUnsupportedType):
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_type", "only PNG, JPEG, WebP and GIF are accepted")
	case errors.Is(err, avatars.ErrInvalidImage):
		writeError(w, http.StatusBadRequest, "invalid_image", "the picture could not be decoded")
	case errors.Is(err, avatars.ErrRateLimited):
		writeError(w, http.StatusTooManyRequests, "rate_limited", "you are changing the avatar too often")
	case errors.Is(err, avatars.ErrNotFound), errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "the avatar does not exist")
	default:
		writeError(w, http.StatusInternalServerError, "internal", "the avatar could not be stored")
	}
}
