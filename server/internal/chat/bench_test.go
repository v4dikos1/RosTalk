package chat

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/roles"
	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

// benchmarkUnreadFixture builds the snapshot workload from docs/PERF.md: 20
// text channels with 5 000 messages each (100 000 rows), one reader and one
// author, and no read markers. Seeding is excluded from the timed loop.
func benchmarkUnreadFixture(b *testing.B) (*Service, int64, []uint64) {
	b.Helper()
	f := newFixture(b)
	ctx := context.Background()
	alice := f.user(b, 1, "Alice", roles.MemberName)
	bob := f.user(b, 2, "Bob", roles.MemberName)

	ids := []uint64{f.channel}
	for i := 1; i < 20; i++ {
		channel, err := f.channels.Create(ctx, channels.CreateParams{
			Name: fmt.Sprintf("bench-%02d", i),
			Kind: rostalkv1.ChannelKind_CHANNEL_KIND_TEXT,
		})
		if err != nil {
			b.Fatalf("create channel %d: %v", i, err)
		}
		ids = append(ids, uint64(channel.ID))
	}

	b.StopTimer()
	err := f.store.InTx(ctx, func(q *db.Queries) error {
		for _, channelID := range ids {
			for j := 0; j < 5000; j++ {
				if _, err := q.InsertMessage(ctx, db.InsertMessageParams{
					ChannelID: sql.NullInt64{Int64: int64(channelID), Valid: true},
					SenderID:  bob,
					Body:      "benchmark message",
					CreatedAt: int64(j),
				}); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		b.Fatalf("seed messages: %v", err)
	}
	b.StartTimer()
	return f.service, alice, ids
}

func BenchmarkUnreadState(b *testing.B) {
	service, alice, ids := benchmarkUnreadFixture(b)
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		counters, err := service.UnreadState(ctx, alice, ids)
		if err != nil {
			b.Fatalf("UnreadState: %v", err)
		}
		if len(counters) != len(ids) {
			b.Fatalf("counters = %d, want %d", len(counters), len(ids))
		}
	}
}

func BenchmarkCountUnreadChannel(b *testing.B) {
	service, alice, ids := benchmarkUnreadFixture(b)
	ctx := context.Background()
	q := service.store.Queries()
	params := db.CountUnreadChannelParams{
		ChannelID: sql.NullInt64{Int64: int64(ids[0]), Valid: true},
		ID:        0,
		SenderID:  alice,
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		count, err := q.CountUnreadChannel(ctx, params)
		if err != nil {
			b.Fatalf("CountUnreadChannel: %v", err)
		}
		if count != 5000 {
			b.Fatalf("count = %d, want 5000", count)
		}
	}
}

func BenchmarkSendChannelMessage(b *testing.B) {
	service, alice, ids := benchmarkUnreadFixture(b)
	service.interval = time.Nanosecond
	service.now = time.Now
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := service.Send(ctx, alice, Conversation{ChannelID: ids[0]}, "benchmark send", nil); err != nil {
			b.Fatalf("Send: %v", err)
		}
	}
}
