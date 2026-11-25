package media

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"
)

// fakeBackend serves a scripted room snapshot and records cleanup calls.
type fakeBackend struct {
	mu      sync.Mutex
	rooms   []Room
	err     error
	removed []string
	deleted []string
}

func (f *fakeBackend) setRooms(rooms ...Room) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rooms = rooms
}

func (f *fakeBackend) EnsureRoom(context.Context, string) error { return nil }

func (f *fakeBackend) DeleteRoom(_ context.Context, room string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, room)
	return nil
}

func (f *fakeBackend) IssueToken(TokenRequest) (Token, error) { return Token{}, nil }

func (f *fakeBackend) RemoveParticipant(_ context.Context, room, identity string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, room+"/"+identity)
	return nil
}

func (f *fakeBackend) SetPublishSource(context.Context, string, string, Source, bool) error {
	return nil
}

func (f *fakeBackend) SetCanSubscribe(context.Context, string, string, bool) error { return nil }

func (f *fakeBackend) Rooms(context.Context) ([]Room, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Room(nil), f.rooms...), f.err
}

func (f *fakeBackend) Events() <-chan Event { return nil }

func (f *fakeBackend) Signalling() http.Handler { return nil }

func (f *fakeBackend) Close() error { return nil }

func (f *fakeBackend) removedParticipants() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.removed...)
}

func (f *fakeBackend) deletedRooms() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.deleted...)
}

// fakePresence is the control-plane side of the reconciler.
type fakePresence struct {
	mu       sync.Mutex
	channels map[int64]uint64
	counts   map[uint64]int
}

func newFakePresence() *fakePresence {
	return &fakePresence{channels: make(map[int64]uint64), counts: make(map[uint64]int)}
}

func (f *fakePresence) set(userID int64, channelID uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.counts, f.channels[userID])
	f.channels[userID] = channelID
	f.counts[channelID]++
}

func (f *fakePresence) remove(userID int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.counts, f.channels[userID])
	delete(f.channels, userID)
}

func (f *fakePresence) InChannel(userID int64, channelID uint64) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.channels[userID] == channelID
}

func (f *fakePresence) ChannelCount(channelID uint64) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.counts[channelID]
}

// recorder collects published events.
type recorder struct {
	mu     sync.Mutex
	events []Event
}

func (r *recorder) Publish(event Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
}

func (r *recorder) take() []Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.events
	r.events = nil
	return out
}

type supervisorFixture struct {
	supervisor *Supervisor
	backend    *fakeBackend
	presence   *fakePresence
	events     *recorder
	now        time.Time
}

func newSupervisorFixture(t *testing.T) *supervisorFixture {
	t.Helper()
	fixture := &supervisorFixture{
		backend:  &fakeBackend{},
		presence: newFakePresence(),
		events:   &recorder{},
		now:      time.Unix(1_700_000_000, 0),
	}
	supervisor, err := NewSupervisor(SupervisorConfig{
		Backend:        fixture.backend,
		Presence:       fixture.presence,
		Publisher:      fixture.events,
		Interval:       time.Millisecond,
		PresenceGrace:  15 * time.Second,
		EmptyRoomGrace: 20 * time.Second,
		Now:            func() time.Time { return fixture.now },
	})
	if err != nil {
		t.Fatalf("NewSupervisor: %v", err)
	}
	fixture.supervisor = supervisor
	return fixture
}

func (f *supervisorFixture) advance(d time.Duration) { f.now = f.now.Add(d) }

func TestSupervisorEmitsParticipantAndTrackEvents(t *testing.T) {
	fixture := newSupervisorFixture(t)
	room := RoomName(1)
	fixture.presence.set(7, 1)
	fixture.backend.setRooms(Room{Name: room, Participants: []Participant{
		{Identity: "7:voice"},
	}})
	fixture.supervisor.Reconcile(context.Background())
	fixture.supervisor.Reconcile(context.Background()) // unchanged snapshot: no events

	events := fixture.events.take()
	if len(events) != 1 {
		t.Fatalf("events = %+v, want one participant_joined", events)
	}
	if events[0].Kind != EventParticipantJoined || events[0].UserID != 7 ||
		events[0].ParticipantKind != KindVoice || events[0].ChannelID != 1 {
		t.Fatalf("unexpected event: %+v", events[0])
	}

	// Publishing a track and then removing the participant.
	fixture.backend.setRooms(Room{Name: room, Participants: []Participant{
		{Identity: "7:voice", Tracks: []Track{{ID: "TR_1", Source: SourceMicrophone}}},
	}})
	fixture.supervisor.Reconcile(context.Background())
	events = fixture.events.take()
	if len(events) != 1 || events[0].Kind != EventTrackPublished ||
		events[0].Track != "TR_1" || events[0].Source != SourceMicrophone {
		t.Fatalf("events = %+v, want track_published", events)
	}

	fixture.backend.setRooms(Room{Name: room, Participants: []Participant{
		{Identity: "7:voice", Tracks: []Track{{ID: "TR_2", Source: SourceMicrophone}}},
	}})
	fixture.supervisor.Reconcile(context.Background())
	events = fixture.events.take()
	if len(events) != 2 {
		t.Fatalf("events = %+v, want unpublished + published", events)
	}
	kinds := map[EventKind]bool{}
	for _, event := range events {
		kinds[event.Kind] = true
	}
	if !kinds[EventTrackUnpublished] || !kinds[EventTrackPublished] {
		t.Fatalf("events = %+v", events)
	}

	fixture.backend.setRooms(Room{Name: room})
	fixture.supervisor.Reconcile(context.Background())
	events = fixture.events.take()
	found := false
	for _, event := range events {
		if event.Kind == EventParticipantLeft && event.Identity == "7:voice" {
			found = true
		}
	}
	if !found {
		t.Fatalf("events = %+v, want participant_left", events)
	}
	if removed := fixture.backend.removedParticipants(); len(removed) != 0 {
		t.Fatalf("a participant with presence was removed: %v", removed)
	}
}

func TestSupervisorRemovesParticipantWithoutPresence(t *testing.T) {
	fixture := newSupervisorFixture(t)
	room := RoomName(2)
	fixture.backend.setRooms(Room{Name: room, Participants: []Participant{{Identity: "9:voice"}}})

	// The user is not in the channel at all: the grace must pass first.
	fixture.supervisor.Reconcile(context.Background())
	if removed := fixture.backend.removedParticipants(); len(removed) != 0 {
		t.Fatalf("participant removed before the grace: %v", removed)
	}
	fixture.advance(14 * time.Second)
	fixture.supervisor.Reconcile(context.Background())
	if removed := fixture.backend.removedParticipants(); len(removed) != 0 {
		t.Fatalf("participant removed before the grace expired: %v", removed)
	}
	fixture.advance(2 * time.Second)
	fixture.supervisor.Reconcile(context.Background())
	removed := fixture.backend.removedParticipants()
	if len(removed) != 1 || removed[0] != room+"/9:voice" {
		t.Fatalf("removed = %v, want [%s/9:voice]", removed, room)
	}
}

func TestSupervisorKeepsParticipantWhoReturned(t *testing.T) {
	fixture := newSupervisorFixture(t)
	room := RoomName(3)
	fixture.presence.set(5, 3)
	fixture.backend.setRooms(Room{Name: room, Participants: []Participant{{Identity: "5:voice"}}})
	fixture.supervisor.Reconcile(context.Background())

	// The presence record disappears (reconnect) and comes back before the
	// grace expires.
	fixture.presence.remove(5)
	fixture.advance(time.Second)
	fixture.supervisor.Reconcile(context.Background())
	fixture.presence.set(5, 3)
	fixture.advance(30 * time.Second)
	fixture.supervisor.Reconcile(context.Background())
	if removed := fixture.backend.removedParticipants(); len(removed) != 0 {
		t.Fatalf("a participant who came back was removed: %v", removed)
	}
}

func TestSupervisorIgnoresForeignParticipants(t *testing.T) {
	fixture := newSupervisorFixture(t)
	fixture.backend.setRooms(Room{Name: RoomName(4), Participants: []Participant{
		{Identity: "agent-test"},
		{Identity: "1:camera"},
	}})
	fixture.supervisor.Reconcile(context.Background())
	fixture.advance(time.Minute)
	fixture.supervisor.Reconcile(context.Background())
	if removed := fixture.backend.removedParticipants(); len(removed) != 0 {
		t.Fatalf("foreign participants were removed: %v", removed)
	}
}

func TestSupervisorClosesEmptyRooms(t *testing.T) {
	fixture := newSupervisorFixture(t)
	room := RoomName(5)
	fixture.backend.setRooms(Room{Name: room})
	fixture.supervisor.Reconcile(context.Background())
	fixture.advance(19 * time.Second)
	fixture.supervisor.Reconcile(context.Background())
	if deleted := fixture.backend.deletedRooms(); len(deleted) != 0 {
		t.Fatalf("room closed before the grace: %v", deleted)
	}
	fixture.advance(2 * time.Second)
	fixture.supervisor.Reconcile(context.Background())
	if deleted := fixture.backend.deletedRooms(); len(deleted) != 1 || deleted[0] != room {
		t.Fatalf("deleted = %v, want [%s]", deleted, room)
	}
}

func TestSupervisorKeepsRoomWithPresence(t *testing.T) {
	fixture := newSupervisorFixture(t)
	room := RoomName(6)
	// Somebody joined the channel and is about to connect: the room is empty
	// but must not be closed under their feet.
	fixture.presence.set(8, 6)
	fixture.backend.setRooms(Room{Name: room})
	fixture.supervisor.Reconcile(context.Background())
	fixture.advance(time.Minute)
	fixture.supervisor.Reconcile(context.Background())
	if deleted := fixture.backend.deletedRooms(); len(deleted) != 0 {
		t.Fatalf("room closed while the channel had users: %v", deleted)
	}
}

func TestSupervisorSurvivesBackendErrors(t *testing.T) {
	fixture := newSupervisorFixture(t)
	fixture.backend.err = errors.New("boom")
	fixture.supervisor.Reconcile(context.Background())
	if events := fixture.events.take(); len(events) != 0 {
		t.Fatalf("events from a failing backend: %+v", events)
	}
	fixture.backend.err = nil
	fixture.backend.setRooms(Room{Name: RoomName(1)})
	fixture.supervisor.Reconcile(context.Background())
}

func TestNewSupervisorRequiresWiring(t *testing.T) {
	if _, err := NewSupervisor(SupervisorConfig{}); err == nil {
		t.Fatal("NewSupervisor accepted an empty configuration")
	}
	if _, err := NewSupervisor(SupervisorConfig{Backend: &fakeBackend{}}); err == nil {
		t.Fatal("NewSupervisor accepted a missing presence")
	}
	if _, err := NewSupervisor(SupervisorConfig{
		Backend:  &fakeBackend{},
		Presence: newFakePresence(),
	}); err == nil {
		t.Fatal("NewSupervisor accepted a missing publisher")
	}
}
