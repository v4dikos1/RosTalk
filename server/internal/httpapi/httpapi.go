// Package httpapi serves /api/v1 with bearer tokens (stage 3.2, design 4.4).
//
// A token acts as exactly one role. Authentication reads api_tokens on every
// request, so revocation and expiry take effect immediately; permission checks
// reuse internal/perms and internal/roles through control.Plane.Apply instead of
// duplicating the rules. The package never logs or returns a token: the
// plaintext appears only in the 201 reply to POST /api/v1/tokens.
package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/avatars"
	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/chat"
	"github.com/v4dikos1/RosTalk/server/internal/control"
	"github.com/v4dikos1/RosTalk/server/internal/perms"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/sessionauth"
	"github.com/v4dikos1/RosTalk/server/internal/state"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

// maxBodySize bounds a JSON request. Every body is a small object.
const maxBodySize = 1 << 20

// Config wires the API.
type Config struct {
	Plane   *control.Plane
	Store   *store.Store
	Chat    *chat.Service
	Avatars *avatars.Service
	Logger  *slog.Logger
	// Sessions resolves the chat HTTP bearer tokens issued in Welcome. The
	// WebView never sees them: the core's loopback proxy adds the header.
	Sessions *sessionauth.Registry
	// Now overrides the clock in tests.
	Now func() time.Time
}

// Server implements http.Handler.
type Server struct {
	plane    *control.Plane
	store    *store.Store
	chat     *chat.Service
	avatars  *avatars.Service
	sessions *sessionauth.Registry
	logger   *slog.Logger
	now      func() time.Time
	mux      *http.ServeMux
}

// New validates the wiring and builds the router.
func New(cfg Config) (*Server, error) {
	if cfg.Plane == nil || cfg.Store == nil {
		return nil, errors.New("httpapi: control plane and store are required")
	}
	if cfg.Chat == nil {
		return nil, errors.New("httpapi: chat service is required")
	}
	if cfg.Avatars == nil {
		return nil, errors.New("httpapi: avatar service is required")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	s := &Server{
		plane:    cfg.Plane,
		store:    cfg.Store,
		chat:     cfg.Chat,
		avatars:  cfg.Avatars,
		sessions: cfg.Sessions,
		logger:   logger,
		now:      now,
		mux:      http.NewServeMux(),
	}
	s.routes()
	return s, nil
}

// Handler returns the router.
func (s *Server) Handler() http.Handler { return s.mux }

func (s *Server) routes() {
	s.mux.HandleFunc("GET /api/v1/users", s.handleUsers)
	s.mux.HandleFunc("GET /api/v1/channels", s.handleChannels)
	s.mux.HandleFunc("GET /api/v1/invites", s.handleInviteList)
	s.mux.HandleFunc("POST /api/v1/invites", s.handleInviteCreate)
	s.mux.HandleFunc("DELETE /api/v1/invites/{id}", s.handleInviteRevoke)
	s.mux.HandleFunc("POST /api/v1/members/{id}/kick", s.handleKick)
	s.mux.HandleFunc("POST /api/v1/members/{id}/ban", s.handleBan)
	s.mux.HandleFunc("DELETE /api/v1/members/{id}/ban", s.handleUnbanUser)
	s.mux.HandleFunc("POST /api/v1/members/{id}/move", s.handleMove)
	s.mux.HandleFunc("GET /api/v1/bans", s.handleBanList)
	s.mux.HandleFunc("DELETE /api/v1/bans/ip/{ip}", s.handleUnbanIP)
	s.mux.HandleFunc("GET /api/v1/audit", s.handleAudit)
	s.mux.HandleFunc("GET /api/v1/tokens", s.handleTokenList)
	s.mux.HandleFunc("POST /api/v1/tokens", s.handleTokenCreate)
	s.mux.HandleFunc("DELETE /api/v1/tokens/{id}", s.handleTokenRevoke)
	s.mux.HandleFunc("GET /api/v1/chat/history", s.handleChatHistory)
	s.mux.HandleFunc("GET /api/v1/chat/export", s.handleChatExport)
	s.mux.HandleFunc("POST /api/v1/chat/attachments", s.handleAttachmentUpload)
	s.mux.HandleFunc("GET /api/v1/chat/attachments/{id}", s.handleAttachmentGet)
	s.mux.HandleFunc("PUT /api/v1/avatars/me", s.handleAvatarSet)
	s.mux.HandleFunc("DELETE /api/v1/avatars/me", s.handleAvatarClear)
	s.mux.HandleFunc("GET /api/v1/avatars/{hash}", s.handleAvatarGet)
	s.mux.HandleFunc("DELETE /api/v1/members/{id}/avatar", s.handleMemberAvatarReset)
	s.mux.HandleFunc("/api/v1/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "the endpoint does not exist")
	})
}

// principal is an authenticated API caller.
type principal struct {
	token     store.APIToken
	subject   perms.Subject
	actorName string
	// userID is set when the caller used a control-plane session token. Chat
	// endpoints require a real user; API tokens act as a role.
	userID int64
}

func (s *Server) authenticate(r *http.Request) (principal, *apiError) {
	header := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return principal{}, &apiError{status: http.StatusUnauthorized, code: "unauthenticated", message: "a bearer token is required"}
	}
	plaintext := strings.TrimSpace(strings.TrimPrefix(header, prefix))
	// A chat session token identifies a real user and is checked first. An
	// API token never reaches the chat endpoints (they need a user).
	if s.sessions != nil {
		if userID, err := s.sessions.Lookup(plaintext); err == nil {
			return principal{
				userID:    userID,
				subject:   s.plane.SubjectForUser(userID),
				actorName: "session",
			}, nil
		}
	}
	token, err := s.store.APITokenByToken(r.Context(), plaintext, s.now())
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return principal{}, &apiError{status: http.StatusUnauthorized, code: "unauthenticated", message: "the token is invalid, expired or revoked"}
		}
		s.logger.Error("api token lookup failed", "error", err)
		return principal{}, &apiError{status: http.StatusInternalServerError, code: "internal", message: "the request could not be completed"}
	}
	if token.RoleID == 0 {
		return principal{}, &apiError{status: http.StatusForbidden, code: "permission_denied", message: "the token role no longer exists"}
	}
	subject, ok := s.plane.SubjectForRole(token.RoleID)
	if !ok {
		return principal{}, &apiError{status: http.StatusForbidden, code: "permission_denied", message: "the token role no longer exists"}
	}
	// last_used_at is advisory; a failure must not reject a valid request.
	if token.LastUsedAt == nil || s.now().Sub(*token.LastUsedAt) > time.Minute {
		if err := s.store.TouchAPIToken(r.Context(), token.ID, s.now()); err != nil {
			s.logger.Debug("could not record api token use", "token_id", token.ID, "error", err)
		}
	}
	return principal{token: token, subject: subject, actorName: "api:" + token.Name}, nil
}

type apiError struct {
	status  int
	code    string
	message string
}

func (s *Server) apply(r *http.Request, p principal, action *rostalkv1.AdminAction) (*rostalkv1.AdminResult, *apiError) {
	result, err := s.plane.Apply(r.Context(), p.subject, p.actorName, action)
	if err != nil {
		return nil, s.mapError(err)
	}
	return result, nil
}

func (s *Server) mapError(err error) *apiError {
	switch {
	case errors.Is(err, roles.ErrPermissionDenied):
		return &apiError{status: http.StatusForbidden, code: "permission_denied", message: "the token role may not perform this action"}
	case errors.Is(err, roles.ErrHierarchy):
		return &apiError{status: http.StatusForbidden, code: "hierarchy", message: "the target is not below the token role"}
	case errors.Is(err, store.ErrNotFound), errors.Is(err, roles.ErrNotFound),
		errors.Is(err, channels.ErrNotFound), errors.Is(err, channels.ErrParentNotFound),
		errors.Is(err, state.ErrNotOnline):
		return &apiError{status: http.StatusNotFound, code: "not_found", message: "the object does not exist"}
	case errors.Is(err, control.ErrInvalidRequest), errors.Is(err, roles.ErrInvalidName),
		errors.Is(err, roles.ErrInvalidPosition), errors.Is(err, roles.ErrDuplicateName),
		errors.Is(err, channels.ErrInvalidName), errors.Is(err, channels.ErrInvalidTopic),
		errors.Is(err, channels.ErrInvalidKind), errors.Is(err, channels.ErrInvalidVoiceProfile),
		errors.Is(err, channels.ErrCycle):
		return &apiError{status: http.StatusBadRequest, code: "invalid_request", message: err.Error()}
	case errors.Is(err, roles.ErrBuiltin), errors.Is(err, roles.ErrSelfLockout),
		errors.Is(err, control.ErrChannelOccupied), errors.Is(err, state.ErrChannelFull):
		return &apiError{status: http.StatusConflict, code: "rejected", message: err.Error()}
	default:
		s.logger.Error("api action failed", "error", err)
		return &apiError{status: http.StatusInternalServerError, code: "internal", message: "the request could not be completed"}
	}
}

func (s *Server) handleUsers(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	query := r.URL.Query()
	includeOffline := query.Get("online") != "true"
	result, apiErr := s.apply(r, p, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_MemberList{MemberList: &rostalkv1.MemberListQuery{
			Query:          query.Get("q"),
			IncludeOffline: includeOffline,
		}},
	})
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	users := result.GetUsers().GetUsers()
	out := make([]userJSON, 0, len(users))
	for _, user := range users {
		out = append(out, userToJSON(user))
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

func (s *Server) handleChannels(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	list := s.plane.ChannelsFor(p.subject)
	out := make([]channelJSON, 0, len(list))
	for _, channel := range list {
		out = append(out, channelToJSON(channel))
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": out})
}

func (s *Server) handleInviteList(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	result, apiErr := s.apply(r, p, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_InviteList{InviteList: &rostalkv1.InviteListQuery{
			IncludeInactive: r.URL.Query().Get("include_inactive") == "true",
		}},
	})
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	invites := result.GetInvites().GetInvites()
	out := make([]inviteJSON, 0, len(invites))
	for _, invite := range invites {
		out = append(out, inviteToJSON(invite))
	}
	writeJSON(w, http.StatusOK, map[string]any{"invites": out})
}

func (s *Server) handleInviteCreate(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	var body struct {
		RoleID           uint64 `json:"roleId"`
		MaxUses          uint32 `json:"maxUses"`
		ExpiresInSeconds uint32 `json:"expiresInSeconds"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	result, apiErr := s.apply(r, p, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_InviteCreate{InviteCreate: &rostalkv1.InviteCreate{
			RoleId:           body.RoleID,
			MaxUses:          body.MaxUses,
			ExpiresInSeconds: body.ExpiresInSeconds,
		}},
	})
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"invite": inviteToJSON(result.GetInvite())})
}

func (s *Server) handleInviteRevoke(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if _, apiErr := s.apply(r, p, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_InviteRevoke{InviteRevoke: &rostalkv1.InviteRevoke{InviteId: id}},
	}); apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleKick(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if !decodeOptionalJSON(w, r, &body) {
		return
	}
	if _, apiErr := s.apply(r, p, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_MemberKick{MemberKick: &rostalkv1.MemberKick{
			UserId: id,
			Reason: body.Reason,
		}},
	}); apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleBan(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var body struct {
		Reason           string `json:"reason"`
		ExpiresInSeconds uint32 `json:"expiresInSeconds"`
		ByKey            *bool  `json:"byKey"`
		ByIP             bool   `json:"byIp"`
	}
	if !decodeOptionalJSON(w, r, &body) {
		return
	}
	if _, apiErr := s.apply(r, p, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_MemberBan{MemberBan: &rostalkv1.MemberBan{
			UserId:           id,
			Reason:           body.Reason,
			ExpiresInSeconds: body.ExpiresInSeconds,
			ByIp:             body.ByIP,
			ByKey:            body.ByKey,
		}},
	}); apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUnbanUser(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if _, apiErr := s.apply(r, p, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_MemberUnban{MemberUnban: &rostalkv1.MemberUnban{UserId: id}},
	}); apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUnbanIP(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	ip := r.PathValue("ip")
	if ip == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "an address is required")
		return
	}
	if _, apiErr := s.apply(r, p, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_MemberUnban{MemberUnban: &rostalkv1.MemberUnban{Ip: ip}},
	}); apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMove(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var body struct {
		ChannelID uint64 `json:"channelId"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if _, apiErr := s.apply(r, p, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_MemberMove{MemberMove: &rostalkv1.MemberMove{
			UserId:    id,
			ChannelId: body.ChannelID,
		}},
	}); apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleBanList(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	result, apiErr := s.apply(r, p, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_BanList{BanList: &rostalkv1.BanListQuery{
			IncludeExpired: r.URL.Query().Get("include_expired") == "true",
		}},
	})
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	bans := result.GetBans().GetBans()
	out := make([]banJSON, 0, len(bans))
	for _, ban := range bans {
		out = append(out, banToJSON(ban))
	}
	writeJSON(w, http.StatusOK, map[string]any{"bans": out})
}

func (s *Server) handleAudit(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	query := r.URL.Query()
	limit, _ := strconv.ParseUint(query.Get("limit"), 10, 32)
	before, _ := strconv.ParseUint(query.Get("before_id"), 10, 64)
	actor, _ := strconv.ParseUint(query.Get("actor_id"), 10, 64)
	result, apiErr := s.apply(r, p, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_AuditList{AuditList: &rostalkv1.AuditList{
			Limit:        uint32(limit),
			BeforeId:     before,
			ActionPrefix: query.Get("action"),
			ActorId:      actor,
		}},
	})
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	page := result.GetAudit()
	entries := make([]auditJSON, 0, len(page.GetEntries()))
	for _, entry := range page.GetEntries() {
		entries = append(entries, auditToJSON(entry))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"entries":      entries,
		"nextBeforeId": page.GetNextBeforeId(),
		"hasMore":      page.GetHasMore(),
	})
}

func (s *Server) handleTokenList(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	result, apiErr := s.apply(r, p, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_ApiTokenList{ApiTokenList: &rostalkv1.ApiTokenListQuery{}},
	})
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	tokens := result.GetApiTokens().GetTokens()
	out := make([]tokenJSON, 0, len(tokens))
	for _, token := range tokens {
		out = append(out, tokenToJSON(token))
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": out})
}

func (s *Server) handleTokenCreate(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	var body struct {
		Name             string `json:"name"`
		RoleID           uint64 `json:"roleId"`
		ExpiresInSeconds uint32 `json:"expiresInSeconds"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	result, apiErr := s.apply(r, p, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_ApiTokenCreate{ApiTokenCreate: &rostalkv1.ApiTokenCreate{
			Name:             body.Name,
			RoleId:           body.RoleID,
			ExpiresInSeconds: body.ExpiresInSeconds,
		}},
	})
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	// The plaintext token is part of this reply only; it is never stored.
	writeJSON(w, http.StatusCreated, map[string]any{"token": tokenToJSON(result.GetApiToken())})
}

func (s *Server) handleTokenRevoke(w http.ResponseWriter, r *http.Request) {
	p, authErr := s.authenticate(r)
	if authErr != nil {
		writeAPIError(w, authErr)
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if _, apiErr := s.apply(r, p, &rostalkv1.AdminAction{
		Action: &rostalkv1.AdminAction_ApiTokenRevoke{ApiTokenRevoke: &rostalkv1.ApiTokenRevoke{TokenId: id}},
	}); apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ------------------------------------------------------------------ json ---

type userJSON struct {
	ID             uint64   `json:"id"`
	Nickname       string   `json:"nickname"`
	RoleIDs        []uint64 `json:"roleIds"`
	Online         bool     `json:"online"`
	LastSeenAtUnix int64    `json:"lastSeenAtUnixMs"`
	ChannelID      uint64   `json:"channelId"`
}

type channelJSON struct {
	ID                uint64 `json:"id"`
	ParentID          uint64 `json:"parentId"`
	Position          int32  `json:"position"`
	Name              string `json:"name"`
	Topic             string `json:"topic"`
	Kind              string `json:"kind"`
	UserLimit         uint32 `json:"userLimit"`
	PasswordProtected bool   `json:"passwordProtected"`
	VoiceProfile      string `json:"voiceProfile"`
	Temporary         bool   `json:"temporary"`
	UserCount         uint32 `json:"userCount"`
	AFK               bool   `json:"afk"`
}

type inviteJSON struct {
	ID              uint64 `json:"id"`
	RoleID          uint64 `json:"roleId"`
	CreatedBy       uint64 `json:"createdBy"`
	CreatedAtUnixMs int64  `json:"createdAtUnixMs"`
	ExpiresAtUnixMs int64  `json:"expiresAtUnixMs"`
	MaxUses         uint32 `json:"maxUses"`
	UsedCount       uint32 `json:"usedCount"`
	RevokedAtUnixMs int64  `json:"revokedAtUnixMs"`
	URL             string `json:"url"`
}

type banJSON struct {
	ID              uint64 `json:"id"`
	UserID          uint64 `json:"userId"`
	PublicKey       string `json:"publicKey"`
	IP              string `json:"ip"`
	Reason          string `json:"reason"`
	CreatedBy       uint64 `json:"createdBy"`
	CreatedAtUnixMs int64  `json:"createdAtUnixMs"`
	ExpiresAtUnixMs int64  `json:"expiresAtUnixMs"`
	Expired         bool   `json:"expired"`
}

type auditJSON struct {
	ID              uint64 `json:"id"`
	ActorID         uint64 `json:"actorId"`
	ActorName       string `json:"actorName"`
	Action          string `json:"action"`
	TargetUserID    uint64 `json:"targetUserId"`
	TargetChannelID uint64 `json:"targetChannelId"`
	TargetRoleID    uint64 `json:"targetRoleId"`
	Details         string `json:"details"`
	CreatedAtUnixMs int64  `json:"createdAtUnixMs"`
}

type tokenJSON struct {
	ID               uint64 `json:"id"`
	Name             string `json:"name"`
	RoleID           uint64 `json:"roleId"`
	CreatedBy        uint64 `json:"createdBy"`
	CreatedAtUnixMs  int64  `json:"createdAtUnixMs"`
	ExpiresAtUnixMs  int64  `json:"expiresAtUnixMs"`
	RevokedAtUnixMs  int64  `json:"revokedAtUnixMs"`
	LastUsedAtUnixMs int64  `json:"lastUsedAtUnixMs"`
	Token            string `json:"token,omitempty"`
}

func userToJSON(user *rostalkv1.UserListEntry) userJSON {
	return userJSON{
		ID:             user.GetId(),
		Nickname:       user.GetNickname(),
		RoleIDs:        user.GetRoleIds(),
		Online:         user.GetOnline(),
		LastSeenAtUnix: user.GetLastSeenAtUnixMs(),
		ChannelID:      user.GetChannelId(),
	}
}

func channelToJSON(channel *rostalkv1.Channel) channelJSON {
	return channelJSON{
		ID:                channel.GetId(),
		ParentID:          channel.GetParentId(),
		Position:          channel.GetPosition(),
		Name:              channel.GetName(),
		Topic:             channel.GetTopic(),
		Kind:              channelKindName(channel.GetKind()),
		UserLimit:         channel.GetUserLimit(),
		PasswordProtected: channel.GetPasswordProtected(),
		VoiceProfile:      voiceProfileName(channel.GetVoiceProfile()),
		Temporary:         channel.GetTemporary(),
		UserCount:         channel.GetUserCount(),
		AFK:               channel.GetAfk(),
	}
}

func inviteToJSON(invite *rostalkv1.Invite) inviteJSON {
	return inviteJSON{
		ID:              invite.GetId(),
		RoleID:          invite.GetRoleId(),
		CreatedBy:       invite.GetCreatedBy(),
		CreatedAtUnixMs: invite.GetCreatedAtUnixMs(),
		ExpiresAtUnixMs: invite.GetExpiresAtUnixMs(),
		MaxUses:         invite.GetMaxUses(),
		UsedCount:       invite.GetUsedCount(),
		RevokedAtUnixMs: invite.GetRevokedAtUnixMs(),
		URL:             invite.GetUrl(),
	}
}

func banToJSON(ban *rostalkv1.BanEntry) banJSON {
	return banJSON{
		ID:              ban.GetId(),
		UserID:          ban.GetUserId(),
		PublicKey:       ban.GetPublicKey(),
		IP:              ban.GetIp(),
		Reason:          ban.GetReason(),
		CreatedBy:       ban.GetCreatedBy(),
		CreatedAtUnixMs: ban.GetCreatedAtUnixMs(),
		ExpiresAtUnixMs: ban.GetExpiresAtUnixMs(),
		Expired:         ban.GetExpired(),
	}
}

func auditToJSON(entry *rostalkv1.AuditEntry) auditJSON {
	return auditJSON{
		ID:              entry.GetId(),
		ActorID:         entry.GetActorId(),
		ActorName:       entry.GetActorName(),
		Action:          entry.GetAction(),
		TargetUserID:    entry.GetTargetUserId(),
		TargetChannelID: entry.GetTargetChannelId(),
		TargetRoleID:    entry.GetTargetRoleId(),
		Details:         entry.GetDetails(),
		CreatedAtUnixMs: entry.GetCreatedAtUnixMs(),
	}
}

func tokenToJSON(token *rostalkv1.ApiToken) tokenJSON {
	return tokenJSON{
		ID:               token.GetId(),
		Name:             token.GetName(),
		RoleID:           token.GetRoleId(),
		CreatedBy:        token.GetCreatedBy(),
		CreatedAtUnixMs:  token.GetCreatedAtUnixMs(),
		ExpiresAtUnixMs:  token.GetExpiresAtUnixMs(),
		RevokedAtUnixMs:  token.GetRevokedAtUnixMs(),
		LastUsedAtUnixMs: token.GetLastUsedAtUnixMs(),
		Token:            token.GetToken(),
	}
}

func channelKindName(kind rostalkv1.ChannelKind) string {
	if kind == rostalkv1.ChannelKind_CHANNEL_KIND_TEXT {
		return "text"
	}
	return "voice"
}

func voiceProfileName(profile rostalkv1.VoiceProfile) string {
	switch profile {
	case rostalkv1.VoiceProfile_VOICE_PROFILE_VOICE_HQ:
		return "voiceHq"
	case rostalkv1.VoiceProfile_VOICE_PROFILE_MUSIC:
		return "music"
	default:
		return "voice"
	}
}

// --------------------------------------------------------------- helpers ---

func pathID(w http.ResponseWriter, r *http.Request) (uint64, bool) {
	value, err := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "the id must be a positive integer")
		return 0, false
	}
	return value, true
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "the request body is not valid JSON")
		return false
	}
	return true
}

// decodeOptionalJSON accepts an empty body as an empty object.
func decodeOptionalJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		if errors.Is(err, io.EOF) {
			// An empty body is an empty object for optional fields.
			return true
		}
		writeError(w, http.StatusBadRequest, "invalid_request", "the request body is not valid JSON")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		// The status is already sent; only a broken connection can get here.
		return
	}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}

func writeAPIError(w http.ResponseWriter, apiErr *apiError) {
	if apiErr.status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Bearer realm="rostalk"`)
	}
	writeError(w, apiErr.status, apiErr.code, apiErr.message)
}
