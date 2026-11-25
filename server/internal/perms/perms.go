// Package perms is the pure permission model of the server (design 4.4).
//
// A subject holds zero or more roles. Effective permissions in a channel are:
//
//	union of the role permissions
//	minus every deny of the subject's roles in that channel
//	plus every allow of the subject's roles in that channel
//
// PERMISSION_MANAGE_SERVER bypasses every check once it survives that
// calculation. The hierarchy rule is separate: an actor may only act on a user
// whose highest role position is strictly below the actor's own, and may only
// manage roles below it.
//
// Nothing in this package touches the database or a lock: internal/roles loads
// the data and calls these functions, which keeps the rules table-testable.
package perms

import (
	"sort"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"
)

// Role is one role as far as permission calculation is concerned.
type Role struct {
	ID          int64
	Name        string
	Color       uint32
	Position    int32
	Permissions uint64
	Builtin     bool
}

// Override is the allow/deny pair of one role in one channel.
type Override struct {
	RoleID int64
	Allow  uint64
	Deny   uint64
}

// Subject is a user with their roles. UserID 0 means "unknown"; such a subject
// holds no rights.
type Subject struct {
	UserID int64
	Roles  []Role
}

// NoPosition is the position of a subject without any role. It is below every
// real role, including the built-in Guest at position 0.
const NoPosition int32 = -1

// SystemUserID is the synthetic actor of the local admin socket. It never
// matches a real user id, which are positive.
const SystemUserID int64 = -1

// Mask builds a permission bitmask from permissions. PERMISSION_UNSPECIFIED is
// ignored.
func Mask(permissions ...rostalkv1.Permission) uint64 {
	var mask uint64
	for _, permission := range permissions {
		if !known(permission) {
			continue
		}
		mask |= 1 << uint(permission)
	}
	return mask
}

// known reports whether the enum value is part of this protocol version.
func known(permission rostalkv1.Permission) bool {
	if permission == rostalkv1.Permission_PERMISSION_UNSPECIFIED {
		return false
	}
	_, ok := rostalkv1.Permission_name[int32(permission)]
	return ok
}

// All returns the mask of every permission the server knows.
func All() uint64 { return AllMask }

// AllMask is a constant copy of All for use in tables and tests.
const AllMask uint64 = (1 << 53) - 2 // bits 1..52, bit 0 stays unused

// PermissionMask returns the bit of one permission.
func PermissionMask(permission rostalkv1.Permission) uint64 {
	if !known(permission) {
		return 0
	}
	return 1 << uint(permission)
}

// Union returns the union of the permissions of every role held.
func Union(subject Subject) uint64 {
	var mask uint64
	for _, role := range subject.Roles {
		mask |= role.Permissions
	}
	return mask & AllMask
}

// HighestPosition returns the position of the highest role, or NoPosition when
// the subject holds none.
func HighestPosition(subject Subject) int32 {
	highest := NoPosition
	for _, role := range subject.Roles {
		if role.Position > highest {
			highest = role.Position
		}
	}
	return highest
}

// HasManageServer reports whether the role union includes the bypass right.
func HasManageServer(subject Subject) bool {
	return Union(subject)&PermissionMask(rostalkv1.Permission_PERMISSION_MANAGE_SERVER) != 0
}

// manageServerBit is the permission that bypasses every check. It is decided by
// the role union alone: a channel override cannot grant it and cannot take it
// away (design 4.4: "manage_server обходит всё"). Otherwise a Member allowed
// manage_server in one channel would become a server administrator there, and an
// Admin denied it would mysteriously lose rights in that channel.
const manageServerBit = 1 << uint(rostalkv1.Permission_PERMISSION_MANAGE_SERVER)

// Effective returns the effective permission mask in one channel. A channel of
// 0 means "outside any channel": only the role union applies, because channel
// overrides do not exist outside a channel.
func Effective(subject Subject, overrides []Override, channelID uint64) uint64 {
	mask := Union(subject)
	if mask&manageServerBit != 0 {
		return AllMask
	}
	if channelID == 0 {
		return mask
	}
	held := make(map[int64]struct{}, len(subject.Roles))
	for _, role := range subject.Roles {
		held[role.ID] = struct{}{}
	}
	var deny, allow uint64
	for _, override := range overrides {
		if _, ok := held[override.RoleID]; !ok {
			continue
		}
		deny |= override.Deny
		allow |= override.Allow
	}
	// Server administration is never a channel-local right.
	deny &^= manageServerBit
	allow &^= manageServerBit
	mask &^= deny
	mask |= allow
	return mask & AllMask
}

// Allows reports whether the subject holds permission in channelID.
func Allows(subject Subject, overrides []Override, permission rostalkv1.Permission, channelID uint64) bool {
	bit := PermissionMask(permission)
	if bit == 0 {
		return false
	}
	return Effective(subject, overrides, channelID)&bit != 0
}

// CanActOn reports whether actor may moderate target. Acting on oneself is
// always allowed; PERMISSION_MANAGE_SERVER bypasses the hierarchy; otherwise the
// actor's highest role must be strictly above the target's.
func CanActOn(actor, target Subject) bool {
	if actor.UserID == 0 {
		return false
	}
	if actor.UserID == target.UserID {
		return true
	}
	if HasManageServer(actor) {
		return true
	}
	return HighestPosition(actor) > HighestPosition(target)
}

// CanManageRole reports whether actor may create, edit or move a role whose
// current position is role.Position to newPosition (nil means "keep it").
func CanManageRole(actor Subject, role Role, newPosition *int32) bool {
	if actor.UserID == 0 {
		return false
	}
	if HasManageServer(actor) {
		return true
	}
	highest := HighestPosition(actor)
	if highest == NoPosition {
		return false
	}
	if role.Position >= highest {
		return false
	}
	if newPosition != nil && *newPosition >= highest {
		return false
	}
	return true
}

// CanCreateRole reports whether actor may create a role at position.
func CanCreateRole(actor Subject, position int32) bool {
	if actor.UserID == 0 {
		return false
	}
	if HasManageServer(actor) {
		return true
	}
	highest := HighestPosition(actor)
	return highest != NoPosition && position < highest
}

// ToPermissions converts a mask into the wire list, in ascending numeric order.
func ToPermissions(mask uint64) []rostalkv1.Permission {
	mask &= AllMask
	out := make([]rostalkv1.Permission, 0, 12)
	for permission := uint(1); permission < 64; permission++ {
		if mask&(1<<permission) == 0 {
			continue
		}
		value := rostalkv1.Permission(permission)
		if !known(value) {
			continue
		}
		out = append(out, value)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// ServerMask selects the rights reported in MyPermissions.server.
const ServerMask uint64 = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) |
	(1 << 6) | (1 << 7) | (1 << 8) | (1 << 9) | (1 << 10) |
	(1 << 40) | (1 << 41)

// ChannelMask selects the rights reported per channel.
const ChannelMask uint64 = (1 << 20) | (1 << 21) | (1 << 22) | (1 << 23) |
	(1 << 24) | (1 << 25) | (1 << 26) | (1 << 30) | (1 << 31) |
	(1 << 50) | (1 << 51) | (1 << 52)

// ServerList returns the server-wide part of a mask.
func ServerList(mask uint64) []rostalkv1.Permission { return ToPermissions(mask & ServerMask) }

// ChannelList returns the per-channel part of a mask.
func ChannelList(mask uint64) []rostalkv1.Permission { return ToPermissions(mask & ChannelMask) }

// IsChannelPermission reports whether permission belongs to the per-channel
// group.
func IsChannelPermission(permission rostalkv1.Permission) bool {
	return PermissionMask(permission)&ChannelMask != 0
}
