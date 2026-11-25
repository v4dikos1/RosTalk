package media

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"
)

// Defaults of the reconciler. The intervals are deliberately asymmetric: a
// participant is removed only well after the control plane's own grace period
// for a dropped connection (10 s), while an empty room is closed quickly.
const (
	DefaultReconcileInterval = time.Second
	DefaultPresenceGrace     = 15 * time.Second
	DefaultEmptyRoomGrace    = 20 * time.Second
)

// Presence is what the reconciler may ask about the control plane. It is
// implemented by internal/state.Hub.
type Presence interface {
	// InChannel reports whether userID is currently in channelID.
	InChannel(userID int64, channelID uint64) bool
	// ChannelCount returns how many users are in a channel.
	ChannelCount(channelID uint64) int
}

// Publisher receives the events the reconciler discovers. *EventBus is the
// production implementation; tests use a recording one.
type Publisher interface {
	Publish(Event)
}

// SupervisorConfig wires the reconciler.
type SupervisorConfig struct {
	Backend   Backend
	Presence  Presence
	Publisher Publisher
	Logger    *slog.Logger
	// Interval is how often the backend is polled.
	Interval time.Duration
	// PresenceGrace is how long a participant may be in a room without a
	// presence record before it is removed.
	PresenceGrace time.Duration
	// EmptyRoomGrace is how long a room may stay empty before it is closed.
	EmptyRoomGrace time.Duration
	// Now overrides the clock in tests.
	Now func() time.Time
}

// Supervisor turns the polled backend snapshot into the event stream and keeps
// the media plane consistent with the control plane (prompt items 1 and 6):
//
//   - a participant in a room with no presence record is removed;
//   - a room with no participants and no users in its channel is closed.
//
// Both rules use the control plane as the source of truth, so a crash of a
// client, a lost media connection or a channel deletion cannot leave a ghost
// participant behind.
type Supervisor struct {
	backend   Backend
	presence  Presence
	publisher Publisher
	logger    *slog.Logger
	interval  time.Duration
	grace     time.Duration
	emptyFor  time.Duration
	now       func() time.Time

	// mu lets tests call Reconcile from a goroutine while Run is going.
	mu      sync.Mutex
	last    map[string]map[string]map[string]Track
	missing map[string]time.Time
	empty   map[string]time.Time
}

// NewSupervisor validates the wiring.
func NewSupervisor(cfg SupervisorConfig) (*Supervisor, error) {
	if cfg.Backend == nil {
		return nil, errors.New("media: supervisor needs a backend")
	}
	if cfg.Presence == nil {
		return nil, errors.New("media: supervisor needs the presence of the control plane")
	}
	if cfg.Publisher == nil {
		return nil, errors.New("media: supervisor needs an event publisher")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	interval := cfg.Interval
	if interval <= 0 {
		interval = DefaultReconcileInterval
	}
	grace := cfg.PresenceGrace
	if grace <= 0 {
		grace = DefaultPresenceGrace
	}
	emptyFor := cfg.EmptyRoomGrace
	if emptyFor <= 0 {
		emptyFor = DefaultEmptyRoomGrace
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &Supervisor{
		backend:   cfg.Backend,
		presence:  cfg.Presence,
		publisher: cfg.Publisher,
		logger:    logger,
		interval:  interval,
		grace:     grace,
		emptyFor:  emptyFor,
		now:       now,
		last:      make(map[string]map[string]map[string]Track),
		missing:   make(map[string]time.Time),
		empty:     make(map[string]time.Time),
	}, nil
}

// Run reconciles until the context is cancelled.
func (s *Supervisor) Run(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.Reconcile(ctx)
		}
	}
}

// Reconcile performs one pass: emit what changed, then enforce presence and
// room lifetime. It is exported so tests can drive it deterministically.
func (s *Supervisor) Reconcile(ctx context.Context) {
	rooms, err := s.backend.Rooms(ctx)
	if err != nil {
		s.logger.Warn("could not read the media rooms", "error", err)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	current := snapshotRooms(rooms)
	s.emitChanges(current)
	s.removeWithoutPresence(ctx, rooms)
	s.closeEmptyRooms(ctx, rooms)
	s.last = current
}

// emitChanges publishes participant and track events by comparing the new
// snapshot with the previous one.
func (s *Supervisor) emitChanges(current map[string]map[string]map[string]Track) {
	now := s.now()
	for room, participants := range current {
		channelID, _ := ChannelOfRoom(room)
		previousRoom := s.last[room]
		for identity, tracks := range participants {
			userID, kind, ours := ParseIdentity(identity)
			if !ours {
				userID, kind = 0, 0
			}
			previousTracks, seen := previousRoom[identity]
			if !seen {
				s.publisher.Publish(Event{
					Kind:            EventParticipantJoined,
					Room:            room,
					ChannelID:       channelID,
					Identity:        identity,
					UserID:          userID,
					ParticipantKind: kind,
					At:              now,
				})
				previousTracks = nil
			}
			for id, track := range tracks {
				if _, known := previousTracks[id]; known {
					continue
				}
				s.publisher.Publish(Event{
					Kind:            EventTrackPublished,
					Room:            room,
					ChannelID:       channelID,
					Identity:        identity,
					UserID:          userID,
					ParticipantKind: kind,
					Track:           track.ID,
					Source:          track.Source,
					At:              now,
				})
			}
			for id, track := range previousTracks {
				if _, still := tracks[id]; still {
					continue
				}
				s.publisher.Publish(Event{
					Kind:            EventTrackUnpublished,
					Room:            room,
					ChannelID:       channelID,
					Identity:        identity,
					UserID:          userID,
					ParticipantKind: kind,
					Track:           track.ID,
					Source:          track.Source,
					At:              now,
				})
			}
		}
		for identity := range previousRoom {
			if _, still := participants[identity]; still {
				continue
			}
			userID, kind, ours := ParseIdentity(identity)
			if !ours {
				userID, kind = 0, 0
			}
			s.publisher.Publish(Event{
				Kind:            EventParticipantLeft,
				Room:            room,
				ChannelID:       channelID,
				Identity:        identity,
				UserID:          userID,
				ParticipantKind: kind,
				At:              now,
			})
		}
	}
	for room, participants := range s.last {
		if _, still := current[room]; still {
			continue
		}
		channelID, _ := ChannelOfRoom(room)
		for identity := range participants {
			userID, kind, ours := ParseIdentity(identity)
			if !ours {
				userID, kind = 0, 0
			}
			s.publisher.Publish(Event{
				Kind:            EventParticipantLeft,
				Room:            room,
				ChannelID:       channelID,
				Identity:        identity,
				UserID:          userID,
				ParticipantKind: kind,
				At:              now,
			})
		}
	}
}

// removeWithoutPresence disconnects participants whose user is not in the
// channel of the room any more: a closed client that never said goodbye, a
// session that was replaced, or an evicted user.
func (s *Supervisor) removeWithoutPresence(ctx context.Context, rooms []Room) {
	now := s.now()
	seen := make(map[string]struct{})
	for _, room := range rooms {
		channelID, isChannel := ChannelOfRoom(room.Name)
		if !isChannel {
			continue
		}
		for _, participant := range room.Participants {
			userID, _, ours := ParseIdentity(participant.Identity)
			if !ours {
				// Not a RosTalk participant (for example a test agent); the
				// control plane has no say about it.
				continue
			}
			key := room.Name + "/" + participant.Identity
			if s.presence.InChannel(userID, channelID) {
				delete(s.missing, key)
				continue
			}
			since, tracked := s.missing[key]
			if !tracked {
				s.missing[key] = now
				seen[key] = struct{}{}
				continue
			}
			if now.Sub(since) < s.grace {
				seen[key] = struct{}{}
				continue
			}
			if err := s.backend.RemoveParticipant(ctx, room.Name, participant.Identity); err != nil {
				s.logger.Warn("could not remove a participant without presence",
					"room", room.Name,
					"identity", participant.Identity,
					"error", err,
				)
				seen[key] = struct{}{}
				continue
			}
			s.logger.Info("removed a media participant without presence",
				"room", room.Name,
				"identity", participant.Identity,
			)
		}
	}
	for key := range s.missing {
		if _, still := seen[key]; !still {
			delete(s.missing, key)
		}
	}
}

// closeEmptyRooms closes rooms that nobody is in and whose channel has no users
// with presence. A room that a user just got credentials for stays: the user is
// in the channel, so the empty grace does not start until they leave.
func (s *Supervisor) closeEmptyRooms(ctx context.Context, rooms []Room) {
	now := s.now()
	seen := make(map[string]struct{}, len(rooms))
	for _, room := range rooms {
		seen[room.Name] = struct{}{}
		if len(room.Participants) > 0 {
			delete(s.empty, room.Name)
			continue
		}
		channelID, isChannel := ChannelOfRoom(room.Name)
		if isChannel && s.presence.ChannelCount(channelID) > 0 {
			// Credentials were issued but nobody has connected yet.
			delete(s.empty, room.Name)
			continue
		}
		since, tracked := s.empty[room.Name]
		if !tracked {
			s.empty[room.Name] = now
			continue
		}
		if now.Sub(since) < s.emptyFor {
			continue
		}
		if err := s.backend.DeleteRoom(ctx, room.Name); err != nil {
			s.logger.Warn("could not close an empty room", "room", room.Name, "error", err)
			continue
		}
		delete(s.empty, room.Name)
		s.logger.Info("closed an empty media room", "room", room.Name, "channel_id", channelID)
	}
	for room := range s.empty {
		if _, still := seen[room]; !still {
			delete(s.empty, room)
		}
	}
}

// snapshotRooms flattens the backend snapshot for diffing: room -> identity ->
// track id -> track.
func snapshotRooms(rooms []Room) map[string]map[string]map[string]Track {
	out := make(map[string]map[string]map[string]Track, len(rooms))
	for _, room := range rooms {
		participants := make(map[string]map[string]Track, len(room.Participants))
		for _, participant := range room.Participants {
			tracks := make(map[string]Track, len(participant.Tracks))
			for _, track := range participant.Tracks {
				tracks[track.ID] = track
			}
			participants[participant.Identity] = tracks
		}
		out[room.Name] = participants
	}
	return out
}
