package media

import (
	"sync"
	"testing"
	"time"
)

func TestRoomNameRoundTrip(t *testing.T) {
	for _, channelID := range []uint64{1, 7, 1 << 40} {
		room := RoomName(channelID)
		got, ok := ChannelOfRoom(room)
		if !ok {
			t.Fatalf("ChannelOfRoom(%q) failed", room)
		}
		if got != channelID {
			t.Fatalf("ChannelOfRoom(%q) = %d, want %d", room, got, channelID)
		}
	}

	for _, room := range []string{"", "channel-", "channel-0", "channel-x", "lobby-1", "channel-1x"} {
		if id, ok := ChannelOfRoom(room); ok {
			t.Fatalf("ChannelOfRoom(%q) = %d, want false", room, id)
		}
	}
}

func TestIdentityForAndParse(t *testing.T) {
	voice := IdentityFor(42, KindVoice)
	if voice != "42:voice" {
		t.Fatalf("voice identity = %q", voice)
	}
	stream := IdentityFor(42, KindStream)
	if stream != "42:stream" {
		t.Fatalf("stream identity = %q", stream)
	}

	userID, kind, ok := ParseIdentity(voice)
	if !ok || userID != 42 || kind != KindVoice {
		t.Fatalf("ParseIdentity(%q) = %d, %v, %v", voice, userID, kind, ok)
	}
	userID, kind, ok = ParseIdentity(stream)
	if !ok || userID != 42 || kind != KindStream {
		t.Fatalf("ParseIdentity(%q) = %d, %v, %v", stream, userID, kind, ok)
	}

	for _, identity := range []string{"", "42", "42:camera", "0:voice", "-1:voice", "abc:voice", ":voice"} {
		if _, _, ok := ParseIdentity(identity); ok {
			t.Fatalf("ParseIdentity(%q) succeeded", identity)
		}
	}
}

func TestTokenRequestValidate(t *testing.T) {
	valid := TokenRequest{
		Room:      RoomName(5),
		ChannelID: 5,
		UserID:    9,
		Kind:      KindVoice,
		Grants:    Grants{CanPublish: true, CanSubscribe: true, PublishSources: []Source{SourceMicrophone}},
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}

	cases := map[string]TokenRequest{
		"no channel":       {Room: RoomName(5), UserID: 9, Kind: KindVoice},
		"no user":          {Room: RoomName(5), ChannelID: 5, Kind: KindVoice},
		"foreign room":     {Room: RoomName(6), ChannelID: 5, UserID: 9, Kind: KindVoice},
		"unknown kind":     {Room: RoomName(5), ChannelID: 5, UserID: 9, Kind: Kind(9)},
		"unknown source":   {Room: RoomName(5), ChannelID: 5, UserID: 9, Kind: KindVoice, Grants: Grants{PublishSources: []Source{"camera"}}},
		"no room at all  ": {ChannelID: 5, UserID: 9, Kind: KindVoice},
	}
	for name, req := range cases {
		if err := req.Validate(); err == nil {
			t.Fatalf("%s: Validate() accepted %+v", name, req)
		}
	}
}

func TestTokenRequestTTL(t *testing.T) {
	if got := (TokenRequest{}).TTLOrDefault(); got != DefaultTokenTTL {
		t.Fatalf("default TTL = %v, want %v", got, DefaultTokenTTL)
	}
	if got := (TokenRequest{TTL: 5 * time.Second}).TTLOrDefault(); got != 5*time.Second {
		t.Fatalf("explicit TTL = %v", got)
	}
	if DefaultTokenTTL != 60*time.Second {
		t.Fatalf("design 4.7 fixes the token TTL at 60 s, got %v", DefaultTokenTTL)
	}
}

func TestEventBusDropsWhenFull(t *testing.T) {
	bus := NewEventBus(2)
	bus.Publish(Event{Kind: EventParticipantJoined, Room: "channel-1"})
	bus.Publish(Event{Kind: EventParticipantLeft, Room: "channel-1"})
	bus.Publish(Event{Kind: EventTrackPublished, Room: "channel-1"})

	if got := bus.Dropped(); got != 1 {
		t.Fatalf("dropped = %d, want 1", got)
	}
	bus.Close()
	bus.Close() // idempotent
	bus.Publish(Event{Kind: EventParticipantJoined})

	count := 0
	for range bus.Events() {
		count++
	}
	if count != 2 {
		t.Fatalf("received %d buffered events, want 2", count)
	}
}

// TestEventBusCloseRacesPublish exercises the shutdown path: the supervisor
// may still be publishing while the backend closes. A send on a channel that
// Close already closed would panic the process, not just fail a scrape.
func TestEventBusCloseRacesPublish(t *testing.T) {
	for attempt := 0; attempt < 50; attempt++ {
		bus := NewEventBus(4)
		var wg sync.WaitGroup
		for i := 0; i < 16; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := 0; j < 500; j++ {
					bus.Publish(Event{Kind: EventParticipantJoined})
				}
			}()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			bus.Close()
		}()
		wg.Wait()
		bus.Close()
	}
}
