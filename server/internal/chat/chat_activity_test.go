package chat

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"testing"

	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

func TestChannelTextCallbackRunsInsideCommittedSend(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	author := f.user(t, 1, "fixture-a", roles.MemberName)
	peer := f.user(t, 2, "fixture-b", roles.MemberName)
	guest := f.user(t, 3, "fixture-c", roles.GuestName)
	conv := Conversation{ChannelID: f.channel}
	reject := errors.New("fixture callback abort")
	var calls int
	var seen int64
	var fail bool
	f.service.onChannelText = func(ctx context.Context, q *db.Queries, sender, message int64) error {
		calls++
		seen = message
		row, err := q.GetMessage(ctx, message)
		if err != nil || sender != author || row.SenderID != author || row.ChannelID.Int64 != int64(f.channel) {
			t.Fatalf("callback could not read its pending message: %v", err)
		}
		if fail {
			return reject
		}
		return nil
	}

	msg, err := f.service.Send(ctx, author, conv, "fixture", nil)
	if err != nil || calls != 1 || msg.ID != seen {
		t.Fatalf("channel send: calls=%d, err=%v", calls, err)
	}
	if _, err := f.service.Edit(ctx, author, msg.ID, "fixture edit"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Send(ctx, author, Conversation{PeerID: peer}, "fixture DM", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Send(ctx, guest, conv, "fixture denied", nil); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("denied send: %v", err)
	}
	upload, err := f.service.Upload(ctx, author, conv, "fixture.png", bytes.NewReader(smallPNG(t)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Send(ctx, author, conv, "", []uint64{uint64(upload.ID)}); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("calls after edit, DM, denied or attachment-only send = %d", calls)
	}

	fail = true
	if _, err := f.service.Send(ctx, author, conv, "fixture rollback", nil); !errors.Is(err, reject) {
		t.Fatalf("failed callback: %v", err)
	}
	if _, err := f.store.Queries().GetMessage(ctx, seen); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("failed callback left a committed message: %v", err)
	}
}
