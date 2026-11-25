package media

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/livekit/livekit-server/pkg/config"
	"github.com/livekit/livekit-server/pkg/routing"
	"github.com/livekit/livekit-server/pkg/service"
	"github.com/livekit/livekit-server/pkg/telemetry/prometheus"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"
)

// Default media ports (design 4.1).
const (
	DefaultSignalPort = 7880
	DefaultUDPPort    = 7882
	DefaultTCPPort    = 7881
)

// UDP batching coalesces RTP packets sent on the single media socket into one
// sendmmsg call. Thirty-two packets is four 20 ms Opus frames per subscriber at
// one millisecond flush latency; the local measurement (docs/PERF.md) cut
// server CPU by about a third on 380 streams without hurting delivery.
const (
	DefaultBatchSize  = 32
	DefaultBatchFlush = time.Millisecond
)

// liveKitConfig is the embedded SFU configuration. It is a template on purpose:
// every value comes from the server configuration, nothing is read from disk.
const liveKitConfig = `
port: %d
bind_addresses:
  - 127.0.0.1
rtc:
  udp_port: %d
  tcp_port: %d
  # Batched UDP writes: one sendmmsg for up to batch_size packets, flushed
  # after max_flush_interval at the latest; batch_size 0 disables batching.
  batch_io:
    batch_size: %d
    max_flush_interval: %s
  use_external_ip: false
  node_ip: "%s"
  enable_loopback_candidate: %t
keys:
  %s: %s
room:
  auto_create: true
  empty_timeout: 300
logging:
  level: info
  json: false
`

// LiveKitConfig configures the embedded backend.
type LiveKitConfig struct {
	// SignalPort is the loopback HTTP/WebSocket signalling port. The gateway
	// proxies /rtc to it; it is never exposed directly (design 4.1).
	SignalPort int
	// UDPPort is the single-port UDP media port (rtc.udp_port).
	UDPPort int
	// TCPPort is the ICE-TCP fallback port (rtc.tcp_port).
	TCPPort int
	// NodeIP is the address announced in ICE candidates (rtc.node_ip). It must
	// be the address clients can reach: the LAN IP of a Windows dev host, never
	// loopback in that setup (ADR 0001).
	NodeIP string
	// EnableLoopbackCandidate offers loopback candidates as well. It must stay
	// false whenever NodeIP is not loopback, otherwise the UDP mux stops
	// answering STUN (ADR 0001, trap 4).
	EnableLoopbackCandidate bool
	// APIKey and APISecret sign the tokens. They are generated once and kept in
	// the settings table so tokens survive a restart.
	APIKey    string
	APISecret string
	Logger    *slog.Logger
	// DisableBatchIO turns off batched UDP writes. Batching is on by default:
	// it is a measurable CPU saving on a busy SFU (docs/PERF.md). The flag
	// exists as an escape hatch for hosts where sendmmsg misbehaves.
	DisableBatchIO bool
	// EventBuffer overrides DefaultEventBuffer.
	EventBuffer int
}

// LiveKit is the embedded LiveKit SFU.
type LiveKit struct {
	logger *slog.Logger
	server *service.LivekitServer
	bus    *EventBus
	proxy  http.Handler

	apiKey    string
	apiSecret string
	nodeIP    string

	mu     sync.RWMutex
	rooms  map[string]struct{}
	closed bool
	done   chan struct{}
}

// NewLiveKit starts the SFU in this process. It returns once the loopback
// signalling endpoint answers, so a returned backend is ready to issue tokens.
func NewLiveKit(cfg LiveKitConfig) (*LiveKit, error) {
	if cfg.APIKey == "" || cfg.APISecret == "" {
		return nil, errors.New("media: livekit api key and secret are required")
	}
	if cfg.NodeIP == "" || net.ParseIP(cfg.NodeIP) == nil {
		return nil, fmt.Errorf("media: node ip %q is not an IP address", cfg.NodeIP)
	}
	if cfg.SignalPort < 0 || cfg.SignalPort > 65535 {
		return nil, fmt.Errorf("media: signalling port %d is out of range", cfg.SignalPort)
	}
	loopback := cfg.EnableLoopbackCandidate && isLoopbackIP(cfg.NodeIP)
	if cfg.EnableLoopbackCandidate && !loopback {
		// ADR 0001, trap 4: with a non-loopback node_ip the UDP mux stops
		// answering STUN when loopback candidates are on.
		if cfg.Logger != nil {
			cfg.Logger.Warn("ignoring enable_loopback_candidate: the advertised node ip is not loopback",
				"node_ip", cfg.NodeIP)
		}
	}

	raw := liveKitYAML(cfg, loopback)
	conf, err := config.NewConfig(raw, true, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("media: livekit config: %w", err)
	}
	config.InitLoggerFromConfig(&conf.Logging)

	node, err := routing.NewLocalNode(conf)
	if err != nil {
		return nil, fmt.Errorf("media: livekit node: %w", err)
	}
	// Must happen before InitializeServer: the node stats worker assumes the
	// Prometheus collectors exist (ADR 0001, trap 3). Init is idempotent.
	if err := prometheus.Init(string(node.NodeID()), node.NodeType()); err != nil {
		return nil, fmt.Errorf("media: prometheus init: %w", err)
	}
	srv, err := service.InitializeServer(conf, node)
	if err != nil {
		return nil, fmt.Errorf("media: livekit initialise: %w", err)
	}

	backend := &LiveKit{
		logger:    loggerOr(cfg.Logger),
		server:    srv,
		bus:       NewEventBus(cfg.EventBuffer),
		apiKey:    cfg.APIKey,
		apiSecret: cfg.APISecret,
		nodeIP:    cfg.NodeIP,
		rooms:     make(map[string]struct{}),
		done:      make(chan struct{}),
	}

	started := make(chan error, 1)
	go func() { started <- srv.Start() }()

	signalURL := fmt.Sprintf("http://127.0.0.1:%d", cfg.SignalPort)
	if err := waitHTTP(signalURL+"/", 30*time.Second, backend.done); err != nil {
		srv.Stop(true)
		return nil, fmt.Errorf("media: livekit did not become ready: %w", err)
	}
	backend.proxy = newSignalProxy(signalURL, backend.logger)

	backend.logger.Info("embedded media backend started",
		"node_ip", cfg.NodeIP,
		"loopback_candidate", loopback,
		"udp_port", cfg.UDPPort,
		"tcp_port", cfg.TCPPort,
		"batch_io", conf.RTC.BatchIO.BatchSize > 0,
		"batch_size", conf.RTC.BatchIO.BatchSize,
		"batch_flush", conf.RTC.BatchIO.MaxFlushInterval,
	)
	return backend, nil
}

// EnsureRoom implements Backend.
func (l *LiveKit) EnsureRoom(ctx context.Context, room string) error {
	if err := l.checkOpen(); err != nil {
		return err
	}
	if _, err := l.server.RoomManager().CreateRoom(ctx, &livekit.CreateRoomRequest{Name: room}); err != nil {
		return fmt.Errorf("media: create room %q: %w", room, err)
	}
	l.mu.Lock()
	l.rooms[room] = struct{}{}
	l.mu.Unlock()
	return nil
}

// DeleteRoom implements Backend.
func (l *LiveKit) DeleteRoom(ctx context.Context, room string) error {
	if err := l.checkOpen(); err != nil {
		return err
	}
	if _, err := l.server.RoomManager().DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: room}); err != nil {
		if errors.Is(err, service.ErrRoomNotFound) {
			l.forgetRoom(room)
			return nil
		}
		// Deleting a room that has no RTC session yet ends up in the room store
		// lookup; a room that never existed is still "gone".
		l.forgetRoom(room)
		return fmt.Errorf("media: delete room %q: %w", room, err)
	}
	l.forgetRoom(room)
	return nil
}

// IssueToken implements Backend.
func (l *LiveKit) IssueToken(req TokenRequest) (Token, error) {
	if err := l.checkOpen(); err != nil {
		return Token{}, err
	}
	if err := req.Validate(); err != nil {
		return Token{}, err
	}
	identity := IdentityFor(req.UserID, req.Kind)
	grant := &auth.VideoGrant{
		RoomJoin: true,
		Room:     req.Room,
	}
	grant.SetCanSubscribe(req.Grants.CanSubscribe)
	if req.Grants.CanPublish {
		grant.SetCanPublish(true)
		if sources := trackSources(req.Grants.PublishSources); len(sources) > 0 {
			grant.SetCanPublishSources(sources)
		}
	} else {
		grant.SetCanPublish(false)
	}

	ttl := req.TTLOrDefault()
	value, err := auth.NewAccessToken(l.apiKey, l.apiSecret).
		SetIdentity(identity).
		SetValidFor(ttl).
		SetVideoGrant(grant).
		ToJWT()
	if err != nil {
		return Token{}, fmt.Errorf("media: sign token: %w", err)
	}
	return Token{
		Value:     value,
		Room:      req.Room,
		Identity:  identity,
		ChannelID: req.ChannelID,
		Kind:      req.Kind,
		ExpiresIn: ttl,
	}, nil
}

// RemoveParticipant implements Backend.
func (l *LiveKit) RemoveParticipant(ctx context.Context, room, identity string) error {
	if err := l.checkOpen(); err != nil {
		return err
	}
	_, err := l.server.RoomManager().RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{
		Room:     room,
		Identity: identity,
	})
	switch {
	case err == nil:
		return nil
	case errors.Is(err, service.ErrRoomNotFound), errors.Is(err, service.ErrParticipantNotFound):
		return nil
	default:
		return fmt.Errorf("media: remove participant %q from %q: %w", identity, room, err)
	}
}

// SetPublishSource implements Backend. It adds or removes one source of the
// participant's live permission and keeps everything else: a server mute must
// not silently lift a server deafen (canSubscribe=false), and muting the
// microphone must not stop the screen-share audio the same voice participant
// publishes (ADR 0027). UpdateParticipant replaces the whole permission
// object, so the current one is copied first.
func (l *LiveKit) SetPublishSource(ctx context.Context, room, identity string, source Source, allowed bool) error {
	if err := l.checkOpen(); err != nil {
		return err
	}
	if !source.Valid() {
		return fmt.Errorf("media: unknown track source %q", source)
	}
	rtcRoom := l.server.RoomManager().GetRoom(ctx, livekit.RoomName(room))
	if rtcRoom == nil {
		return fmt.Errorf("%w: room %q", ErrNotFound, room)
	}
	for _, participant := range rtcRoom.GetParticipants() {
		info := participant.ToProto()
		if info.GetIdentity() != identity {
			continue
		}
		_, err := l.server.RoomManager().UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
			Room:       room,
			Identity:   identity,
			Permission: permissionWithSource(info.GetPermission(), source, allowed),
		})
		switch {
		case err == nil:
			return nil
		case errors.Is(err, service.ErrRoomNotFound), errors.Is(err, service.ErrParticipantNotFound):
			return fmt.Errorf("%w: participant %q in %q", ErrNotFound, identity, room)
		default:
			return fmt.Errorf("media: set publish source %s for %q in %q: %w", source, identity, room, err)
		}
	}
	return fmt.Errorf("%w: participant %q in %q", ErrNotFound, identity, room)
}

// allTrackSources is what an empty CanPublishSources list means while
// CanPublish is set: every source. Tokens issued by this server always name
// their sources, so this only matters for a permission of unknown origin.
var allTrackSources = []livekit.TrackSource{
	livekit.TrackSource_MICROPHONE,
	livekit.TrackSource_SCREEN_SHARE,
	livekit.TrackSource_SCREEN_SHARE_AUDIO,
}

// permissionWithSource returns a copy of the current permission with one
// source added or removed and CanPublish recomputed from the remaining list.
// Every other grant (subscribe, data, hidden) stays exactly as the token or a
// previous update left it. A nil permission (a participant created before the
// field existed) starts from the same conservative default the old code used.
func permissionWithSource(current *livekit.ParticipantPermission, source Source, allowed bool) *livekit.ParticipantPermission {
	var permission *livekit.ParticipantPermission
	if current != nil {
		permission = proto.Clone(current).(*livekit.ParticipantPermission)
	} else {
		permission = &livekit.ParticipantPermission{
			CanSubscribe:   true,
			CanPublishData: true,
		}
	}
	sources := permission.GetCanPublishSources()
	if permission.GetCanPublish() && len(sources) == 0 {
		sources = allTrackSources
	}
	if !permission.GetCanPublish() {
		// Without the publish bit the list is only a leftover of the token;
		// it grants nothing.
		sources = nil
	}
	target := trackSources([]Source{source})[0]
	next := make([]livekit.TrackSource, 0, len(sources)+1)
	for _, existing := range sources {
		if existing != target {
			next = append(next, existing)
		}
	}
	if allowed {
		next = append(next, target)
	}
	permission.CanPublishSources = next
	permission.CanPublish = len(next) > 0
	return permission
}

// SetCanSubscribe implements Backend. It keeps the current publish permission
// intact, so a server-side deafen does not silently unmute the user.
func (l *LiveKit) SetCanSubscribe(ctx context.Context, room, identity string, canSubscribe bool) error {
	if err := l.checkOpen(); err != nil {
		return err
	}
	rtcRoom := l.server.RoomManager().GetRoom(ctx, livekit.RoomName(room))
	if rtcRoom == nil {
		return fmt.Errorf("%w: room %q", ErrNotFound, room)
	}
	for _, participant := range rtcRoom.GetParticipants() {
		info := participant.ToProto()
		if info.GetIdentity() != identity || info.GetPermission() == nil {
			continue
		}
		info.Permission.CanSubscribe = canSubscribe
		_, err := l.server.RoomManager().UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
			Room:       room,
			Identity:   identity,
			Permission: info.Permission,
		})
		if err != nil {
			return fmt.Errorf("media: set can subscribe for %q in %q: %w", identity, room, err)
		}
		return nil
	}
	return fmt.Errorf("%w: participant %q in %q", ErrNotFound, identity, room)
}

// Rooms implements Backend. The backend remembers which rooms the control plane
// created; a room LiveKit closed on its own disappears from the snapshot.
func (l *LiveKit) Rooms(ctx context.Context) ([]Room, error) {
	if err := l.checkOpen(); err != nil {
		return nil, err
	}
	l.mu.RLock()
	names := make([]string, 0, len(l.rooms))
	for name := range l.rooms {
		names = append(names, name)
	}
	l.mu.RUnlock()

	rooms := make([]Room, 0, len(names))
	for _, name := range names {
		rtcRoom := l.server.RoomManager().GetRoom(ctx, livekit.RoomName(name))
		if rtcRoom == nil {
			l.forgetRoom(name)
			continue
		}
		participants := rtcRoom.GetParticipants()
		snapshot := Room{Name: name, Participants: make([]Participant, 0, len(participants))}
		for _, participant := range participants {
			info := participant.ToProto()
			out := Participant{Identity: info.GetIdentity()}
			for _, track := range info.GetTracks() {
				out.Tracks = append(out.Tracks, Track{
					ID:     track.GetSid(),
					Source: Source(trackSourceName(track.GetSource())),
				})
			}
			snapshot.Participants = append(snapshot.Participants, out)
		}
		rooms = append(rooms, snapshot)
	}
	return rooms, nil
}

// Events implements Backend.
func (l *LiveKit) Events() <-chan Event { return l.bus.Events() }

// Publish implements Publisher: the supervisor reports the changes it observes
// into the event stream of this backend.
func (l *LiveKit) Publish(event Event) { l.bus.Publish(event) }

// Signalling implements Backend.
func (l *LiveKit) Signalling() http.Handler { return l.proxy }

// Close implements Backend.
func (l *LiveKit) Close() error {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil
	}
	l.closed = true
	l.mu.Unlock()

	close(l.done)
	l.bus.Close()
	if l.server != nil {
		l.server.Stop(false)
	}
	return nil
}

// NodeIP returns the address announced in ICE candidates.
func (l *LiveKit) NodeIP() string { return l.nodeIP }

func (l *LiveKit) checkOpen() error {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if l.closed {
		return ErrClosed
	}
	return nil
}

func (l *LiveKit) forgetRoom(room string) {
	l.mu.Lock()
	delete(l.rooms, room)
	l.mu.Unlock()
}

// liveKitYAML renders the embedded SFU configuration. It is separated from
// NewLiveKit so a test can parse the exact config without opening sockets.
func liveKitYAML(cfg LiveKitConfig, loopback bool) string {
	batchSize := DefaultBatchSize
	batchFlush := DefaultBatchFlush
	if cfg.DisableBatchIO {
		batchSize = 0
		batchFlush = 0
	}
	return fmt.Sprintf(liveKitConfig,
		cfg.SignalPort,
		cfg.UDPPort,
		cfg.TCPPort,
		batchSize,
		batchFlush,
		cfg.NodeIP,
		loopback,
		cfg.APIKey,
		cfg.APISecret,
	)
}

func isLoopbackIP(value string) bool {
	ip := net.ParseIP(strings.TrimSpace(value))
	return ip != nil && ip.IsLoopback()
}

func trackSources(sources []Source) []livekit.TrackSource {
	if len(sources) == 0 {
		return nil
	}
	out := make([]livekit.TrackSource, 0, len(sources))
	for _, source := range sources {
		switch source {
		case SourceMicrophone:
			out = append(out, livekit.TrackSource_MICROPHONE)
		case SourceScreenShare:
			out = append(out, livekit.TrackSource_SCREEN_SHARE)
		case SourceScreenShareAudio:
			out = append(out, livekit.TrackSource_SCREEN_SHARE_AUDIO)
		}
	}
	return out
}

func trackSourceName(source livekit.TrackSource) string {
	switch source {
	case livekit.TrackSource_MICROPHONE:
		return string(SourceMicrophone)
	case livekit.TrackSource_SCREEN_SHARE:
		return string(SourceScreenShare)
	case livekit.TrackSource_SCREEN_SHARE_AUDIO:
		return string(SourceScreenShareAudio)
	default:
		return ""
	}
}

// newSignalProxy forwards the gateway's /rtc traffic to the loopback signalling
// endpoint. The public Host header is kept: LiveKit embeds it in the ICE
// servers it returns, and the client must see the address it dialled.
func newSignalProxy(target string, logger *slog.Logger) http.Handler {
	targetURL, err := url.Parse(target)
	if err != nil {
		// The URL is built from a port number, so this cannot fail in practice.
		return http.NotFoundHandler()
	}
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(targetURL)
			pr.SetXForwarded()
			pr.Out.Host = pr.In.Host
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			logger.Warn("media signalling proxy failed", "path", r.URL.Path, "error", err)
			http.Error(w, "bad gateway", http.StatusBadGateway)
		},
	}
}

// waitHTTP polls url until it answers or the timeout expires.
func waitHTTP(rawURL string, timeout time.Duration, done <-chan struct{}) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 500 * time.Millisecond}
	for time.Now().Before(deadline) {
		select {
		case <-done:
			return errors.New("backend closed while starting")
		default:
		}
		req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, rawURL, nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err == nil {
			_ = resp.Body.Close()
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return errors.New("timeout")
}

func loggerOr(logger *slog.Logger) *slog.Logger {
	if logger == nil {
		return slog.Default()
	}
	return logger
}
