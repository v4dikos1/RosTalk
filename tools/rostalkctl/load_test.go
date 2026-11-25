package main

import (
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"
)

func TestPercentilesHandleEmptyAndSmallSlices(t *testing.T) {
	if p50, p95 := percentiles(nil); p50 != 0 || p95 != 0 {
		t.Fatalf("empty percentiles = %v/%v", p50, p95)
	}
	one := []time.Duration{7 * time.Millisecond}
	if p50, p95 := percentiles(one); p50 != 7*time.Millisecond || p95 != 7*time.Millisecond {
		t.Fatalf("single percentiles = %v/%v", p50, p95)
	}
	values := []time.Duration{50, 10, 20, 30, 40}
	p50, p95 := percentiles(values)
	if p50 != 30 {
		t.Fatalf("p50 = %v, want 30", p50)
	}
	if p95 != 50 {
		t.Fatalf("p95 = %v, want the maximum", p95)
	}
}

func TestPickLoadChannelsSkipsAfkAndHonoursNames(t *testing.T) {
	channel := func(id uint64, name string, kind rostalkv1.ChannelKind, afk bool) *rostalkv1.Channel {
		return &rostalkv1.Channel{Id: id, Name: name, Kind: kind, Afk: afk}
	}
	welcome := &rostalkv1.Welcome{Snapshot: &rostalkv1.ServerSnapshot{Channels: []*rostalkv1.Channel{
		channel(1, "Лобби", rostalkv1.ChannelKind_CHANNEL_KIND_VOICE, false),
		channel(2, "AFK", rostalkv1.ChannelKind_CHANNEL_KIND_VOICE, true),
		channel(3, "text", rostalkv1.ChannelKind_CHANNEL_KIND_TEXT, false),
		channel(4, "Games", rostalkv1.ChannelKind_CHANNEL_KIND_VOICE, false),
	}}}

	settings := loadSettings{channels: 1}
	selected, err := pickLoadChannels(welcome, settings)
	if err != nil {
		t.Fatalf("pickLoadChannels: %v", err)
	}
	if len(selected) != 1 || selected[0].id != 1 {
		t.Fatalf("selected = %v, want the Lobby only", selected)
	}

	settings = loadSettings{channels: 2}
	selected, err = pickLoadChannels(welcome, settings)
	if err != nil {
		t.Fatalf("pickLoadChannels: %v", err)
	}
	if len(selected) != 2 || selected[1].id != 4 {
		t.Fatalf("selected = %v, want Lobby and Games (AFK skipped)", selected)
	}

	settings = loadSettings{channels: 2, channelNames: []string{"Games", "Лобби"}}
	selected, err = pickLoadChannels(welcome, settings)
	if err != nil {
		t.Fatalf("pickLoadChannels by name: %v", err)
	}
	if selected[0].id != 4 || selected[1].id != 1 {
		t.Fatalf("selected = %v, want the requested order", selected)
	}

	settings = loadSettings{channels: 1, channelNames: []string{"missing"}}
	if _, err := pickLoadChannels(welcome, settings); err == nil {
		t.Fatal("an unknown channel name must fail")
	}

	settings = loadSettings{channels: 5}
	if _, err := pickLoadChannels(welcome, settings); err == nil {
		t.Fatal("asking for more channels than exist must fail")
	}
}

func TestSummarizeLoadCountsFailuresAndLatency(t *testing.T) {
	results := []userResult{
		{connected: true, joined: true, mediaUp: true, connectDelay: 10 * time.Millisecond,
			joinDelay: 20 * time.Millisecond, mediaDelay: 30 * time.Millisecond},
		{connected: true, joined: true, mediaUp: true, connectDelay: 30 * time.Millisecond,
			joinDelay: 40 * time.Millisecond, mediaDelay: 50 * time.Millisecond},
		{error: "connect: refused"},
		{connected: true, joined: true, mediaUp: true, disconnectErr: "control connection lost",
			connectDelay: 20 * time.Millisecond, joinDelay: 25 * time.Millisecond,
			mediaDelay: 35 * time.Millisecond},
	}
	summary := summarizeLoad(results, 100, 200, 300, loadSettings{users: 4, channels: 1, talking: 2, duration: time.Minute})
	if summary.Connected != 3 || summary.Joined != 3 || summary.MediaUp != 3 {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.Failed != 1 || summary.Disconnects != 1 {
		t.Fatalf("failed/dropped = %d/%d", summary.Failed, summary.Disconnects)
	}
	if summary.SentFrames != 100 || summary.RecvPackets != 200 || summary.RecvBytes != 300 {
		t.Fatalf("counters = %+v", summary)
	}
	if summary.ConnectP50MS != 20 || summary.JoinP50MS != 25 || summary.MediaP50MS != 35 {
		t.Fatalf("median latencies = %+v", summary)
	}
	if len(summary.Errors) != 2 {
		t.Fatalf("errors = %v", summary.Errors)
	}
}
