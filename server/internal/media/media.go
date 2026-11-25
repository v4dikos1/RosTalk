// Package media owns the media plane of the server: the Backend interface, its
// embedded LiveKit implementation, the token grants the control plane asks for
// and the event stream the rest of the server observes.
//
// This is the only package in the server that may mention LiveKit (CONTRIBUTING.md,
// design 3, ADR 0001). The control plane talks to Backend only; a future
// replacement (own SFU on Pion) implements the same interface.
//
// # Rooms and identities
//
// A voice channel maps to exactly one room, so the room name is derived from the
// channel id (RoomName) instead of being stored: restarting the server loses no
// mapping, and a room is recreated the next time somebody joins the channel.
//
// A user may have two media participants: the voice participant
// "<user_id>:voice" opened by the Rust core and the screen-share participant
// "<user_id>:stream" opened by the stream engine (design 4.7). Both use the same
// room; the track source, not the identity suffix, tells them apart on the wire.
package media

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Kind selects the media participant a token belongs to.
type Kind uint8

const (
	// KindVoice is the voice participant "<user_id>:voice".
	KindVoice Kind = 1
	// KindStream is the screen-share participant "<user_id>:stream".
	KindStream Kind = 2
)

// Suffix is the part of the participant identity after the colon.
func (k Kind) Suffix() string {
	switch k {
	case KindStream:
		return "stream"
	default:
		return "voice"
	}
}

// String implements fmt.Stringer; the values match the wire enum suffixes.
func (k Kind) String() string { return k.Suffix() }

// Source is a track source a token may publish. The names match the LiveKit
// grant and track-source spelling so the backend needs no lookup table.
type Source string

const (
	// SourceMicrophone is ordinary voice audio.
	SourceMicrophone Source = "microphone"
	// SourceScreenShare is a screen-share video track.
	SourceScreenShare Source = "screen_share"
	// SourceScreenShareAudio is the audio of a screen share.
	SourceScreenShareAudio Source = "screen_share_audio"
)

// Valid reports whether the value is a source this server issues grants for.
func (s Source) Valid() bool {
	switch s {
	case SourceMicrophone, SourceScreenShare, SourceScreenShareAudio:
		return true
	default:
		return false
	}
}

// Grants are the rights a media token carries. They mirror the token
// permissions of the backend, which is what actually enforces them: the client
// cannot exceed them even if it ignores the control plane.
type Grants struct {
	// CanPublish allows uploading tracks.
	CanPublish bool
	// CanSubscribe allows receiving the tracks of others.
	CanSubscribe bool
	// PublishSources limits publishing to these sources. When empty and
	// CanPublish is true, any source is allowed.
	PublishSources []Source
}

// TokenRequest asks the backend for one media token.
type TokenRequest struct {
	// Room is the backend room; it must be RoomName(ChannelID).
	Room string
	// ChannelID is the control-plane channel the token is bound to.
	ChannelID uint64
	// UserID is the control-plane user.
	UserID int64
	// Kind selects the participant identity.
	Kind Kind
	// TTL is the token lifetime. Zero means DefaultTokenTTL.
	TTL time.Duration
	// Grants are the rights the token carries.
	Grants Grants
}

// Token is an issued media credential. Its value must never be logged.
type Token struct {
	// Value is the opaque access token.
	Value string
	// Room is the room the token is valid for.
	Room string
	// Identity is the participant identity it was issued to.
	Identity string
	// ChannelID is the channel it is bound to.
	ChannelID uint64
	// Kind is the participant kind.
	Kind Kind
	// ExpiresIn is the remaining lifetime at issue time.
	ExpiresIn time.Duration
}

// DefaultTokenTTL is the design lifetime of a media token (design 4.7: 60 s).
// A client that is slow to connect asks for a new one; tokens are not reused.
const DefaultTokenTTL = 60 * time.Second

// Track is one published track of a room participant.
type Track struct {
	// ID is the backend track id.
	ID string
	// Source is the track source.
	Source Source
}

// Participant is one connected media participant.
type Participant struct {
	// Identity is the participant identity, "<user_id>:<voice|stream>".
	Identity string
	// Tracks are the published tracks.
	Tracks []Track
}

// Room is a snapshot of one backend room.
type Room struct {
	// Name is the room name, see RoomName.
	Name string
	// Participants are the connected participants.
	Participants []Participant
}

// EventKind classifies a media event.
type EventKind string

const (
	// EventParticipantJoined means a participant connected to a room.
	EventParticipantJoined EventKind = "participant_joined"
	// EventParticipantLeft means a participant disconnected.
	EventParticipantLeft EventKind = "participant_left"
	// EventTrackPublished means a participant started publishing a track.
	EventTrackPublished EventKind = "track_published"
	// EventTrackUnpublished means a published track was removed.
	EventTrackUnpublished EventKind = "track_unpublished"
)

// Event is one change in the media plane.
type Event struct {
	// Kind is what happened.
	Kind EventKind
	// Room is the backend room.
	Room string
	// ChannelID is the channel the room maps to, 0 when unknown.
	ChannelID uint64
	// Identity is the participant identity.
	Identity string
	// UserID is the control-plane user, 0 when the identity is not ours.
	UserID int64
	// ParticipantKind is the participant kind, 0 when the identity is not ours.
	ParticipantKind Kind
	// Track is the track id for track events.
	Track string
	// Source is the track source for track events.
	Source Source
	// At is when the event was observed.
	At time.Time
}

// ErrNotFound is returned when the room or participant does not exist. Callers
// treat it as "already gone" and do not report an error.
var ErrNotFound = errors.New("media: room or participant not found")

// ErrClosed is returned by operations on a closed backend.
var ErrClosed = errors.New("media: backend is closed")

// Backend is the media plane. The control plane is its only caller; nothing
// outside this package knows which SFU implements it.
type Backend interface {
	// EnsureRoom creates the room if it does not exist. It is idempotent.
	EnsureRoom(ctx context.Context, room string) error
	// DeleteRoom disconnects everyone in the room and removes it. A room that
	// does not exist is not an error.
	DeleteRoom(ctx context.Context, room string) error
	// IssueToken returns a short-lived credential for one participant.
	IssueToken(req TokenRequest) (Token, error)
	// RemoveParticipant disconnects one participant. A participant that is
	// already gone is not an error.
	RemoveParticipant(ctx context.Context, room, identity string) error
	// SetPublishSource allows or forbids publishing one track source in an
	// existing session and keeps every other grant. canPublish follows the
	// remaining sources. It is how a server-side mute (microphone) and a
	// revoked stream right (screen_share_audio of the voice participant) are
	// enforced (design 4.4, ADR 0027); the SFU removes a published track whose
	// source is no longer allowed.
	SetPublishSource(ctx context.Context, room, identity string, source Source, allowed bool) error
	// SetCanSubscribe allows or forbids receiving tracks in an existing
	// session. It is how a server-side deafen is enforced.
	SetCanSubscribe(ctx context.Context, room, identity string, canSubscribe bool) error
	// Rooms returns a snapshot of every room the backend knows about. The
	// supervisor polls it to produce Events and to reconcile state.
	Rooms(ctx context.Context) ([]Room, error)
	// Events streams participant and track changes. The channel is closed when
	// the backend closes. Consumers must keep draining it.
	Events() <-chan Event
	// Signalling returns the HTTP handler the gateway mounts on /rtc.
	Signalling() http.Handler
	// Close stops the backend and releases the media ports.
	Close() error
}

// RoomName maps a channel id to its media room.
func RoomName(channelID uint64) string {
	return "channel-" + strconv.FormatUint(channelID, 10)
}

// ChannelOfRoom is the inverse of RoomName. It reports false for rooms that do
// not belong to a channel.
func ChannelOfRoom(room string) (uint64, bool) {
	rest, ok := strings.CutPrefix(room, "channel-")
	if !ok || rest == "" {
		return 0, false
	}
	id, err := strconv.ParseUint(rest, 10, 64)
	if err != nil || id == 0 {
		return 0, false
	}
	return id, true
}

// IdentityFor builds the participant identity of a user.
func IdentityFor(userID int64, kind Kind) string {
	return strconv.FormatInt(userID, 10) + ":" + kind.Suffix()
}

// ParseIdentity splits "<user_id>:<voice|stream>".
func ParseIdentity(identity string) (int64, Kind, bool) {
	idPart, kindPart, ok := strings.Cut(identity, ":")
	if !ok || idPart == "" {
		return 0, 0, false
	}
	var kind Kind
	switch kindPart {
	case "voice":
		kind = KindVoice
	case "stream":
		kind = KindStream
	default:
		return 0, 0, false
	}
	userID, err := strconv.ParseInt(idPart, 10, 64)
	if err != nil || userID <= 0 {
		return 0, 0, false
	}
	return userID, kind, true
}

// Validate checks a token request against the room naming rule.
func (r TokenRequest) Validate() error {
	if r.ChannelID == 0 {
		return errors.New("media: token request has no channel id")
	}
	if r.UserID <= 0 {
		return errors.New("media: token request has no user id")
	}
	if r.Room != RoomName(r.ChannelID) {
		return fmt.Errorf("media: room %q does not belong to channel %d", r.Room, r.ChannelID)
	}
	if r.Kind != KindVoice && r.Kind != KindStream {
		return fmt.Errorf("media: unknown participant kind %d", r.Kind)
	}
	for _, source := range r.Grants.PublishSources {
		if !source.Valid() {
			return fmt.Errorf("media: unknown publish source %q", source)
		}
	}
	return nil
}

// TTLOrDefault returns the token lifetime to use, substituting the default for
// an unset TTL.
func (r TokenRequest) TTLOrDefault() time.Duration {
	if r.TTL <= 0 {
		return DefaultTokenTTL
	}
	return r.TTL
}
