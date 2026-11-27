package chat

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/perms"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/state"
	"github.com/v4dikos1/RosTalk/server/internal/store"
	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

type fixture struct {
	service   *Service
	store     *store.Store
	roles     *roles.Service
	channels  *channels.Service
	hub       *state.Hub
	dir       string
	channel   uint64
	member    int64
	moderator int64
	guest     int64
	now       time.Time
}

func newFixture(t testing.TB) *fixture {
	t.Helper()
	return newFixtureWithLimits(t, 4096, 8192)
}

func newFixtureWithLimits(t testing.TB, maxFile, quota int64) *fixture {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "rostalk.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	channelsService, err := channels.Open(context.Background(), channels.Config{Store: st})
	if err != nil {
		t.Fatalf("open channels: %v", err)
	}
	roleService, err := roles.Open(context.Background(), roles.Config{Store: st})
	if err != nil {
		t.Fatalf("open roles: %v", err)
	}
	hub := state.NewHub(state.Config{Channels: channelsService, Visibility: roleService})
	channel, err := channelsService.Create(context.Background(), channels.CreateParams{
		Name: "general",
		Kind: rostalkv1.ChannelKind_CHANNEL_KIND_TEXT,
	})
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	now := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	service, err := New(Config{
		Store:    st,
		Roles:    roleService,
		Hub:      hub,
		FilesDir: filepath.Join(dir, "files"),
		Settings: func() store.Settings {
			return store.Settings{MaxAttachmentBytes: maxFile, AttachmentQuotaBytes: quota}
		},
		Now:          func() time.Time { return now },
		RateInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("new chat: %v", err)
	}
	return &fixture{
		service:   service,
		store:     st,
		roles:     roleService,
		channels:  channelsService,
		hub:       hub,
		dir:       dir,
		channel:   uint64(channel.ID),
		moderator: 0,
		guest:     0,
		member:    0,
		now:       now,
	}
}

func (f *fixture) user(t testing.TB, key byte, nickname, roleName string) int64 {
	t.Helper()
	publicKey := bytes.Repeat([]byte{key}, 32)
	user, err := f.store.UpsertUser(context.Background(), publicKey, nickname, f.now)
	if err != nil {
		t.Fatalf("create user %s: %v", nickname, err)
	}
	role, ok := f.roles.RoleByName(roleName)
	if !ok {
		t.Fatalf("role %q not found", roleName)
	}
	if err := f.roles.Assign(context.Background(), roles.System, user.ID, role.ID); err != nil {
		t.Fatalf("assign %s: %v", roleName, err)
	}
	return user.ID
}

// onlineUser gives a stored user a live presence. Nicknames are unique only
// among connected users, so a test of a namesake needs one record online.
func (f *fixture) onlineUser(t testing.TB, userID int64, nickname string) {
	t.Helper()
	session, err := state.NewSession(state.SessionParams{
		UserID:      userID,
		PublicKeyID: fmt.Sprintf("online-%d", userID),
		Nickname:    nickname,
		ConnectedAt: f.now,
		Transport:   nopTransport{},
	})
	if err != nil {
		t.Fatalf("new session: %v", err)
	}
	if _, err := f.hub.Register(session); err != nil {
		t.Fatalf("register session: %v", err)
	}
	if err := f.hub.Welcome(session, 1, func(users []state.Presence) *rostalkv1.ServerSnapshot {
		return &rostalkv1.ServerSnapshot{
			Server: &rostalkv1.ServerInfo{OnlineUsers: uint32(len(users))},
		}
	}); err != nil {
		t.Fatalf("welcome: %v", err)
	}
	t.Cleanup(func() {
		session.Terminate(rostalkv1.ErrorCode_ERROR_CODE_UNSPECIFIED, "test finished")
	})
}

// nopTransport keeps an online session without a socket.
type nopTransport struct{}

func (nopTransport) Read(ctx context.Context) (*rostalkv1.ClientFrame, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func (nopTransport) Write(context.Context, *rostalkv1.ServerFrame) error { return nil }

func (nopTransport) Close() error { return nil }

func TestSendHistoryAndCursors(t *testing.T) {
	f := newFixture(t)
	author := f.user(t, 1, "Alice", roles.MemberName)
	ctx := context.Background()

	var sent []Message
	for index := 0; index < 5; index++ {
		message, err := f.service.Send(ctx, author, Conversation{ChannelID: f.channel}, "message "+string(rune('a'+index)), nil)
		if err != nil {
			t.Fatalf("send %d: %v", index, err)
		}
		sent = append(sent, message)
	}

	page, next, hasMore, err := f.service.History(ctx, author, Conversation{ChannelID: f.channel}, "", 2)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if !hasMore || len(page) != 2 || page[0].ID != sent[3].ID || page[1].ID != sent[4].ID {
		t.Fatalf("unexpected newest page: %+v hasMore=%v", page, hasMore)
	}
	older, next2, hasMore2, err := f.service.History(ctx, author, Conversation{ChannelID: f.channel}, next, 2)
	if err != nil {
		t.Fatalf("older history: %v", err)
	}
	if len(older) != 2 || older[0].ID != sent[1].ID || older[1].ID != sent[2].ID || !hasMore2 {
		t.Fatalf("unexpected older page: %+v", older)
	}
	last, _, hasMore3, err := f.service.History(ctx, author, Conversation{ChannelID: f.channel}, next2, 2)
	if err != nil {
		t.Fatalf("last history: %v", err)
	}
	if len(last) != 1 || last[0].ID != sent[0].ID || hasMore3 {
		t.Fatalf("unexpected last page: %+v hasMore=%v", last, hasMore3)
	}
	if _, _, _, err := f.service.History(ctx, author, Conversation{ChannelID: f.channel}, next, 5); err != nil {
		t.Fatalf("cursor is bound to a conversation: %v", err)
	}
	other := f.user(t, 2, "Bob", roles.MemberName)
	peerCursor := encodeCursor(Conversation{PeerID: other}, sent[0].ID)
	if _, _, _, err := f.service.History(ctx, author, Conversation{ChannelID: f.channel}, peerCursor, 5); err == nil {
		t.Fatal("a cursor from another conversation must be rejected")
	}
}

func TestPermissionsAndRateLimit(t *testing.T) {
	f := newFixture(t)
	member := f.user(t, 1, "Alice", roles.MemberName)
	guest := f.user(t, 2, "Guest", roles.GuestName)
	ctx := context.Background()

	if _, err := f.service.Send(ctx, guest, Conversation{ChannelID: f.channel}, "hello", nil); err == nil {
		t.Fatal("guest without send_messages must not send")
	}
	for index := 0; index < 5; index++ {
		if _, err := f.service.Send(ctx, member, Conversation{ChannelID: f.channel}, "hi", nil); err != nil {
			t.Fatalf("send %d: %v", index, err)
		}
	}
	if _, err := f.service.Send(ctx, member, Conversation{ChannelID: f.channel}, "too fast", nil); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("want ErrRateLimited, got %v", err)
	}
}

func TestUnreadStateSurvivesOwnChannelMessages(t *testing.T) {
	f := newFixture(t)
	alice := f.user(t, 1, "Alice", roles.MemberName)
	bob := f.user(t, 2, "Bob", roles.MemberName)
	ctx := context.Background()

	dm, err := f.service.Send(ctx, alice, Conversation{PeerID: bob}, "hello", nil)
	if err != nil {
		t.Fatalf("send dm: %v", err)
	}
	// A channel message by the same author has no recipient. It must not turn
	// into a direct-conversation row with a NULL peer id.
	if _, err := f.service.Send(ctx, alice, Conversation{ChannelID: f.channel}, "in channel", nil); err != nil {
		t.Fatalf("send channel message: %v", err)
	}
	counters, err := f.service.UnreadState(ctx, alice, []uint64{f.channel})
	if err != nil {
		t.Fatalf("UnreadState: %v", err)
	}
	foundDM := false
	for _, counter := range counters {
		if counter.Conversation.PeerID != 0 {
			foundDM = true
			if counter.Conversation.PeerID != bob || counter.LastMessageID != uint64(dm.ID) {
				t.Fatalf("unexpected dm counter: %+v", counter)
			}
		}
	}
	if !foundDM {
		t.Fatalf("the direct conversation is missing from the snapshot: %+v", counters)
	}
}

func TestUnreadStateMatchesPerConversationCounters(t *testing.T) {
	f := newFixture(t)
	alice := f.user(t, 1, "Alice", roles.MemberName)
	bob := f.user(t, 2, "Bob", roles.MemberName)
	ctx := context.Background()

	// Alice's own channel message is never unread, and a channel without a
	// read marker and without unread messages is not listed.
	if _, err := f.service.Send(ctx, alice, Conversation{ChannelID: f.channel}, "mine", nil); err != nil {
		t.Fatalf("send own channel message: %v", err)
	}
	counters, err := f.service.UnreadState(ctx, alice, []uint64{f.channel})
	if err != nil {
		t.Fatalf("UnreadState: %v", err)
	}
	for _, counter := range counters {
		if counter.Conversation.ChannelID == f.channel {
			t.Fatalf("a fully read channel must not be listed: %+v", counter)
		}
	}

	// A message from another user and a mention produce unread=1 and mentions=1.
	mentioned, err := f.service.Send(ctx, bob, Conversation{ChannelID: f.channel}, "hi @Alice", nil)
	if err != nil {
		t.Fatalf("send mentioned message: %v", err)
	}
	counters, err = f.service.UnreadState(ctx, alice, []uint64{f.channel})
	if err != nil {
		t.Fatalf("UnreadState: %v", err)
	}
	channelCounter := unreadOf(t, counters, Conversation{ChannelID: f.channel})
	if channelCounter.Unread != 1 || channelCounter.Mentions != 1 || channelCounter.LastReadID != 0 {
		t.Fatalf("fresh mention counter = %+v, want unread=1 mentions=1 last_read=0", channelCounter)
	}

	// Marking the channel read keeps it in the list (the marker exists) but
	// zeroes the counters and records the cursor.
	read, err := f.service.MarkRead(ctx, alice, Conversation{ChannelID: f.channel}, 0)
	if err != nil {
		t.Fatalf("mark channel read: %v", err)
	}
	if read.Unread != 0 || read.Mentions != 0 || read.LastReadID != uint64(mentioned.ID) {
		t.Fatalf("marked channel counter = %+v", read)
	}
	counters, err = f.service.UnreadState(ctx, alice, []uint64{f.channel})
	if err != nil {
		t.Fatalf("UnreadState after read: %v", err)
	}
	channelCounter = unreadOf(t, counters, Conversation{ChannelID: f.channel})
	if channelCounter.Unread != 0 || channelCounter.Mentions != 0 || channelCounter.LastReadID != uint64(mentioned.ID) {
		t.Fatalf("read channel counter = %+v", channelCounter)
	}

	// A direct conversation appears even with zero unread, carries the peer
	// nickname and the newest message id, and counts only the other side.
	firstDM, err := f.service.Send(ctx, alice, Conversation{PeerID: bob}, "hello", nil)
	if err != nil {
		t.Fatalf("send dm: %v", err)
	}
	counters, err = f.service.UnreadState(ctx, alice, []uint64{f.channel})
	if err != nil {
		t.Fatalf("UnreadState with dm: %v", err)
	}
	dmCounter := unreadOf(t, counters, Conversation{PeerID: bob})
	if dmCounter.Unread != 0 || dmCounter.LastMessageID != uint64(firstDM.ID) ||
		dmCounter.PeerNickname != "Bob" {
		t.Fatalf("own dm counter = %+v", dmCounter)
	}
	reply, err := f.service.Send(ctx, bob, Conversation{PeerID: alice}, "reply @Alice", nil)
	if err != nil {
		t.Fatalf("send dm reply: %v", err)
	}
	counters, err = f.service.UnreadState(ctx, alice, []uint64{f.channel})
	if err != nil {
		t.Fatalf("UnreadState after reply: %v", err)
	}
	dmCounter = unreadOf(t, counters, Conversation{PeerID: bob})
	if dmCounter.Unread != 1 || dmCounter.Mentions != 1 ||
		dmCounter.LastMessageID != uint64(reply.ID) || dmCounter.PeerNickname != "Bob" {
		t.Fatalf("dm counter after reply = %+v", dmCounter)
	}
	if _, err := f.service.MarkRead(ctx, alice, Conversation{PeerID: bob}, 0); err != nil {
		t.Fatalf("mark dm read: %v", err)
	}
	second, err := f.service.Send(ctx, bob, Conversation{PeerID: alice}, "second", nil)
	if err != nil {
		t.Fatalf("send second dm: %v", err)
	}
	third, err := f.service.Send(ctx, bob, Conversation{PeerID: alice}, "third", nil)
	if err != nil {
		t.Fatalf("send third dm: %v", err)
	}
	counters, err = f.service.UnreadState(ctx, alice, []uint64{f.channel})
	if err != nil {
		t.Fatalf("UnreadState after read dm: %v", err)
	}
	dmCounter = unreadOf(t, counters, Conversation{PeerID: bob})
	if dmCounter.Unread != 2 || dmCounter.Mentions != 0 ||
		dmCounter.LastMessageID != uint64(third.ID) || dmCounter.LastReadID != uint64(reply.ID) ||
		dmCounter.PeerNickname != "Bob" {
		t.Fatalf("dm counter after read = %+v (second id %d)", dmCounter, second.ID)
	}
}

func unreadOf(t *testing.T, counters []Unread, conv Conversation) Unread {
	t.Helper()
	for _, counter := range counters {
		if counter.Conversation == conv {
			return counter
		}
	}
	t.Fatalf("conversation %+v is missing from %+v", conv, counters)
	return Unread{}
}

func TestDirectMessagesAndUnread(t *testing.T) {
	f := newFixture(t)
	alice := f.user(t, 1, "Alice", roles.MemberName)
	bob := f.user(t, 2, "Bob", roles.MemberName)
	ctx := context.Background()

	first, err := f.service.Send(ctx, alice, Conversation{PeerID: bob}, "hi @Bob", nil)
	if err != nil {
		t.Fatalf("send dm: %v", err)
	}
	if first.ChannelID != 0 || first.RecipientID != bob || first.SenderID != alice {
		t.Fatalf("direct message ids are wrong: %+v", first)
	}
	if len(first.MentionIDs) != 1 || first.MentionIDs[0] != bob {
		t.Fatalf("mention was not resolved: %+v", first.MentionIDs)
	}
	second, err := f.service.Send(ctx, bob, Conversation{PeerID: alice}, "hello back", nil)
	if err != nil {
		t.Fatalf("send dm reply: %v", err)
	}

	counter, err := f.service.UnreadFor(ctx, alice, Conversation{PeerID: bob})
	if err != nil {
		t.Fatalf("unread: %v", err)
	}
	if counter.Unread != 1 || counter.Mentions != 0 {
		t.Fatalf("unexpected alice counter: %+v", counter)
	}
	bobCounter, err := f.service.UnreadFor(ctx, bob, Conversation{PeerID: alice})
	if err != nil {
		t.Fatalf("bob unread: %v", err)
	}
	if bobCounter.Unread != 1 || bobCounter.Mentions != 1 {
		t.Fatalf("the mention did not reach Bob: %+v", bobCounter)
	}
	page, _, _, err := f.service.History(ctx, alice, Conversation{PeerID: bob}, "", 10)
	if err != nil {
		t.Fatalf("dm history: %v", err)
	}
	if len(page) != 2 || page[0].ID != first.ID || page[1].ID != second.ID {
		t.Fatalf("unexpected dm page: %+v", page)
	}
	if _, err := f.service.MarkRead(ctx, alice, Conversation{PeerID: bob}, uint64(second.ID)); err != nil {
		t.Fatalf("mark read: %v", err)
	}
	counter, err = f.service.UnreadFor(ctx, alice, Conversation{PeerID: bob})
	if err != nil {
		t.Fatalf("unread after read: %v", err)
	}
	if counter.Unread != 0 || counter.Mentions != 0 {
		t.Fatalf("counter did not clear: %+v", counter)
	}

	// A third user is not a participant and must not read the conversation.
	carol := f.user(t, 3, "Carol", roles.MemberName)
	page, _, _, err = f.service.History(ctx, carol, Conversation{PeerID: bob}, "", 10)
	if err != nil {
		t.Fatalf("empty dm history: %v", err)
	}
	if len(page) != 0 {
		t.Fatalf("a non-participant saw direct messages: %+v", page)
	}
}

func TestMentionResolutionPrefersLongestName(t *testing.T) {
	f := newFixture(t)
	alice := f.user(t, 1, "Alice", roles.MemberName)
	ann := f.user(t, 2, "Ann", roles.MemberName)
	anna := f.user(t, 3, "Anna", roles.MemberName)
	annaMaria := f.user(t, 4, "Anna Maria", roles.MemberName)
	f.user(t, 5, "Bob", roles.MemberName)
	cyrillic := f.user(t, 6, "Анна", roles.MemberName)
	ctx := context.Background()
	conv := Conversation{ChannelID: f.channel}

	cases := []struct {
		body string
		want []int64
	}{
		{"@Ann", []int64{ann}},
		{"@Anna", []int64{anna}},
		{"@Anna Maria", []int64{annaMaria}},
		{"@anna maria", []int64{annaMaria}},
		{"look at @Ann, and @Anna Maria!", []int64{ann, annaMaria}},
		{"x@Anna", nil},
		{"@Anna-Marie", nil},
		{"@Ann @Ann @Anna", []int64{ann, anna}},
		{"@", nil},
		{"@Nobody", nil},
		{"@анна", []int64{cyrillic}},
	}
	for _, testCase := range cases {
		got, err := f.service.resolveMentions(ctx, alice, conv, testCase.body)
		if err != nil {
			t.Fatalf("resolveMentions(%q): %v", testCase.body, err)
		}
		if !sameIDSet(got, testCase.want) {
			t.Fatalf("mentions in %q = %v, want %v", testCase.body, got, testCase.want)
		}
	}
}

func TestMentionResolutionPrefersOnlineNamesake(t *testing.T) {
	f := newFixture(t)
	alice := f.user(t, 1, "Alice", roles.MemberName)
	// The old record has a smaller id, so a plain "ORDER BY id" scan would pick
	// it before the person the author actually chose in the editor.
	f.user(t, 2, "Anna", roles.MemberName)
	online := f.user(t, 3, "Anna", roles.MemberName)
	carol := f.user(t, 4, "Carol", roles.MemberName)
	f.onlineUser(t, online, "Anna")
	ctx := context.Background()
	conv := Conversation{ChannelID: f.channel}

	// One tag repeated with different case still delivers once, to one user.
	message, err := f.service.Send(ctx, alice, conv, "@Anna, @anna hello", nil)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(message.MentionIDs) != 1 || message.MentionIDs[0] != online {
		t.Fatalf("mention ids = %v, want one delivery to the online namesake %d", message.MentionIDs, online)
	}

	mentioned, err := f.service.UnreadFor(ctx, online, conv)
	if err != nil {
		t.Fatalf("unread of the mentioned user: %v", err)
	}
	if mentioned.Mentions != 1 {
		t.Fatalf("online namesake mentions = %d, want 1", mentioned.Mentions)
	}

	// A third participant reads the channel but is not mentioned.
	third, err := f.service.UnreadFor(ctx, carol, conv)
	if err != nil {
		t.Fatalf("unread of a third participant: %v", err)
	}
	if third.Unread != 1 || third.Mentions != 0 {
		t.Fatalf("third participant counter = %+v, want unread=1 mentions=0", third)
	}
}

func TestMentionResolutionIsBounded(t *testing.T) {
	f := newFixture(t)
	alice := f.user(t, 1, "Alice", roles.MemberName)
	ctx := context.Background()
	conv := Conversation{ChannelID: f.channel}

	tokens := make([]string, 0, MaxMentions+8)
	want := make([]int64, 0, MaxMentions)
	for index := 0; index < MaxMentions+8; index++ {
		nickname := fmt.Sprintf("person%02d", index)
		userID := f.user(t, byte(10+index), nickname, roles.MemberName)
		tokens = append(tokens, "@"+nickname)
		if index < MaxMentions {
			want = append(want, userID)
		}
	}
	got, err := f.service.resolveMentions(ctx, alice, conv, strings.Join(tokens, " "))
	if err != nil {
		t.Fatalf("resolveMentions: %v", err)
	}
	if len(got) != MaxMentions {
		t.Fatalf("%d mentions resolved, want the bound %d", len(got), MaxMentions)
	}
	if !sameIDSet(got, want) {
		t.Fatalf("mentions = %v, want the first %d", got, MaxMentions)
	}
}

// sameIDSet compares mention ids regardless of the order the query returns.
func sameIDSet(got, want []int64) bool {
	if len(got) != len(want) {
		return false
	}
	seen := make(map[int64]int, len(got))
	for _, id := range got {
		seen[id]++
	}
	for _, id := range want {
		seen[id]--
		if seen[id] < 0 {
			return false
		}
	}
	for _, count := range seen {
		if count != 0 {
			return false
		}
	}
	return true
}

func TestEditDeleteAndModeration(t *testing.T) {
	f := newFixture(t)
	author := f.user(t, 1, "Alice", roles.MemberName)
	other := f.user(t, 2, "Bob", roles.MemberName)
	moderator := f.user(t, 3, "Mod", roles.ModeratorName)
	ctx := context.Background()

	message, err := f.service.Send(ctx, author, Conversation{ChannelID: f.channel}, "original", nil)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	edited, err := f.service.Edit(ctx, author, message.ID, "edited")
	if err != nil {
		t.Fatalf("edit: %v", err)
	}
	if edited.Body != "edited" || edited.EditedAt == 0 {
		t.Fatalf("edit was not stored: %+v", edited)
	}
	if _, err := f.service.Edit(ctx, other, message.ID, "hijack"); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("a member edited a foreign message: %v", err)
	}
	// manage_messages moderates and deletes; it does not let anyone put words
	// into another user's mouth (ADR 0025).
	if _, err := f.service.Edit(ctx, moderator, message.ID, "moderated"); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("a moderator edited a foreign message: %v", err)
	}
	unchanged, err := f.service.loadMessage(ctx, message.ID)
	if err != nil {
		t.Fatalf("load after a refused edit: %v", err)
	}
	if unchanged.Body != "edited" {
		t.Fatalf("a refused edit changed the body: %q", unchanged.Body)
	}
	if err := f.service.Delete(ctx, other, message.ID); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("a member deleted a foreign message: %v", err)
	}
	if err := f.service.Delete(ctx, moderator, message.ID); err != nil {
		t.Fatalf("moderator delete: %v", err)
	}
	if _, err := f.service.loadMessage(ctx, message.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("message still exists: %v", err)
	}
}

func TestAttachmentNeedsPermissionInTheTargetConversation(t *testing.T) {
	f := newFixture(t)
	author := f.user(t, 1, "Alice", roles.MemberName)
	ctx := context.Background()

	// The upload goes to channel A, where the Member role may attach files.
	attachment, err := f.service.Upload(ctx, author, Conversation{ChannelID: f.channel}, "cat.png", bytes.NewReader(smallPNG(t)))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	// Channel B forbids attachments but still allows sending text.
	other, err := f.channels.Create(ctx, channels.CreateParams{
		Name: "no-files",
		Kind: rostalkv1.ChannelKind_CHANNEL_KIND_TEXT,
	})
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	memberRole, ok := f.roles.RoleByName(roles.MemberName)
	if !ok {
		t.Fatal("the Member role is missing")
	}
	if _, err := f.roles.SetOverride(ctx, roles.System, other.ID, memberRole.ID, 0,
		perms.Mask(rostalkv1.Permission_PERMISSION_ATTACH_FILES)); err != nil {
		t.Fatalf("deny attach: %v", err)
	}
	target := Conversation{ChannelID: uint64(other.ID)}
	if _, err := f.service.Send(ctx, author, target, "", []uint64{uint64(attachment.ID)}); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("send with an attachment into a channel without attach_files = %v, want ErrPermissionDenied", err)
	}
	// The claim must not happen when the permission check fails.
	if _, err := f.service.Send(ctx, author, target, "plain text", nil); err != nil {
		t.Fatalf("text message without an attachment: %v", err)
	}
	// The upload itself is refused in the channel that denies attachments.
	if _, err := f.service.Upload(ctx, author, target, "cat.png", bytes.NewReader(smallPNG(t))); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("upload into a channel without attach_files = %v, want ErrPermissionDenied", err)
	}
}

func TestAttachmentUploadAndAccess(t *testing.T) {
	f := newFixture(t)
	author := f.user(t, 1, "Alice", roles.MemberName)
	stranger := f.user(t, 2, "Bob", roles.MemberName)
	ctx := context.Background()
	png := smallPNG(t)

	attachment, err := f.service.Upload(ctx, author, Conversation{ChannelID: f.channel}, "cat.png", bytes.NewReader(png))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if !attachment.Image || attachment.ContentType != "image/png" || attachment.FileName != "cat.png" {
		t.Fatalf("unexpected attachment: %+v", attachment)
	}
	message, err := f.service.Send(ctx, author, Conversation{ChannelID: f.channel}, "", []uint64{uint64(attachment.ID)})
	if err != nil {
		t.Fatalf("send with attachment: %v", err)
	}
	if len(message.Attachments) != 1 || message.Attachments[0].ID != attachment.ID {
		t.Fatalf("attachment was not claimed: %+v", message.Attachments)
	}
	if _, path, err := f.service.Open(ctx, stranger, attachment.ID); err != nil {
		t.Fatalf("other member cannot read a channel attachment: %v", err)
	} else if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("stored file is missing: %v", statErr)
	}
	if _, _, err := f.service.Open(ctx, author, attachment.ID+1000); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown attachment: %v", err)
	}

	// HTML is rejected whatever its extension says.
	if _, err := f.service.Upload(ctx, author, Conversation{ChannelID: f.channel}, "page.png",
		bytes.NewReader([]byte("<html><script>alert(1)</script></html>"))); !errors.Is(err, ErrUnsupportedType) {
		t.Fatalf("html upload was accepted: %v", err)
	}
	// SVG is XML and must be rejected as well.
	if _, err := f.service.Upload(ctx, author, Conversation{ChannelID: f.channel}, "pic.png",
		bytes.NewReader([]byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`))); !errors.Is(err, ErrUnsupportedType) {
		t.Fatalf("svg upload was accepted: %v", err)
	}
	// Size limit.
	if _, err := f.service.Upload(ctx, author, Conversation{ChannelID: f.channel}, "big.bin",
		bytes.NewReader(bytes.Repeat([]byte{7}, 5000))); !errors.Is(err, ErrUploadTooLarge) {
		t.Fatalf("oversized upload was accepted: %v", err)
	}
	// Quota: the first file (PNG) plus a second 4 KiB text file exceeds 8192.
	if _, err := f.service.Upload(ctx, author, Conversation{ChannelID: f.channel}, "text.txt",
		bytes.NewReader(bytes.Repeat([]byte("a"), 4096))); err != nil {
		t.Fatalf("text upload: %v", err)
	}
	if _, err := f.service.Upload(ctx, author, Conversation{ChannelID: f.channel}, "text2.txt",
		bytes.NewReader(bytes.Repeat([]byte("b"), 4096))); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("quota was not enforced: %v", err)
	}
}

// TestAttachmentTypesAcceptsMediaAndArchives is the regression test for
// complaint 13: video and audio used to fall into classify's default branch and
// were rejected with ErrUnsupportedType, while archives were rejected too even
// though they are harmless when downloaded. HTML, SVG and XML must stay out.
func TestAttachmentTypesAcceptsMediaAndArchives(t *testing.T) {
	f := newFixtureWithLimits(t, 1<<20, 64<<20)
	author := f.user(t, 1, "Alice", roles.MemberName)
	ctx := context.Background()
	conv := Conversation{ChannelID: f.channel}

	mp4 := make([]byte, 64)
	mp4[3] = 64 // box size, big endian
	copy(mp4[4:], "ftypmp42")
	copy(mp4[16:], "mp41")
	webm := append([]byte("\x1A\x45\xDF\xA3"), make([]byte, 60)...)
	mp3 := append([]byte("ID3\x04\x00\x00\x00\x00\x00\x00"), make([]byte, 32)...)
	ogg := append([]byte("OggS\x00"), make([]byte, 60)...)
	wav := append([]byte("RIFF\x00\x00\x00\x00WAVEfmt "), make([]byte, 32)...)
	zip := append([]byte("PK\x03\x04"), make([]byte, 60)...)
	rar := append([]byte("Rar!\x1A\x07\x00"), make([]byte, 60)...)
	sevenZip := append([]byte("7z\xBC\xAF\x27\x1C"), make([]byte, 60)...)

	cases := []struct {
		name       string
		data       []byte
		wantType   string
		wantInline bool
		wantZip    bool
	}{
		{"clip.mp4", mp4, "video/mp4", true, false},
		{"clip.webm", webm, "video/webm", true, false},
		{"song.mp3", mp3, "audio/mpeg", true, false},
		{"voice.ogg", ogg, "audio/ogg", true, false},
		{"voice.wav", wav, "audio/wav", true, false},
		{"pack.zip", zip, "application/zip", false, true},
		{"pack.rar", rar, "application/x-rar-compressed", false, true},
		{"pack.7z", sevenZip, "application/x-7z-compressed", false, true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			attachment, err := f.service.Upload(ctx, author, conv, test.name, bytes.NewReader(test.data))
			if err != nil {
				t.Fatalf("upload %s: %v", test.name, err)
			}
			if attachment.ContentType != test.wantType {
				t.Fatalf("content type = %q, want %q", attachment.ContentType, test.wantType)
			}
			if attachment.SizeBytes != int64(len(test.data)) {
				t.Fatalf("size = %d, want %d", attachment.SizeBytes, len(test.data))
			}
			if got := IsInlineType(attachment.ContentType); got != test.wantInline {
				t.Fatalf("IsInlineType(%q) = %v, want %v", attachment.ContentType, got, test.wantInline)
			}
			if got := IsArchiveType(attachment.ContentType); got != test.wantZip {
				t.Fatalf("IsArchiveType(%q) = %v, want %v", attachment.ContentType, got, test.wantZip)
			}
		})
	}

	for name, data := range map[string][]byte{
		"page.html": []byte("<html><script>alert(1)</script></html>"),
		"image.svg": []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`),
		"feed.xml":  []byte(`<?xml version="1.0"?><root><script>alert(1)</script></root>`),
	} {
		if _, err := f.service.Upload(ctx, author, conv, name, bytes.NewReader(data)); !errors.Is(err, ErrUnsupportedType) {
			t.Fatalf("%s upload = %v, want ErrUnsupportedType", name, err)
		}
	}
}

// TestAttachmentDefaultLimitIs25MiB pins the new default. The old 8 MiB value
// rejected a 7 MiB screenshot on a network where the upload itself barely fit.
func TestAttachmentDefaultLimitIs25MiB(t *testing.T) {
	f := newFixtureWithLimits(t, 0, 0)
	if got := f.service.MaxAttachmentBytes(); got != 25<<20 {
		t.Fatalf("default max attachment = %d, want %d", got, 25<<20)
	}
	if got := (store.Settings{}).MaxAttachmentBytesOrDefault(); got != 25<<20 {
		t.Fatalf("store default = %d, want %d", got, 25<<20)
	}
	if got := (store.Settings{MaxAttachmentBytes: 4096}).MaxAttachmentBytesOrDefault(); got != 4096 {
		t.Fatalf("explicit limit = %d, want 4096", got)
	}
}

// guardedReader returns at most chunk bytes per Read and records how many bytes
// the service consumed. It proves uploads are streamed: a quota that is hit
// early must stop the read instead of draining the body first.
type guardedReader struct {
	data  []byte
	at    int
	chunk int
	read  int64
}

func (r *guardedReader) Read(p []byte) (int, error) {
	if r.at >= len(r.data) {
		return 0, io.EOF
	}
	n := len(p)
	if n > r.chunk {
		n = r.chunk
	}
	if remaining := len(r.data) - r.at; n > remaining {
		n = remaining
	}
	copy(p, r.data[r.at:r.at+n])
	r.at += n
	r.read += int64(n)
	return n, nil
}

// TestUploadStreamsToDisk checks three properties the in-memory version did not
// have: the file is written while it arrives, a quota rejection happens during
// the stream, and the SHA-256 describes the stored bytes.
func TestUploadStreamsToDisk(t *testing.T) {
	const threeMiB = 3 << 20
	f := newFixtureWithLimits(t, 8<<20, 64<<20)
	author := f.user(t, 1, "Alice", roles.MemberName)
	ctx := context.Background()
	conv := Conversation{ChannelID: f.channel}

	data := append([]byte(nil), smallPNG(t)...)
	data = append(data, make([]byte, threeMiB-len(data))...)
	reader := &guardedReader{data: data, chunk: 32 << 10}
	attachment, err := f.service.Upload(ctx, author, conv, "big.png", reader)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if reader.read != int64(len(data)) {
		t.Fatalf("read %d bytes, want %d", reader.read, len(data))
	}
	if attachment.SizeBytes != int64(len(data)) {
		t.Fatalf("stored size = %d, want %d", attachment.SizeBytes, len(data))
	}
	wantHash := fmt.Sprintf("%x", sha256.Sum256(data))
	if attachment.Sha256 != wantHash {
		t.Fatalf("sha256 = %q, want %q", attachment.Sha256, wantHash)
	}
	row, err := f.store.Queries().GetAttachment(ctx, attachment.ID)
	if err != nil {
		t.Fatalf("get attachment: %v", err)
	}
	stored, err := os.ReadFile(filepath.Join(f.service.filesDir, row.StoredName))
	if err != nil {
		t.Fatalf("read stored file: %v", err)
	}
	if !bytes.Equal(stored, data) {
		t.Fatal("the stored file differs from the uploaded bytes")
	}
	entries, err := os.ReadDir(f.service.filesDir)
	if err != nil {
		t.Fatalf("read files dir: %v", err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".upload") {
			t.Fatalf("temporary upload file left behind: %s", entry.Name())
		}
	}

	// A quota that is exhausted during the body stops the read early. With the
	// old io.ReadAll the whole 3 MiB would have been consumed before the check.
	tight := newFixtureWithLimits(t, 8<<20, 1<<20)
	tightAuthor := tight.user(t, 2, "Bob", roles.MemberName)
	tightReader := &guardedReader{data: data, chunk: 32 << 10}
	_, err = tight.service.Upload(ctx, tightAuthor, Conversation{ChannelID: tight.channel}, "big.png", tightReader)
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("upload over quota = %v, want ErrQuotaExceeded", err)
	}
	if tightReader.read >= int64(len(data)) {
		t.Fatalf("the whole body was read before the quota check: %d bytes", tightReader.read)
	}
}

// gateReader blocks in Read until release is closed and reports the first time
// a body actually starts being buffered.
type gateReader struct {
	entered chan<- struct{}
	release <-chan struct{}
	once    sync.Once
}

func (r *gateReader) Read([]byte) (int, error) {
	r.once.Do(func() { r.entered <- struct{}{} })
	<-r.release
	return 0, io.EOF
}

// TestConcurrentUploadsAreBounded makes sure a burst of uploads cannot each
// buffer max_attachment_bytes in memory at the same time.
func TestConcurrentUploadsAreBounded(t *testing.T) {
	f := newFixture(t)
	author := f.user(t, 1, "Alice", roles.MemberName)
	ctx := context.Background()
	conv := Conversation{ChannelID: f.channel}
	release := make(chan struct{})
	entered := make(chan struct{}, MaxConcurrentUploads+4)

	var wg sync.WaitGroup
	start := func() {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = f.service.Upload(ctx, author, conv, "file.bin",
				&gateReader{entered: entered, release: release})
		}()
	}
	for i := 0; i < MaxConcurrentUploads; i++ {
		start()
	}
	for i := 0; i < MaxConcurrentUploads; i++ {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			close(release)
			wg.Wait()
			t.Fatalf("only %d uploads started reading", i)
		}
	}

	start() // the next upload must wait for a slot
	select {
	case <-entered:
		close(release)
		wg.Wait()
		t.Fatal("more uploads than the slot limit read a body at once")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	wg.Wait()
}

// TestStoredNameIsNotAPath keeps a database column from becoming a file path:
// attachment rows are normally written by us, but a restored or hand-edited
// database must not let a row point outside the files directory.
func TestStoredNameIsNotAPath(t *testing.T) {
	f := newFixture(t)
	author := f.user(t, 1, "Alice", roles.MemberName)
	ctx := context.Background()

	row, err := f.store.Queries().InsertAttachment(ctx, db.InsertAttachmentParams{
		UploaderID:  author,
		FileName:    "escape.txt",
		StoredName:  "../../outside",
		ContentType: "text/plain; charset=utf-8",
		SizeBytes:   1,
		CreatedAt:   f.now.UnixMilli(),
	})
	if err != nil {
		t.Fatalf("insert attachment: %v", err)
	}
	if _, path, err := f.service.Open(ctx, author, row.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Open with a traversal stored_name = %q, %v; want not found", path, err)
	}
	if err := f.service.removeStored("../../outside"); err != nil {
		t.Fatalf("removeStored on an unsafe name: %v", err)
	}
}

func TestConcurrentSendsCannotClaimOneAttachmentTwice(t *testing.T) {
	f := newFixture(t)
	author := f.user(t, 1, "Alice", roles.MemberName)
	ctx := context.Background()
	attachment, err := f.service.Upload(ctx, author, Conversation{ChannelID: f.channel}, "cat.png", bytes.NewReader(smallPNG(t)))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}

	const attempts = 2
	start := make(chan struct{})
	results := make([]error, attempts)
	messages := make([]Message, attempts)
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			messages[index], results[index] = f.service.Send(ctx, author,
				Conversation{ChannelID: f.channel}, "same file", []uint64{uint64(attachment.ID)})
		}(i)
	}
	close(start)
	wg.Wait()

	successes := 0
	for index, sendErr := range results {
		switch {
		case sendErr == nil:
			successes++
		case errors.Is(sendErr, ErrAttachmentInvalid):
		default:
			t.Fatalf("send %d failed with %v, want success or ErrAttachmentInvalid", index, sendErr)
		}
	}
	if successes != 1 {
		t.Fatalf("%d of %d concurrent sends claimed the same attachment, want 1", successes, attempts)
	}
	row, err := f.store.Queries().GetAttachment(ctx, attachment.ID)
	if err != nil {
		t.Fatalf("get attachment: %v", err)
	}
	if !row.MessageID.Valid {
		t.Fatal("the winning message did not claim the attachment")
	}
	// The losing transaction rolled its message back as well.
	rows, err := f.store.Queries().ListChannelMessagesBefore(ctx, db.ListChannelMessagesBeforeParams{
		ChannelID: sql.NullInt64{Int64: int64(f.channel), Valid: true},
		ID:        int64(^uint64(0) >> 1),
		Limit:     10,
	})
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != row.MessageID.Int64 {
		t.Fatalf("channel contains %d messages after the race, want only the winner", len(rows))
	}
}

func TestSweepRemovesOldMessages(t *testing.T) {
	f := newFixture(t)
	author := f.user(t, 1, "Alice", roles.MemberName)
	ctx := context.Background()
	old := f.now.AddDate(0, 0, -10)
	row, err := f.store.Queries().InsertMessage(ctx, db.InsertMessageParams{
		ChannelID: sql.NullInt64{Int64: int64(f.channel), Valid: true},
		SenderID:  author,
		Body:      "old",
		CreatedAt: old.UnixMilli(),
	})
	if err != nil {
		t.Fatalf("insert old message: %v", err)
	}
	f.service.settings = func() store.Settings { return store.Settings{MessageRetentionDays: 7} }
	removed, err := f.service.Sweep(ctx)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if removed != 1 {
		t.Fatalf("want one removed message, got %d", removed)
	}
	if _, err := f.service.loadMessage(ctx, row.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old message survived: %v", err)
	}
}

func smallPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	for x := 0; x < 2; x++ {
		for y := 0; y < 2; y++ {
			img.Set(x, y, color.RGBA{R: 255, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buffer.Bytes()
}
