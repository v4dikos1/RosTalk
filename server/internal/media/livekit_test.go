package media

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	livekitconfig "github.com/livekit/livekit-server/pkg/config"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
)

func TestBatchIOConfig(t *testing.T) {
	cfg := LiveKitConfig{
		SignalPort: 7880,
		UDPPort:    7882,
		TCPPort:    7881,
		NodeIP:     "127.0.0.1",
		APIKey:     "key",
		APISecret:  "secret",
	}

	parsed, err := livekitconfig.NewConfig(liveKitYAML(cfg, false), true, nil, nil)
	if err != nil {
		t.Fatalf("parse config with batching: %v", err)
	}
	if parsed.RTC.BatchIO.BatchSize != DefaultBatchSize ||
		parsed.RTC.BatchIO.MaxFlushInterval != DefaultBatchFlush {
		t.Fatalf("batch_io = %+v, want %d/%s", parsed.RTC.BatchIO,
			DefaultBatchSize, DefaultBatchFlush)
	}

	cfg.DisableBatchIO = true
	parsed, err = livekitconfig.NewConfig(liveKitYAML(cfg, false), true, nil, nil)
	if err != nil {
		t.Fatalf("parse config without batching: %v", err)
	}
	if parsed.RTC.BatchIO.BatchSize != 0 || parsed.RTC.BatchIO.MaxFlushInterval != 0 {
		t.Fatalf("batch_io with the escape hatch = %+v, want disabled", parsed.RTC.BatchIO)
	}
}

// tokenBackend builds a backend that can sign tokens without starting the SFU.
func tokenBackend() *LiveKit {
	return &LiveKit{
		apiKey:    "test-key",
		apiSecret: "test-secret-value",
		bus:       NewEventBus(1),
		rooms:     make(map[string]struct{}),
	}
}

// decodeClaims verifies a token and returns its grants.
func decodeClaims(t *testing.T, backend *LiveKit, token string) (*auth.ClaimGrants, jwt.MapClaims) {
	t.Helper()
	mapClaims := jwt.MapClaims{}
	parsed, err := jwt.ParseWithClaims(token, mapClaims, func(*jwt.Token) (any, error) {
		return []byte(backend.apiSecret), nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil {
		t.Fatalf("parse token: %v", err)
	}
	if !parsed.Valid {
		t.Fatal("token is not valid")
	}
	raw, err := json.Marshal(mapClaims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	claims := &auth.ClaimGrants{}
	if err := json.Unmarshal(raw, claims); err != nil {
		t.Fatalf("unmarshal claims: %v", err)
	}
	return claims, mapClaims
}

func TestIssueTokenGrantsAndLifetime(t *testing.T) {
	backend := tokenBackend()
	token, err := backend.IssueToken(TokenRequest{
		Room:      RoomName(3),
		ChannelID: 3,
		UserID:    7,
		Kind:      KindVoice,
		Grants: Grants{
			CanPublish:     true,
			CanSubscribe:   true,
			PublishSources: []Source{SourceMicrophone},
		},
	})
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	if token.Identity != "7:voice" || token.Room != RoomName(3) || token.ChannelID != 3 {
		t.Fatalf("unexpected token metadata: %+v", token)
	}
	if token.ExpiresIn != DefaultTokenTTL {
		t.Fatalf("expires in %v, want %v", token.ExpiresIn, DefaultTokenTTL)
	}

	claims, raw := decodeClaims(t, backend, token.Value)
	if claims.Identity != "7:voice" {
		t.Fatalf("identity claim = %q", claims.Identity)
	}
	video := claims.Video
	if video == nil {
		t.Fatal("token has no video grant")
	}
	if !video.RoomJoin || video.Room != RoomName(3) {
		t.Fatalf("room grant = join:%v room:%q", video.RoomJoin, video.Room)
	}
	if !video.GetCanPublish() {
		t.Fatal("voice token cannot publish")
	}
	if !video.GetCanSubscribe() {
		t.Fatal("voice token cannot subscribe")
	}
	if len(video.CanPublishSources) != 1 || video.CanPublishSources[0] != string(SourceMicrophone) {
		t.Fatalf("publish sources = %v, want [microphone]", video.CanPublishSources)
	}

	issuedAt, err := raw.GetIssuedAt()
	if err != nil {
		t.Fatalf("iat: %v", err)
	}
	expiresAt, err := raw.GetExpirationTime()
	if err != nil {
		t.Fatalf("exp: %v", err)
	}
	if lifetime := expiresAt.Sub(issuedAt.Time); lifetime != DefaultTokenTTL {
		t.Fatalf("token lifetime = %v, want %v", lifetime, DefaultTokenTTL)
	}
}

func TestIssueTokenWithoutSpeakCannotPublish(t *testing.T) {
	backend := tokenBackend()
	token, err := backend.IssueToken(TokenRequest{
		Room:      RoomName(3),
		ChannelID: 3,
		UserID:    7,
		Kind:      KindVoice,
		Grants:    Grants{CanPublish: false, CanSubscribe: true},
	})
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	claims, _ := decodeClaims(t, backend, token.Value)
	if claims.Video == nil {
		t.Fatal("token has no video grant")
	}
	if claims.Video.GetCanPublish() {
		t.Fatal("a token issued without speak can publish")
	}
	if len(claims.Video.CanPublishSources) != 0 {
		t.Fatalf("a non-publishing token narrowed its sources: %v", claims.Video.CanPublishSources)
	}
	if !claims.Video.GetCanSubscribe() {
		t.Fatal("a non-publishing token must still subscribe")
	}
}

func TestIssueTokenStreamSources(t *testing.T) {
	backend := tokenBackend()
	token, err := backend.IssueToken(TokenRequest{
		Room:      RoomName(4),
		ChannelID: 4,
		UserID:    11,
		Kind:      KindStream,
		Grants: Grants{
			CanPublish:     true,
			CanSubscribe:   true,
			PublishSources: []Source{SourceScreenShare, SourceScreenShareAudio},
		},
	})
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	if token.Identity != "11:stream" {
		t.Fatalf("stream identity = %q", token.Identity)
	}
	claims, _ := decodeClaims(t, backend, token.Value)
	if got := claims.Video.CanPublishSources; len(got) != 2 ||
		got[0] != string(SourceScreenShare) || got[1] != string(SourceScreenShareAudio) {
		t.Fatalf("stream publish sources = %v", got)
	}
}

func TestIssueTokenRejectsForeignRoom(t *testing.T) {
	backend := tokenBackend()
	if _, err := backend.IssueToken(TokenRequest{
		Room:      RoomName(9),
		ChannelID: 8,
		UserID:    1,
		Kind:      KindVoice,
	}); err == nil {
		t.Fatal("IssueToken accepted a room that does not belong to the channel")
	}
}

func TestIssueTokenAfterClose(t *testing.T) {
	backend := tokenBackend()
	backend.closed = true
	if _, err := backend.IssueToken(TokenRequest{
		Room:      RoomName(1),
		ChannelID: 1,
		UserID:    1,
		Kind:      KindVoice,
	}); err == nil {
		t.Fatal("IssueToken on a closed backend succeeded")
	}
}

func TestPermissionWithSourcePreservesOtherGrants(t *testing.T) {
	current := &livekit.ParticipantPermission{
		CanSubscribe:   false, // a server deafen must survive a mute/unmute
		CanPublish:     true,
		CanPublishData: true,
		CanPublishSources: []livekit.TrackSource{
			livekit.TrackSource_MICROPHONE,
			livekit.TrackSource_SCREEN_SHARE_AUDIO,
		},
		Hidden: true,
	}
	muted := permissionWithSource(current, SourceMicrophone, false)
	// A server mute removes only the microphone: the screen-share audio the
	// same voice participant publishes keeps going (ADR 0027).
	if !muted.GetCanPublish() {
		t.Fatal("muting the microphone cleared the publish bit of the stream audio")
	}
	if got := muted.GetCanPublishSources(); len(got) != 1 || got[0] != livekit.TrackSource_SCREEN_SHARE_AUDIO {
		t.Fatalf("publish sources = %v, want [screen_share_audio]", got)
	}
	if muted.GetCanSubscribe() {
		t.Fatal("muting lifted the server deafen")
	}
	if !muted.GetCanPublishData() || !muted.GetHidden() {
		t.Fatalf("other grants were dropped: %+v", muted)
	}
	if len(current.GetCanPublishSources()) != 2 {
		t.Fatal("permissionWithSource mutated the live permission")
	}

	unmuted := permissionWithSource(muted, SourceMicrophone, true)
	if !unmuted.GetCanPublish() || unmuted.GetCanSubscribe() ||
		len(unmuted.GetCanPublishSources()) != 2 {
		t.Fatalf("unmute changed more than the microphone: %+v", unmuted)
	}

	// Removing the last source clears the publish bit.
	silent := permissionWithSource(muted, SourceScreenShareAudio, false)
	if silent.GetCanPublish() || len(silent.GetCanPublishSources()) != 0 {
		t.Fatalf("no source left but publishing allowed: %+v", silent)
	}

	// Adding a source twice keeps one entry.
	twice := permissionWithSource(unmuted, SourceMicrophone, true)
	if len(twice.GetCanPublishSources()) != 2 {
		t.Fatalf("duplicate source: %v", twice.GetCanPublishSources())
	}

	// A token without the publish bit grants nothing; enabling the microphone
	// does not resurrect a leftover source list.
	revoked := &livekit.ParticipantPermission{
		CanPublish:        false,
		CanPublishSources: []livekit.TrackSource{livekit.TrackSource_SCREEN_SHARE_AUDIO},
	}
	speak := permissionWithSource(revoked, SourceMicrophone, true)
	if got := speak.GetCanPublishSources(); !speak.GetCanPublish() || len(got) != 1 ||
		got[0] != livekit.TrackSource_MICROPHONE {
		t.Fatalf("speak grant = %+v", speak)
	}

	// "Publish anything" (no list) narrows to everything but the removed source.
	anything := &livekit.ParticipantPermission{CanPublish: true}
	narrowed := permissionWithSource(anything, SourceScreenShareAudio, false)
	if got := narrowed.GetCanPublishSources(); len(got) != 2 ||
		got[0] != livekit.TrackSource_MICROPHONE || got[1] != livekit.TrackSource_SCREEN_SHARE {
		t.Fatalf("narrowed sources = %v", got)
	}

	// A participant without a permission object still gets a usable default.
	fallback := permissionWithSource(nil, SourceMicrophone, true)
	if !fallback.GetCanPublish() || !fallback.GetCanSubscribe() || !fallback.GetCanPublishData() {
		t.Fatalf("fallback permission = %+v", fallback)
	}
}

func TestLoopbackDetection(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "127.1.2.3", "::1"} {
		if !isLoopbackIP(address) {
			t.Fatalf("%s is not detected as loopback", address)
		}
	}
	for _, address := range []string{"", "192.168.1.10", "10.0.0.1", "not-an-ip"} {
		if isLoopbackIP(address) {
			t.Fatalf("%s is detected as loopback", address)
		}
	}
}

func TestTrackSourceNames(t *testing.T) {
	cases := map[Source]livekit.TrackSource{
		SourceMicrophone:       livekit.TrackSource_MICROPHONE,
		SourceScreenShare:      livekit.TrackSource_SCREEN_SHARE,
		SourceScreenShareAudio: livekit.TrackSource_SCREEN_SHARE_AUDIO,
	}
	for source, livekitSource := range cases {
		if got := trackSourceName(livekitSource); got != string(source) {
			t.Fatalf("trackSourceName(%s) = %q, want %q", livekitSource, got, source)
		}
	}

	// A token with no publish sources gets no source restriction at all.
	if sources := trackSources(nil); sources != nil {
		t.Fatalf("trackSources(nil) = %v", sources)
	}
	if sources := trackSources([]Source{SourceMicrophone}); len(sources) != 1 {
		t.Fatalf("trackSources = %v", sources)
	}
}

func TestNewLiveKitRejectsBadConfig(t *testing.T) {
	if _, err := NewLiveKit(LiveKitConfig{NodeIP: "127.0.0.1"}); err == nil {
		t.Fatal("NewLiveKit accepted a configuration without keys")
	}
	if _, err := NewLiveKit(LiveKitConfig{NodeIP: "nope", APIKey: "k", APISecret: "s"}); err == nil {
		t.Fatal("NewLiveKit accepted a non-IP node address")
	}
}

func TestReconcileIntervalDefaults(t *testing.T) {
	if DefaultPresenceGrace <= 10*time.Second {
		t.Fatalf("the presence grace (%v) must outlast the control-plane disconnect grace (10 s)", DefaultPresenceGrace)
	}
}
