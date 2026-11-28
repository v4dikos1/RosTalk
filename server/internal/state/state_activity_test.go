package state

import (
	"testing"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"
)

type activityChannels struct{}

func (activityChannels) View(id uint64) (*rostalkv1.Channel, bool) {
	return &rostalkv1.Channel{Id: id, Kind: rostalkv1.ChannelKind_CHANNEL_KIND_VOICE, Afk: id == 3}, true
}

func TestVoiceActivityReplacementMoveAndEviction(t *testing.T) {
	hub := NewHub(Config{Channels: activityChannels{}})
	register := func() *Session {
		t.Helper()
		s := newTestSession(t, 1, "fixture", false, newFakeTransport())
		old, err := hub.Register(s)
		if err != nil {
			t.Fatal(err)
		}
		if old != nil {
			old.stop()
		}
		t.Cleanup(s.stop)
		return s
	}
	move := func(channel uint64) {
		t.Helper()
		if _, err := hub.Move(1, channel, 0); err != nil {
			t.Fatal(err)
		}
	}
	current := func() VoiceActivity {
		t.Helper()
		got := hub.SnapshotVoiceActivity()
		if len(got) != 1 || got[0].UserID != 1 || got[0].ChannelID != 1 {
			t.Fatalf("unexpected voice activity: %+v", got)
		}
		return got[0]
	}
	absent := func() {
		t.Helper()
		if got := hub.SnapshotVoiceActivity(); len(got) != 0 {
			t.Fatalf("ineligible presence sampled: %+v", got)
		}
	}

	old := register()
	move(1)
	first := current()
	active := register()
	if _, removed := hub.UnregisterSession(old); removed || current() != first {
		t.Fatal("a late unregister invalidated the replacement's tenure")
	}
	move(1)
	if current() != first {
		t.Fatal("a no-op move changed tenure")
	}
	move(2)
	move(1)
	second := current()
	if second.Tenure <= first.Tenure {
		t.Fatal("an admin move away and back retained tenure")
	}
	move(3)
	absent()
	move(1)
	beforeEviction := current()
	hub.EvictFromChannels([]uint64{1})
	absent()
	move(1)
	beforeDisconnect := current()
	if beforeDisconnect.Tenure <= beforeEviction.Tenure {
		t.Fatal("an eviction retained tenure")
	}
	if _, removed := hub.UnregisterSession(active); !removed {
		t.Fatal("the current session was not removed")
	}
	absent()
	register()
	move(1)
	if current().Tenure <= beforeDisconnect.Tenure {
		t.Fatal("a genuine reconnect retained tenure")
	}
}
