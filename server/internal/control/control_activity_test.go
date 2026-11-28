package control

import (
	"context"
	"testing"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/channels"
	"github.com/v4dikos1/RosTalk/server/internal/state"
)

func TestVoiceActivityAFKToggleInvalidatesTenure(t *testing.T) {
	f := newPlaneFixture(t)
	ctx := context.Background()
	s, err := state.NewSession(state.SessionParams{
		UserID: 1, Nickname: "fixture", Transport: newQueueTransport(), ConnectedAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.hub.Register(s); err != nil {
		t.Fatal(err)
	}
	defer f.hub.Unregister(s)
	if _, err := f.hub.Move(1, uint64(f.lobby.ID), 0); err != nil {
		t.Fatal(err)
	}
	before := f.plane.SnapshotVoiceActivity()
	if len(before) != 1 {
		t.Fatal("ordinary voice was not sampled")
	}
	afk := true
	if _, err := f.plane.UpdateChannel(ctx, f.lobby.ID, channels.UpdateParams{AFK: &afk}); err != nil {
		t.Fatal(err)
	}
	if got := f.plane.SnapshotVoiceActivity(); len(got) != 0 {
		t.Fatalf("AFK voice was sampled: %+v", got)
	}
	afk = false
	if _, err := f.plane.UpdateChannel(ctx, f.lobby.ID, channels.UpdateParams{AFK: &afk}); err != nil {
		t.Fatal(err)
	}
	after := f.plane.SnapshotVoiceActivity()
	if len(after) != 1 || after[0].Tenure <= before[0].Tenure {
		t.Fatalf("an AFK round trip retained tenure: %+v -> %+v", before, after)
	}
}
