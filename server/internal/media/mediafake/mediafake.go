// Package mediafake is an in-memory media.Backend for tests. It records every
// call and serves canned rooms, so control-plane tests can assert what the
// server asked the media plane to do without starting an SFU.
//
// It is a test double: it is imported by _test.go files only and never linked
// into the server binary.
package mediafake

import (
	"context"
	"fmt"
	"net/http"
	"sync"

	"github.com/v4dikos1/RosTalk/server/internal/media"
)

// Call is one recorded backend call.
type Call struct {
	// Method is the Backend method name.
	Method string
	// Room is the room argument, when the method has one.
	Room string
	// Identity is the participant identity, when the method has one.
	Identity string
	// ChannelID is the channel of an issued token.
	ChannelID uint64
	// UserID is the user of an issued token.
	UserID int64
	// Kind is the participant kind of an issued token.
	Kind media.Kind
	// Grants are the token grants.
	Grants media.Grants
	// Source is the source argument of SetPublishSource.
	Source media.Source
	// CanPublish is the allowed argument of SetPublishSource.
	CanPublish bool
	// CanSubscribe is the argument of SetCanSubscribe.
	CanSubscribe bool
}

// Backend implements media.Backend.
type Backend struct {
	mu    sync.Mutex
	calls []Call
	rooms map[string][]media.Participant
	bus   *media.EventBus
	// Err, when set, is returned by every call.
	Err error
}

// New returns an empty backend.
func New() *Backend {
	return &Backend{
		rooms: make(map[string][]media.Participant),
		bus:   media.NewEventBus(8),
	}
}

// EnsureRoom implements media.Backend.
func (b *Backend) EnsureRoom(_ context.Context, room string) error {
	b.record(Call{Method: "EnsureRoom", Room: room})
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.rooms[room]; !ok {
		b.rooms[room] = nil
	}
	return b.Err
}

// DeleteRoom implements media.Backend.
func (b *Backend) DeleteRoom(_ context.Context, room string) error {
	b.record(Call{Method: "DeleteRoom", Room: room})
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.rooms, room)
	return b.Err
}

// IssueToken implements media.Backend.
func (b *Backend) IssueToken(req media.TokenRequest) (media.Token, error) {
	b.record(Call{
		Method:    "IssueToken",
		Room:      req.Room,
		ChannelID: req.ChannelID,
		UserID:    req.UserID,
		Kind:      req.Kind,
		Grants:    req.Grants,
		Identity:  media.IdentityFor(req.UserID, req.Kind),
	})
	if b.Err != nil {
		return media.Token{}, b.Err
	}
	return media.Token{
		Value:     fmt.Sprintf("token-%d-%s", req.UserID, req.Kind.Suffix()),
		Room:      req.Room,
		Identity:  media.IdentityFor(req.UserID, req.Kind),
		ChannelID: req.ChannelID,
		Kind:      req.Kind,
		ExpiresIn: req.TTLOrDefault(),
	}, nil
}

// RemoveParticipant implements media.Backend.
func (b *Backend) RemoveParticipant(_ context.Context, room, identity string) error {
	b.record(Call{Method: "RemoveParticipant", Room: room, Identity: identity})
	return b.Err
}

// SetPublishSource implements media.Backend.
func (b *Backend) SetPublishSource(_ context.Context, room, identity string, source media.Source, allowed bool) error {
	b.record(Call{Method: "SetPublishSource", Room: room, Identity: identity, Source: source, CanPublish: allowed})
	return b.Err
}

// SetCanSubscribe implements media.Backend.
func (b *Backend) SetCanSubscribe(_ context.Context, room, identity string, canSubscribe bool) error {
	b.record(Call{Method: "SetCanSubscribe", Room: room, Identity: identity, CanSubscribe: canSubscribe})
	return b.Err
}

// Rooms implements media.Backend.
func (b *Backend) Rooms(context.Context) ([]media.Room, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	rooms := make([]media.Room, 0, len(b.rooms))
	for name, participants := range b.rooms {
		rooms = append(rooms, media.Room{Name: name, Participants: participants})
	}
	return rooms, b.Err
}

// Events implements media.Backend.
func (b *Backend) Events() <-chan media.Event { return b.bus.Events() }

// Publish implements media.Publisher, so the supervisor can feed the fake.
func (b *Backend) Publish(event media.Event) { b.bus.Publish(event) }

// Signalling implements media.Backend.
func (b *Backend) Signalling() http.Handler { return http.NotFoundHandler() }

// Close implements media.Backend.
func (b *Backend) Close() error {
	b.bus.Close()
	return nil
}

// Calls returns a copy of the recorded calls.
func (b *Backend) Calls() []Call {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]Call(nil), b.calls...)
}

// CallsOf returns the calls of one method.
func (b *Backend) CallsOf(method string) []Call {
	var out []Call
	for _, call := range b.Calls() {
		if call.Method == method {
			out = append(out, call)
		}
	}
	return out
}

// SourceCalls returns the recorded SetPublishSource calls for one source.
func (b *Backend) SourceCalls(source media.Source) []Call {
	var out []Call
	for _, call := range b.CallsOf("SetPublishSource") {
		if call.Source == source {
			out = append(out, call)
		}
	}
	return out
}

// SetParticipants sets the reported participants of a room.
func (b *Backend) SetParticipants(room string, participants ...media.Participant) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rooms[room] = participants
}

// Reset calls clears the recorded calls.
func (b *Backend) Reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.calls = nil
}

func (b *Backend) record(call Call) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.calls = append(b.calls, call)
}
