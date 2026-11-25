package channels

import (
	"context"
	"errors"
	"path/filepath"
	"strconv"
	"testing"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/store"
)

func newTestService(t *testing.T) (*Service, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "rostalk.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	service, err := Open(context.Background(), Config{Store: st})
	if err != nil {
		t.Fatalf("channels.Open: %v", err)
	}
	return service, st
}

func TestFirstStartCreatesLobbyAndAFK(t *testing.T) {
	service, _ := newTestService(t)

	list := service.List()
	if len(list) != 2 {
		t.Fatalf("channels = %d, want Lobby and AFK", len(list))
	}
	if list[0].Name != LobbyName || list[1].Name != AFKName {
		t.Fatalf("default channels = %q, %q; want %q, %q",
			list[0].Name, list[1].Name, LobbyName, AFKName)
	}
	if list[0].Position != 0 || list[1].Position != 1 {
		t.Fatalf("default positions = %d, %d", list[0].Position, list[1].Position)
	}
	if list[0].Kind != rostalkv1.ChannelKind_CHANNEL_KIND_VOICE {
		t.Fatal("Lobby is not a voice channel")
	}
	if list[0].Temporary || list[1].Temporary {
		t.Fatal("default channels must not be temporary")
	}
	if list[0].AFK || !list[1].AFK {
		t.Fatalf("idle flags = %v, %v; want only the second default channel flagged",
			list[0].AFK, list[1].AFK)
	}

	// Reopening does not duplicate them.
	again, err := Open(context.Background(), Config{Store: service.store})
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := len(again.List()); got != 2 {
		t.Fatalf("channels after reopen = %d, want 2", got)
	}
}

func TestTemporaryChannelsAreRemovedOnRestart(t *testing.T) {
	service, st := newTestService(t)
	ctx := context.Background()
	lobby := service.List()[0]

	temporary, err := service.Create(ctx, CreateParams{Name: "temp", ParentID: lobby.ID, Temporary: true})
	if err != nil {
		t.Fatalf("create temporary: %v", err)
	}
	nested, err := service.Create(ctx, CreateParams{Name: "nested", ParentID: temporary.ID, Temporary: true})
	if err != nil {
		t.Fatalf("create nested temporary: %v", err)
	}
	permanent, err := service.Create(ctx, CreateParams{Name: "keep", ParentID: lobby.ID})
	if err != nil {
		t.Fatalf("create permanent: %v", err)
	}

	// Presence is in memory, so a restart sees every temporary channel empty.
	reopened, err := Open(ctx, Config{Store: st})
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if _, ok := reopened.Get(temporary.ID); ok {
		t.Fatal("a temporary channel survived the restart")
	}
	if _, ok := reopened.Get(nested.ID); ok {
		t.Fatal("a nested temporary channel survived the restart")
	}
	if _, ok := reopened.Get(permanent.ID); !ok {
		t.Fatal("a permanent channel was deleted on restart")
	}
}

func TestCreateKeepsSiblingOrder(t *testing.T) {
	service, _ := newTestService(t)
	ctx := context.Background()
	lobby := service.List()[0]

	second, err := service.Create(ctx, CreateParams{Name: "Second", ParentID: lobby.ID})
	if err != nil {
		t.Fatalf("create Second: %v", err)
	}
	if second.Position != int32(len(service.Children(lobby.ID))-1) {
		t.Fatalf("Second position = %d", second.Position)
	}

	// Insert at the head of the sibling list.
	position := int32(0)
	first, err := service.Create(ctx, CreateParams{Name: "First", ParentID: lobby.ID, Position: &position})
	if err != nil {
		t.Fatalf("create First: %v", err)
	}
	children := service.Children(lobby.ID)
	if len(children) != 2 || children[0].ID != first.ID || children[1].ID != second.ID {
		t.Fatalf("children order = %v", children)
	}
	for i, child := range children {
		if child.Position != int32(i) {
			t.Fatalf("child %d (%s) has position %d", i, child.Name, child.Position)
		}
	}

	// Out-of-range positions are clamped to the end.
	huge := int32(99)
	last, err := service.Create(ctx, CreateParams{Name: "Last", ParentID: lobby.ID, Position: &huge})
	if err != nil {
		t.Fatalf("create Last: %v", err)
	}
	if got := service.Children(lobby.ID); got[len(got)-1].ID != last.ID {
		t.Fatal("a clamped position did not append the channel")
	}
}

func TestMoveReordersAndReparents(t *testing.T) {
	service, _ := newTestService(t)
	ctx := context.Background()
	lobby := service.List()[0]
	afk := service.List()[1]

	a, err := service.Create(ctx, CreateParams{Name: "a", ParentID: lobby.ID})
	if err != nil {
		t.Fatalf("create a: %v", err)
	}
	b, err := service.Create(ctx, CreateParams{Name: "b", ParentID: lobby.ID})
	if err != nil {
		t.Fatalf("create b: %v", err)
	}

	// Same parent, move b to the front.
	position := int32(0)
	if _, err := service.Move(ctx, b.ID, lobby.ID, &position); err != nil {
		t.Fatalf("move b: %v", err)
	}
	children := service.Children(lobby.ID)
	if children[0].ID != b.ID || children[1].ID != a.ID {
		t.Fatalf("children after move = %v", children)
	}
	for i, child := range children {
		if child.Position != int32(i) {
			t.Fatalf("%s has position %d, want %d", child.Name, child.Position, i)
		}
	}

	// Reparent a under AFK.
	if _, err := service.Move(ctx, a.ID, afk.ID, nil); err != nil {
		t.Fatalf("reparent a: %v", err)
	}
	if got := service.Children(lobby.ID); len(got) != 1 || got[0].ID != b.ID {
		t.Fatalf("lobby children after reparent = %v", got)
	}
	if got := service.Children(afk.ID); len(got) != 1 || got[0].ID != a.ID {
		t.Fatalf("AFK children after reparent = %v", got)
	}
	if got := service.Children(lobby.ID)[0].Position; got != 0 {
		t.Fatalf("lobby positions were not renumbered: %d", got)
	}
}

func TestMoveRejectsCycles(t *testing.T) {
	service, _ := newTestService(t)
	ctx := context.Background()
	lobby := service.List()[0]

	parent, err := service.Create(ctx, CreateParams{Name: "parent", ParentID: lobby.ID})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}
	child, err := service.Create(ctx, CreateParams{Name: "child", ParentID: parent.ID})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	grandchild, err := service.Create(ctx, CreateParams{Name: "grandchild", ParentID: child.ID})
	if err != nil {
		t.Fatalf("create grandchild: %v", err)
	}

	if _, err := service.Move(ctx, parent.ID, parent.ID, nil); !errors.Is(err, ErrCycle) {
		t.Fatalf("moving a channel into itself = %v, want ErrCycle", err)
	}
	if _, err := service.Move(ctx, parent.ID, grandchild.ID, nil); !errors.Is(err, ErrCycle) {
		t.Fatalf("moving a channel into its grandchild = %v, want ErrCycle", err)
	}
	if _, err := service.Move(ctx, child.ID, parent.ID, nil); err != nil {
		t.Fatalf("moving a child to its current parent: %v", err)
	}
	if _, err := service.Move(ctx, parent.ID, 424242, nil); !errors.Is(err, ErrParentNotFound) {
		t.Fatalf("moving under a missing parent = %v, want ErrParentNotFound", err)
	}
	if _, err := service.Move(ctx, 424242, lobby.ID, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("moving a missing channel = %v, want ErrNotFound", err)
	}

	// The tree is still a tree: walking parents from every node reaches the root.
	for _, ch := range service.List() {
		seen := 0
		for current := ch; current.ParentID != 0; {
			next, ok := service.Get(current.ParentID)
			if !ok {
				t.Fatalf("%q has a dangling parent %d", ch.Name, current.ParentID)
			}
			current = next
			seen++
			if seen > len(service.List()) {
				t.Fatalf("%q is part of a parent cycle", ch.Name)
			}
		}
	}
}

func TestDeleteRemovesSubtreeAndRenumbers(t *testing.T) {
	service, _ := newTestService(t)
	ctx := context.Background()
	lobby := service.List()[0]

	keep, err := service.Create(ctx, CreateParams{Name: "keep", ParentID: lobby.ID})
	if err != nil {
		t.Fatalf("create keep: %v", err)
	}
	gone, err := service.Create(ctx, CreateParams{Name: "gone", ParentID: lobby.ID})
	if err != nil {
		t.Fatalf("create gone: %v", err)
	}
	child, err := service.Create(ctx, CreateParams{Name: "child", ParentID: gone.ID})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	grandchild, err := service.Create(ctx, CreateParams{Name: "grandchild", ParentID: child.ID})
	if err != nil {
		t.Fatalf("create grandchild: %v", err)
	}

	removed, err := service.Delete(ctx, gone.ID)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	want := []int64{grandchild.ID, child.ID, gone.ID}
	if len(removed) != len(want) {
		t.Fatalf("removed = %v, want %v", removed, want)
	}
	for i := range want {
		if removed[i] != want[i] {
			t.Fatalf("removed = %v, want children before parents %v", removed, want)
		}
	}
	for _, id := range want {
		if _, ok := service.Get(id); ok {
			t.Fatalf("channel %d survived deletion", id)
		}
	}
	children := service.Children(lobby.ID)
	if len(children) != 1 || children[0].ID != keep.ID || children[0].Position != 0 {
		t.Fatalf("siblings after delete = %v", children)
	}
	if _, err := service.Delete(ctx, gone.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleting twice = %v, want ErrNotFound", err)
	}
}

func TestUpdateSettingsAndPassword(t *testing.T) {
	service, _ := newTestService(t)
	ctx := context.Background()
	lobby := service.List()[0]

	channel, err := service.Create(ctx, CreateParams{Name: "Music", ParentID: lobby.ID})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	topic := "  Добро пожаловать  "
	limit := uint32(5)
	profile := rostalkv1.VoiceProfile_VOICE_PROFILE_MUSIC
	temporary := true
	updated, err := service.Update(ctx, channel.ID, UpdateParams{
		Topic:        &topic,
		UserLimit:    &limit,
		VoiceProfile: &profile,
		Temporary:    &temporary,
		SetPassword:  true,
		Password:     "s3cret",
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Topic != "Добро пожаловать" {
		t.Fatalf("topic = %q", updated.Topic)
	}
	if updated.UserLimit != 5 || updated.VoiceProfile != profile || !updated.Temporary {
		t.Fatalf("update result = %+v", updated)
	}
	if !updated.HasPassword() {
		t.Fatal("password was not set")
	}
	if updated.PasswordHash() == "s3cret" {
		t.Fatal("password was stored in clear text")
	}
	if !service.VerifyPassword(channel.ID, "s3cret") {
		t.Fatal("correct channel password was rejected")
	}
	if service.VerifyPassword(channel.ID, "wrong") {
		t.Fatal("wrong channel password was accepted")
	}

	// An empty password clears it.
	cleared, err := service.Update(ctx, channel.ID, UpdateParams{SetPassword: true})
	if err != nil {
		t.Fatalf("clear password: %v", err)
	}
	if cleared.HasPassword() {
		t.Fatal("password was not cleared")
	}
	if !service.VerifyPassword(channel.ID, "") {
		t.Fatal("a channel without a password rejected an empty one")
	}

	// Nil fields keep their values.
	name := "Renamed"
	renamed, err := service.Update(ctx, channel.ID, UpdateParams{Name: &name})
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if renamed.Name != "Renamed" || renamed.UserLimit != 5 || renamed.VoiceProfile != profile {
		t.Fatalf("partial update lost fields: %+v", renamed)
	}
}

func TestIdleFlagIsPersistedAndSentOnTheWire(t *testing.T) {
	service, st := newTestService(t)
	ctx := context.Background()
	lobby := service.List()[0]

	idle := true
	updated, err := service.Update(ctx, lobby.ID, UpdateParams{AFK: &idle})
	if err != nil {
		t.Fatalf("update idle flag: %v", err)
	}
	if !updated.AFK {
		t.Fatal("the idle flag was not set")
	}
	if !updated.Proto(0).GetAfk() {
		t.Fatal("the wire channel does not carry the idle flag")
	}

	reopened, err := Open(ctx, Config{Store: st})
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	channel, ok := reopened.Get(lobby.ID)
	if !ok || !channel.AFK {
		t.Fatal("the idle flag did not survive a restart")
	}
}

func TestInvalidChannelInputIsRejected(t *testing.T) {
	service, _ := newTestService(t)
	ctx := context.Background()
	lobby := service.List()[0]

	if _, err := service.Create(ctx, CreateParams{Name: "   "}); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("empty name = %v, want ErrInvalidName", err)
	}
	if _, err := service.Create(ctx, CreateParams{Name: "bad\nname"}); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("control characters = %v, want ErrInvalidName", err)
	}
	kind := rostalkv1.ChannelKind(99)
	if _, err := service.Create(ctx, CreateParams{Name: "k", Kind: kind}); !errors.Is(err, ErrInvalidKind) {
		t.Fatalf("unknown kind = %v, want ErrInvalidKind", err)
	}
	profile := rostalkv1.VoiceProfile(99)
	if _, err := service.Create(ctx, CreateParams{Name: "p", VoiceProfile: profile}); !errors.Is(err, ErrInvalidVoiceProfile) {
		t.Fatalf("unknown voice profile = %v, want ErrInvalidVoiceProfile", err)
	}
	if _, err := service.Create(ctx, CreateParams{Name: "orphan", ParentID: lobby.ID + 1000}); !errors.Is(err, ErrParentNotFound) {
		t.Fatalf("missing parent = %v, want ErrParentNotFound", err)
	}
}

func TestListIsStableAfterManyMoves(t *testing.T) {
	service, _ := newTestService(t)
	ctx := context.Background()
	root := service.List()[0]

	var created []Channel
	for i := 0; i < 10; i++ {
		ch, err := service.Create(ctx, CreateParams{Name: "c" + strconv.Itoa(i), ParentID: root.ID})
		if err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
		created = append(created, ch)
	}
	for i := 0; i < 100; i++ {
		target := created[i%len(created)]
		position := int32(i % 5)
		if _, err := service.Move(ctx, target.ID, root.ID, &position); err != nil {
			t.Fatalf("move %d: %v", i, err)
		}
	}
	children := service.Children(root.ID)
	if len(children) != len(created) {
		t.Fatalf("children = %d, want %d", len(children), len(created))
	}
	for i, child := range children {
		if child.Position != int32(i) {
			t.Fatalf("child %d has position %d", i, child.Position)
		}
	}
}
