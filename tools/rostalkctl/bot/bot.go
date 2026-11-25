// Package bot is a headless media participant: it joins a channel through the
// control plane and publishes synthetic audio as G.711 mu-law.
//
// It exists for tests and manual checks (stage 1.4 acceptance: two bots in one
// channel hear each other). PCMU is chosen because server-sdk-go encodes Opus
// through pkg/media, which needs CGO; CONTRIBUTING.md keeps the server and the tools
// CGO-free, and the probe of stage 0.1 proved that an uncompressed mu-law track
// is all a headless participant needs (ADR 0001).
package bot

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/livekit/protocol/livekit"
	protoLogger "github.com/livekit/protocol/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// SampleRate is the PCMU clock rate.
const SampleRate = 8000

// FrameDuration is one audio frame; 20 ms at 8 kHz is 160 mu-law bytes.
const FrameDuration = 20 * time.Millisecond

// FrameBytes is the payload size of one frame.
const FrameBytes = 160

// Config describes one bot.
type Config struct {
	// URL is the media gateway address from MediaCredentials ("wss://...").
	URL string
	// Token is the media token from MediaCredentials. Never logged.
	Token string
	// Identity is the participant identity the token was issued for.
	Identity string
	// Fingerprint pins the SHA-256 of the gateway leaf certificate (hex).
	Fingerprint string
	// Frequency is the tone frequency in Hz; ignored when File is set.
	Frequency float64
	// File is a WAV file to play instead of a tone.
	File string
	// Loop restarts the file when it ends; without it the bot sends silence
	// after the last frame.
	Loop bool
	// ListenOnly joins the room and subscribes to the published tracks without
	// publishing its own. Load tests use it for the non-speaking users.
	ListenOnly bool
	// Output receives human-readable progress. Defaults to io.Discard.
	Output io.Writer
	// LogLevel sets the SDK log level; "error" by default.
	LogLevel string
}

// Stats is a snapshot of the packet counters.
type Stats struct {
	// SentPackets counts audio frames published.
	SentPackets int64
	// Received maps a remote participant identity to received RTP packets.
	Received map[string]int64
	// ReceivedBytes maps a remote participant identity to received payload bytes.
	ReceivedBytes map[string]int64
	// Participants is the number of remote participants currently in the room.
	Participants int
}

// Session is a joined bot.
type Session struct {
	out    io.Writer
	room   *lksdk.Room
	track  *webrtc.TrackLocalStaticSample
	source frameSource

	sent atomic.Int64

	mu       sync.Mutex
	received map[string]*counters
	remote   map[string]struct{}
}

type counters struct {
	packets atomic.Int64
	bytes   atomic.Int64
}

// Join connects to the room with the token and starts publishing audio. The
// returned session stops publishing when ctx is cancelled; call Close to leave.
func Join(ctx context.Context, cfg Config) (*Session, error) {
	if cfg.URL == "" || cfg.Token == "" || cfg.Identity == "" {
		return nil, errors.New("bot: url, token and identity are required")
	}
	out := cfg.Output
	if out == nil {
		out = io.Discard
	}
	logLevel := cfg.LogLevel
	if logLevel == "" {
		logLevel = "error"
	}
	if err := configureTLS(cfg.Fingerprint); err != nil {
		return nil, err
	}
	configureLogger(logLevel)

	source, err := newSource(cfg.File, cfg.Frequency, cfg.Loop)
	if err != nil {
		return nil, err
	}

	session := &Session{
		out:      out,
		source:   source,
		received: make(map[string]*counters),
		remote:   make(map[string]struct{}),
	}
	callback := &lksdk.RoomCallback{
		ParticipantCallback: lksdk.ParticipantCallback{
			OnTrackSubscribed: session.onTrackSubscribed,
		},
		OnParticipantConnected: func(participant *lksdk.RemoteParticipant) {
			session.mu.Lock()
			session.remote[participant.Identity()] = struct{}{}
			session.mu.Unlock()
		},
		OnParticipantDisconnected: func(participant *lksdk.RemoteParticipant) {
			session.mu.Lock()
			delete(session.remote, participant.Identity())
			session.mu.Unlock()
		},
	}

	room, err := lksdk.ConnectToRoomWithToken(signallingURL(cfg.URL), cfg.Token, callback, lksdk.WithAutoSubscribe(true))
	if err != nil {
		return nil, fmt.Errorf("bot: connect to %s: %w", cfg.URL, err)
	}
	session.room = room

	if !cfg.ListenOnly {
		track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypePCMU,
			ClockRate: SampleRate,
			Channels:  1,
		}, "audio", "rostalk-bot")
		if err != nil {
			room.Disconnect()
			return nil, fmt.Errorf("bot: create the audio track: %w", err)
		}
		session.track = track
		if _, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
			Name:   "audio",
			Source: livekit.TrackSource_MICROPHONE,
		}); err != nil {
			room.Disconnect()
			return nil, fmt.Errorf("bot: publish the audio track: %w", err)
		}
		go session.pump(ctx)
	}
	_, _ = fmt.Fprintf(out, "%s: joined %s\n", cfg.Identity, room.Name())
	return session, nil
}

// Stats returns the current counters.
func (s *Session) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	stats := Stats{
		SentPackets:   s.sent.Load(),
		Received:      make(map[string]int64, len(s.received)),
		ReceivedBytes: make(map[string]int64, len(s.received)),
		Participants:  len(s.remote),
	}
	for identity, counter := range s.received {
		stats.Received[identity] = counter.packets.Load()
		stats.ReceivedBytes[identity] = counter.bytes.Load()
	}
	return stats
}

// RoomName returns the room the bot joined.
func (s *Session) RoomName() string {
	if s.room == nil {
		return ""
	}
	return s.room.Name()
}

// Close leaves the room.
func (s *Session) Close() {
	if s.room != nil {
		s.room.Disconnect()
	}
}

// pump publishes one frame every 20 ms until the context is cancelled.
func (s *Session) pump(ctx context.Context) {
	ticker := time.NewTicker(FrameDuration)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			frame := s.source.next()
			if frame == nil {
				// The file ended: silence keeps the room alive so the bot can
				// still receive audio from the others.
				frame = silentFrame()
			}
			if err := s.track.WriteSample(media.Sample{Data: frame, Duration: FrameDuration}); err != nil {
				return
			}
			s.sent.Add(1)
		}
	}
}

func (s *Session) onTrackSubscribed(track *webrtc.TrackRemote, _ *lksdk.RemoteTrackPublication, participant *lksdk.RemoteParticipant) {
	if track.Kind() != webrtc.RTPCodecTypeAudio {
		return
	}
	identity := participant.Identity()
	s.mu.Lock()
	counter := s.received[identity]
	if counter == nil {
		counter = &counters{}
		s.received[identity] = counter
	}
	s.remote[identity] = struct{}{}
	s.mu.Unlock()

	go func() {
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			counter.packets.Add(1)
			counter.bytes.Add(int64(len(packet.Payload)))
		}
	}()
}

// configureLogger initialises the LiveKit logger once per process. The SDK is
// chatty at its default level and a bot has nothing useful to say.
func configureLogger(level string) {
	loggerOnce.Do(func() {
		protoLogger.InitFromConfig(&protoLogger.Config{Level: level}, "rostalkctl-bot")
		lksdk.SetLogger(protoLogger.GetLogger())
	})
}

var loggerOnce sync.Once

// signallingURL turns the media credentials URL into the base URL the LiveKit
// SDK expects. The control plane sends the full gateway endpoint with the /rtc
// path (design 4.6), while the SDKs append the signalling path themselves and
// would produce /rtc/rtc.
func signallingURL(url string) string {
	trimmed := strings.TrimSuffix(url, "/")
	return strings.TrimSuffix(trimmed, "/rtc")
}

// configureTLS pins the gateway certificate. server-sdk-go dials with the
// gorilla websocket default dialer, so pinning happens there.
func configureTLS(fingerprint string) error {
	if fingerprint == "" {
		return errors.New("bot: the certificate fingerprint is required")
	}
	expected := normalizeFingerprint(fingerprint)
	if _, err := hex.DecodeString(expected); err != nil {
		return fmt.Errorf("bot: invalid certificate fingerprint %q: %w", fingerprint, err)
	}
	websocket.DefaultDialer.TLSClientConfig = &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true, // verification is the pinned fingerprint below
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 {
				return errors.New("bot: the server presented no certificate")
			}
			sum := sha256.Sum256(raw[0])
			if got := hex.EncodeToString(sum[:]); got != expected {
				return fmt.Errorf("bot: certificate fingerprint mismatch: got %s want %s", got, expected)
			}
			return nil
		},
	}
	return nil
}

func normalizeFingerprint(value string) string {
	out := make([]byte, 0, len(value))
	for _, r := range value {
		switch r {
		case ':', ' ':
			continue
		default:
			out = append(out, byte(r))
		}
	}
	// The link carries a lowercase hex digest; hex.DecodeString rejects upper
	// case, so lower it here.
	for i, b := range out {
		if b >= 'A' && b <= 'Z' {
			out[i] = b + ('a' - 'A')
		}
	}
	return string(out)
}
