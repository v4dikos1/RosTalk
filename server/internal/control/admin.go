package control

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/media"
	"github.com/v4dikos1/RosTalk/server/internal/perms"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/secret"
	"github.com/v4dikos1/RosTalk/server/internal/state"
	"github.com/v4dikos1/RosTalk/server/internal/store"
	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

// DefaultInviteMaxUses is the number of logins of an invite created without an
// explicit limit.
const DefaultInviteMaxUses = 1

// actor is who performs an administrative action. Sessions carry a real user;
// the local admin socket uses the synthetic system subject and the name "cli".
type actor struct {
	subject perms.Subject
	userID  int64
	name    string
}

func (p *Plane) actorOf(session *state.Session) actor {
	return actor{
		subject: p.roles.Subject(session.UserID()),
		userID:  session.UserID(),
		name:    session.Nickname(),
	}
}

var cliActor = actor{subject: roles.System, userID: 0, name: "cli"}

// handleAdmin dispatches one AdminAction and replies with AdminResult or Error.
func (p *Plane) handleAdmin(ctx context.Context, session *state.Session, requestID uint64, action *rostalkv1.AdminAction) {
	if action == nil || action.GetAction() == nil {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST,
			"admin action is empty")
		return
	}
	result, err := p.admin(ctx, p.actorOf(session), action)
	if err != nil {
		p.replyAdminError(session, requestID, err)
		return
	}
	p.send(session, &rostalkv1.ServerFrame{
		ReplyTo: requestID,
		Payload: &rostalkv1.ServerFrame_AdminResult{AdminResult: result},
	})
}

// Apply runs one administrative action for an explicit subject. The HTTP API
// uses it with the role a bearer token acts as; the protocol handler uses the
// session actor. Permission checks, hierarchy and auditing stay in one place.
//
// Audit entries of API actors carry actor_id 0 and a readable name such as
// "api:deploy-bot"; the token itself never reaches the audit log.
func (p *Plane) Apply(ctx context.Context, subject perms.Subject, actorName string, action *rostalkv1.AdminAction) (*rostalkv1.AdminResult, error) {
	return p.admin(ctx, actor{subject: subject, userID: 0, name: actorName}, action)
}

func (p *Plane) admin(ctx context.Context, a actor, action *rostalkv1.AdminAction) (*rostalkv1.AdminResult, error) {
	switch payload := action.GetAction().(type) {
	case *rostalkv1.AdminAction_RoleCreate:
		return p.adminRoleCreate(ctx, a, payload.RoleCreate)
	case *rostalkv1.AdminAction_RoleUpdate:
		return p.adminRoleUpdate(ctx, a, payload.RoleUpdate)
	case *rostalkv1.AdminAction_RoleDelete:
		return p.adminRoleDelete(ctx, a, payload.RoleDelete)
	case *rostalkv1.AdminAction_RoleReorder:
		return p.adminRoleReorder(ctx, a, payload.RoleReorder)
	case *rostalkv1.AdminAction_RoleAssign:
		return p.adminRoleAssign(ctx, a, payload.RoleAssign, true)
	case *rostalkv1.AdminAction_RoleUnassign:
		return p.adminRoleAssign(ctx, a, &rostalkv1.RoleAssign{
			UserId: payload.RoleUnassign.GetUserId(), RoleId: payload.RoleUnassign.GetRoleId(),
		}, false)
	case *rostalkv1.AdminAction_ChannelOverrideSet:
		return p.adminOverrideSet(ctx, a, payload.ChannelOverrideSet)
	case *rostalkv1.AdminAction_ChannelOverrideClear:
		return p.adminOverrideClear(ctx, a, payload.ChannelOverrideClear)
	case *rostalkv1.AdminAction_ChannelOverrideList:
		return p.adminOverrideList(ctx, a, payload.ChannelOverrideList)
	case *rostalkv1.AdminAction_ChannelCreate:
		return p.adminChannelCreate(ctx, a, payload.ChannelCreate)
	case *rostalkv1.AdminAction_ChannelUpdate:
		return p.adminChannelUpdate(ctx, a, payload.ChannelUpdate)
	case *rostalkv1.AdminAction_ChannelDelete:
		return p.adminChannelDelete(ctx, a, payload.ChannelDelete)
	case *rostalkv1.AdminAction_ChannelMove:
		return p.adminChannelMove(ctx, a, payload.ChannelMove)
	case *rostalkv1.AdminAction_ApiTokenCreate:
		return p.adminTokenCreate(ctx, a, payload.ApiTokenCreate)
	case *rostalkv1.AdminAction_ApiTokenList:
		return p.adminTokenList(ctx, a, payload.ApiTokenList)
	case *rostalkv1.AdminAction_ApiTokenRevoke:
		return p.adminTokenRevoke(ctx, a, payload.ApiTokenRevoke)
	case *rostalkv1.AdminAction_MemberList:
		return p.adminMemberList(ctx, a, payload.MemberList)
	case *rostalkv1.AdminAction_BanList:
		return p.adminBanList(ctx, a, payload.BanList)
	case *rostalkv1.AdminAction_InviteCreate:
		return p.adminInviteCreate(ctx, a, payload.InviteCreate)
	case *rostalkv1.AdminAction_InviteRevoke:
		return p.adminInviteRevoke(ctx, a, payload.InviteRevoke)
	case *rostalkv1.AdminAction_InviteList:
		return p.adminInviteList(ctx, a, payload.InviteList)
	case *rostalkv1.AdminAction_ServerSettingsSet:
		return p.adminSettingsSet(ctx, a, payload.ServerSettingsSet)
	case *rostalkv1.AdminAction_MemberKick:
		return p.adminKick(ctx, a, payload.MemberKick)
	case *rostalkv1.AdminAction_MemberBan:
		return p.adminBan(ctx, a, payload.MemberBan)
	case *rostalkv1.AdminAction_MemberUnban:
		return p.adminUnban(ctx, a, payload.MemberUnban)
	case *rostalkv1.AdminAction_MemberMove:
		return p.adminMove(ctx, a, payload.MemberMove)
	case *rostalkv1.AdminAction_MemberSetMuted:
		return p.adminSetMuted(ctx, a, payload.MemberSetMuted)
	case *rostalkv1.AdminAction_MemberSetDeafened:
		return p.adminSetDeafened(ctx, a, payload.MemberSetDeafened)
	case *rostalkv1.AdminAction_MemberStopStream:
		return p.adminStopStream(ctx, a, payload.MemberStopStream)
	case *rostalkv1.AdminAction_AuditList:
		return p.adminAuditList(ctx, a, payload.AuditList)
	default:
		return nil, fmt.Errorf("%w: admin action is not available", errInvalidRequest)
	}
}

var errInvalidRequest = errors.New("invalid request")

// ErrInvalidRequest is the exported sentinel for malformed admin input. The
// HTTP API maps it to 400 without importing unexported state.
var ErrInvalidRequest = errInvalidRequest

// ---------------------------------------------------------------- roles ---

func (p *Plane) adminRoleCreate(ctx context.Context, a actor, req *rostalkv1.RoleCreate) (*rostalkv1.AdminResult, error) {
	before := p.captureVisibility()
	var position *int32
	if req.Position != nil {
		value := req.GetPosition()
		position = &value
	}
	role, err := p.roles.Create(ctx, a.subject, roles.CreateParams{
		Name:        req.GetName(),
		Color:       req.GetColor(),
		Position:    position,
		Permissions: permissionsOf(req.GetPermissions()),
	})
	if err != nil {
		return nil, err
	}
	p.audit(ctx, a, "role.create", 0, 0, role.ID, role.Name)
	p.afterRoleChange(ctx, before)
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Role{Role: roleProto(role)}}, nil
}

func (p *Plane) adminRoleUpdate(ctx context.Context, a actor, req *rostalkv1.RoleUpdate) (*rostalkv1.AdminResult, error) {
	before := p.captureVisibility()
	var position *int32
	if req.Position != nil {
		value := req.GetPosition()
		position = &value
	}
	params := roles.UpdateParams{
		Name:     req.Name,
		Color:    req.Color,
		Position: position,
	}
	if req.Permissions != nil {
		permissions := permissionsOf(req.GetPermissions())
		params.Permissions = &permissions
	}
	role, err := p.roles.Update(ctx, a.subject, int64(req.GetRoleId()), params)
	if err != nil {
		return nil, err
	}
	details := role.Name
	if req.Permissions != nil {
		details = fmt.Sprintf("%s permissions=%v", role.Name, req.GetPermissions().GetPermissions())
	}
	p.audit(ctx, a, "role.update", 0, 0, role.ID, details)
	p.afterRoleChange(ctx, before)
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Role{Role: roleProto(role)}}, nil
}

func (p *Plane) adminRoleDelete(ctx context.Context, a actor, req *rostalkv1.RoleDelete) (*rostalkv1.AdminResult, error) {
	before := p.captureVisibility()
	roleID := int64(req.GetRoleId())
	role, ok := p.roles.RoleByID(roleID)
	if !ok {
		return nil, roles.ErrNotFound
	}
	if err := p.roles.Delete(ctx, a.subject, roleID); err != nil {
		return nil, err
	}
	p.audit(ctx, a, "role.delete", 0, 0, roleID, role.Name)
	p.afterRoleChange(ctx, before)
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Ok{Ok: true}}, nil
}

func (p *Plane) adminRoleReorder(ctx context.Context, a actor, req *rostalkv1.RoleReorder) (*rostalkv1.AdminResult, error) {
	before := p.captureVisibility()
	list, err := p.roles.Reorder(ctx, a.subject, req.GetRoleIds())
	if err != nil {
		return nil, err
	}
	p.audit(ctx, a, "role.reorder", 0, 0, 0, fmt.Sprintf("roles=%d", len(list)))
	p.afterRoleChange(ctx, before)
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Roles{
		Roles: &rostalkv1.RoleList{Roles: roleListProto(list)},
	}}, nil
}

func (p *Plane) adminRoleAssign(ctx context.Context, a actor, req *rostalkv1.RoleAssign, assign bool) (*rostalkv1.AdminResult, error) {
	before := p.captureVisibility()
	userID := int64(req.GetUserId())
	roleID := int64(req.GetRoleId())
	action := "role.assign"
	if !assign {
		action = "role.unassign"
	}
	var err error
	if assign {
		err = p.roles.Assign(ctx, a.subject, userID, roleID)
	} else {
		err = p.roles.Unassign(ctx, a.subject, userID, roleID)
	}
	if err != nil {
		return nil, err
	}
	p.audit(ctx, a, action, userID, 0, roleID, "")
	p.afterRoleChange(ctx, before)
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Ok{Ok: true}}, nil
}

// -------------------------------------------------------------- overrides ---

func (p *Plane) adminOverrideSet(ctx context.Context, a actor, req *rostalkv1.ChannelOverrideSet) (*rostalkv1.AdminResult, error) {
	channelID := int64(req.GetChannelId())
	if _, ok := p.channels.Get(channelID); !ok {
		return nil, store.ErrNotFound
	}
	before := p.captureVisibility()
	override, err := p.roles.SetOverride(ctx, a.subject, channelID, int64(req.GetRoleId()),
		perms.Mask(permissionsOf(req.GetAllow())...), perms.Mask(permissionsOf(req.GetDeny())...))
	if err != nil {
		return nil, err
	}
	p.audit(ctx, a, "channel.override.set", 0, channelID, int64(req.GetRoleId()),
		"allow="+permissionsString(req.GetAllow())+" deny="+permissionsString(req.GetDeny()))
	p.afterRoleChange(ctx, before)
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Override{
		Override: overrideProto(uint64(channelID), override),
	}}, nil
}

func (p *Plane) adminOverrideClear(ctx context.Context, a actor, req *rostalkv1.ChannelOverrideClear) (*rostalkv1.AdminResult, error) {
	channelID := int64(req.GetChannelId())
	if _, ok := p.channels.Get(channelID); !ok {
		return nil, store.ErrNotFound
	}
	before := p.captureVisibility()
	if err := p.roles.ClearOverride(ctx, a.subject, channelID, int64(req.GetRoleId())); err != nil {
		return nil, err
	}
	p.audit(ctx, a, "channel.override.clear", 0, channelID, int64(req.GetRoleId()), "")
	p.afterRoleChange(ctx, before)
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Ok{Ok: true}}, nil
}

func (p *Plane) adminOverrideList(_ context.Context, a actor, req *rostalkv1.ChannelOverrideListQuery) (*rostalkv1.AdminResult, error) {
	channelID := int64(req.GetChannelId())
	if _, ok := p.channels.Get(channelID); !ok {
		return nil, store.ErrNotFound
	}
	if !p.canManageChannelsOrRoles(a.subject) {
		return nil, roles.ErrPermissionDenied
	}
	overrides := p.roles.ChannelOverrides(uint64(channelID))
	out := make([]*rostalkv1.ChannelOverride, 0, len(overrides))
	for _, override := range overrides {
		out = append(out, overrideProto(uint64(channelID), override))
	}
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Overrides{
		Overrides: &rostalkv1.ChannelOverrideList{Overrides: out},
	}}, nil
}

// --------------------------------------------------------------- channels ---

// SubjectForRole builds the permission subject an HTTP API token acts as. The
// role is read from the live role service, so deleting or editing it changes
// the token's rights immediately.
func (p *Plane) SubjectForRole(roleID int64) (perms.Subject, bool) {
	return p.roles.SubjectOfRole(roleID)
}

// ChannelsFor returns every channel the subject may see, in display order. The
// HTTP API uses it for GET /api/v1/channels so a token never learns about a
// channel its role cannot view.
func (p *Plane) ChannelsFor(subject perms.Subject) []*rostalkv1.Channel {
	list := p.channels.List()
	out := make([]*rostalkv1.Channel, 0, len(list))
	for _, channel := range list {
		channelID := uint64(channel.ID)
		if !p.roles.CanSubject(subject, rostalkv1.Permission_PERMISSION_VIEW_CHANNEL, channelID) {
			continue
		}
		out = append(out, channel.Proto(p.channelCount(channelID)))
	}
	return out
}

func (p *Plane) adminChannelCreate(ctx context.Context, a actor, req *rostalkv1.ChannelCreate) (*rostalkv1.AdminResult, error) {
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_MANAGE_CHANNELS, 0) {
		return nil, roles.ErrPermissionDenied
	}
	params := channels.CreateParams{
		ParentID:     int64(req.GetParentId()),
		Name:         req.GetName(),
		Topic:        req.GetTopic(),
		Kind:         req.GetKind(),
		UserLimit:    req.GetUserLimit(),
		VoiceProfile: req.GetVoiceProfile(),
		Temporary:    req.GetTemporary(),
		AFK:          req.GetAfk(),
		Password:     req.GetPassword(),
	}
	if req.Position != nil {
		position := req.GetPosition()
		params.Position = &position
	}
	channel, err := p.CreateChannel(ctx, params)
	if err != nil {
		return nil, err
	}
	p.audit(ctx, a, "channel.create", 0, channel.ID, 0, channel.Name)
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Channel{
		Channel: channel.Proto(p.channelCount(uint64(channel.ID))),
	}}, nil
}

func (p *Plane) adminChannelUpdate(ctx context.Context, a actor, req *rostalkv1.ChannelUpdate) (*rostalkv1.AdminResult, error) {
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_MANAGE_CHANNELS, 0) {
		return nil, roles.ErrPermissionDenied
	}
	channelID := int64(req.GetChannelId())
	if _, ok := p.channels.Get(channelID); !ok {
		return nil, store.ErrNotFound
	}
	params := channels.UpdateParams{
		Name:      req.Name,
		Topic:     req.Topic,
		Temporary: req.Temporary,
		AFK:       req.Afk,
	}
	if req.Kind != nil {
		kind := req.GetKind()
		params.Kind = &kind
	}
	if req.UserLimit != nil {
		limit := req.GetUserLimit()
		params.UserLimit = &limit
	}
	if req.VoiceProfile != nil {
		profile := req.GetVoiceProfile()
		params.VoiceProfile = &profile
	}
	if req.Password != nil {
		params.SetPassword = true
		params.Password = req.GetPassword()
	}
	channel, err := p.UpdateChannel(ctx, channelID, params)
	if err != nil {
		return nil, err
	}
	details := channel.Name
	if req.Password != nil {
		// Never record the value, only that it changed.
		details += " password=changed"
	}
	p.audit(ctx, a, "channel.update", 0, channelID, 0, details)
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Channel{
		Channel: channel.Proto(p.channelCount(uint64(channelID))),
	}}, nil
}

func (p *Plane) adminChannelDelete(ctx context.Context, a actor, req *rostalkv1.ChannelDelete) (*rostalkv1.AdminResult, error) {
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_MANAGE_CHANNELS, 0) {
		return nil, roles.ErrPermissionDenied
	}
	channelID := int64(req.GetChannelId())
	channel, ok := p.channels.Get(channelID)
	if !ok {
		return nil, store.ErrNotFound
	}
	if err := p.DeleteChannel(ctx, channelID); err != nil {
		return nil, err
	}
	p.audit(ctx, a, "channel.delete", 0, channelID, 0, channel.Name)
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Ok{Ok: true}}, nil
}

func (p *Plane) adminChannelMove(ctx context.Context, a actor, req *rostalkv1.ChannelMove) (*rostalkv1.AdminResult, error) {
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_MANAGE_CHANNELS, 0) {
		return nil, roles.ErrPermissionDenied
	}
	var position *int32
	if req.Position != nil {
		value := req.GetPosition()
		position = &value
	}
	channel, err := p.MoveChannel(ctx, int64(req.GetChannelId()), int64(req.GetParentId()), position)
	if err != nil {
		return nil, err
	}
	p.audit(ctx, a, "channel.move", 0, channel.ID, 0,
		fmt.Sprintf("parent=%d position=%d", channel.ParentID, channel.Position))
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Channel{
		Channel: channel.Proto(p.channelCount(uint64(channel.ID))),
	}}, nil
}

// ------------------------------------------------------------- api tokens ---

// maxTokenNameRunes bounds the name shown in the admin UI and the audit log.
const maxTokenNameRunes = 64

func (p *Plane) adminTokenCreate(ctx context.Context, a actor, req *rostalkv1.ApiTokenCreate) (*rostalkv1.AdminResult, error) {
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_MANAGE_SERVER, 0) {
		return nil, roles.ErrPermissionDenied
	}
	name := strings.TrimSpace(req.GetName())
	if name == "" || utf8.RuneCountInString(name) > maxTokenNameRunes ||
		strings.ContainsAny(name, "\x00\r\n\t") {
		return nil, fmt.Errorf("%w: token name must be 1..%d characters without control characters",
			errInvalidRequest, maxTokenNameRunes)
	}
	role, ok := p.roles.RoleByID(int64(req.GetRoleId()))
	if !ok {
		return nil, roles.ErrNotFound
	}
	if !perms.CanManageRole(a.subject, role, nil) {
		return nil, roles.ErrHierarchy
	}
	var expires *time.Time
	if req.GetExpiresInSeconds() > 0 {
		deadline := p.now().Add(time.Duration(req.GetExpiresInSeconds()) * time.Second)
		expires = &deadline
	}
	token, plaintext, err := p.store.CreateAPIToken(ctx, store.APITokenOptions{
		Name:      name,
		RoleID:    role.ID,
		CreatedBy: a.userID,
		ExpiresAt: expires,
	})
	if err != nil {
		return nil, err
	}
	p.audit(ctx, a, "api_token.create", 0, 0, role.ID,
		fmt.Sprintf("token=%d name=%q expires=%d", token.ID, name, req.GetExpiresInSeconds()))
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_ApiToken{
		ApiToken: apiTokenProto(token, plaintext),
	}}, nil
}

func (p *Plane) adminTokenList(ctx context.Context, a actor, _ *rostalkv1.ApiTokenListQuery) (*rostalkv1.AdminResult, error) {
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_MANAGE_SERVER, 0) {
		return nil, roles.ErrPermissionDenied
	}
	tokens, err := p.store.ListAPITokens(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*rostalkv1.ApiToken, 0, len(tokens))
	for _, token := range tokens {
		out = append(out, apiTokenProto(token, ""))
	}
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_ApiTokens{
		ApiTokens: &rostalkv1.ApiTokenList{Tokens: out},
	}}, nil
}

func (p *Plane) adminTokenRevoke(ctx context.Context, a actor, req *rostalkv1.ApiTokenRevoke) (*rostalkv1.AdminResult, error) {
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_MANAGE_SERVER, 0) {
		return nil, roles.ErrPermissionDenied
	}
	tokenID := int64(req.GetTokenId())
	tokens, err := p.store.ListAPITokens(ctx)
	if err != nil {
		return nil, err
	}
	var found bool
	for _, token := range tokens {
		if token.ID == tokenID {
			found = true
			break
		}
	}
	if !found {
		return nil, store.ErrNotFound
	}
	if err := p.store.RevokeAPIToken(ctx, tokenID, p.now()); err != nil {
		return nil, err
	}
	p.audit(ctx, a, "api_token.revoke", 0, 0, 0, fmt.Sprintf("token=%d", tokenID))
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Ok{Ok: true}}, nil
}

// ------------------------------------------------------------- members ---

func (p *Plane) adminMemberList(ctx context.Context, a actor, req *rostalkv1.MemberListQuery) (*rostalkv1.AdminResult, error) {
	if !p.canViewMembers(a.subject) {
		return nil, roles.ErrPermissionDenied
	}
	users, err := p.store.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	type presence struct {
		online    bool
		channelID uint64
	}
	online := make(map[int64]presence, len(users))
	for _, user := range p.hub.SnapshotUsers() {
		online[user.UserID] = presence{online: true, channelID: user.ChannelID}
	}
	query := strings.ToLower(strings.TrimSpace(req.GetQuery()))
	entries := make([]*rostalkv1.UserListEntry, 0, len(users))
	for _, user := range users {
		if query != "" && !strings.Contains(strings.ToLower(user.Nickname), query) {
			continue
		}
		present, isOnline := online[user.ID]
		if !isOnline && !req.GetIncludeOffline() {
			continue
		}
		entries = append(entries, &rostalkv1.UserListEntry{
			Id:               uint64(user.ID),
			Nickname:         user.Nickname,
			RoleIds:          uint64s(p.roles.RoleIDs(user.ID)),
			Online:           isOnline,
			LastSeenAtUnixMs: user.LastSeenAt,
			ChannelId:        present.channelID,
		})
	}
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Users{
		Users: &rostalkv1.UserList{Users: entries},
	}}, nil
}

func (p *Plane) adminBanList(ctx context.Context, a actor, req *rostalkv1.BanListQuery) (*rostalkv1.AdminResult, error) {
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_BAN, 0) {
		return nil, roles.ErrPermissionDenied
	}
	bans, err := p.store.ListBans(ctx)
	if err != nil {
		return nil, err
	}
	now := p.now()
	out := make([]*rostalkv1.BanEntry, 0, len(bans))
	for _, ban := range bans {
		expired := ban.ExpiresAt != nil && !ban.ExpiresAt.After(now)
		if expired && !req.GetIncludeExpired() {
			continue
		}
		entry := &rostalkv1.BanEntry{
			Id:              uint64(ban.ID),
			PublicKey:       hex.EncodeToString(ban.PublicKey),
			Ip:              ban.IP,
			Reason:          ban.Reason,
			CreatedBy:       uint64(ban.CreatedBy),
			CreatedAtUnixMs: ban.CreatedAt.UnixMilli(),
			Expired:         expired,
		}
		if ban.ExpiresAt != nil {
			entry.ExpiresAtUnixMs = ban.ExpiresAt.UnixMilli()
		}
		if len(ban.PublicKey) == 32 {
			if user, err := p.store.UserByPublicKey(ctx, ban.PublicKey); err == nil {
				entry.UserId = uint64(user.ID)
			}
		}
		out = append(out, entry)
	}
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Bans{
		Bans: &rostalkv1.BanList{Bans: out},
	}}, nil
}

// canManageChannelsOrRoles reports whether the subject may read or change
// channel overrides. Channel administrators and role managers both may.
func (p *Plane) canManageChannelsOrRoles(subject perms.Subject) bool {
	return p.roles.CanSubject(subject, rostalkv1.Permission_PERMISSION_MANAGE_CHANNELS, 0) ||
		p.roles.CanSubject(subject, rostalkv1.Permission_PERMISSION_MANAGE_ROLES, 0) ||
		p.roles.CanSubject(subject, rostalkv1.Permission_PERMISSION_MANAGE_SERVER, 0)
}

// canViewMembers reports whether the subject may read the member list. Any
// moderation or role right is enough, so a moderator can find a person to act
// on without being a server administrator.
func (p *Plane) canViewMembers(subject perms.Subject) bool {
	for _, permission := range []rostalkv1.Permission{
		rostalkv1.Permission_PERMISSION_MANAGE_SERVER,
		rostalkv1.Permission_PERMISSION_MANAGE_ROLES,
		rostalkv1.Permission_PERMISSION_KICK,
		rostalkv1.Permission_PERMISSION_BAN,
		rostalkv1.Permission_PERMISSION_MOVE_MEMBERS,
		rostalkv1.Permission_PERMISSION_MUTE_MEMBERS,
		rostalkv1.Permission_PERMISSION_DEAFEN_MEMBERS,
	} {
		if p.roles.CanSubject(subject, permission, 0) {
			return true
		}
	}
	return false
}

// --------------------------------------------------------------- invites ---

func (p *Plane) adminInviteCreate(ctx context.Context, a actor, req *rostalkv1.InviteCreate) (*rostalkv1.AdminResult, error) {
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_MANAGE_INVITES, 0) {
		return nil, roles.ErrPermissionDenied
	}
	roleID := int64(req.GetRoleId())
	if roleID == 0 {
		roleID = p.roles.DefaultRoleID()
	}
	if roleID != 0 {
		role, ok := p.roles.RoleByID(roleID)
		if !ok {
			return nil, roles.ErrNotFound
		}
		// An invite must not grant a role above the creator, otherwise a
		// moderator could mint an administrator link.
		if !perms.CanManageRole(a.subject, role, nil) {
			return nil, roles.ErrHierarchy
		}
		// Hierarchy alone is not enough: a lower role can still carry a right
		// the creator does not hold. Handing out an invite for it would let a
		// moderator redeem the link with a fresh key and escalate (the login
		// path assigns the invite role as the system actor). The same grant
		// rule as role assignment applies.
		if !roles.CanGrant(a.subject, role.Permissions) {
			return nil, roles.ErrPermissionDenied
		}
	}
	invite, url, err := p.createInvite(ctx, a, roleID, req.GetMaxUses(), req.GetExpiresInSeconds())
	if err != nil {
		return nil, err
	}
	invite.Url = url
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Invite{Invite: invite}}, nil
}

func (p *Plane) adminInviteRevoke(ctx context.Context, a actor, req *rostalkv1.InviteRevoke) (*rostalkv1.AdminResult, error) {
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_MANAGE_INVITES, 0) {
		return nil, roles.ErrPermissionDenied
	}
	inviteID := int64(req.GetInviteId())
	if _, err := p.store.InviteByID(ctx, inviteID); err != nil {
		return nil, err
	}
	if err := p.store.RevokeInvite(ctx, inviteID, p.now()); err != nil {
		return nil, err
	}
	p.audit(ctx, a, "invite.revoke", 0, 0, 0, fmt.Sprintf("invite=%d", inviteID))
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Ok{Ok: true}}, nil
}

func (p *Plane) adminInviteList(ctx context.Context, a actor, req *rostalkv1.InviteListQuery) (*rostalkv1.AdminResult, error) {
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_MANAGE_INVITES, 0) {
		return nil, roles.ErrPermissionDenied
	}
	rows, err := p.store.ListInvites(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*rostalkv1.Invite, 0, len(rows))
	for _, row := range rows {
		if !req.GetIncludeInactive() && store.CheckInvite(row, p.now()) != nil {
			continue
		}
		out = append(out, inviteProto(row))
	}
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Invites{
		Invites: &rostalkv1.InviteList{Invites: out},
	}}, nil
}

// createInvite is shared by the protocol and the local socket.
func (p *Plane) createInvite(ctx context.Context, a actor, roleID int64, maxUses, expiresInSeconds uint32) (*rostalkv1.Invite, string, error) {
	uses := int(maxUses)
	if uses <= 0 {
		uses = DefaultInviteMaxUses
	}
	opts := store.InviteOptions{MaxUses: uses}
	if roleID > 0 {
		opts.RoleID = &roleID
	}
	if a.userID > 0 {
		creator := a.userID
		opts.CreatedBy = &creator
	}
	if expiresInSeconds > 0 {
		deadline := p.now().Add(time.Duration(expiresInSeconds) * time.Second)
		opts.ExpiresAt = &deadline
	}
	token, err := p.store.CreateInvite(ctx, opts)
	if err != nil {
		return nil, "", err
	}
	// The database stores only the hash, so the id of the new row is looked up
	// by its token. This is the only moment the plaintext exists.
	stored, err := p.store.FindInvite(ctx, token)
	if err != nil {
		return nil, "", err
	}
	p.audit(ctx, a, "invite.create", 0, 0, 0,
		fmt.Sprintf("invite=%d role=%d uses=%d expires=%d", stored.ID, roleID, uses, expiresInSeconds))
	return inviteProto(stored), p.inviteURL(token), nil
}

// -------------------------------------------------------------- settings ---

func (p *Plane) adminSettingsSet(ctx context.Context, a actor, req *rostalkv1.ServerSettingsSet) (*rostalkv1.AdminResult, error) {
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_MANAGE_SERVER, 0) {
		return nil, roles.ErrPermissionDenied
	}
	var attachmentLimit *int64
	if req.MaxAttachmentBytes != nil {
		value := int64(*req.MaxAttachmentBytes)
		attachmentLimit = &value
	}
	if err := p.applySettings(ctx, settingsPatch{
		Name:               req.Name,
		LoginMode:          req.LoginMode,
		MaxUsers:           req.MaxUsers,
		Password:           req.Password,
		HasPassword:        req.Password != nil,
		MaxAttachmentBytes: attachmentLimit,
	}); err != nil {
		return nil, err
	}
	p.audit(ctx, a, "settings.update", 0, 0, 0, settingsPatchString(req))
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Server{Server: p.serverInfo()}}, nil
}

type settingsPatch struct {
	Name        *string
	LoginMode   *rostalkv1.LoginMode
	MaxUsers    *uint32
	Password    *string
	HasPassword bool
	// MaxAttachmentBytes is already in bytes; the admin UI edits MiB but the
	// wire field and the settings table use bytes.
	MaxAttachmentBytes *int64
}

// Attachment limits the administrator may choose (stage P3). The lower bound
// keeps a useful screenshot possible; the upper bound keeps one request from
// turning into an unbounded disk reservation.
const (
	MinAttachmentBytes int64 = 1 << 20
	MaxAttachmentBytes int64 = 2 << 30
)

func validateAttachmentLimit(value int64) error {
	if value < MinAttachmentBytes || value > MaxAttachmentBytes {
		return fmt.Errorf("%w: max_attachment_bytes must be between 1 MiB and 2 GiB", errInvalidRequest)
	}
	return nil
}

func (p *Plane) applySettings(ctx context.Context, patch settingsPatch) error {
	if patch.LoginMode != nil && *patch.LoginMode == rostalkv1.LoginMode_LOGIN_MODE_PASSWORD {
		hasPassword := p.settingsSnapshot().ServerPassword != ""
		if patch.HasPassword {
			hasPassword = *patch.Password != ""
		}
		if !hasPassword {
			return fmt.Errorf("%w: set a server password before switching to password login", errInvalidRequest)
		}
	}
	if patch.Name != nil {
		name := strings.TrimSpace(*patch.Name)
		if name == "" {
			return fmt.Errorf("%w: server name must not be empty", errInvalidRequest)
		}
		if err := p.store.SetSetting(ctx, "server_name", name); err != nil {
			return err
		}
	}
	if patch.LoginMode != nil {
		mode, err := loginModeName(*patch.LoginMode)
		if err != nil {
			return err
		}
		if err := p.store.SetSetting(ctx, "login_mode", mode); err != nil {
			return err
		}
	}
	if patch.MaxUsers != nil {
		if err := p.store.SetSetting(ctx, "max_users", fmt.Sprintf("%d", *patch.MaxUsers)); err != nil {
			return err
		}
	}
	if patch.MaxAttachmentBytes != nil {
		if err := validateAttachmentLimit(*patch.MaxAttachmentBytes); err != nil {
			return err
		}
		if err := p.store.SetSetting(ctx, "max_attachment_bytes",
			strconv.FormatInt(*patch.MaxAttachmentBytes, 10)); err != nil {
			return err
		}
	}
	if patch.HasPassword {
		hash := ""
		if *patch.Password != "" {
			var err error
			hash, err = secret.HashPassword(*patch.Password)
			if err != nil {
				return fmt.Errorf("hash server password: %w", err)
			}
		}
		if err := p.store.SetSetting(ctx, "server_password_hash", hash); err != nil {
			return err
		}
	}
	settings, err := p.store.Settings(ctx)
	if err != nil {
		return err
	}
	p.settingsMu.Lock()
	p.settings = settings
	p.settingsMu.Unlock()
	p.hub.SetMaxUsers(settings.MaxUsers)
	if p.onSettingsChange != nil {
		p.onSettingsChange(settings)
	}
	p.hub.Broadcast(&rostalkv1.Event{
		Payload: &rostalkv1.Event_ServerUpdated{ServerUpdated: &rostalkv1.ServerUpdated{
			Server: p.serverInfo(),
		}},
	})
	p.logger.Info("server settings updated",
		"server_name", settings.ServerName,
		"login_mode", settings.LoginMode,
		"max_users", settings.MaxUsers,
	)
	return nil
}

// ------------------------------------------------------------------ kick ---

func (p *Plane) adminKick(ctx context.Context, a actor, req *rostalkv1.MemberKick) (*rostalkv1.AdminResult, error) {
	userID := int64(req.GetUserId())
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_KICK, 0) ||
		!p.roles.CanActOnSubject(a.subject, userID) {
		return nil, roles.ErrHierarchy
	}
	if _, err := p.store.UserByID(ctx, userID); err != nil {
		return nil, err
	}
	p.kick(ctx, userID, req.GetReason(), rostalkv1.ErrorCode_ERROR_CODE_KICKED)
	p.audit(ctx, a, "member.kick", userID, 0, 0, req.GetReason())
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Ok{Ok: true}}, nil
}

func (p *Plane) kick(ctx context.Context, userID int64, reason string, code rostalkv1.ErrorCode) {
	_ = p.RemoveMediaParticipant(ctx, userID)
	// The HTTP session token is independent of the WebSocket. Terminating the
	// control connection only flushes a final frame and may take a moment on a
	// slow client, so revoke the bearer immediately: a kicked or banned user
	// must not be able to keep reading chat history in the meantime.
	p.hub.RevokeHTTPTokens(userID)
	message := reason
	if message == "" {
		message = "you were disconnected by a moderator"
	}
	p.hub.TerminateUser(userID, code, message)
}

// ------------------------------------------------------------------- ban ---

func (p *Plane) adminBan(ctx context.Context, a actor, req *rostalkv1.MemberBan) (*rostalkv1.AdminResult, error) {
	userID := int64(req.GetUserId())
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_BAN, 0) ||
		!p.roles.CanActOnSubject(a.subject, userID) {
		return nil, roles.ErrHierarchy
	}
	user, err := p.store.UserByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	byKey := true
	if req.ByKey != nil {
		byKey = req.GetByKey()
	}
	if !byKey && !req.GetByIp() {
		return nil, fmt.Errorf("%w: ban needs a key or an address", errInvalidRequest)
	}
	var expires *time.Time
	if req.GetExpiresInSeconds() > 0 {
		deadline := p.now().Add(time.Duration(req.GetExpiresInSeconds()) * time.Second)
		expires = &deadline
	}
	if byKey {
		if err := p.store.AddBan(ctx, store.BanOptions{
			PublicKey: user.PublicKey,
			Reason:    req.GetReason(),
			ExpiresAt: expires,
		}); err != nil {
			return nil, err
		}
	}
	ip := ""
	if req.GetByIp() {
		presence, ok := p.hub.Presence(userID)
		if !ok || presence.IP == "" {
			return nil, fmt.Errorf("%w: the user is not online, so the address is unknown", errInvalidRequest)
		}
		ip = presence.IP
		if err := p.store.AddBan(ctx, store.BanOptions{
			IP:        ip,
			Reason:    req.GetReason(),
			ExpiresAt: expires,
		}); err != nil {
			return nil, err
		}
	}
	p.kick(ctx, userID, req.GetReason(), rostalkv1.ErrorCode_ERROR_CODE_BANNED)
	p.audit(ctx, a, "member.ban", userID, 0, 0,
		fmt.Sprintf("key=%t ip=%s reason=%q expires=%d", byKey, ip, req.GetReason(), req.GetExpiresInSeconds()))
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Ok{Ok: true}}, nil
}

func (p *Plane) adminUnban(ctx context.Context, a actor, req *rostalkv1.MemberUnban) (*rostalkv1.AdminResult, error) {
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_BAN, 0) {
		return nil, roles.ErrPermissionDenied
	}
	if req.GetUserId() == 0 && req.GetIp() == "" {
		return nil, fmt.Errorf("%w: unban needs a user or an address", errInvalidRequest)
	}
	if req.GetUserId() != 0 {
		user, err := p.store.UserByID(ctx, int64(req.GetUserId()))
		if err != nil {
			return nil, err
		}
		if err := p.store.RemoveBanByPublicKey(ctx, user.PublicKey); err != nil {
			return nil, err
		}
	}
	if req.GetIp() != "" {
		if err := p.store.RemoveBanByIP(ctx, req.GetIp()); err != nil {
			return nil, err
		}
	}
	p.audit(ctx, a, "member.unban", int64(req.GetUserId()), 0, 0, req.GetIp())
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Ok{Ok: true}}, nil
}

// ------------------------------------------------------------------ move ---

func (p *Plane) adminMove(ctx context.Context, a actor, req *rostalkv1.MemberMove) (*rostalkv1.AdminResult, error) {
	userID := int64(req.GetUserId())
	channelID := req.GetChannelId()
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_MOVE_MEMBERS, 0) ||
		!p.roles.CanActOnSubject(a.subject, userID) {
		return nil, roles.ErrHierarchy
	}
	if err := p.moveUser(ctx, userID, channelID, true); err != nil {
		return nil, err
	}
	p.audit(ctx, a, "member.move", userID, int64(channelID), 0, "")
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Ok{Ok: true}}, nil
}

// moveUser moves a user after checking the destination the way a join does.
func (p *Plane) moveUser(ctx context.Context, userID int64, channelID uint64, moderator bool) error {
	if channelID != 0 {
		channel, ok := p.channels.Get(int64(channelID))
		if !ok {
			return store.ErrNotFound
		}
		if !p.roles.Can(userID, rostalkv1.Permission_PERMISSION_VIEW_CHANNEL, channelID) ||
			!p.roles.Can(userID, rostalkv1.Permission_PERMISSION_JOIN_CHANNEL, channelID) {
			return roles.ErrPermissionDenied
		}
		// A move is a join performed by somebody else. The destination's
		// password still applies to the user being moved: otherwise a
		// moderator could place a member in a protected channel without the
		// password and the member would then get media credentials for it.
		if channel.HasPassword() &&
			!p.roles.Can(userID, rostalkv1.Permission_PERMISSION_BYPASS_CHANNEL_PASSWORD, channelID) {
			return roles.ErrPermissionDenied
		}
		if channel.Kind != rostalkv1.ChannelKind_CHANNEL_KIND_VOICE && moderator {
			return fmt.Errorf("%w: text channels do not take voice participants", errInvalidRequest)
		}
		limit := channel.UserLimit
		if limit > 0 && p.roles.Can(userID, rostalkv1.Permission_PERMISSION_BYPASS_USER_LIMIT, channelID) {
			limit = 0
		}
		result, err := p.hub.Move(userID, channelID, limit)
		if err != nil {
			return err
		}
		// The idle-channel policy is not tied to a client-initiated join: a
		// moderator move into AFK must mute the microphone just like joining
		// it, and a move out must restore the user's own flag.
		if channel.AFK {
			p.enterIdleChannel(ctx, userID, channelID)
		} else {
			p.leaveIdleChannel(ctx, userID, 0)
		}
		if result.FromChannelID != 0 && result.FromChannelID != channelID {
			_ = p.removeMediaParticipants(ctx, result.FromChannelID, userID)
		}
		return nil
	}
	result, err := p.hub.Move(userID, 0, 0)
	if err != nil {
		return err
	}
	p.leaveIdleChannel(ctx, userID, 0)
	if result.FromChannelID != 0 {
		_ = p.removeMediaParticipants(ctx, result.FromChannelID, userID)
	}
	return nil
}

// ------------------------------------------------------ mute and deafen ---

func (p *Plane) adminSetMuted(ctx context.Context, a actor, req *rostalkv1.MemberSetMuted) (*rostalkv1.AdminResult, error) {
	userID := int64(req.GetUserId())
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_MUTE_MEMBERS, 0) ||
		!p.roles.CanActOnSubject(a.subject, userID) {
		return nil, roles.ErrHierarchy
	}
	if err := p.SetServerMuted(ctx, userID, req.GetMuted()); err != nil {
		return nil, err
	}
	p.audit(ctx, a, "member.mute", userID, 0, 0, fmt.Sprintf("muted=%t", req.GetMuted()))
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Ok{Ok: true}}, nil
}

func (p *Plane) adminSetDeafened(ctx context.Context, a actor, req *rostalkv1.MemberSetDeafened) (*rostalkv1.AdminResult, error) {
	userID := int64(req.GetUserId())
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_DEAFEN_MEMBERS, 0) ||
		!p.roles.CanActOnSubject(a.subject, userID) {
		return nil, roles.ErrHierarchy
	}
	if err := p.SetServerDeafened(ctx, userID, req.GetDeafened()); err != nil {
		return nil, err
	}
	p.audit(ctx, a, "member.deafen", userID, 0, 0, fmt.Sprintf("deafened=%t", req.GetDeafened()))
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Ok{Ok: true}}, nil
}

func (p *Plane) adminStopStream(ctx context.Context, a actor, req *rostalkv1.MemberStopStream) (*rostalkv1.AdminResult, error) {
	userID := int64(req.GetUserId())
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_MUTE_MEMBERS, 0) ||
		!p.roles.CanActOnSubject(a.subject, userID) {
		return nil, roles.ErrHierarchy
	}
	presence, ok := p.hub.Presence(userID)
	if !ok {
		return nil, state.ErrNotOnline
	}
	if presence.ChannelID != 0 {
		room := media.RoomName(presence.ChannelID)
		err := p.media.RemoveParticipant(ctx, room, media.IdentityFor(userID, media.KindStream))
		if err != nil && !errors.Is(err, media.ErrNotFound) {
			return nil, err
		}
		// The stream audio comes from the voice participant (ADR 0027).
		// Withdrawing the source makes the SFU remove the published track;
		// handing it back right away lets the user start a new stream, which
		// the stream right still allows (this is a stop, not a revoke).
		voice := media.IdentityFor(userID, media.KindVoice)
		err = p.media.SetPublishSource(ctx, room, voice, media.SourceScreenShareAudio, false)
		if err != nil && !errors.Is(err, media.ErrNotFound) {
			return nil, err
		}
		if p.voiceStreamAudioAllowed(userID, presence.ChannelID) {
			err = p.media.SetPublishSource(ctx, room, voice, media.SourceScreenShareAudio, true)
			if err != nil && !errors.Is(err, media.ErrNotFound) {
				return nil, err
			}
		}
	}
	if _, err := p.hub.SetStreaming(userID, false); err != nil && !errors.Is(err, state.ErrNotOnline) {
		return nil, err
	}
	p.audit(ctx, a, "member.stop_stream", userID, 0, 0, "")
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Ok{Ok: true}}, nil
}

// ---------------------------------------------------------------- audit ---

func (p *Plane) adminAuditList(ctx context.Context, a actor, req *rostalkv1.AuditList) (*rostalkv1.AdminResult, error) {
	if !p.roles.CanSubject(a.subject, rostalkv1.Permission_PERMISSION_VIEW_AUDIT_LOG, 0) {
		return nil, roles.ErrPermissionDenied
	}
	limit := int(req.GetLimit())
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	before := int64(req.GetBeforeId())
	entries, err := p.store.AuditPageFiltered(ctx, before, limit+1,
		strings.TrimSpace(req.GetActionPrefix()), int64(req.GetActorId()))
	if err != nil {
		return nil, err
	}
	hasMore := len(entries) > limit
	if hasMore {
		entries = entries[:limit]
	}
	page := &rostalkv1.AuditPage{Entries: make([]*rostalkv1.AuditEntry, 0, len(entries))}
	for _, entry := range entries {
		page.Entries = append(page.Entries, auditEntryProto(entry))
	}
	if hasMore && len(entries) > 0 {
		page.HasMore = true
		page.NextBeforeId = uint64(entries[len(entries)-1].ID)
	}
	return &rostalkv1.AdminResult{Result: &rostalkv1.AdminResult_Audit{Audit: page}}, nil
}

func (p *Plane) audit(ctx context.Context, a actor, action string, targetUser, targetChannel, targetRole int64, details string) {
	if _, err := p.store.AddAuditEntry(ctx, store.AuditOptions{
		ActorID:         a.userID,
		ActorName:       a.name,
		Action:          action,
		TargetUserID:    targetUser,
		TargetChannelID: targetChannel,
		TargetRoleID:    targetRole,
		Details:         details,
	}); err != nil {
		// Auditing must not break the action itself, but a missing entry is a
		// real problem the operator has to see.
		p.logger.Error("could not write the audit log", "action", action, "error", err)
	}
}

// ------------------------------------------------- permission recalculation ---

type visibilityState map[int64]map[uint64]bool

// captureVisibility records which channels every online user can see. It is
// taken before a role or override change so the difference can be announced.
func (p *Plane) captureVisibility() visibilityState {
	channels := p.channels.List()
	users := p.hub.SnapshotUsers()
	out := make(visibilityState, len(users))
	for _, user := range users {
		seen := make(map[uint64]bool, len(channels))
		for _, channel := range channels {
			seen[uint64(channel.ID)] = p.roles.CanView(user.UserID, uint64(channel.ID))
		}
		out[user.UserID] = seen
	}
	return out
}

// afterRoleChange announces the new role list and applies the new permissions
// to every online user: session roles, visible channels, channel membership and
// media grants.
func (p *Plane) afterRoleChange(ctx context.Context, before visibilityState) {
	p.hub.Broadcast(&rostalkv1.Event{
		Payload: &rostalkv1.Event_RolesUpdated{RolesUpdated: &rostalkv1.RolesUpdated{
			Roles: roleListProto(p.roles.Roles()),
		}},
	})
	p.applyPermissionChanges(ctx, before)
}

func (p *Plane) applyPermissionChanges(ctx context.Context, before visibilityState) {
	channels := p.channels.List()
	users := p.hub.SnapshotUsers()

	// Roles are part of the user state; refresh them before announcing moves.
	for _, user := range users {
		if _, err := p.hub.SetRoles(user.UserID, p.roles.RoleIDs(user.UserID)); err != nil &&
			!errors.Is(err, state.ErrNotOnline) {
			p.logger.Warn("could not update the session roles", "user_id", user.UserID, "error", err)
		}
	}

	for _, user := range users {
		userID := user.UserID
		presence, online := p.hub.Presence(userID)
		if !online {
			continue
		}
		current := presence.ChannelID
		if current != 0 &&
			(!p.roles.Can(userID, rostalkv1.Permission_PERMISSION_VIEW_CHANNEL, current) ||
				!p.roles.Can(userID, rostalkv1.Permission_PERMISSION_JOIN_CHANNEL, current)) {
			p.evictToDefault(ctx, userID, current)
		}

		previous := before[userID]
		for _, channel := range channels {
			channelID := uint64(channel.ID)
			wasVisible := previous[channelID]
			isVisible := p.roles.CanView(userID, channelID)
			switch {
			case wasVisible && !isVisible:
				p.sendSelfEvent(userID, &rostalkv1.Event{
					Payload: &rostalkv1.Event_ChannelDeleted{ChannelDeleted: &rostalkv1.ChannelDeleted{
						ChannelId: channelID,
					}},
				})
				for _, other := range users {
					if other.UserID != userID && other.ChannelID == channelID {
						p.sendSelfEvent(userID, &rostalkv1.Event{
							Payload: &rostalkv1.Event_UserLeft{UserLeft: &rostalkv1.UserLeft{
								UserId: uint64(other.UserID),
							}},
						})
					}
				}
			case !wasVisible && isVisible:
				p.sendSelfEvent(userID, &rostalkv1.Event{
					Payload: &rostalkv1.Event_ChannelCreated{ChannelCreated: &rostalkv1.ChannelCreated{
						Channel: channel.Proto(p.channelCount(channelID)),
					}},
				})
				for _, other := range users {
					if other.ChannelID != channelID {
						continue
					}
					if otherPresence, ok := p.hub.Presence(other.UserID); ok {
						p.sendSelfEvent(userID, &rostalkv1.Event{
							Payload: &rostalkv1.Event_UserJoined{UserJoined: &rostalkv1.UserJoined{
								User: otherPresence.Proto(),
							}},
						})
					}
				}
			}
		}
		p.sendSelfPermissions(userID)
		p.syncMedia(ctx, userID)
	}
}

// evictToDefault moves a user who lost access to their channel to the first
// visible and joinable voice channel, or to no channel when none exists.
func (p *Plane) evictToDefault(ctx context.Context, userID int64, from uint64) {
	target := p.defaultChannel(userID)
	if target == from {
		return
	}
	if _, err := p.hub.Move(userID, target, 0); err != nil && !errors.Is(err, state.ErrNotOnline) {
		p.logger.Warn("could not move a user out of a hidden channel",
			"user_id", userID, "channel_id", from, "error", err)
	}
	if target != 0 && p.channelIsAFK(target) {
		p.enterIdleChannel(ctx, userID, target)
	} else {
		p.leaveIdleChannel(ctx, userID, 0)
	}
	_ = p.removeMediaParticipants(ctx, from, userID)
	p.logger.Info("user lost channel access and was moved",
		"user_id", userID, "from_channel_id", from, "to_channel_id", target)
}

func (p *Plane) defaultChannel(userID int64) uint64 {
	for _, channel := range p.channels.List() {
		if channel.Kind != rostalkv1.ChannelKind_CHANNEL_KIND_VOICE {
			continue
		}
		channelID := uint64(channel.ID)
		if !p.roles.Can(userID, rostalkv1.Permission_PERMISSION_VIEW_CHANNEL, channelID) ||
			!p.roles.Can(userID, rostalkv1.Permission_PERMISSION_JOIN_CHANNEL, channelID) {
			continue
		}
		// An automatic move must respect the channel password too: the user
		// cannot answer a password prompt while being evicted.
		if channel.HasPassword() &&
			!p.roles.Can(userID, rostalkv1.Permission_PERMISSION_BYPASS_CHANNEL_PASSWORD, channelID) {
			continue
		}
		return channelID
	}
	return 0
}

func (p *Plane) channelCount(channelID uint64) uint32 {
	return uint32(p.hub.ChannelCount(channelID))
}

// syncMedia brings the LiveKit grants of one online user in line with the new
// permissions: speak controls canPublish, stream controls the screen-share
// participant, and server deafen controls canSubscribe.
func (p *Plane) syncMedia(ctx context.Context, userID int64) {
	presence, ok := p.hub.Presence(userID)
	if !ok || presence.ChannelID == 0 {
		return
	}
	channelID := presence.ChannelID
	room := media.RoomName(channelID)
	voice := media.IdentityFor(userID, media.KindVoice)

	// Permission recalculation must not lift the idle-channel mute: the flag
	// lives on the channel, not in the role list (ADR 0009).
	canPublish := p.voiceMicrophoneAllowed(userID, channelID)
	mediaCtx, cancel := context.WithTimeout(ctx, mediaTimeout)
	err := p.media.SetPublishSource(mediaCtx, room, voice, media.SourceMicrophone, canPublish)
	cancel()
	if err != nil && !errors.Is(err, media.ErrNotFound) {
		p.logger.Warn("could not apply speak permission", "user_id", userID, "error", err)
	}

	// The core publishes the stream audio from the voice participant (ADR
	// 0027); the stream right controls that source live, and the SFU removes
	// an already published track when the right is gone.
	mediaCtx, cancel = context.WithTimeout(ctx, mediaTimeout)
	err = p.media.SetPublishSource(mediaCtx, room, voice, media.SourceScreenShareAudio,
		p.voiceStreamAudioAllowed(userID, channelID))
	cancel()
	if err != nil && !errors.Is(err, media.ErrNotFound) {
		p.logger.Warn("could not apply the stream audio permission", "user_id", userID, "error", err)
	}

	canSubscribe := !p.serverDeafened(userID)
	mediaCtx, cancel = context.WithTimeout(ctx, mediaTimeout)
	err = p.media.SetCanSubscribe(mediaCtx, room, voice, canSubscribe)
	cancel()
	if err != nil && !errors.Is(err, media.ErrNotFound) {
		p.logger.Warn("could not apply deafen permission", "user_id", userID, "error", err)
	}

	if presence.Streaming &&
		!p.roles.Can(userID, rostalkv1.Permission_PERMISSION_STREAM, channelID) {
		mediaCtx, cancel = context.WithTimeout(ctx, mediaTimeout)
		err = p.media.RemoveParticipant(mediaCtx, room, media.IdentityFor(userID, media.KindStream))
		cancel()
		if err != nil && !errors.Is(err, media.ErrNotFound) {
			p.logger.Warn("could not stop a stream after losing the permission",
				"user_id", userID, "error", err)
		}
		if _, err := p.hub.SetStreaming(userID, false); err != nil &&
			!errors.Is(err, state.ErrNotOnline) {
			p.logger.Warn("could not clear the stream flag", "user_id", userID, "error", err)
		}
	}
}

func (p *Plane) sendSelfEvent(userID int64, event *rostalkv1.Event) {
	if err := p.hub.SendToUser(userID, event); err != nil && !errors.Is(err, state.ErrNotOnline) {
		p.logger.Debug("could not send a personal event", "user_id", userID, "error", err)
	}
}

func (p *Plane) sendSelfPermissions(userID int64) {
	p.sendSelfEvent(userID, &rostalkv1.Event{
		Payload: &rostalkv1.Event_PermissionsUpdated{PermissionsUpdated: &rostalkv1.PermissionsUpdated{
			Permissions: p.myPermissions(userID),
		}},
	})
}

// myPermissions builds the per-user permission view used by Welcome and by the
// PermissionsUpdated event.
func (p *Plane) myPermissions(userID int64) *rostalkv1.MyPermissions {
	channelList := p.channels.List()
	perChannel := make([]*rostalkv1.ChannelPermissions, 0, len(channelList))
	for _, channel := range channelList {
		channelID := uint64(channel.ID)
		if !p.roles.CanView(userID, channelID) {
			continue
		}
		perChannel = append(perChannel, &rostalkv1.ChannelPermissions{
			ChannelId: channelID,
			Effective: &rostalkv1.PermissionSet{Permissions: p.roles.ChannelPermissions(userID, channelID)},
		})
	}
	return &rostalkv1.MyPermissions{
		Server:   &rostalkv1.PermissionSet{Permissions: p.roles.ServerPermissions(userID)},
		Channels: perChannel,
	}
}

func (p *Plane) serverInfo() *rostalkv1.ServerInfo {
	settings := p.settingsSnapshot()
	return &rostalkv1.ServerInfo{
		Name:               settings.ServerName,
		Version:            p.version,
		ProtocolVersion:    p.protocol,
		Id:                 append([]byte(nil), p.serverID[:]...),
		LoginMode:          loginMode(settings.LoginMode),
		MaxUsers:           settings.MaxUsers,
		OnlineUsers:        uint32(p.hub.Count()),
		PasswordSet:        settings.ServerPassword != "",
		MaxAttachmentBytes: uint64(settings.MaxAttachmentBytesOrDefault()),
	}
}

// ---------------------------------------------------------- conversions ---

func roleProto(role perms.Role) *rostalkv1.Role {
	return &rostalkv1.Role{
		Id:          uint64(role.ID),
		Name:        role.Name,
		Color:       role.Color,
		Position:    role.Position,
		Permissions: &rostalkv1.PermissionSet{Permissions: perms.ToPermissions(role.Permissions)},
		Builtin:     role.Builtin,
	}
}

func roleListProto(list []perms.Role) []*rostalkv1.Role {
	out := make([]*rostalkv1.Role, 0, len(list))
	for _, role := range list {
		out = append(out, roleProto(role))
	}
	return out
}

func permissionsOf(set *rostalkv1.PermissionSet) []rostalkv1.Permission {
	if set == nil {
		return nil
	}
	return set.GetPermissions()
}

func permissionsString(set *rostalkv1.PermissionSet) string {
	if set == nil {
		return ""
	}
	names := make([]string, 0, len(set.GetPermissions()))
	for _, permission := range set.GetPermissions() {
		names = append(names, permission.String())
	}
	sort.Strings(names)
	return strings.Join(names, ",")
}

func overrideProto(channelID uint64, override perms.Override) *rostalkv1.ChannelOverride {
	return &rostalkv1.ChannelOverride{
		ChannelId: channelID,
		RoleId:    uint64(override.RoleID),
		Allow:     &rostalkv1.PermissionSet{Permissions: perms.ToPermissions(override.Allow)},
		Deny:      &rostalkv1.PermissionSet{Permissions: perms.ToPermissions(override.Deny)},
	}
}

func inviteProto(row db.Invite) *rostalkv1.Invite {
	invite := &rostalkv1.Invite{
		Id:              uint64(row.ID),
		CreatedBy:       uint64(nullInt64(row.CreatedBy)),
		RoleId:          uint64(nullInt64(row.RoleID)),
		CreatedAtUnixMs: row.CreatedAt,
		MaxUses:         uint32(row.MaxUses),
		UsedCount:       uint32(row.UsedCount),
	}
	if row.ExpiresAt.Valid {
		invite.ExpiresAtUnixMs = row.ExpiresAt.Int64
	}
	if row.RevokedAt.Valid {
		invite.RevokedAtUnixMs = row.RevokedAt.Int64
	}
	return invite
}

func apiTokenProto(token store.APIToken, plaintext string) *rostalkv1.ApiToken {
	out := &rostalkv1.ApiToken{
		Id:              uint64(token.ID),
		Name:            token.Name,
		RoleId:          uint64(token.RoleID),
		CreatedBy:       uint64(token.CreatedBy),
		CreatedAtUnixMs: token.CreatedAt.UnixMilli(),
		Token:           plaintext,
	}
	if token.ExpiresAt != nil {
		out.ExpiresAtUnixMs = token.ExpiresAt.UnixMilli()
	}
	if token.RevokedAt != nil {
		out.RevokedAtUnixMs = token.RevokedAt.UnixMilli()
	}
	if token.LastUsedAt != nil {
		out.LastUsedAtUnixMs = token.LastUsedAt.UnixMilli()
	}
	return out
}

func uint64s(ids []int64) []uint64 {
	out := make([]uint64, 0, len(ids))
	for _, id := range ids {
		if id > 0 {
			out = append(out, uint64(id))
		}
	}
	return out
}

func auditEntryProto(entry store.AuditEntry) *rostalkv1.AuditEntry {
	return &rostalkv1.AuditEntry{
		Id:              uint64(entry.ID),
		ActorId:         uint64(entry.ActorID),
		ActorName:       entry.ActorName,
		Action:          entry.Action,
		TargetUserId:    uint64(entry.TargetUserID),
		TargetChannelId: uint64(entry.TargetChannelID),
		TargetRoleId:    uint64(entry.TargetRoleID),
		Details:         entry.Details,
		CreatedAtUnixMs: entry.CreatedAt.UnixMilli(),
	}
}

func settingsPatchString(req *rostalkv1.ServerSettingsSet) string {
	parts := make([]string, 0, 4)
	if req.Name != nil {
		parts = append(parts, "name")
	}
	if req.LoginMode != nil {
		parts = append(parts, "login_mode="+req.GetLoginMode().String())
	}
	if req.MaxUsers != nil {
		parts = append(parts, fmt.Sprintf("max_users=%d", req.GetMaxUsers()))
	}
	if req.MaxAttachmentBytes != nil {
		parts = append(parts, fmt.Sprintf("max_attachment_bytes=%d", req.GetMaxAttachmentBytes()))
	}
	if req.Password != nil {
		// Never record the value, only the fact that it changed.
		parts = append(parts, "password=changed")
	}
	return strings.Join(parts, " ")
}

func loginModeName(mode rostalkv1.LoginMode) (string, error) {
	switch mode {
	case rostalkv1.LoginMode_LOGIN_MODE_INVITE, rostalkv1.LoginMode_LOGIN_MODE_UNSPECIFIED:
		return "invite", nil
	case rostalkv1.LoginMode_LOGIN_MODE_PASSWORD:
		return "password", nil
	case rostalkv1.LoginMode_LOGIN_MODE_OPEN:
		return "open", nil
	default:
		return "", fmt.Errorf("%w: unknown login mode %d", errInvalidRequest, mode)
	}
}

func (p *Plane) replyAdminError(session *state.Session, requestID uint64, err error) {
	code := rostalkv1.ErrorCode_ERROR_CODE_INTERNAL
	switch {
	case errors.Is(err, roles.ErrPermissionDenied), errors.Is(err, roles.ErrHierarchy):
		code = rostalkv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED
		if errors.Is(err, roles.ErrHierarchy) {
			code = rostalkv1.ErrorCode_ERROR_CODE_HIERARCHY
		}
	case errors.Is(err, store.ErrNotFound), errors.Is(err, roles.ErrNotFound),
		errors.Is(err, channels.ErrNotFound), errors.Is(err, channels.ErrParentNotFound),
		errors.Is(err, state.ErrNotOnline):
		code = rostalkv1.ErrorCode_ERROR_CODE_NOT_FOUND
	case errors.Is(err, roles.ErrDuplicateName), errors.Is(err, errInvalidRequest),
		errors.Is(err, roles.ErrInvalidName), errors.Is(err, roles.ErrInvalidPosition),
		errors.Is(err, channels.ErrInvalidName), errors.Is(err, channels.ErrInvalidTopic),
		errors.Is(err, channels.ErrInvalidKind), errors.Is(err, channels.ErrInvalidVoiceProfile),
		errors.Is(err, channels.ErrCycle):
		code = rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST
	case errors.Is(err, roles.ErrBuiltin), errors.Is(err, roles.ErrSelfLockout),
		errors.Is(err, state.ErrChannelFull), errors.Is(err, ErrChannelOccupied):
		code = rostalkv1.ErrorCode_ERROR_CODE_REJECTED
	}
	if code == rostalkv1.ErrorCode_ERROR_CODE_INTERNAL {
		p.logger.Error("admin action failed", "user_id", session.UserID(), "error", err)
		p.replyError(session, requestID, code, "the action could not be completed")
		return
	}
	p.replyError(session, requestID, code, err.Error())
}

// ------------------------------------------------------------- CLI bridge ---

// InviteParams describes an invite created through the local admin socket.
type InviteParams struct {
	RoleName   string
	MaxUses    int
	ExpiresIn  time.Duration
	GrantAdmin bool
}

// CLIInvite creates an invite for the local admin socket and returns the join
// link. The plaintext token appears only in the link.
func (p *Plane) CLIInvite(ctx context.Context, params InviteParams) (string, error) {
	roleID := p.roles.DefaultRoleID()
	if params.RoleName != "" {
		role, ok := p.roles.RoleByName(params.RoleName)
		if !ok {
			return "", fmt.Errorf("%w: role %q", roles.ErrNotFound, params.RoleName)
		}
		roleID = role.ID
	}
	if params.GrantAdmin {
		roleID = p.roles.AdminRoleID()
	}
	var expires uint32
	if params.ExpiresIn > 0 {
		expires = uint32(params.ExpiresIn / time.Second)
	}
	uses := params.MaxUses
	if uses <= 0 {
		uses = DefaultInviteMaxUses
	}
	_, url, err := p.createInvite(ctx, cliActor, roleID, uint32(uses), expires)
	return url, err
}

// UserSummary is one row of the local `admin user list`.
type UserSummary struct {
	ID         int64
	Nickname   string
	RoleIDs    []int64
	RoleNames  []string
	Online     bool
	LastSeenAt time.Time
}

// CLIUsers lists every known user for the local admin socket.
func (p *Plane) CLIUsers(ctx context.Context) ([]UserSummary, error) {
	users, err := p.store.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	online := make(map[int64]bool)
	for _, presence := range p.hub.SnapshotUsers() {
		online[presence.UserID] = true
	}
	out := make([]UserSummary, 0, len(users))
	for _, user := range users {
		roleIDs := p.roles.RoleIDs(user.ID)
		roleNames := make([]string, 0, len(roleIDs))
		for _, roleID := range roleIDs {
			if role, ok := p.roles.RoleByID(roleID); ok {
				roleNames = append(roleNames, role.Name)
			}
		}
		out = append(out, UserSummary{
			ID:         user.ID,
			Nickname:   user.Nickname,
			RoleIDs:    roleIDs,
			RoleNames:  roleNames,
			Online:     online[user.ID],
			LastSeenAt: time.UnixMilli(user.LastSeenAt).UTC(),
		})
	}
	return out, nil
}

// BanParams describes a ban created through the local admin socket.
type BanParams struct {
	UserID       int64
	PublicKeyHex string
	IP           string
	Reason       string
	Duration     time.Duration
	ByIP         bool
}

// CLIBan bans a key, an address or both from the local admin socket.
func (p *Plane) CLIBan(ctx context.Context, params BanParams) error {
	var expires *time.Time
	if params.Duration > 0 {
		deadline := p.now().Add(params.Duration)
		expires = &deadline
	}
	var publicKey []byte
	if params.UserID != 0 {
		user, err := p.store.UserByID(ctx, params.UserID)
		if err != nil {
			return err
		}
		publicKey = user.PublicKey
	}
	if params.PublicKeyHex != "" {
		decoded, err := hex.DecodeString(params.PublicKeyHex)
		if err != nil || len(decoded) != 32 {
			return fmt.Errorf("%w: public key must be 32 bytes of hex", errInvalidRequest)
		}
		publicKey = decoded
	}
	if len(publicKey) == 0 && params.IP == "" {
		return fmt.Errorf("%w: ban needs a user, a key or an address", errInvalidRequest)
	}
	if len(publicKey) > 0 {
		if err := p.store.AddBan(ctx, store.BanOptions{
			PublicKey: publicKey,
			Reason:    params.Reason,
			ExpiresAt: expires,
		}); err != nil {
			return err
		}
	}
	if params.IP != "" {
		if err := p.store.AddBan(ctx, store.BanOptions{
			IP:        params.IP,
			Reason:    params.Reason,
			ExpiresAt: expires,
		}); err != nil {
			return err
		}
	}
	if params.UserID != 0 {
		p.kick(ctx, params.UserID, params.Reason, rostalkv1.ErrorCode_ERROR_CODE_BANNED)
	}
	ip := params.IP
	p.audit(ctx, cliActor, "member.ban", params.UserID, 0, 0,
		fmt.Sprintf("key=%t ip=%s reason=%q", len(publicKey) > 0, ip, params.Reason))
	return nil
}

// CLIUnban lifts a ban by user id, key or address.
func (p *Plane) CLIUnban(ctx context.Context, userID int64, publicKeyHex, ip string) error {
	var publicKey []byte
	if userID != 0 {
		user, err := p.store.UserByID(ctx, userID)
		if err != nil {
			return err
		}
		publicKey = user.PublicKey
	}
	if publicKeyHex != "" {
		decoded, err := hex.DecodeString(publicKeyHex)
		if err != nil || len(decoded) != 32 {
			return fmt.Errorf("%w: public key must be 32 bytes of hex", errInvalidRequest)
		}
		publicKey = decoded
	}
	if len(publicKey) == 0 && ip == "" {
		return fmt.Errorf("%w: unban needs a user, a key or an address", errInvalidRequest)
	}
	if len(publicKey) > 0 {
		if err := p.store.RemoveBanByPublicKey(ctx, publicKey); err != nil {
			return err
		}
	}
	if ip != "" {
		if err := p.store.RemoveBanByIP(ctx, ip); err != nil {
			return err
		}
	}
	p.audit(ctx, cliActor, "member.unban", userID, 0, 0, ip)
	return nil
}

// CLISettings returns the current settings for `admin settings get`.
func (p *Plane) CLISettings(ctx context.Context) (store.Settings, error) {
	return p.store.Settings(ctx)
}

// refreshSettings reloads the cached settings after a plain key/value change
// (retention and attachment limits) without announcing a new ServerInfo.
func (p *Plane) refreshSettings(ctx context.Context) error {
	settings, err := p.store.Settings(ctx)
	if err != nil {
		return err
	}
	p.settingsMu.Lock()
	p.settings = settings
	p.settingsMu.Unlock()
	if p.onSettingsChange != nil {
		p.onSettingsChange(settings)
	}
	return nil
}

// CLISetSetting changes one setting from `admin settings set`. The password is
// hashed; every other value is stored as text after validation.
func (p *Plane) CLISetSetting(ctx context.Context, key, value string) error {
	switch key {
	case "server_name":
		v := value
		if err := p.applySettings(ctx, settingsPatch{Name: &v}); err != nil {
			return err
		}
	case "login_mode":
		var mode rostalkv1.LoginMode
		switch strings.ToLower(value) {
		case "invite":
			mode = rostalkv1.LoginMode_LOGIN_MODE_INVITE
		case "password":
			mode = rostalkv1.LoginMode_LOGIN_MODE_PASSWORD
		case "open":
			mode = rostalkv1.LoginMode_LOGIN_MODE_OPEN
		default:
			return fmt.Errorf("%w: login_mode must be invite, password or open", errInvalidRequest)
		}
		if err := p.applySettings(ctx, settingsPatch{LoginMode: &mode}); err != nil {
			return err
		}
	case "max_users":
		var parsed int64
		if _, err := fmt.Sscan(value, &parsed); err != nil || parsed < 0 || parsed > math.MaxUint32 {
			return fmt.Errorf("%w: max_users must be a non-negative integer", errInvalidRequest)
		}
		v := uint32(parsed)
		if err := p.applySettings(ctx, settingsPatch{MaxUsers: &v}); err != nil {
			return err
		}
	case "server_password":
		v := value
		if err := p.applySettings(ctx, settingsPatch{Password: &v, HasPassword: true}); err != nil {
			return err
		}
	case "message_retention_days":
		var parsed int
		if _, err := fmt.Sscan(value, &parsed); err != nil || parsed < 0 {
			return fmt.Errorf("%w: message_retention_days must be a non-negative integer", errInvalidRequest)
		}
		if err := p.store.SetSetting(ctx, key, strconv.Itoa(parsed)); err != nil {
			return err
		}
		return p.refreshSettings(ctx)
	case "max_attachment_bytes", "attachment_quota_bytes":
		var parsed int64
		if _, err := fmt.Sscan(value, &parsed); err != nil || parsed <= 0 {
			return fmt.Errorf("%w: %s must be a positive integer", errInvalidRequest, key)
		}
		if key == "max_attachment_bytes" {
			// The CLI and the admin API share one range so an operator cannot
			// set a value the UI would refuse to show.
			if err := validateAttachmentLimit(parsed); err != nil {
				return err
			}
		}
		if err := p.store.SetSetting(ctx, key, strconv.FormatInt(parsed, 10)); err != nil {
			return err
		}
		return p.refreshSettings(ctx)
	default:
		return fmt.Errorf("%w: unknown setting %q", errInvalidRequest, key)
	}
	p.audit(ctx, cliActor, "settings.update", 0, 0, 0, "key="+key)
	return nil
}

// CLITokenCreate mints an API token from the local admin socket. The plaintext
// token is returned once; only the hash is stored. An empty role name uses the
// default Member role.
func (p *Plane) CLITokenCreate(ctx context.Context, name, roleName string, expires time.Duration) (string, int64, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > maxTokenNameRunes ||
		strings.ContainsAny(name, "\x00\r\n\t") {
		return "", 0, fmt.Errorf("%w: token name must be 1..%d characters", errInvalidRequest, maxTokenNameRunes)
	}
	roleID := p.roles.DefaultRoleID()
	if roleName != "" {
		role, ok := p.roles.RoleByName(roleName)
		if !ok {
			return "", 0, fmt.Errorf("%w: role %q", roles.ErrNotFound, roleName)
		}
		roleID = role.ID
	}
	var expiresAt *time.Time
	if expires > 0 {
		deadline := p.now().Add(expires)
		expiresAt = &deadline
	}
	token, plaintext, err := p.store.CreateAPIToken(ctx, store.APITokenOptions{
		Name:      name,
		RoleID:    roleID,
		ExpiresAt: expiresAt,
	})
	if err != nil {
		return "", 0, err
	}
	p.audit(ctx, cliActor, "api_token.create", 0, 0, roleID,
		fmt.Sprintf("token=%d name=%q", token.ID, name))
	return plaintext, token.ID, nil
}

// CLITokenList lists API tokens without secrets for the local admin socket.
func (p *Plane) CLITokenList(ctx context.Context) ([]store.APIToken, error) {
	return p.store.ListAPITokens(ctx)
}

// LinkFor builds a join link from a plaintext token; the local socket uses it
// when the server config is not needed.
func (p *Plane) LinkFor(token string) string { return p.inviteURL(token) }

func nullInt64(value sql.NullInt64) int64 {
	if value.Valid {
		return value.Int64
	}
	return 0
}
