// Package roles owns the role model of the server: role definitions, the roles
// each user holds, channel overrides and the pure permission rules in
// internal/perms (design 4.4).
//
// The database is the source of truth. The service keeps a small in-memory copy
// so a permission check never touches SQLite; every mutation writes the
// database and reloads the copy. Callers announce the change (roles event,
// per-user permissions, media grants) after the mutation returns.
//
// Lock order: internal/state may call CanView under the hub lock, so this
// package must never call back into state.
package roles

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/perms"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

// Standard role names created by the migration. They are matched by name when
// the server needs a predictable baseline.
const (
	AdminName     = "Admin"
	ModeratorName = "Moderator"
	MemberName    = "Member"
	GuestName     = "Guest"
)

const maxRoleNameRunes = 64

// Errors callers map to protocol error codes.
var (
	ErrNotFound          = errors.New("role not found")
	ErrPermissionDenied  = errors.New("permission denied")
	ErrHierarchy         = errors.New("target is not below the actor")
	ErrBuiltin           = errors.New("built-in role cannot be renamed or deleted")
	ErrDuplicateName     = errors.New("role name is already used")
	ErrInvalidName       = errors.New("invalid role name")
	ErrInvalidPosition   = errors.New("invalid role position")
	ErrSelfLockout       = errors.New("the change would leave the server without an administrator")
	ErrOverrideYoungRole = errors.New("override refers to an unknown role")
)

// System is the actor used by the local admin socket. It holds every right and
// sits above every role.
var System = perms.Subject{
	UserID: perms.SystemUserID,
	Roles: []perms.Role{{
		ID:          0,
		Name:        "system",
		Position:    1 << 30,
		Permissions: perms.AllMask,
	}},
}

// Config wires the service.
type Config struct {
	Store  *store.Store
	Logger *slog.Logger
	// Now overrides the clock in tests.
	Now func() time.Time
}

// Service is the role model.
type Service struct {
	store  *store.Store
	logger *slog.Logger
	now    func() time.Time

	mu        sync.RWMutex
	roles     map[int64]perms.Role
	order     []int64
	userRoles map[int64][]int64
	overrides map[uint64]map[int64]perms.Override
	byName    map[string]int64
	defaultID int64
	adminID   int64
}

// Open loads roles, assignments and overrides.
func Open(ctx context.Context, cfg Config) (*Service, error) {
	if cfg.Store == nil {
		return nil, errors.New("roles: store is required")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	s := &Service{
		store:     cfg.Store,
		logger:    logger,
		now:       now,
		roles:     make(map[int64]perms.Role),
		userRoles: make(map[int64][]int64),
		overrides: make(map[uint64]map[int64]perms.Override),
		byName:    make(map[string]int64),
	}
	if err := s.reload(ctx); err != nil {
		return nil, err
	}
	if len(s.roles) == 0 {
		return nil, errors.New("roles: the database has no roles; the stage 3.1 migration did not run")
	}
	// Old databases may still carry the migration positions (0, 10, 50, 100).
	// Compact them once so a reorder can be expressed as indexes 0..n-1 and
	// the hierarchy rule stays unambiguous. normalizeLocked expects the write
	// lock.
	s.mu.Lock()
	err := s.normalizeLocked(ctx)
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return s, nil
}

// reload replaces the in-memory copy. The caller must not hold s.mu.
func (s *Service) reload(ctx context.Context) error {
	data, err := s.load(ctx)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.applyLocked(data)
	s.mu.Unlock()
	return nil
}

// reloadLocked replaces the in-memory copy. The caller holds s.mu for writing.
func (s *Service) reloadLocked(ctx context.Context) error {
	data, err := s.load(ctx)
	if err != nil {
		return err
	}
	s.applyLocked(data)
	return nil
}

type loaded struct {
	roles     map[int64]perms.Role
	order     []int64
	userRoles map[int64][]int64
	overrides map[uint64]map[int64]perms.Override
	byName    map[string]int64
}

func (s *Service) load(ctx context.Context) (loaded, error) {
	roleRows, err := s.store.ListRoles(ctx)
	if err != nil {
		return loaded{}, err
	}
	assignments, err := s.store.UserRoleAssignments(ctx)
	if err != nil {
		return loaded{}, err
	}
	overrideRows, err := s.store.ListChannelOverrides(ctx)
	if err != nil {
		return loaded{}, err
	}

	roleMap := make(map[int64]perms.Role, len(roleRows))
	order := make([]int64, 0, len(roleRows))
	byName := make(map[string]int64, len(roleRows))
	for _, row := range roleRows {
		roleMap[row.ID] = toPermRole(row)
		order = append(order, row.ID)
		byName[strings.ToLower(row.Name)] = row.ID
	}
	userRoles := make(map[int64][]int64, len(assignments))
	for _, assignment := range assignments {
		userRoles[assignment.UserID] = append(userRoles[assignment.UserID], assignment.RoleID)
	}
	for userID, roleIDs := range userRoles {
		userRoles[userID] = sortedRoleIDs(roleIDs, roleMap)
	}
	overrides := make(map[uint64]map[int64]perms.Override, len(overrideRows))
	for _, row := range overrideRows {
		channelID := uint64(row.ChannelID)
		if overrides[channelID] == nil {
			overrides[channelID] = make(map[int64]perms.Override)
		}
		overrides[channelID][row.RoleID] = perms.Override{
			RoleID: row.RoleID,
			Allow:  row.Allow,
			Deny:   row.Deny,
		}
	}

	return loaded{
		roles:     roleMap,
		order:     order,
		userRoles: userRoles,
		overrides: overrides,
		byName:    byName,
	}, nil
}

// applyLocked installs loaded data. The caller holds s.mu for writing.
func (s *Service) applyLocked(data loaded) {
	s.roles = data.roles
	s.order = data.order
	s.userRoles = data.userRoles
	s.overrides = data.overrides
	s.byName = data.byName
	s.defaultID = s.idByNameLocked(MemberName)
	s.adminID = s.idByNameLocked(AdminName)
}

func sortedRoleIDs(ids []int64, roleMap map[int64]perms.Role) []int64 {
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if _, ok := roleMap[id]; ok {
			out = append(out, id)
		}
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0; j-- {
			left, right := roleMap[out[j-1]], roleMap[out[j]]
			if left.Position < right.Position ||
				(left.Position == right.Position && left.ID <= right.ID) {
				break
			}
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}

func (s *Service) idByNameLocked(name string) int64 {
	return s.byName[strings.ToLower(name)]
}

// DefaultRoleID returns the Member role id, or 0 when it was deleted.
func (s *Service) DefaultRoleID() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.defaultID
}

// AdminRoleID returns the Admin role id, or 0 when it was deleted.
func (s *Service) AdminRoleID() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.adminID
}

// RoleByID returns a role.
func (s *Service) RoleByID(id int64) (perms.Role, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	role, ok := s.roles[id]
	return role, ok
}

// RoleByName returns a role by its case-insensitive name.
func (s *Service) RoleByName(name string) (perms.Role, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.byName[strings.ToLower(strings.TrimSpace(name))]
	if !ok {
		return perms.Role{}, false
	}
	role, ok := s.roles[id]
	return role, ok
}

// Roles returns every role in ascending position order.
func (s *Service) Roles() []perms.Role {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.rolesLocked()
}

func (s *Service) rolesLocked() []perms.Role {
	out := make([]perms.Role, 0, len(s.order))
	for _, id := range s.order {
		if role, ok := s.roles[id]; ok {
			out = append(out, role)
		}
	}
	return out
}

// Subject returns the role-carrying subject of a user.
func (s *Service) Subject(userID int64) perms.Subject {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.subjectLocked(userID)
}

func (s *Service) subjectLocked(userID int64) perms.Subject {
	subject := perms.Subject{UserID: userID}
	for _, roleID := range s.userRoles[userID] {
		if role, ok := s.roles[roleID]; ok {
			subject.Roles = append(subject.Roles, role)
		}
	}
	return subject
}

// RoleIDs returns the role ids of a user in ascending position order.
func (s *Service) RoleIDs(userID int64) []int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]int64(nil), s.userRoles[userID]...)
}

// HighestPosition returns the user's highest role position.
func (s *Service) HighestPosition(userID int64) int32 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return perms.HighestPosition(s.subjectLocked(userID))
}

// Can reports whether the user holds permission in a channel. Channel 0 means
// the server-wide check.
func (s *Service) Can(userID int64, permission rostalkv1.Permission, channelID uint64) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return perms.Allows(s.subjectLocked(userID), s.overridesLocked(channelID), permission, channelID)
}

// CanSubject is Can for an explicit subject. API tokens act as a role rather
// than a real user, so they cannot be looked up by user id.
func (s *Service) CanSubject(subject perms.Subject, permission rostalkv1.Permission, channelID uint64) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return perms.Allows(subject, s.overridesLocked(channelID), permission, channelID)
}

// SubjectOfRole builds the synthetic subject an API token acts as. The id is
// negative so it never collides with a real user; audit entries still use 0.
func (s *Service) SubjectOfRole(roleID int64) (perms.Subject, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	role, ok := s.roles[roleID]
	if !ok {
		return perms.Subject{}, false
	}
	return perms.Subject{UserID: -roleID, Roles: []perms.Role{role}}, true
}

// CanView reports whether the user may see a channel. Channel 0 (not in a
// channel) is always "visible" for user-list filtering.
func (s *Service) CanView(userID int64, channelID uint64) bool {
	if channelID == 0 {
		return true
	}
	return s.Can(userID, rostalkv1.Permission_PERMISSION_VIEW_CHANNEL, channelID)
}

// Effective returns the user's effective permission mask in one channel.
func (s *Service) Effective(userID int64, channelID uint64) uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return perms.Effective(s.subjectLocked(userID), s.overridesLocked(channelID), channelID)
}

// ServerPermissions returns the server-wide permission list of a user.
func (s *Service) ServerPermissions(userID int64) []rostalkv1.Permission {
	return perms.ServerList(s.Effective(userID, 0))
}

// ChannelPermissions returns the per-channel permission list of a user.
func (s *Service) ChannelPermissions(userID int64, channelID uint64) []rostalkv1.Permission {
	return perms.ChannelList(s.Effective(userID, channelID))
}

// CanActOn reports whether actor may moderate target.
func (s *Service) CanActOn(actor, target int64) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return perms.CanActOn(s.subjectLocked(actor), s.subjectLocked(target))
}

// CanActOnSubject is CanActOn for an explicit actor subject.
func (s *Service) CanActOnSubject(actor perms.Subject, target int64) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return perms.CanActOn(actor, s.subjectLocked(target))
}

// CanManageRoleSubject reports whether an explicit actor may edit or move a
// role. API tokens use it instead of a user id.
func (s *Service) CanManageRoleSubject(actor perms.Subject, roleID int64, newPosition *int32) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	role, ok := s.roles[roleID]
	if !ok {
		return false
	}
	return perms.CanManageRole(actor, role, newPosition)
}

// overridesLocked returns the overrides of one channel, nil for channel 0.
func (s *Service) overridesLocked(channelID uint64) []perms.Override {
	if channelID == 0 {
		return nil
	}
	byRole := s.overrides[channelID]
	if len(byRole) == 0 {
		return nil
	}
	out := make([]perms.Override, 0, len(byRole))
	for _, override := range byRole {
		out = append(out, override)
	}
	return out
}

// ChannelOverrides returns the overrides of one channel.
func (s *Service) ChannelOverrides(channelID uint64) []perms.Override {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.overridesLocked(channelID)
}

// CreateParams describes a new role.
type CreateParams struct {
	Name        string
	Color       uint32
	Position    *int32
	Permissions []rostalkv1.Permission
}

// UpdateParams changes a role. Nil fields keep their value.
type UpdateParams struct {
	Name        *string
	Color       *uint32
	Position    *int32
	Permissions *[]rostalkv1.Permission
}

// Create adds a role.
func (s *Service) Create(ctx context.Context, actor perms.Subject, params CreateParams) (perms.Role, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.canManageRolesLocked(actor) {
		return perms.Role{}, ErrPermissionDenied
	}
	name, err := validateName(params.Name)
	if err != nil {
		return perms.Role{}, err
	}
	if _, exists := s.byName[strings.ToLower(name)]; exists {
		return perms.Role{}, ErrDuplicateName
	}
	position := int32(0)
	if params.Position != nil {
		position = *params.Position
	}
	if position < 0 {
		return perms.Role{}, ErrInvalidPosition
	}
	if !perms.CanCreateRole(actor, position) {
		return perms.Role{}, ErrHierarchy
	}
	permissionMask := perms.Mask(params.Permissions...)
	if !CanGrant(actor, permissionMask) {
		return perms.Role{}, ErrPermissionDenied
	}
	// Ties keep the higher id later, so the new role lands after every role
	// with a position at or below the requested one. Reject an insertion that
	// would push the new role to the caller's own position.
	if !perms.HasManageServer(actor) {
		rank := 0
		for _, existing := range s.roles {
			if existing.Position <= position {
				rank++
			}
		}
		if rank >= int(perms.HighestPosition(actor)) {
			return perms.Role{}, ErrHierarchy
		}
	}
	role, err := s.store.InsertRole(ctx, store.Role{
		Name:        name,
		Color:       params.Color,
		Position:    position,
		Permissions: permissionMask,
	})
	if err != nil {
		if isUniqueViolation(err) {
			return perms.Role{}, ErrDuplicateName
		}
		return perms.Role{}, err
	}
	if err := s.reloadLocked(ctx); err != nil {
		return perms.Role{}, err
	}
	if err := s.normalizeLocked(ctx); err != nil {
		return perms.Role{}, err
	}
	s.logger.Info("role created", "role_id", role.ID, "name", name)
	return s.roles[role.ID], nil
}

// normalizeLocked compacts positions to 0..n-1 while keeping the order, so two
// roles never share a position and the hierarchy rule stays unambiguous.
func (s *Service) normalizeLocked(ctx context.Context) error {
	roles := s.rolesLocked()
	changed := false
	storeRoles := make([]store.Role, 0, len(roles))
	for index := range roles {
		if roles[index].Position != int32(index) {
			changed = true
		}
		storeRoles = append(storeRoles, store.Role{ID: roles[index].ID, Position: int32(index)})
	}
	if !changed {
		return nil
	}
	if err := s.store.SetRolePositions(ctx, storeRoles); err != nil {
		return err
	}
	return s.reloadLocked(ctx)
}

// Update changes a role.
func (s *Service) Update(ctx context.Context, actor perms.Subject, roleID int64, params UpdateParams) (perms.Role, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.canManageRolesLocked(actor) {
		return perms.Role{}, ErrPermissionDenied
	}
	current, ok := s.roles[roleID]
	if !ok {
		return perms.Role{}, ErrNotFound
	}
	if !perms.CanManageRole(actor, current, params.Position) {
		return perms.Role{}, ErrHierarchy
	}
	updated := current
	if params.Name != nil {
		name, err := validateName(*params.Name)
		if err != nil {
			return perms.Role{}, err
		}
		// GrantAdmin and the default-role lookup are resolved by name when the
		// service starts. Renaming a built-in role would silently break them
		// (and the well-known Admin/Member contract), so the name is immutable.
		if current.Builtin && name != current.Name {
			return perms.Role{}, ErrBuiltin
		}
		otherID, exists := s.byName[strings.ToLower(name)]
		if exists && otherID != roleID {
			return perms.Role{}, ErrDuplicateName
		}
		updated.Name = name
	}
	if params.Color != nil {
		updated.Color = *params.Color
	}
	if params.Position != nil {
		if *params.Position < 0 {
			return perms.Role{}, ErrInvalidPosition
		}
		if !perms.HasManageServer(actor) {
			rank := 0
			for _, existing := range s.roles {
				if existing.ID == roleID {
					continue
				}
				if existing.Position < *params.Position ||
					(existing.Position == *params.Position && existing.ID < roleID) {
					rank++
				}
			}
			if rank >= int(perms.HighestPosition(actor)) {
				return perms.Role{}, ErrHierarchy
			}
		}
		updated.Position = *params.Position
	}
	if params.Permissions != nil {
		mask := perms.Mask(*params.Permissions...)
		if !CanGrant(actor, mask) {
			return perms.Role{}, ErrPermissionDenied
		}
		updated.Permissions = mask
	}
	// Removing the bypass right from the last role that carries it would lock
	// every administrator out of the server, whoever asks for the change.
	if hasManageServer(current.Permissions) && !hasManageServer(updated.Permissions) {
		before := s.manageServerHoldersLocked(nil, 0, 0)
		after := s.manageServerHoldersLocked(map[int64]uint64{roleID: updated.Permissions}, 0, 0)
		if before > 0 && after == 0 {
			return perms.Role{}, ErrSelfLockout
		}
	}
	if _, err := s.store.UpdateRole(ctx, store.Role{
		ID:          updated.ID,
		Name:        updated.Name,
		Color:       updated.Color,
		Position:    updated.Position,
		Permissions: updated.Permissions,
	}); err != nil {
		if isUniqueViolation(err) {
			return perms.Role{}, ErrDuplicateName
		}
		return perms.Role{}, err
	}
	if err := s.reloadLocked(ctx); err != nil {
		return perms.Role{}, err
	}
	if err := s.normalizeLocked(ctx); err != nil {
		return perms.Role{}, err
	}
	s.logger.Info("role updated", "role_id", roleID)
	return s.roles[roleID], nil
}

// Delete removes a role. Built-in roles are protected.
func (s *Service) Delete(ctx context.Context, actor perms.Subject, roleID int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.canManageRolesLocked(actor) {
		return ErrPermissionDenied
	}
	role, ok := s.roles[roleID]
	if !ok {
		return ErrNotFound
	}
	if role.Builtin {
		return ErrBuiltin
	}
	if !perms.CanManageRole(actor, role, nil) {
		return ErrHierarchy
	}
	if err := s.store.DeleteRole(ctx, roleID); err != nil {
		return err
	}
	if err := s.reloadLocked(ctx); err != nil {
		return err
	}
	if err := s.normalizeLocked(ctx); err != nil {
		return err
	}
	s.logger.Info("role deleted", "role_id", roleID)
	return nil
}

// Reorder assigns positions 0..n-1 in the given order (least powerful first).
func (s *Service) Reorder(ctx context.Context, actor perms.Subject, roleIDs []uint64) ([]perms.Role, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.canManageRolesLocked(actor) {
		return nil, ErrPermissionDenied
	}
	if len(roleIDs) != len(s.roles) {
		return nil, fmt.Errorf("%w: the reorder must list every role", ErrInvalidPosition)
	}
	seen := make(map[int64]struct{}, len(roleIDs))
	ordered := make([]store.Role, 0, len(roleIDs))
	for position, rawID := range roleIDs {
		id := int64(rawID)
		role, ok := s.roles[id]
		if !ok {
			return nil, ErrNotFound
		}
		if _, duplicate := seen[id]; duplicate {
			return nil, fmt.Errorf("%w: duplicate role %d", ErrInvalidPosition, id)
		}
		seen[id] = struct{}{}
		if !perms.HasManageServer(actor) {
			highest := perms.HighestPosition(actor)
			if role.Position >= highest {
				// A role at or above the actor keeps its slot; only the
				// region below the actor may be rearranged.
				if int32(position) != role.Position {
					return nil, ErrHierarchy
				}
			} else if int32(position) >= highest {
				return nil, ErrHierarchy
			}
		}
		ordered = append(ordered, store.Role{
			ID:       id,
			Position: int32(position),
		})
	}
	if err := s.store.SetRolePositions(ctx, ordered); err != nil {
		return nil, err
	}
	if err := s.reloadLocked(ctx); err != nil {
		return nil, err
	}
	s.logger.Info("roles reordered", "count", len(roleIDs))
	return s.rolesLocked(), nil
}

// Assign grants a role to a user.
func (s *Service) Assign(ctx context.Context, actor perms.Subject, userID, roleID int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.canManageRolesLocked(actor) {
		return ErrPermissionDenied
	}
	target := s.subjectLocked(userID)
	role, ok := s.roles[roleID]
	if !ok {
		return ErrNotFound
	}
	if !perms.CanActOn(actor, target) || !perms.CanManageRole(actor, role, nil) {
		return ErrHierarchy
	}
	// A role below the actor can still carry a right the actor does not hold.
	// Handing it out would let a moderator escalate through a pre-made role,
	// so the same grant rule as role creation applies (review of stage 3.1).
	if !CanGrant(actor, role.Permissions) {
		return ErrPermissionDenied
	}
	if err := s.store.AssignRole(ctx, userID, roleID); err != nil {
		return err
	}
	if err := s.reloadLocked(ctx); err != nil {
		return err
	}
	s.logger.Info("role assigned", "user_id", userID, "role_id", roleID)
	return nil
}

// Unassign removes a role from a user. Removing the last role that carries
// MANAGE_SERVER is rejected for every actor, including the local admin socket:
// the server must never be left without an administrator.
func (s *Service) Unassign(ctx context.Context, actor perms.Subject, userID, roleID int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.canManageRolesLocked(actor) {
		return ErrPermissionDenied
	}
	target := s.subjectLocked(userID)
	role, ok := s.roles[roleID]
	if !ok {
		return ErrNotFound
	}
	if !perms.CanActOn(actor, target) || !perms.CanManageRole(actor, role, nil) {
		return ErrHierarchy
	}
	if hasManageServer(role.Permissions) && s.userHasRoleLocked(userID, roleID) {
		before := s.manageServerHoldersLocked(nil, 0, 0)
		after := s.manageServerHoldersLocked(nil, userID, roleID)
		if before > 0 && after == 0 {
			return ErrSelfLockout
		}
	}
	if err := s.store.UnassignRole(ctx, userID, roleID); err != nil {
		return err
	}
	if err := s.reloadLocked(ctx); err != nil {
		return err
	}
	s.logger.Info("role unassigned", "user_id", userID, "role_id", roleID)
	return nil
}

// SetOverride replaces the allow/deny pair of one role in one channel.
func (s *Service) SetOverride(ctx context.Context, actor perms.Subject, channelID, roleID int64, allow, deny uint64) (perms.Override, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.canManageRolesLocked(actor) && !s.canManageChannelsLocked(actor) {
		return perms.Override{}, ErrPermissionDenied
	}
	role, ok := s.roles[roleID]
	if !ok {
		return perms.Override{}, ErrNotFound
	}
	if !perms.CanManageRole(actor, role, nil) {
		return perms.Override{}, ErrHierarchy
	}
	if channelID <= 0 {
		return perms.Override{}, errors.New("roles: channel id must be positive")
	}
	if !CanGrant(actor, allow) {
		return perms.Override{}, ErrPermissionDenied
	}
	override := store.ChannelOverride{
		ChannelID: channelID,
		RoleID:    roleID,
		Allow:     allow & perms.AllMask,
		Deny:      deny & perms.AllMask,
	}
	if err := s.store.UpsertChannelOverride(ctx, override); err != nil {
		return perms.Override{}, err
	}
	if err := s.reloadLocked(ctx); err != nil {
		return perms.Override{}, err
	}
	s.logger.Info("channel override set", "channel_id", channelID, "role_id", roleID)
	return perms.Override{RoleID: roleID, Allow: override.Allow, Deny: override.Deny}, nil
}

// ClearOverride removes one override, or every override of a channel when
// roleID is 0.
func (s *Service) ClearOverride(ctx context.Context, actor perms.Subject, channelID, roleID int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.canManageRolesLocked(actor) && !s.canManageChannelsLocked(actor) {
		return ErrPermissionDenied
	}
	if channelID <= 0 {
		return errors.New("roles: channel id must be positive")
	}
	if roleID == 0 {
		if !perms.HasManageServer(actor) {
			return ErrHierarchy
		}
		if err := s.store.DeleteChannelOverrides(ctx, channelID); err != nil {
			return err
		}
	} else {
		role, ok := s.roles[roleID]
		if !ok {
			return ErrNotFound
		}
		if !perms.CanManageRole(actor, role, nil) {
			return ErrHierarchy
		}
		if err := s.store.DeleteChannelOverride(ctx, channelID, roleID); err != nil {
			return err
		}
	}
	if err := s.reloadLocked(ctx); err != nil {
		return err
	}
	s.logger.Info("channel override cleared", "channel_id", channelID, "role_id", roleID)
	return nil
}

// CanGrant reports whether the actor may hand out the permissions in mask. An
// actor without PERMISSION_MANAGE_SERVER cannot grant a right they do not hold,
// so a moderator cannot edit a lower role into an administrator role, assign
// such a role, or mint an invite that grants it.
func CanGrant(actor perms.Subject, mask uint64) bool {
	if perms.HasManageServer(actor) {
		return true
	}
	allowed := perms.Effective(actor, nil, 0)
	return mask&^allowed == 0
}

// canManageRolesLocked checks the server-wide right to change roles on an
// explicit subject (the actor may be the local system actor).
func (s *Service) canManageRolesLocked(subject perms.Subject) bool {
	return perms.Allows(subject, nil, rostalkv1.Permission_PERMISSION_MANAGE_ROLES, 0)
}

// canManageChannelsLocked lets a channel administrator edit channel overrides
// without granting the separate right to define roles (design 4.4).
func (s *Service) canManageChannelsLocked(subject perms.Subject) bool {
	return perms.Allows(subject, nil, rostalkv1.Permission_PERMISSION_MANAGE_CHANNELS, 0)
}

// hasManageServer reports whether a role permission mask carries the bypass
// right.
func hasManageServer(mask uint64) bool {
	return mask&perms.PermissionMask(rostalkv1.Permission_PERMISSION_MANAGE_SERVER) != 0
}

// userHasRoleLocked reports whether the user currently holds roleID.
func (s *Service) userHasRoleLocked(userID, roleID int64) bool {
	for _, id := range s.userRoles[userID] {
		if id == roleID {
			return true
		}
	}
	return false
}

// manageServerHoldersLocked counts users whose role union still carries
// MANAGE_SERVER. replacements maps a role id to the permission mask it would
// have after a pending change; skipUser/skipRole drop one assignment (an
// unassign). The count is what the last-admin guard protects.
func (s *Service) manageServerHoldersLocked(replacements map[int64]uint64, skipUser, skipRole int64) int {
	count := 0
	for userID, roleIDs := range s.userRoles {
		holds := false
		for _, roleID := range roleIDs {
			if userID == skipUser && roleID == skipRole {
				continue
			}
			mask := uint64(0)
			if replacement, ok := replacements[roleID]; ok {
				mask = replacement
			} else if role, ok := s.roles[roleID]; ok {
				mask = role.Permissions
			}
			if hasManageServer(mask) {
				holds = true
				break
			}
		}
		if holds {
			count++
		}
	}
	return count
}

// EnsureDefaultRole assigns the Member role to a user that has no roles. It is
// called on login so a user created before roles existed (or whose roles were
// all deleted) still sees the server.
func (s *Service) EnsureDefaultRole(ctx context.Context, userID int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.userRoles[userID]) > 0 {
		return nil
	}
	if s.defaultID == 0 {
		return nil
	}
	if err := s.store.AssignRole(ctx, userID, s.defaultID); err != nil {
		return err
	}
	return s.reloadLocked(ctx)
}

// GrantAdmin assigns the Admin role to a user. It is the bootstrap path: the
// administrator invite grants the role, not a separate column.
func (s *Service) GrantAdmin(ctx context.Context, userID int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.adminID == 0 {
		return errors.New("roles: the Admin role does not exist")
	}
	if err := s.store.AssignRole(ctx, userID, s.adminID); err != nil {
		return err
	}
	return s.reloadLocked(ctx)
}

func toPermRole(row store.Role) perms.Role {
	return perms.Role{
		ID:          row.ID,
		Name:        row.Name,
		Color:       row.Color,
		Position:    row.Position,
		Permissions: row.Permissions,
		Builtin:     row.Builtin,
	}
}

func validateName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", fmt.Errorf("%w: name must not be empty", ErrInvalidName)
	}
	if utf8.RuneCountInString(name) > maxRoleNameRunes {
		return "", fmt.Errorf("%w: name is longer than %d characters", ErrInvalidName, maxRoleNameRunes)
	}
	if strings.ContainsAny(name, "\x00\r\n\t") {
		return "", fmt.Errorf("%w: name contains control characters", ErrInvalidName)
	}
	return name, nil
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "unique")
}
