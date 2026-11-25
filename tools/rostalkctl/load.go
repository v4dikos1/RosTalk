package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/tools/rostalkctl/bot"
	"github.com/v4dikos1/RosTalk/tools/rostalkctl/client"
	"github.com/v4dikos1/RosTalk/tools/rostalkctl/internal/version"
)

// loadSettings are the flags of `rostalkctl load`.
type loadSettings struct {
	users        int
	channels     int
	talking      int
	duration     time.Duration
	ramp         time.Duration
	nickPrefix   string
	password     string
	caPath       string
	roots        *x509.CertPool
	timeout      time.Duration
	frequency    float64
	logLevel     string
	json         bool
	strict       bool
	channelNames []string
}

// userResult is what one simulated user contributed to the report.
type userResult struct {
	nickname      string
	channelID     uint64
	channelName   string
	connectDelay  time.Duration
	joinDelay     time.Duration
	mediaDelay    time.Duration
	connected     bool
	joined        bool
	mediaUp       bool
	disconnectErr string
	error         string
}

// loadSummary is the machine-readable report printed at the end.
type loadSummary struct {
	Users        int           `json:"users"`
	Channels     int           `json:"channels"`
	Talking      int           `json:"talking"`
	Duration     string        `json:"duration"`
	Connected    int           `json:"connected"`
	Joined       int           `json:"joined"`
	MediaUp      int           `json:"media_up"`
	Failed       int           `json:"failed"`
	Disconnects  int           `json:"disconnects"`
	SentFrames   int64         `json:"sent_frames"`
	RecvPackets  int64         `json:"recv_packets"`
	RecvBytes    int64         `json:"recv_bytes"`
	ConnectP50   time.Duration `json:"-"`
	ConnectP95   time.Duration `json:"-"`
	JoinP50      time.Duration `json:"-"`
	JoinP95      time.Duration `json:"-"`
	MediaP50     time.Duration `json:"-"`
	MediaP95     time.Duration `json:"-"`
	ConnectP50MS float64       `json:"connect_p50_ms"`
	ConnectP95MS float64       `json:"connect_p95_ms"`
	JoinP50MS    float64       `json:"join_p50_ms"`
	JoinP95MS    float64       `json:"join_p95_ms"`
	MediaP50MS   float64       `json:"media_p50_ms"`
	MediaP95MS   float64       `json:"media_p95_ms"`
	Errors       []string      `json:"errors,omitempty"`
}

// runLoad starts N control-plane users, distributes them over M existing voice
// channels and lets K of them publish audio. The others subscribe, which is
// what makes the test interesting for the SFU: N users in one channel mean
// N*(N-1) media streams.
func runLoad(args []string, stdout, stderr io.Writer) error {
	settings, linkArg, err := parseLoadFlags(args, stderr)
	if err != nil {
		return err
	}
	link, err := client.ParseLink(linkArg)
	if err != nil {
		return err
	}
	if settings.users < 1 {
		return errors.New("--users must be at least 1")
	}
	if settings.channels < 1 {
		return errors.New("--channels must be at least 1")
	}
	if settings.talking < 0 || settings.talking > settings.users {
		return fmt.Errorf("--talking must be between 0 and --users (%d)", settings.users)
	}
	if settings.duration <= 0 {
		return errors.New("--duration must be positive")
	}
	if settings.timeout <= 0 {
		settings.timeout = 15 * time.Second
	}
	if settings.nickPrefix == "" {
		settings.nickPrefix = "load"
	}

	ctx, stop := signalContext()
	defer stop()

	// The first connection also tells us which channels exist and gives the
	// runner a chance to fail before spawning anything.
	setupID, err := generateIdentity()
	if err != nil {
		return err
	}
	setupCtx, cancelSetup := context.WithTimeout(ctx, settings.timeout)
	setup, err := client.Connect(setupCtx, link, setupID, client.Options{
		Nickname:      settings.nickPrefix + "-probe",
		Password:      settings.password,
		ClientVersion: version.String(),
		Timeout:       settings.timeout,
		RootCAs:       settings.roots,
	})
	cancelSetup()
	if err != nil {
		return fmt.Errorf("connect the probe user: %w", err)
	}
	channels, err := pickLoadChannels(setup.Welcome, settings)
	if err != nil {
		_ = setup.Close()
		return err
	}
	_ = setup.Close()

	runCtx, cancelRun := context.WithTimeout(ctx, settings.duration)
	defer cancelRun()

	start := time.Now()
	results := make([]userResult, settings.users)
	var (
		wg       sync.WaitGroup
		sessions []*loadUser
		mu       sync.Mutex
		sent     atomic.Int64
		received atomic.Int64
		recvByte atomic.Int64
	)
	for i := 0; i < settings.users; i++ {
		if settings.ramp > 0 && i > 0 {
			select {
			case <-runCtx.Done():
				// Stop the ramp, not just this timer: a cancelled run must not
				// keep spawning users that are bound to fail.
				for j := i; j < settings.users; j++ {
					if results[j].error == "" {
						results[j].error = "the run was cancelled before this user started"
					}
				}
				i = settings.users
				continue
			case <-time.After(settings.ramp):
			}
		}
		user, userErr := startLoadUser(runCtx, i, settings, link, channels, &wg)
		if userErr != nil {
			results[i].error = userErr.Error()
			continue
		}
		mu.Lock()
		sessions = append(sessions, user)
		mu.Unlock()
	}

	// Print progress once a second so a long run is visibly alive and an
	// operator can stop it early.
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				var s, r int64
				mu.Lock()
				for _, user := range sessions {
					if user.media != nil {
						stats := user.media.Stats()
						s += stats.SentPackets
						for _, packets := range stats.Received {
							r += packets
						}
					}
				}
				mu.Unlock()
				_, _ = fmt.Fprintf(stdout, "load: %s, sent=%d, received=%d\n",
					time.Since(start).Round(time.Second), s, r)
			}
		}
	}()

	<-runCtx.Done()
	// Stop the media publishers before collecting the final counters.
	mu.Lock()
	for _, user := range sessions {
		if user.cancel != nil {
			user.cancel()
		}
	}
	mu.Unlock()
	wg.Wait()
	<-done

	for _, user := range sessions {
		result := &results[user.index]
		result.nickname = user.nickname
		result.channelID = user.channelID
		result.channelName = user.channelName
		result.connectDelay = user.connectDelay
		result.joinDelay = user.joinDelay
		result.mediaDelay = user.mediaDelay
		result.connected = true
		result.joined = user.joined
		result.mediaUp = user.media != nil
		result.disconnectErr = user.disconnectErr()
		if user.media != nil {
			stats := user.media.Stats()
			sent.Add(stats.SentPackets)
			for _, packets := range stats.Received {
				received.Add(packets)
			}
			for _, bytes := range stats.ReceivedBytes {
				recvByte.Add(bytes)
			}
		}
	}

	summary := summarizeLoad(results, sent.Load(), received.Load(), recvByte.Load(), settings)
	printLoadSummary(stdout, summary)
	if settings.json {
		data, marshalErr := json.Marshal(summary)
		if marshalErr != nil {
			return marshalErr
		}
		_, _ = fmt.Fprintln(stdout, string(data))
	}
	if settings.strict && (summary.Failed > 0 || summary.Disconnects > 0) {
		return fmt.Errorf("load: %d users failed and %d connections dropped",
			summary.Failed, summary.Disconnects)
	}
	return nil
}

// loadUser is one joined simulated user.
type loadUser struct {
	index        int
	nickname     string
	channelID    uint64
	channelName  string
	connectDelay time.Duration
	joinDelay    time.Duration
	mediaDelay   time.Duration
	joined       bool
	session      *client.Session
	media        *bot.Session
	cancel       context.CancelFunc
	readErr      atomic.Value // string
}

func (u *loadUser) disconnectErr() string {
	if value := u.readErr.Load(); value != nil {
		if text, ok := value.(string); ok {
			return text
		}
	}
	return ""
}

// startLoadUser connects one user and joins the assigned channel. The caller
// owns the WaitGroup that tracks the control read loop.
func startLoadUser(
	ctx context.Context,
	index int,
	settings loadSettings,
	link client.Link,
	channels []loadChannel,
	wg *sync.WaitGroup,
) (*loadUser, error) {
	identity, err := generateIdentity()
	if err != nil {
		return nil, err
	}
	nickname := fmt.Sprintf("%s-%03d", settings.nickPrefix, index+1)
	target := channels[index%len(channels)]
	user := &loadUser{
		index:       index,
		nickname:    nickname,
		channelID:   target.id,
		channelName: target.name,
	}

	connectCtx, cancelConnect := context.WithTimeout(ctx, settings.timeout)
	started := time.Now()
	session, err := client.Connect(connectCtx, link, identity, client.Options{
		Nickname:      nickname,
		Password:      settings.password,
		ClientVersion: version.String(),
		Timeout:       settings.timeout,
		RootCAs:       settings.roots,
	})
	cancelConnect()
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	user.connectDelay = time.Since(started)
	user.session = session

	const joinRequestID uint64 = 3
	joinStart := time.Now()
	if err := session.Send(ctx, &rostalkv1.ClientFrame{
		RequestId: joinRequestID,
		Payload: &rostalkv1.ClientFrame_JoinChannel{JoinChannel: &rostalkv1.JoinChannel{
			ChannelId: target.id,
		}},
	}); err != nil {
		_ = session.Close()
		return nil, fmt.Errorf("join: %w", err)
	}
	credentials, err := awaitLoadCredentials(ctx, session, joinRequestID)
	if err != nil {
		_ = session.Close()
		return nil, fmt.Errorf("join: %w", err)
	}
	user.joinDelay = time.Since(joinStart)
	user.joined = true

	publish := index < settings.talking
	botCtx, cancelBot := context.WithCancel(ctx)
	mediaStart := time.Now()
	media, err := bot.Join(botCtx, bot.Config{
		URL:         credentials.GetUrl(),
		Token:       credentials.GetToken(),
		Identity:    credentials.GetParticipantIdentity(),
		Fingerprint: session.Link.Fingerprint,
		Frequency:   settings.frequency,
		ListenOnly:  !publish,
		LogLevel:    settings.logLevel,
		Output:      io.Discard,
	})
	if err != nil {
		cancelBot()
		_ = session.Close()
		return nil, fmt.Errorf("media: %w", err)
	}
	user.mediaDelay = time.Since(mediaStart)
	user.media = media
	user.cancel = func() {
		cancelBot()
		media.Close()
	}

	// Drain control events: the hub disconnects a client whose queue overflows,
	// and a read error is how the load test notices a dropped session.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			if _, nextErr := session.Next(ctx); nextErr != nil {
				if ctx.Err() == nil {
					user.readErr.Store(nextErr.Error())
				}
				_ = session.Close()
				return
			}
		}
	}()
	return user, nil
}

// awaitLoadCredentials reads frames until the join reply arrives.
func awaitLoadCredentials(
	ctx context.Context,
	session *client.Session,
	requestID uint64,
) (*rostalkv1.MediaCredentials, error) {
	for {
		frame, err := session.Next(ctx)
		if err != nil {
			return nil, err
		}
		if frame.GetReplyTo() != requestID {
			continue
		}
		if serverErr := frame.GetError(); serverErr != nil {
			return nil, fmt.Errorf("%s: %s", serverErr.GetCode(), serverErr.GetMessage())
		}
		credentials := frame.GetMediaCredentials()
		if credentials == nil {
			return nil, fmt.Errorf("the join reply carries no media credentials")
		}
		return credentials, nil
	}
}

type loadChannel struct {
	id   uint64
	name string
}

// pickLoadChannels selects the M voice channels named by the flags, or the
// first M ordinary voice channels of the snapshot. The AFK channel is skipped
// unless named explicitly: it mutes its occupants by design (ADR 0009).
func pickLoadChannels(welcome *rostalkv1.Welcome, settings loadSettings) ([]loadChannel, error) {
	snapshot := welcome.GetSnapshot()
	if snapshot == nil {
		return nil, errors.New("the server sent no snapshot")
	}
	byName := make(map[string]loadChannel, len(snapshot.GetChannels()))
	var voiceChannels []loadChannel
	for _, channel := range snapshot.GetChannels() {
		if channel.GetKind() != rostalkv1.ChannelKind_CHANNEL_KIND_VOICE {
			continue
		}
		entry := loadChannel{id: channel.GetId(), name: channel.GetName()}
		byName[entry.name] = entry
		if channel.GetAfk() {
			continue
		}
		voiceChannels = append(voiceChannels, entry)
	}
	if len(settings.channelNames) > 0 {
		if len(settings.channelNames) < settings.channels {
			return nil, fmt.Errorf("--channels=%d needs at least that many --channel names, got %d",
				settings.channels, len(settings.channelNames))
		}
		selected := make([]loadChannel, 0, settings.channels)
		for _, name := range settings.channelNames[:settings.channels] {
			channel, ok := byName[name]
			if !ok {
				return nil, fmt.Errorf("voice channel %q does not exist", name)
			}
			selected = append(selected, channel)
		}
		return selected, nil
	}
	if len(voiceChannels) < settings.channels {
		return nil, fmt.Errorf("the server has %d ordinary voice channels, --channels wants %d; "+
			"create them or name existing ones with --channel", len(voiceChannels), settings.channels)
	}
	return voiceChannels[:settings.channels], nil
}

// generateIdentity makes a throwaway Ed25519 identity for one simulated user.
// It is deliberately not written to disk: a load run must not leave keys
// behind in the operator's home directory.
func generateIdentity() (*client.Identity, error) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate identity: %w", err)
	}
	return &client.Identity{Private: private, Public: public}, nil
}

// summarizeLoad turns the per-user results into the report, including the
// latency percentiles and the list of errors for the operator.
func summarizeLoad(
	results []userResult,
	sent, received, recvBytes int64,
	settings loadSettings,
) loadSummary {
	summary := loadSummary{
		Users:       settings.users,
		Channels:    settings.channels,
		Talking:     settings.talking,
		Duration:    settings.duration.String(),
		SentFrames:  sent,
		RecvPackets: received,
		RecvBytes:   recvBytes,
	}
	var connect, join, media []time.Duration
	for _, result := range results {
		if result.error != "" {
			summary.Failed++
			summary.Errors = append(summary.Errors, fmt.Sprintf("%s: %s", result.nickname, result.error))
			continue
		}
		if result.connected {
			summary.Connected++
			connect = append(connect, result.connectDelay)
		}
		if result.joined {
			summary.Joined++
			join = append(join, result.joinDelay)
		}
		if result.mediaUp {
			summary.MediaUp++
			media = append(media, result.mediaDelay)
		}
		if result.disconnectErr != "" {
			summary.Disconnects++
			summary.Errors = append(summary.Errors, fmt.Sprintf("%s: %s", result.nickname, result.disconnectErr))
		}
	}
	summary.ConnectP50, summary.ConnectP95 = percentiles(connect)
	summary.JoinP50, summary.JoinP95 = percentiles(join)
	summary.MediaP50, summary.MediaP95 = percentiles(media)
	summary.ConnectP50MS = durationMS(summary.ConnectP50)
	summary.ConnectP95MS = durationMS(summary.ConnectP95)
	summary.JoinP50MS = durationMS(summary.JoinP50)
	summary.JoinP95MS = durationMS(summary.JoinP95)
	summary.MediaP50MS = durationMS(summary.MediaP50)
	summary.MediaP95MS = durationMS(summary.MediaP95)
	return summary
}

// percentiles returns the median and the 95th percentile. Empty input gives
// zeros so the report stays a table with no holes.
func percentiles(values []time.Duration) (time.Duration, time.Duration) {
	if len(values) == 0 {
		return 0, 0
	}
	sorted := append([]time.Duration(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	median := sorted[len(sorted)/2]
	index := (len(sorted)*95 + 99) / 100
	if index <= 0 {
		index = 1
	}
	if index > len(sorted) {
		index = len(sorted)
	}
	return median, sorted[index-1]
}

func durationMS(value time.Duration) float64 {
	return float64(value.Microseconds()) / 1000
}

// printLoadSummary prints the operator-facing table.
func printLoadSummary(w io.Writer, summary loadSummary) {
	_, _ = fmt.Fprintf(w, "\nload summary: users=%d channels=%d talking=%d duration=%s\n",
		summary.Users, summary.Channels, summary.Talking, summary.Duration)
	_, _ = fmt.Fprintf(w, "  connected=%d joined=%d media=%d failed=%d dropped=%d\n",
		summary.Connected, summary.Joined, summary.MediaUp, summary.Failed, summary.Disconnects)
	_, _ = fmt.Fprintf(w, "  latency median/p95: connect %.0f/%.0f ms, join %.0f/%.0f ms, media %.0f/%.0f ms\n",
		summary.ConnectP50MS, summary.ConnectP95MS,
		summary.JoinP50MS, summary.JoinP95MS,
		summary.MediaP50MS, summary.MediaP95MS)
	_, _ = fmt.Fprintf(w, "  audio: sent=%d frames, received=%d packets (%d KiB)\n",
		summary.SentFrames, summary.RecvPackets, summary.RecvBytes/1024)
	for _, text := range summary.Errors {
		_, _ = fmt.Fprintf(w, "  error: %s\n", text)
	}
}

// parseLoadFlags accepts `rostalkctl load <link> [flags]` and the flag-first
// form. The link is the only positional argument.
func parseLoadFlags(args []string, stderr io.Writer) (loadSettings, string, error) {
	settings := loadSettings{
		users:      10,
		channels:   1,
		talking:    -1,
		duration:   time.Minute,
		ramp:       100 * time.Millisecond,
		nickPrefix: "load",
		timeout:    15 * time.Second,
		logLevel:   "error",
	}
	flagArgs, positional := splitArguments(args)
	fs := flag.NewFlagSet("load", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.IntVar(&settings.users, "users", settings.users, "number of users")
	fs.IntVar(&settings.channels, "channels", settings.channels, "number of voice channels to spread users over")
	fs.IntVar(&settings.talking, "talking", settings.talking, "users that publish audio (default: all)")
	fs.DurationVar(&settings.duration, "duration", settings.duration, "how long to run")
	fs.DurationVar(&settings.ramp, "ramp", settings.ramp, "delay between user starts")
	fs.StringVar(&settings.nickPrefix, "nick-prefix", settings.nickPrefix, "nickname prefix; a number is appended")
	fs.StringVar(&settings.password, "password", os.Getenv("ROSTALK_PASSWORD"), "server password for password-mode servers")
	fs.StringVar(&settings.caPath, "ca", "", "optional CA certificate file")
	fs.DurationVar(&settings.timeout, "timeout", settings.timeout, "per-connection timeout")
	fs.Float64Var(&settings.frequency, "freq", bot.DefaultFrequency, "tone frequency of the talking users")
	fs.StringVar(&settings.logLevel, "loglevel", settings.logLevel, "SDK log level: error, warn, info, debug")
	fs.BoolVar(&settings.json, "json", false, "print the summary as one JSON line")
	fs.BoolVar(&settings.strict, "strict", false, "exit non-zero when a user failed or dropped")
	channelList := fs.String("channel", "", "comma-separated voice channel names, in load order")
	if err := fs.Parse(flagArgs); err != nil {
		return settings, "", err
	}
	if *channelList != "" {
		for _, name := range strings.Split(*channelList, ",") {
			if trimmed := strings.TrimSpace(name); trimmed != "" {
				settings.channelNames = append(settings.channelNames, trimmed)
			}
		}
	}
	if len(positional) != 1 {
		return settings, "", errors.New("usage: rostalkctl load <link> [--users N] [--channels M] [--talking K] [--duration D]")
	}
	if settings.talking < 0 {
		settings.talking = settings.users
	}
	if settings.caPath != "" {
		pemData, readErr := os.ReadFile(settings.caPath)
		if readErr != nil {
			return settings, "", fmt.Errorf("read CA file %q: %w", settings.caPath, readErr)
		}
		pool, poolErr := client.LoadRootCAs(pemData)
		if poolErr != nil {
			return settings, "", fmt.Errorf("parse CA file %q: %w", settings.caPath, poolErr)
		}
		settings.roots = pool
	}
	return settings, positional[0], nil
}
