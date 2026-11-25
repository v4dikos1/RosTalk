package perms

import (
	"testing"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"
)

const (
	permManageServer   = rostalkv1.Permission_PERMISSION_MANAGE_SERVER
	permManageRoles    = rostalkv1.Permission_PERMISSION_MANAGE_ROLES
	permManageChannels = rostalkv1.Permission_PERMISSION_MANAGE_CHANNELS
	permView           = rostalkv1.Permission_PERMISSION_VIEW_CHANNEL
	permJoin           = rostalkv1.Permission_PERMISSION_JOIN_CHANNEL
	permSpeak          = rostalkv1.Permission_PERMISSION_SPEAK
	permStream         = rostalkv1.Permission_PERMISSION_STREAM
	permKick           = rostalkv1.Permission_PERMISSION_KICK
	permChangeNickname = rostalkv1.Permission_PERMISSION_CHANGE_NICKNAME
)

func role(id int64, position int32, permissions ...rostalkv1.Permission) Role {
	return Role{ID: id, Name: "role", Position: position, Permissions: Mask(permissions...)}
}

func TestEffectivePermissionTable(t *testing.T) {
	member := role(1, 10, permView, permJoin, permSpeak, permStream)
	moderator := role(2, 50, permView, permJoin, permSpeak, permKick)
	admin := role(3, 100, permManageServer)

	tests := []struct {
		name      string
		subject   Subject
		overrides []Override
		channel   uint64
		want      map[rostalkv1.Permission]bool
	}{
		{
			name:    "union of roles",
			subject: Subject{UserID: 7, Roles: []Role{member, moderator}},
			want: map[rostalkv1.Permission]bool{
				permView: true, permSpeak: true, permKick: true, permStream: true,
			},
		},
		{
			name:      "channel deny beats the union",
			subject:   Subject{UserID: 7, Roles: []Role{member, moderator}},
			overrides: []Override{{RoleID: 1, Deny: Mask(permSpeak)}},
			channel:   42,
			want:      map[rostalkv1.Permission]bool{permView: true, permSpeak: false, permKick: true},
		},
		{
			name:      "channel allow beats the deny",
			subject:   Subject{UserID: 7, Roles: []Role{member, moderator}},
			overrides: []Override{{RoleID: 1, Deny: Mask(permSpeak), Allow: Mask(permSpeak)}},
			channel:   42,
			want:      map[rostalkv1.Permission]bool{permSpeak: true},
		},
		{
			name:      "allow grants a permission the role lacks",
			subject:   Subject{UserID: 7, Roles: []Role{member}},
			overrides: []Override{{RoleID: 1, Allow: Mask(permStream)}},
			channel:   42,
			want:      map[rostalkv1.Permission]bool{permStream: true, permView: true},
		},
		{
			name:      "override of a role the subject does not hold is ignored",
			subject:   Subject{UserID: 7, Roles: []Role{member}},
			overrides: []Override{{RoleID: 2, Deny: Mask(permView)}},
			channel:   42,
			want:      map[rostalkv1.Permission]bool{permView: true},
		},
		{
			name:      "two denies add up",
			subject:   Subject{UserID: 7, Roles: []Role{member, moderator}},
			overrides: []Override{{RoleID: 1, Deny: Mask(permSpeak)}, {RoleID: 2, Deny: Mask(permKick)}},
			channel:   42,
			want:      map[rostalkv1.Permission]bool{permSpeak: false, permKick: false, permView: true},
		},
		{
			name:    "no role means no rights",
			subject: Subject{UserID: 7},
			want:    map[rostalkv1.Permission]bool{permView: false, permJoin: false},
		},
		{
			name:    "manage_server bypasses everything",
			subject: Subject{UserID: 7, Roles: []Role{admin}},
			want: map[rostalkv1.Permission]bool{
				permManageServer: true, permManageRoles: true, permManageChannels: true,
				permView: true, permSpeak: true, permStream: true,
			},
		},
		{
			name:      "channel deny cannot take manage_server away",
			subject:   Subject{UserID: 7, Roles: []Role{admin}},
			overrides: []Override{{RoleID: 3, Deny: Mask(permManageServer)}},
			channel:   42,
			want:      map[rostalkv1.Permission]bool{permManageServer: true, permSpeak: true},
		},
		{
			name:      "channel allow cannot grant manage_server",
			subject:   Subject{UserID: 7, Roles: []Role{member}},
			overrides: []Override{{RoleID: 1, Allow: Mask(permManageServer)}},
			channel:   42,
			want:      map[rostalkv1.Permission]bool{permManageServer: false, permSpeak: true},
		},
		{
			name:    "channel overrides do not apply outside a channel",
			subject: Subject{UserID: 7, Roles: []Role{member}},
			// A zero channel means server-wide: overrides must be ignored.
			overrides: []Override{{RoleID: 1, Deny: Mask(permSpeak)}},
			channel:   0,
			want:      map[rostalkv1.Permission]bool{permSpeak: true},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			for permission, want := range test.want {
				if got := Allows(test.subject, test.overrides, permission, test.channel); got != want {
					t.Errorf("Allows(%s) = %t, want %t", permission, got, want)
				}
			}
		})
	}
}

func TestAllowAndDenyConflict(t *testing.T) {
	subject := Subject{UserID: 1, Roles: []Role{role(1, 10, permSpeak)}}
	overrides := []Override{{RoleID: 1, Deny: Mask(permSpeak), Allow: Mask(permSpeak)}}
	if !Allows(subject, overrides, permSpeak, 5) {
		t.Fatal("allow must be applied after deny")
	}
}

func TestHighestPosition(t *testing.T) {
	tests := []struct {
		name    string
		subject Subject
		want    int32
	}{
		{"none", Subject{UserID: 1}, NoPosition},
		{"one", Subject{UserID: 1, Roles: []Role{role(1, 10)}}, 10},
		{"highest", Subject{UserID: 1, Roles: []Role{role(1, 10), role(2, 50), role(3, 20)}}, 50},
		{"zero role", Subject{UserID: 1, Roles: []Role{role(1, 0)}}, 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := HighestPosition(test.subject); got != test.want {
				t.Fatalf("HighestPosition = %d, want %d", got, test.want)
			}
		})
	}
}

func TestCanActOnHierarchy(t *testing.T) {
	admin := role(1, 100, permManageServer)
	moderator := role(2, 50, permKick)
	member := role(3, 10)
	guest := role(4, 0)

	tests := []struct {
		name   string
		actor  Subject
		target Subject
		want   bool
	}{
		{"manage_server acts on anyone", Subject{UserID: 1, Roles: []Role{admin}}, Subject{UserID: 2, Roles: []Role{admin}}, true},
		{"higher role acts on lower", Subject{UserID: 1, Roles: []Role{moderator}}, Subject{UserID: 2, Roles: []Role{member}}, true},
		{"same position cannot act", Subject{UserID: 1, Roles: []Role{moderator}}, Subject{UserID: 2, Roles: []Role{moderator}}, false},
		{"lower role cannot act on higher", Subject{UserID: 1, Roles: []Role{member}}, Subject{UserID: 2, Roles: []Role{moderator}}, false},
		{"moderator cannot kick an administrator", Subject{UserID: 1, Roles: []Role{moderator}}, Subject{UserID: 2, Roles: []Role{admin}}, false},
		{"self", Subject{UserID: 1, Roles: []Role{member}}, Subject{UserID: 1, Roles: []Role{admin}}, true},
		{"no roles cannot act", Subject{UserID: 1, Roles: []Role{guest}}, Subject{UserID: 2}, true},
		{"no role actor", Subject{UserID: 1}, Subject{UserID: 2, Roles: []Role{member}}, false},
		{"target without roles is below everyone", Subject{UserID: 1, Roles: []Role{guest}}, Subject{UserID: 2}, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := CanActOn(test.actor, test.target); got != test.want {
				t.Fatalf("CanActOn = %t, want %t", got, test.want)
			}
		})
	}
}

func TestCanManageRole(t *testing.T) {
	admin := Subject{UserID: 1, Roles: []Role{role(1, 100, permManageServer, permManageRoles)}}
	moderator := Subject{UserID: 2, Roles: []Role{role(2, 50, permManageRoles)}}
	member := Subject{UserID: 3, Roles: []Role{role(3, 10)}}
	low := role(10, 10)
	high := role(11, 50)
	above := role(12, 80)
	position := func(v int32) *int32 { return &v }

	tests := []struct {
		name     string
		actor    Subject
		role     Role
		position *int32
		want     bool
	}{
		{"manage_server edits anything", admin, above, nil, true},
		{"moderator edits lower role", moderator, low, nil, true},
		{"moderator cannot edit same-position role", moderator, high, nil, false},
		{"moderator cannot move a role above itself", moderator, low, position(50), false},
		{"moderator may move a role below itself", moderator, low, position(20), true},
		{"member cannot manage roles without manage_roles", member, low, nil, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := CanManageRole(test.actor, test.role, test.position); got != test.want {
				t.Fatalf("CanManageRole = %t, want %t", got, test.want)
			}
		})
	}
}

func TestServerAndChannelLists(t *testing.T) {
	mask := Mask(permManageRoles, permKick, permView, permSpeak, permChangeNickname)
	server := ServerList(mask)
	channel := ChannelList(mask)
	if len(server) != 3 {
		t.Fatalf("server list = %v, want 3 entries", server)
	}
	if len(channel) != 2 {
		t.Fatalf("channel list = %v, want 2 entries", channel)
	}
	for _, permission := range server {
		if IsChannelPermission(permission) {
			t.Fatalf("server list contains channel permission %s", permission)
		}
	}
}

func TestToPermissionsIsSortedAndIgnoresUnknownBits(t *testing.T) {
	mask := Mask(permKick, permView) | 1<<63
	got := ToPermissions(mask)
	if len(got) != 2 || got[0] != permKick || got[1] != permView {
		t.Fatalf("ToPermissions = %v", got)
	}
}

func TestToPermissionsReturnsACopy(t *testing.T) {
	first := ToPermissions(Mask(permKick))
	first[0] = rostalkv1.Permission_PERMISSION_UNSPECIFIED
	second := ToPermissions(Mask(permKick))
	if second[0] != permKick {
		t.Fatal("ToPermissions shares state")
	}
}

func TestCanCreateRoleBoundaries(t *testing.T) {
	admin := Subject{UserID: 1, Roles: []Role{role(1, 100, permManageServer)}}
	moderator := Subject{UserID: 2, Roles: []Role{role(2, 50)}}
	member := Subject{UserID: 3, Roles: []Role{role(3, 10)}}

	tests := []struct {
		name     string
		actor    Subject
		position int32
		want     bool
	}{
		{"manage_server creates anywhere", admin, 1_000, true},
		{"strictly below the highest role", moderator, 49, true},
		{"same position is refused", moderator, 50, false},
		{"above the highest role is refused", moderator, 51, false},
		{"member creates below itself", member, 9, true},
		{"member cannot create at its own position", member, 10, false},
		{"subject without roles creates nothing", Subject{UserID: 4}, 0, false},
		{"unknown actor creates nothing", Subject{UserID: 0, Roles: []Role{role(9, 100, permManageServer)}}, 0, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := CanCreateRole(test.actor, test.position); got != test.want {
				t.Fatalf("CanCreateRole = %t, want %t", got, test.want)
			}
		})
	}
}

func TestUnknownPermissionsAreNeverGranted(t *testing.T) {
	unknown := rostalkv1.Permission(99)
	subject := Subject{UserID: 1, Roles: []Role{role(1, 10, permManageServer)}}

	if got := Mask(unknown); got != 0 {
		t.Fatalf("Mask(unknown) = %d, want 0", got)
	}
	if got := PermissionMask(unknown); got != 0 {
		t.Fatalf("PermissionMask(unknown) = %d, want 0", got)
	}
	if Allows(subject, nil, unknown, 0) {
		t.Fatal("Allows granted an unknown permission")
	}
	if IsChannelPermission(unknown) {
		t.Fatal("unknown permission counts as a channel permission")
	}
	if got := Mask(rostalkv1.Permission_PERMISSION_UNSPECIFIED, permKick); got != Mask(permKick) {
		t.Fatalf("unspecified must not add a bit: %d", got)
	}
	if All() != AllMask {
		t.Fatalf("All() = %d, want AllMask %d", All(), AllMask)
	}
	// Bit 0 stays unused, and the mask ends at the highest real permission.
	if AllMask&1 != 0 {
		t.Fatal("bit 0 must not be part of AllMask")
	}
	if AllMask&PermissionMask(rostalkv1.Permission_PERMISSION_MANAGE_MESSAGES) == 0 {
		t.Fatal("AllMask must contain the highest permission")
	}
}
