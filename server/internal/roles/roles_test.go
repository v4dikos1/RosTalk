package roles

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/perms"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

type fixture struct {
	service *Service
	store   *store.Store
	admin   int64
	mod     int64
	member  int64
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "rostalk.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	service, err := Open(ctx, Config{Store: st})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	f := &fixture{service: service, store: st}
	for index, target := range []*int64{&f.admin, &f.mod, &f.member} {
		key := make([]byte, 32)
		key[0] = byte(index + 1)
		user, err := st.UpsertUser(ctx, key, "user", time.Unix(1_700_000_000, 0))
		if err != nil {
			t.Fatalf("UpsertUser: %v", err)
		}
		*target = user.ID
	}
	assign := func(userID int64, name string) {
		role, ok := service.RoleByName(name)
		if !ok {
			t.Fatalf("role %s is missing", name)
		}
		if err := service.Assign(ctx, System, userID, role.ID); err != nil {
			t.Fatalf("assign %s: %v", name, err)
		}
	}
	assign(f.admin, AdminName)
	assign(f.mod, ModeratorName)
	assign(f.member, MemberName)
	return f
}

func TestRoleServiceRequiresManageRoles(t *testing.T) {
	f := newFixture(t)
	member := f.service.Subject(f.member)
	if _, err := f.service.Create(context.Background(), member, CreateParams{Name: "Nope"}); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("Create without manage_roles = %v, want ErrPermissionDenied", err)
	}
}

func TestModeratorCannotEscalateThroughALowerRole(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	memberRole, ok := f.service.RoleByName(MemberName)
	if !ok {
		t.Fatal("Member role is missing")
	}
	moderator := f.service.Subject(f.mod)
	permissions := []rostalkv1.Permission{
		rostalkv1.Permission_PERMISSION_VIEW_CHANNEL,
		rostalkv1.Permission_PERMISSION_MANAGE_SERVER,
	}
	_, err := f.service.Update(ctx, moderator, memberRole.ID, UpdateParams{Permissions: &permissions})
	if !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("moderator adding manage_server = %v, want ErrPermissionDenied", err)
	}
}

func TestModeratorCannotAssignAdminRole(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	// Give the moderator the manage_roles right through a lower role, so the
	// hierarchy check (not the missing permission) is what rejects the action.
	manager, err := f.service.Create(ctx, System, CreateParams{
		Name:        "RoleManager",
		Permissions: []rostalkv1.Permission{rostalkv1.Permission_PERMISSION_MANAGE_ROLES},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := f.service.Assign(ctx, System, f.mod, manager.ID); err != nil {
		t.Fatalf("Assign RoleManager: %v", err)
	}
	adminRole, ok := f.service.RoleByName(AdminName)
	if !ok {
		t.Fatal("Admin role is missing")
	}
	if err := f.service.Assign(ctx, f.service.Subject(f.mod), f.member, adminRole.ID); !errors.Is(err, ErrHierarchy) {
		t.Fatalf("moderator assigning Admin = %v, want ErrHierarchy", err)
	}
}

func TestModeratorCanReorderBelowOwnRoleOnly(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	manager, err := f.service.Create(ctx, System, CreateParams{
		Name:        "RoleManager",
		Permissions: []rostalkv1.Permission{rostalkv1.Permission_PERMISSION_MANAGE_ROLES},
	})
	if err != nil {
		t.Fatalf("Create RoleManager: %v", err)
	}
	if err := f.service.Assign(ctx, System, f.mod, manager.ID); err != nil {
		t.Fatalf("Assign RoleManager: %v", err)
	}
	actor := f.service.Subject(f.mod)
	roles := f.service.Roles()
	ids := make([]uint64, 0, len(roles))
	for _, role := range roles {
		ids = append(ids, uint64(role.ID))
	}
	// Swap the two least powerful roles; a moderator may rearrange the region
	// below its own role.
	swapped := append([]uint64(nil), ids...)
	swapped[0], swapped[1] = swapped[1], swapped[0]
	if _, err := f.service.Reorder(ctx, actor, swapped); err != nil {
		t.Fatalf("reorder below own role: %v", err)
	}
	// Moving Member above Moderator changes a role at the actor's level.
	memberRole, _ := f.service.RoleByName(MemberName)
	moderatorRole, _ := f.service.RoleByName(ModeratorName)
	above := append([]uint64(nil), swapped...)
	memberIndex, moderatorIndex := -1, -1
	for index, id := range above {
		switch int64(id) {
		case memberRole.ID:
			memberIndex = index
		case moderatorRole.ID:
			moderatorIndex = index
		}
	}
	if memberIndex < 0 || moderatorIndex < 0 {
		t.Fatal("built-in roles are missing")
	}
	above[memberIndex], above[moderatorIndex] = above[moderatorIndex], above[memberIndex]
	if _, err := f.service.Reorder(ctx, actor, above); !errors.Is(err, ErrHierarchy) {
		t.Fatalf("reorder above own role = %v, want ErrHierarchy", err)
	}
}

func TestOverrideControlsChannelVisibility(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	tx, err := f.store.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	channel, err := tx.InsertChannel(ctx, store.Channel{
		Name: "test", Kind: 1, VoiceProfile: 1, CreatedAt: time.Unix(1_700_000_000, 0),
	})
	if err != nil {
		t.Fatalf("InsertChannel: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	channelID := channel.ID
	memberRole, ok := f.service.RoleByName(MemberName)
	if !ok {
		t.Fatal("Member role is missing")
	}
	if !f.service.CanView(f.member, uint64(channelID)) {
		t.Fatal("a member cannot see a channel before the override")
	}
	if _, err := f.service.SetOverride(ctx, f.service.Subject(f.admin), channelID, memberRole.ID,
		0, perms.Mask(rostalkv1.Permission_PERMISSION_VIEW_CHANNEL)); err != nil {
		t.Fatalf("SetOverride: %v", err)
	}
	if f.service.CanView(f.member, uint64(channelID)) {
		t.Fatal("a channel deny did not hide the channel")
	}
	// The administrator holds manage_server, which bypasses the deny.
	if !f.service.CanView(f.admin, uint64(channelID)) {
		t.Fatal("manage_server did not bypass the channel deny")
	}
}

func TestBuiltinRolesCannotBeDeleted(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	guest, ok := f.service.RoleByName(GuestName)
	if !ok {
		t.Fatal("Guest role is missing")
	}
	if err := f.service.Delete(ctx, System, guest.ID); !errors.Is(err, ErrBuiltin) {
		t.Fatalf("deleting a built-in role = %v, want ErrBuiltin", err)
	}
}

func TestBuiltinRolesCannotBeRenamed(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	for _, name := range []string{AdminName, MemberName} {
		role, ok := f.service.RoleByName(name)
		if !ok {
			t.Fatalf("%s role is missing", name)
		}
		renamed := "Renamed " + name
		if _, err := f.service.Update(ctx, System, role.ID, UpdateParams{Name: &renamed}); !errors.Is(err, ErrBuiltin) {
			t.Fatalf("renaming the built-in %s role = %v, want ErrBuiltin", name, err)
		}
		if current, _ := f.service.RoleByID(role.ID); current.Name != name {
			t.Fatalf("the built-in %s role was renamed to %q", name, current.Name)
		}
	}
	// Re-applying the same name is not a rename and must keep working for an
	// admin UI that sends the whole role back.
	member, _ := f.service.RoleByName(MemberName)
	same := member.Name
	if _, err := f.service.Update(ctx, System, member.ID, UpdateParams{Name: &same}); err != nil {
		t.Fatalf("update with an unchanged built-in name: %v", err)
	}
}

func TestLastAdminCannotBeLockedOut(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	adminRole, ok := f.service.RoleByName(AdminName)
	if !ok {
		t.Fatal("the Admin role is missing")
	}
	withoutManageServer := []rostalkv1.Permission{
		rostalkv1.Permission_PERMISSION_VIEW_CHANNEL,
		rostalkv1.Permission_PERMISSION_MANAGE_ROLES,
	}
	// Even the local system actor must not strip the last bypass right.
	if _, err := f.service.Update(ctx, System, adminRole.ID, UpdateParams{Permissions: &withoutManageServer}); !errors.Is(err, ErrSelfLockout) {
		t.Fatalf("stripping manage_server from the last admin role = %v, want ErrSelfLockout", err)
	}
	if current, _ := f.service.RoleByID(adminRole.ID); !hasManageServer(current.Permissions) {
		t.Fatal("the Admin role lost manage_server after a rejected update")
	}
	// Neither may an administrator remove their own last assignment.
	if err := f.service.Unassign(ctx, f.service.Subject(f.admin), f.admin, adminRole.ID); !errors.Is(err, ErrSelfLockout) {
		t.Fatalf("unassigning the last admin = %v, want ErrSelfLockout", err)
	}
	if err := f.service.Unassign(ctx, System, f.admin, adminRole.ID); !errors.Is(err, ErrSelfLockout) {
		t.Fatalf("system unassigning the last admin = %v, want ErrSelfLockout", err)
	}
	if !f.service.Can(f.admin, rostalkv1.Permission_PERMISSION_MANAGE_SERVER, 0) {
		t.Fatal("the rejected changes left the administrator without manage_server")
	}

	// With a second administrator the same unassign is allowed, and the guard
	// still protects the remaining one.
	if err := f.service.Assign(ctx, System, f.mod, adminRole.ID); err != nil {
		t.Fatalf("grant a second admin: %v", err)
	}
	if err := f.service.Unassign(ctx, System, f.admin, adminRole.ID); err != nil {
		t.Fatalf("unassign one of two admins: %v", err)
	}
	if err := f.service.Unassign(ctx, System, f.mod, adminRole.ID); !errors.Is(err, ErrSelfLockout) {
		t.Fatalf("unassigning the remaining admin = %v, want ErrSelfLockout", err)
	}
}

func TestDefaultRoleIsMember(t *testing.T) {
	f := newFixture(t)
	member, ok := f.service.RoleByName(MemberName)
	if !ok {
		t.Fatal("Member role is missing")
	}
	if f.service.DefaultRoleID() != member.ID {
		t.Fatalf("default role = %d, want %d", f.service.DefaultRoleID(), member.ID)
	}
}
