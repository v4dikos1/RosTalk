package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

// Role is the typed view of one role. Permissions is the permission bitmask:
// bit N corresponds to rostalk.v1.Permission with numeric value N.
type Role struct {
	ID          int64
	Name        string
	Color       uint32
	Position    int32
	Permissions uint64
	Builtin     bool
	CreatedAt   time.Time
}

// UserRole is one role assignment.
type UserRole struct {
	UserID int64
	RoleID int64
}

// ChannelOverride is the allow/deny pair of one role in one channel.
type ChannelOverride struct {
	ChannelID int64
	RoleID    int64
	Allow     uint64
	Deny      uint64
}

// AuditEntry is one row of the audit log.
type AuditEntry struct {
	ID              int64
	ActorID         int64
	ActorName       string
	Action          string
	TargetUserID    int64
	TargetChannelID int64
	TargetRoleID    int64
	Details         string
	CreatedAt       time.Time
}

func roleFromRow(row db.Role) Role {
	return Role{
		ID:          row.ID,
		Name:        row.Name,
		Color:       uint32(row.Color),
		Position:    int32(row.Position),
		Permissions: uint64(row.Permissions),
		Builtin:     row.Builtin != 0,
		CreatedAt:   time.UnixMilli(row.CreatedAt).UTC(),
	}
}

func auditFromRow(row db.AuditLog) AuditEntry {
	entry := AuditEntry{
		ID:        row.ID,
		ActorName: row.ActorName,
		Action:    row.Action,
		Details:   row.Details,
		CreatedAt: time.UnixMilli(row.CreatedAt).UTC(),
	}
	if row.ActorID.Valid {
		entry.ActorID = row.ActorID.Int64
	}
	if row.TargetUserID.Valid {
		entry.TargetUserID = row.TargetUserID.Int64
	}
	if row.TargetChannelID.Valid {
		entry.TargetChannelID = row.TargetChannelID.Int64
	}
	if row.TargetRoleID.Valid {
		entry.TargetRoleID = row.TargetRoleID.Int64
	}
	return entry
}

// ListRoles returns every role in ascending power order.
func (s *Store) ListRoles(ctx context.Context) ([]Role, error) {
	rows, err := s.q.ListRoles(ctx)
	if err != nil {
		return nil, fmt.Errorf("list roles: %w", err)
	}
	out := make([]Role, 0, len(rows))
	for _, row := range rows {
		out = append(out, roleFromRow(row))
	}
	return out, nil
}

// RoleByID returns one role or ErrNotFound.
func (s *Store) RoleByID(ctx context.Context, id int64) (Role, error) {
	row, err := s.q.GetRole(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Role{}, ErrNotFound
	}
	if err != nil {
		return Role{}, fmt.Errorf("get role %d: %w", id, err)
	}
	return roleFromRow(row), nil
}

// RoleByName looks a role up case-insensitively or returns ErrNotFound.
func (s *Store) RoleByName(ctx context.Context, name string) (Role, error) {
	row, err := s.q.GetRoleByName(ctx, name)
	if errors.Is(err, sql.ErrNoRows) {
		return Role{}, ErrNotFound
	}
	if err != nil {
		return Role{}, fmt.Errorf("get role %q: %w", name, err)
	}
	return roleFromRow(row), nil
}

// InsertRole adds a role and returns it with the assigned id.
func (s *Store) InsertRole(ctx context.Context, role Role) (Role, error) {
	row, err := s.q.InsertRole(ctx, db.InsertRoleParams{
		Name:        role.Name,
		Color:       int64(role.Color),
		Position:    int64(role.Position),
		Permissions: int64(role.Permissions),
		Builtin:     boolToInt(role.Builtin),
		CreatedAt:   time.Now().UnixMilli(),
	})
	if err != nil {
		return Role{}, fmt.Errorf("insert role %q: %w", role.Name, err)
	}
	return roleFromRow(row), nil
}

// UpdateRole replaces the mutable fields of a role.
func (s *Store) UpdateRole(ctx context.Context, role Role) (Role, error) {
	row, err := s.q.UpdateRole(ctx, db.UpdateRoleParams{
		Name:        role.Name,
		Color:       int64(role.Color),
		Position:    int64(role.Position),
		Permissions: int64(role.Permissions),
		ID:          role.ID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return Role{}, ErrNotFound
	}
	if err != nil {
		return Role{}, fmt.Errorf("update role %d: %w", role.ID, err)
	}
	return roleFromRow(row), nil
}

// SetRolePositions stores a complete new order in one transaction.
func (s *Store) SetRolePositions(ctx context.Context, roles []Role) error {
	tx, err := s.sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin role reorder: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	q := s.q.WithTx(tx)
	for _, role := range roles {
		if err := q.SetRolePosition(ctx, db.SetRolePositionParams{
			Position: int64(role.Position),
			ID:       role.ID,
		}); err != nil {
			return fmt.Errorf("set role %d position: %w", role.ID, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit role reorder: %w", err)
	}
	return nil
}

// DeleteRole removes a role; assignments and overrides cascade.
func (s *Store) DeleteRole(ctx context.Context, id int64) error {
	if err := s.q.DeleteRole(ctx, id); err != nil {
		return fmt.Errorf("delete role %d: %w", id, err)
	}
	return nil
}

// CountRoles reports how many roles exist.
func (s *Store) CountRoles(ctx context.Context) (int64, error) {
	n, err := s.q.CountRoles(ctx)
	if err != nil {
		return 0, fmt.Errorf("count roles: %w", err)
	}
	return n, nil
}

// UserRoleAssignments returns every assignment.
func (s *Store) UserRoleAssignments(ctx context.Context) ([]UserRole, error) {
	rows, err := s.q.ListUserRoles(ctx)
	if err != nil {
		return nil, fmt.Errorf("list user roles: %w", err)
	}
	out := make([]UserRole, 0, len(rows))
	for _, row := range rows {
		out = append(out, UserRole{UserID: row.UserID, RoleID: row.RoleID})
	}
	return out, nil
}

// RolesOfUser returns the role ids held by one user.
func (s *Store) RolesOfUser(ctx context.Context, userID int64) ([]int64, error) {
	rows, err := s.q.ListUserRolesOfUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list roles of user %d: %w", userID, err)
	}
	return rows, nil
}

// AssignRole grants a role to a user. Assigning twice is a no-op.
func (s *Store) AssignRole(ctx context.Context, userID, roleID int64) error {
	if err := s.q.AssignUserRole(ctx, db.AssignUserRoleParams{
		UserID:     userID,
		RoleID:     roleID,
		AssignedAt: time.Now().UnixMilli(),
	}); err != nil {
		return fmt.Errorf("assign role %d to user %d: %w", roleID, userID, err)
	}
	return nil
}

// UnassignRole removes a role from a user.
func (s *Store) UnassignRole(ctx context.Context, userID, roleID int64) error {
	if err := s.q.UnassignUserRole(ctx, db.UnassignUserRoleParams{
		UserID: userID,
		RoleID: roleID,
	}); err != nil {
		return fmt.Errorf("unassign role %d from user %d: %w", roleID, userID, err)
	}
	return nil
}

// ListChannelOverrides returns every override.
func (s *Store) ListChannelOverrides(ctx context.Context) ([]ChannelOverride, error) {
	rows, err := s.q.ListChannelOverrides(ctx)
	if err != nil {
		return nil, fmt.Errorf("list channel overrides: %w", err)
	}
	out := make([]ChannelOverride, 0, len(rows))
	for _, row := range rows {
		out = append(out, ChannelOverride{
			ChannelID: row.ChannelID,
			RoleID:    row.RoleID,
			Allow:     uint64(row.Allow),
			Deny:      uint64(row.Deny),
		})
	}
	return out, nil
}

// UpsertChannelOverride writes the allow/deny pair of one role in one channel.
func (s *Store) UpsertChannelOverride(ctx context.Context, override ChannelOverride) error {
	if err := s.q.UpsertChannelOverride(ctx, db.UpsertChannelOverrideParams{
		ChannelID: override.ChannelID,
		RoleID:    override.RoleID,
		Allow:     int64(override.Allow),
		Deny:      int64(override.Deny),
	}); err != nil {
		return fmt.Errorf("upsert channel %d override for role %d: %w",
			override.ChannelID, override.RoleID, err)
	}
	return nil
}

// DeleteChannelOverride removes one override.
func (s *Store) DeleteChannelOverride(ctx context.Context, channelID, roleID int64) error {
	if err := s.q.DeleteChannelOverride(ctx, db.DeleteChannelOverrideParams{
		ChannelID: channelID,
		RoleID:    roleID,
	}); err != nil {
		return fmt.Errorf("delete channel %d override for role %d: %w", channelID, roleID, err)
	}
	return nil
}

// DeleteChannelOverrides removes every override of a channel.
func (s *Store) DeleteChannelOverrides(ctx context.Context, channelID int64) error {
	if err := s.q.DeleteChannelOverrides(ctx, channelID); err != nil {
		return fmt.Errorf("delete overrides of channel %d: %w", channelID, err)
	}
	return nil
}

// AuditOptions describes one audit entry.
type AuditOptions struct {
	ActorID         int64
	ActorName       string
	Action          string
	TargetUserID    int64
	TargetChannelID int64
	TargetRoleID    int64
	Details         string
}

// AddAuditEntry records an administrative action.
func (s *Store) AddAuditEntry(ctx context.Context, opts AuditOptions) (AuditEntry, error) {
	params := db.InsertAuditEntryParams{
		ActorName: opts.ActorName,
		Action:    opts.Action,
		Details:   opts.Details,
		CreatedAt: time.Now().UnixMilli(),
	}
	if opts.ActorID != 0 {
		params.ActorID = sql.NullInt64{Int64: opts.ActorID, Valid: true}
	}
	if opts.TargetUserID != 0 {
		params.TargetUserID = sql.NullInt64{Int64: opts.TargetUserID, Valid: true}
	}
	if opts.TargetChannelID != 0 {
		params.TargetChannelID = sql.NullInt64{Int64: opts.TargetChannelID, Valid: true}
	}
	if opts.TargetRoleID != 0 {
		params.TargetRoleID = sql.NullInt64{Int64: opts.TargetRoleID, Valid: true}
	}
	row, err := s.q.InsertAuditEntry(ctx, params)
	if err != nil {
		return AuditEntry{}, fmt.Errorf("insert audit entry %q: %w", opts.Action, err)
	}
	return auditFromRow(row), nil
}

// AuditPage returns entries newest first, at most limit of them, with ids below
// beforeID (0 starts at the newest entry).
func (s *Store) AuditPage(ctx context.Context, beforeID int64, limit int) ([]AuditEntry, error) {
	return s.AuditPageFiltered(ctx, beforeID, limit, "", 0)
}

// AuditPageFiltered is AuditPage with an optional action prefix and actor id.
// Empty prefix and actor 0 mean "no filter".
func (s *Store) AuditPageFiltered(ctx context.Context, beforeID int64, limit int, actionPrefix string, actorID int64) ([]AuditEntry, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.q.ListAuditEntriesFiltered(ctx, db.ListAuditEntriesFilteredParams{
		BeforeID:     beforeID,
		ActionPrefix: actionPrefix,
		ActorID:      actorID,
		PageSize:     int64(limit),
	})
	if err != nil {
		return nil, fmt.Errorf("list audit entries: %w", err)
	}
	out := make([]AuditEntry, 0, len(rows))
	for _, row := range rows {
		out = append(out, auditFromRow(row))
	}
	return out, nil
}

// UserByID returns one user or ErrNotFound.
func (s *Store) UserByID(ctx context.Context, id int64) (db.User, error) {
	user, err := s.q.GetUserByID(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return db.User{}, ErrNotFound
	}
	if err != nil {
		return db.User{}, fmt.Errorf("get user %d: %w", id, err)
	}
	return user, nil
}

// ListUsers returns every known user in creation order.
func (s *Store) ListUsers(ctx context.Context) ([]db.User, error) {
	users, err := s.q.ListUsers(ctx)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	return users, nil
}

// InviteByID returns one invite or ErrNotFound.
func (s *Store) InviteByID(ctx context.Context, id int64) (db.Invite, error) {
	invite, err := s.q.GetInviteByID(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return db.Invite{}, ErrNotFound
	}
	if err != nil {
		return db.Invite{}, fmt.Errorf("get invite %d: %w", id, err)
	}
	return invite, nil
}

// ListInvites returns every invite, newest first.
func (s *Store) ListInvites(ctx context.Context) ([]db.Invite, error) {
	invites, err := s.q.ListInvites(ctx)
	if err != nil {
		return nil, fmt.Errorf("list invites: %w", err)
	}
	return invites, nil
}

// RevokeInvite marks an invite revoked at now.
func (s *Store) RevokeInvite(ctx context.Context, id int64, now time.Time) error {
	if err := s.q.RevokeInvite(ctx, db.RevokeInviteParams{
		RevokedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true},
		ID:        id,
	}); err != nil {
		return fmt.Errorf("revoke invite %d: %w", id, err)
	}
	return nil
}

// RemoveBanByIP lifts an address ban.
func (s *Store) RemoveBanByIP(ctx context.Context, ip string) error {
	if err := s.q.DeleteBanByIP(ctx, sql.NullString{String: ip, Valid: true}); err != nil {
		return fmt.Errorf("delete ban by ip: %w", err)
	}
	return nil
}

// RemoveBanByPublicKey lifts a key ban.
func (s *Store) RemoveBanByPublicKey(ctx context.Context, publicKey []byte) error {
	if err := s.q.DeleteBanByPublicKey(ctx, publicKey); err != nil {
		return fmt.Errorf("delete ban by key: %w", err)
	}
	return nil
}
