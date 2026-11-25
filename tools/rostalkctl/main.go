// Command rostalkctl is the RosTalk command-line client: a development and
// testing tool for the server, and later the base for test bots.
//
// It is a separate Go module from server/ on purpose: livekit-server and
// server-sdk-go pin incompatible versions of the LiveKit Pion forks, so the two
// cannot live in one go.mod (ADR 0001). The command layer stays free of
// server-sdk-go so it can be imported by tests; the stage 1.4 bot goes into a
// nested module.
package main

import (
	"context"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/tools/rostalkctl/bot"
	"github.com/v4dikos1/RosTalk/tools/rostalkctl/client"
	"github.com/v4dikos1/RosTalk/tools/rostalkctl/internal/version"
)

const usage = `rostalkctl — RosTalk command-line client

Usage:
  rostalkctl <command> [flags]

Commands:
  identity new   Create an Ed25519 identity (the user's key)
  connect        Connect with an invite link and print the snapshot and events
  channels       Print the channel tree of a server
  join           Join a channel and keep printing events
  bot            Join a channel and publish audio (tone or WAV file)
  load           Simulate N users in M channels for a measurement run  watch          Print the snapshot and then every event, without joining
  version        Print the build identity
  help           Print this text

Connection flags (connect, channels, join, bot, watch):
  --identity PATH   identity key file
  --nick NAME       display name (required for a new key)
  --password VALUE  server password for password-mode servers
  --ca PATH         verify the full TLS chain in addition to the fingerprint
  --timeout DURATION

Join flags:
  --channel-password VALUE   password of a protected channel (or ROSTALK_CHANNEL_PASSWORD)

Bot flags:
  --channel NAME    channel to join (required)
  --tone            publish a sine tone (default)
  --freq HZ         tone frequency, 440 by default
  --play FILE       publish a PCM WAV file instead of the tone
  --loop            restart the file when it ends (with --play)
  --duration D      leave after D (0 means until Ctrl+C)
  --loglevel LEVEL  SDK log level: error (default), warn, info, debug

Bots publish G.711 mu-law: server-sdk-go encodes Opus through pkg/media, which
needs CGO, and both modules are built with CGO_ENABLED=0 (ADR 0001).

Load flags:
  --users N         control-plane users (default 10)
  --channels M      spread them over M existing voice channels
  --talking K       users that publish audio (default: all)
  --duration D      run length, 60s by default
  --channel NAMES   comma-separated voice channel names, in load order
  The server limits logins per IP (auth_attempts_limit, 10 per minute by
  default). Raise it in the settings table for a run with more users from one
  address, or spread the run over time with --ramp.

Examples:
  rostalkctl identity new
  rostalkctl channels "rostalk://join?host=192.168.1.10:7443&fp=...&invite=..." --nick alice
  rostalkctl join "rostalk://join?..." --nick alice "Лобби"
  rostalkctl bot "rostalk://join?..." --channel "Лобби" --tone
  rostalkctl watch "rostalk://join?..." --nick bob
`

func main() {
	if err := execute(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "rostalkctl: %v\n", err)
		os.Exit(1)
	}
}

// execute runs one CLI invocation; tests drive it directly.
func execute(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		_, _ = fmt.Fprint(stderr, usage)
		return errors.New("a subcommand is required (identity, connect, channels, join, watch, version, help)")
	}

	switch args[0] {
	case "version":
		if len(args) > 1 {
			return fmt.Errorf("version takes no arguments, got %q", args[1])
		}
		_, _ = fmt.Fprintf(stdout, "rostalkctl %s\n", version.String())
		return nil
	case "identity":
		return runIdentity(args[1:], stdout, stderr)
	case "connect":
		return runConnect(args[1:], stdout, stderr)
	case "channels":
		return runChannels(args[1:], stdout, stderr)
	case "join":
		return runJoin(args[1:], stdout, stderr)
	case "bot":
		return runBot(args[1:], stdout, stderr)
	case "load":
		return runLoad(args[1:], stdout, stderr)
	case "watch":
		return runWatch(args[1:], stdout, stderr)
	case "help", "-h", "--help":
		_, _ = fmt.Fprint(stdout, usage)
		return nil
	case "-version", "--version":
		return fmt.Errorf("use the %q subcommand instead of %q", "version", args[0])
	default:
		return fmt.Errorf("unknown subcommand %q", args[0])
	}
}

func runIdentity(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || args[0] != "new" {
		return errors.New("usage: rostalkctl identity new [--out PATH] [--force]")
	}
	fs := flag.NewFlagSet("identity new", flag.ContinueOnError)
	fs.SetOutput(stderr)
	out := fs.String("out", defaultIdentityPath(), "where to write the private key")
	force := fs.Bool("force", false, "overwrite an existing identity")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	id, err := client.NewIdentity(*out, *force)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "created identity %s\n", id.Path)
	_, _ = fmt.Fprintf(stdout, "public key %s\n", hex.EncodeToString(id.Public))
	_, _ = fmt.Fprintf(stdout, "fingerprint %s\n", id.Fingerprint())
	return nil
}

// connection holds the flags shared by every command that opens a session.
type connection struct {
	linkArg  string
	position []string
	identity string
	nick     string
	password string
	caPath   string
	timeout  time.Duration
}

// parseConnection accepts both "command <link> [args] --flag" and
// "command --flag <link> [args]". The flag package stops at the first
// positional argument, so flags and positionals are separated first: our
// commands document the link and the channel before the flags.
func parseConnection(command string, args []string, stderr io.Writer, usage string) (*connection, error) {
	conn := &connection{}
	flagArgs, positional := splitArguments(args)

	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&conn.identity, "identity", defaultIdentityPath(), "identity key file")
	fs.StringVar(&conn.nick, "nick", "", "display name (required for a new key)")
	fs.StringVar(&conn.password, "password", os.Getenv("ROSTALK_PASSWORD"), "server password for password-mode servers")
	fs.StringVar(&conn.caPath, "ca", "", "optional CA certificate file; verifies the full TLS chain in addition to the fingerprint")
	fs.DurationVar(&conn.timeout, "timeout", 15*time.Second, "connection timeout")
	if err := fs.Parse(flagArgs); err != nil {
		return nil, err
	}
	conn.position = positional
	if conn.linkArg == "" {
		if len(conn.position) < 1 {
			return nil, errors.New(usage)
		}
		conn.linkArg = conn.position[0]
		conn.position = conn.position[1:]
	}
	return conn, nil
}

// splitArguments separates flags (with their values) from positional
// arguments without depending on their order.
func splitArguments(args []string) (flags, positional []string) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if len(arg) < 2 || !strings.HasPrefix(arg, "-") {
			positional = append(positional, arg)
			continue
		}
		flags = append(flags, arg)
		if strings.Contains(arg, "=") || !flagNeedsValue(arg) {
			continue
		}
		if i+1 < len(args) {
			flags = append(flags, args[i+1])
			i++
		}
	}
	return flags, positional
}

// flagNeedsValue lists the connection flags that take a separate value. Every
// flag of these commands does except the help flags.
func flagNeedsValue(arg string) bool {
	switch strings.TrimLeft(arg, "-") {
	case "help", "h":
		return false
	default:
		return true
	}
}

// open connects with the parsed flags and returns the session and its view.
func (c *connection) open(ctx context.Context) (*client.Session, error) {
	link, err := client.ParseLink(c.linkArg)
	if err != nil {
		return nil, err
	}
	identity, created, err := client.LoadOrCreateIdentity(c.identity)
	if err != nil {
		return nil, err
	}
	if created {
		_, _ = fmt.Fprintf(os.Stderr, "rostalkctl: created a new identity at %s\n", identity.Path)
	}
	opts := client.Options{
		Nickname:      c.nick,
		Password:      c.password,
		ClientVersion: version.String(),
		Timeout:       c.timeout,
	}
	if c.caPath != "" {
		pemData, readErr := os.ReadFile(c.caPath)
		if readErr != nil {
			return nil, fmt.Errorf("read CA file %q: %w", c.caPath, readErr)
		}
		pool, poolErr := client.LoadRootCAs(pemData)
		if poolErr != nil {
			return nil, fmt.Errorf("parse CA file %q: %w", c.caPath, poolErr)
		}
		opts.RootCAs = pool
	}
	connectCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	return client.Connect(connectCtx, link, identity, opts)
}

// signalContext returns a context cancelled by Ctrl+C.
func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

func runConnect(args []string, stdout, stderr io.Writer) error {
	// connect is kept for scripts written against stage 1.2: it prints the
	// snapshot and waits for events unless --once is given.
	once := false
	var filtered []string
	for _, arg := range args {
		if arg == "--once" || arg == "-once" {
			once = true
			continue
		}
		filtered = append(filtered, arg)
	}
	conn, err := parseConnection("connect", filtered, stderr, "usage: rostalkctl connect <link> [--identity PATH] [--nick NAME] [--once]")
	if err != nil {
		return err
	}
	ctx, stop := signalContext()
	defer stop()
	session, err := conn.open(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = session.Close() }()

	view := newView(stdout, session.Welcome)
	printSnapshot(stdout, session, view)
	if once {
		return nil
	}
	return follow(ctx, session, view)
}

func runWatch(args []string, stdout, stderr io.Writer) error {
	conn, err := parseConnection("watch", args, stderr, "usage: rostalkctl watch <link> [--identity PATH] [--nick NAME]")
	if err != nil {
		return err
	}
	ctx, stop := signalContext()
	defer stop()
	session, err := conn.open(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = session.Close() }()

	view := newView(stdout, session.Welcome)
	printSnapshot(stdout, session, view)
	return follow(ctx, session, view)
}

func runChannels(args []string, stdout, stderr io.Writer) error {
	if len(args) > 0 && args[0] == "create" {
		return runChannelCreate(args[1:], stdout, stderr)
	}
	conn, err := parseConnection("channels", args, stderr, "usage: rostalkctl channels <link> [--identity PATH] [--nick NAME]")
	if err != nil {
		return err
	}
	if len(conn.position) > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(conn.position, " "))
	}
	ctx, stop := signalContext()
	defer stop()
	session, err := conn.open(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = session.Close() }()

	view := newView(stdout, session.Welcome)
	printChannelTree(stdout, view)
	return nil
}

// runChannelCreate adds a voice channel through the admin protocol. It is a
// setup helper for load runs and manual checks; the desktop UI has its own
// path. The caller must have manage_channels (an administrator invite does).
func runChannelCreate(args []string, stdout, stderr io.Writer) error {
	conn, err := parseConnection("channels create", args, stderr,
		"usage: rostalkctl channels create <link> <name> [--identity PATH]")
	if err != nil {
		return err
	}
	if len(conn.position) != 1 {
		return errors.New("exactly one channel name is required")
	}
	ctx, stop := signalContext()
	defer stop()
	session, err := conn.open(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = session.Close() }()

	const requestID uint64 = 3
	if err := session.Send(ctx, &rostalkv1.ClientFrame{
		RequestId: requestID,
		Payload: &rostalkv1.ClientFrame_AdminAction{AdminAction: &rostalkv1.AdminAction{
			Action: &rostalkv1.AdminAction_ChannelCreate{ChannelCreate: &rostalkv1.ChannelCreate{
				Name:         conn.position[0],
				Kind:         rostalkv1.ChannelKind_CHANNEL_KIND_VOICE,
				VoiceProfile: rostalkv1.VoiceProfile_VOICE_PROFILE_VOICE,
			}},
		}},
	}); err != nil {
		return err
	}
	for {
		frame, nextErr := session.Next(ctx)
		if nextErr != nil {
			return nextErr
		}
		if frame.GetReplyTo() != requestID {
			continue
		}
		if serverErr := frame.GetError(); serverErr != nil {
			return fmt.Errorf("%s: %s", serverErr.GetCode(), serverErr.GetMessage())
		}
		channel := frame.GetAdminResult().GetChannel()
		if channel == nil {
			return fmt.Errorf("the server did not return the created channel")
		}
		_, _ = fmt.Fprintf(stdout, "created channel %d %q\n", channel.GetId(), channel.GetName())
		return nil
	}
}

func runJoin(args []string, stdout, stderr io.Writer) error {
	// --channel-password is pulled out first: parseConnection owns the
	// connection flags and does not know about channel arguments.
	channelPassword := os.Getenv("ROSTALK_CHANNEL_PASSWORD")
	var filtered []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case strings.HasPrefix(arg, "--channel-password="):
			channelPassword = strings.TrimPrefix(arg, "--channel-password=")
		case arg == "--channel-password" && i+1 < len(args):
			channelPassword = args[i+1]
			i++
		default:
			filtered = append(filtered, arg)
		}
	}

	conn, err := parseConnection("join", filtered, stderr,
		"usage: rostalkctl join <link> <channel> [--channel-password CHANNEL_PASSWORD]")
	if err != nil {
		return err
	}
	if len(conn.position) != 1 {
		return errors.New("exactly one channel (name or id) is required")
	}
	target := conn.position[0]

	ctx, stop := signalContext()
	defer stop()
	session, err := conn.open(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = session.Close() }()

	view := newView(stdout, session.Welcome)
	printSnapshot(stdout, session, view)
	channelID, ok := view.channelID(target)
	if !ok {
		return fmt.Errorf("channel %q does not exist on this server", target)
	}

	const requestID uint64 = 3
	if err := session.Send(ctx, &rostalkv1.ClientFrame{
		RequestId: requestID,
		Payload: &rostalkv1.ClientFrame_JoinChannel{JoinChannel: &rostalkv1.JoinChannel{
			ChannelId: channelID,
			Password:  channelPassword,
		}},
	}); err != nil {
		return err
	}
	for {
		frame, nextErr := session.Next(ctx)
		if nextErr != nil {
			if ctx.Err() != nil {
				return nil
			}
			return nextErr
		}
		view.handle(frame)
		if frame.GetReplyTo() == requestID {
			if serverErr := frame.GetError(); serverErr != nil {
				return fmt.Errorf("%s: %s", serverErr.GetCode(), serverErr.GetMessage())
			}
			break
		}
	}
	return follow(ctx, session, view)
}

// botSettings are the flags specific to the bot command.
type botSettings struct {
	channel   string
	tone      bool
	frequency float64
	play      string
	loop      bool
	duration  time.Duration
	logLevel  string
}

// runBot joins a channel, publishes audio into the media room and prints packet
// counters until it is stopped.
func runBot(args []string, stdout, stderr io.Writer) error {
	settings, filtered, err := parseBotFlags(args)
	if err != nil {
		return err
	}

	conn, err := parseConnection("bot", filtered, stderr,
		"usage: rostalkctl bot <link> --channel NAME [--tone | --play FILE [--loop]] [--duration D]")
	if err != nil {
		return err
	}
	if settings.channel == "" {
		return errors.New("--channel is required")
	}

	ctx, stop := signalContext()
	defer stop()
	session, err := conn.open(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = session.Close() }()

	view := newView(stdout, session.Welcome)
	channelID, ok := view.channelID(settings.channel)
	if !ok {
		return fmt.Errorf("channel %q does not exist on this server", settings.channel)
	}

	const requestID uint64 = 3
	if err := session.Send(ctx, &rostalkv1.ClientFrame{
		RequestId: requestID,
		Payload: &rostalkv1.ClientFrame_JoinChannel{JoinChannel: &rostalkv1.JoinChannel{
			ChannelId: channelID,
		}},
	}); err != nil {
		return err
	}
	credentials, err := awaitCredentials(ctx, session, view, requestID, stdout)
	if err != nil {
		return err
	}

	botCtx := ctx
	cancelBot := func() {}
	if settings.duration > 0 {
		botCtx, cancelBot = context.WithTimeout(ctx, settings.duration)
	}
	defer cancelBot()

	participant, err := bot.Join(botCtx, bot.Config{
		URL:         credentials.GetUrl(),
		Token:       credentials.GetToken(),
		Identity:    credentials.GetParticipantIdentity(),
		Fingerprint: session.Link.Fingerprint,
		File:        settings.play,
		Loop:        settings.loop,
		Frequency:   settings.frequency,
		Output:      stdout,
		LogLevel:    settings.logLevel,
	})
	if err != nil {
		return err
	}
	defer participant.Close()

	// Keep draining the control connection: the hub disconnects a client whose
	// event queue overflows, and the user must stay online while the bot plays.
	go func() {
		for {
			frame, nextErr := session.Next(ctx)
			if nextErr != nil {
				return
			}
			view.handle(frame)
		}
	}()

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-botCtx.Done():
			printBotStats(stdout, participant)
			if ctx.Err() == nil {
				_ = session.Send(context.Background(), &rostalkv1.ClientFrame{
					RequestId: requestID + 1,
					Payload:   &rostalkv1.ClientFrame_LeaveChannel{LeaveChannel: &rostalkv1.LeaveChannel{}},
				})
			}
			return nil
		case <-ticker.C:
			printBotStats(stdout, participant)
		}
	}
}

// awaitCredentials reads frames until the reply to the join request arrives and
// returns the media credentials it carries.
func awaitCredentials(ctx context.Context, session *client.Session, view *view, requestID uint64, stdout io.Writer) (*rostalkv1.MediaCredentials, error) {
	for {
		frame, err := session.Next(ctx)
		if err != nil {
			return nil, err
		}
		view.handle(frame)
		if frame.GetReplyTo() != requestID {
			continue
		}
		if serverErr := frame.GetError(); serverErr != nil {
			return nil, fmt.Errorf("%s: %s", serverErr.GetCode(), serverErr.GetMessage())
		}
		credentials := frame.GetMediaCredentials()
		if credentials == nil {
			return nil, fmt.Errorf("the join reply carries no media credentials (%T)", frame.GetPayload())
		}
		_, _ = fmt.Fprintf(stdout, "media room %s, participant %s, token valid for %d s\n",
			credentials.GetRoom(), credentials.GetParticipantIdentity(), credentials.GetExpiresInSeconds())
		return credentials, nil
	}
}

func printBotStats(w io.Writer, participant *bot.Session) {
	stats := participant.Stats()
	identities := make([]string, 0, len(stats.Received))
	for identity := range stats.Received {
		identities = append(identities, identity)
	}
	sort.Strings(identities)
	parts := make([]string, 0, len(identities))
	for _, identity := range identities {
		parts = append(parts, fmt.Sprintf("%s=%d packets/%d bytes",
			identity, stats.Received[identity], stats.ReceivedBytes[identity]))
	}
	if len(parts) == 0 {
		parts = append(parts, "nobody yet")
	}
	_, _ = fmt.Fprintf(w, "bot: sent=%d frames, remote=%d, received: %s\n",
		stats.SentPackets, stats.Participants, strings.Join(parts, ", "))
}

// parseBotFlags extracts the bot-only flags and leaves the connection flags for
// parseConnection.
func parseBotFlags(args []string) (botSettings, []string, error) {
	settings := botSettings{tone: true, frequency: 0, logLevel: "error"}
	var filtered []string
	toneSet := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		value := ""
		hasInline := false
		if name, inline, found := strings.Cut(arg, "="); found && strings.HasPrefix(name, "--") {
			arg, value, hasInline = name, inline, true
		}
		takeValue := func() (string, error) {
			if hasInline {
				return value, nil
			}
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s needs a value", arg)
			}
			i++
			return args[i], nil
		}
		switch arg {
		case "--channel":
			channel, err := takeValue()
			if err != nil {
				return settings, nil, err
			}
			settings.channel = channel
		case "--play":
			file, err := takeValue()
			if err != nil {
				return settings, nil, err
			}
			settings.play = file
		case "--freq":
			raw, err := takeValue()
			if err != nil {
				return settings, nil, err
			}
			frequency, convErr := strconv.ParseFloat(raw, 64)
			if convErr != nil {
				return settings, nil, fmt.Errorf("--freq %q is not a number", raw)
			}
			settings.frequency = frequency
		case "--duration":
			raw, err := takeValue()
			if err != nil {
				return settings, nil, err
			}
			duration, convErr := time.ParseDuration(raw)
			if convErr != nil {
				return settings, nil, fmt.Errorf("--duration %q is not a duration", raw)
			}
			settings.duration = duration
		case "--tone":
			if hasInline {
				enabled, convErr := strconv.ParseBool(value)
				if convErr != nil {
					return settings, nil, fmt.Errorf("--tone=%q is not a boolean", value)
				}
				settings.tone = enabled
			} else {
				settings.tone = true
			}
			toneSet = true
		case "--loop":
			if hasInline {
				enabled, convErr := strconv.ParseBool(value)
				if convErr != nil {
					return settings, nil, fmt.Errorf("--loop=%q is not a boolean", value)
				}
				settings.loop = enabled
			} else {
				settings.loop = true
			}
		case "--loglevel":
			level, err := takeValue()
			if err != nil {
				return settings, nil, err
			}
			settings.logLevel = level
		default:
			filtered = append(filtered, args[i])
		}
	}
	if settings.play != "" && toneSet {
		return settings, nil, errors.New("--tone and --play are mutually exclusive")
	}
	if settings.play != "" {
		settings.tone = false
	}
	return settings, filtered, nil
}

// follow prints events until the context is cancelled.
func follow(ctx context.Context, session *client.Session, view *view) error {
	_, _ = fmt.Fprintln(view.w, "\nwaiting for events (Ctrl+C to stop)")
	for {
		frame, err := session.Next(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		view.handle(frame)
	}
}

// view is the local copy of the server state kept only for readable output.
type view struct {
	w        io.Writer
	users    map[uint64]*rostalkv1.User
	channels map[uint64]*rostalkv1.Channel
}

func newView(w io.Writer, welcome *rostalkv1.Welcome) *view {
	v := &view{
		w:        w,
		users:    make(map[uint64]*rostalkv1.User),
		channels: make(map[uint64]*rostalkv1.Channel),
	}
	snapshot := welcome.GetSnapshot()
	for _, user := range snapshot.GetUsers() {
		v.users[user.GetId()] = user
	}
	for _, channel := range snapshot.GetChannels() {
		v.channels[channel.GetId()] = channel
	}
	return v
}

// channelID resolves a channel by numeric id or by (case-insensitive) name.
func (v *view) channelID(target string) (uint64, bool) {
	if id, err := strconv.ParseUint(target, 10, 64); err == nil {
		if _, ok := v.channels[id]; ok {
			return id, true
		}
	}
	for id, channel := range v.channels {
		if strings.EqualFold(channel.GetName(), target) {
			return id, true
		}
	}
	return 0, false
}

func (v *view) nickname(userID uint64) string {
	if user, ok := v.users[userID]; ok && user.GetNickname() != "" {
		return user.GetNickname()
	}
	return fmt.Sprintf("#%d", userID)
}

func (v *view) channelName(channelID uint64) string {
	if channelID == 0 {
		return "(none)"
	}
	if channel, ok := v.channels[channelID]; ok {
		return channel.GetName()
	}
	return fmt.Sprintf("#%d", channelID)
}

func (v *view) handle(frame *rostalkv1.ServerFrame) {
	switch payload := frame.GetPayload().(type) {
	case *rostalkv1.ServerFrame_Event:
		v.handleEvent(payload.Event)
	case *rostalkv1.ServerFrame_Error:
		_, _ = fmt.Fprintf(v.w, "error: %s: %s\n", payload.Error.GetCode(), payload.Error.GetMessage())
	case *rostalkv1.ServerFrame_Ack:
		_, _ = fmt.Fprintln(v.w, "ok")
	case *rostalkv1.ServerFrame_MediaCredentials:
		// Handled by the command that asked for them. The token is never
		// printed or logged.
	case *rostalkv1.ServerFrame_Welcome:
		v.users = make(map[uint64]*rostalkv1.User)
		v.channels = make(map[uint64]*rostalkv1.Channel)
		for _, user := range payload.Welcome.GetSnapshot().GetUsers() {
			v.users[user.GetId()] = user
		}
		for _, channel := range payload.Welcome.GetSnapshot().GetChannels() {
			v.channels[channel.GetId()] = channel
		}
		printWelcome(v.w, "", payload.Welcome, v)
	case nil:
		_, _ = fmt.Fprintln(v.w, "frame with no payload")
	default:
		_, _ = fmt.Fprintf(v.w, "frame: %T\n", payload)
	}
}

func (v *view) handleEvent(event *rostalkv1.Event) {
	switch payload := event.GetPayload().(type) {
	case *rostalkv1.Event_UserJoined:
		user := payload.UserJoined.GetUser()
		v.users[user.GetId()] = user
		_, _ = fmt.Fprintf(v.w, "event: %s connected (channel: %s)\n",
			user.GetNickname(), v.channelName(user.GetChannelId()))
	case *rostalkv1.Event_UserLeft:
		name := v.nickname(payload.UserLeft.GetUserId())
		delete(v.users, payload.UserLeft.GetUserId())
		_, _ = fmt.Fprintf(v.w, "event: %s disconnected\n", name)
	case *rostalkv1.Event_UserMoved:
		moved := payload.UserMoved
		if user, ok := v.users[moved.GetUserId()]; ok {
			user.ChannelId = moved.GetToChannelId()
		}
		_, _ = fmt.Fprintf(v.w, "event: %s moved %s -> %s\n",
			v.nickname(moved.GetUserId()),
			v.channelName(moved.GetFromChannelId()),
			v.channelName(moved.GetToChannelId()))
	case *rostalkv1.Event_UserUpdated:
		user := payload.UserUpdated.GetUser()
		v.users[user.GetId()] = user
		voice := user.GetVoiceState()
		_, _ = fmt.Fprintf(v.w, "event: %s updated (channel: %s, muted: %t, deafened: %t, away: %t)\n",
			user.GetNickname(), v.channelName(user.GetChannelId()),
			voice.GetSelfMuted(), voice.GetSelfDeafened(), voice.GetAway())
	case *rostalkv1.Event_ChannelCreated:
		channel := payload.ChannelCreated.GetChannel()
		v.channels[channel.GetId()] = channel
		_, _ = fmt.Fprintf(v.w, "event: channel %q created (#%d, parent: %s, position: %d)\n",
			channel.GetName(), channel.GetId(), v.channelName(channel.GetParentId()), channel.GetPosition())
	case *rostalkv1.Event_ChannelUpdated:
		channel := payload.ChannelUpdated.GetChannel()
		v.channels[channel.GetId()] = channel
		_, _ = fmt.Fprintf(v.w, "event: channel %q updated (#%d, users: %d, position: %d)\n",
			channel.GetName(), channel.GetId(), channel.GetUserCount(), channel.GetPosition())
	case *rostalkv1.Event_ChannelDeleted:
		channelID := payload.ChannelDeleted.GetChannelId()
		name := v.channelName(channelID)
		delete(v.channels, channelID)
		_, _ = fmt.Fprintf(v.w, "event: channel %q deleted (#%d)\n", name, channelID)
	case *rostalkv1.Event_ServerUpdated:
		server := payload.ServerUpdated.GetServer()
		_, _ = fmt.Fprintf(v.w, "event: server %q updated (online: %d)\n",
			server.GetName(), server.GetOnlineUsers())
	default:
		_, _ = fmt.Fprintf(v.w, "event: %T\n", event.GetPayload())
	}
}

func printSnapshot(w io.Writer, session *client.Session, v *view) {
	printWelcome(w, session.Link.Host, session.Welcome, v)
}

func printWelcome(w io.Writer, host string, welcome *rostalkv1.Welcome, v *view) {
	snapshot := welcome.GetSnapshot()
	info := snapshot.GetServer()
	if host != "" {
		_, _ = fmt.Fprintf(w, "connected to %s\n", host)
	}
	_, _ = fmt.Fprintf(w, "server %q version %s\n", info.GetName(), info.GetVersion())
	_, _ = fmt.Fprintf(w, "server id %s\n", hex.EncodeToString(info.GetId()))
	_, _ = fmt.Fprintf(w, "protocol %d, login mode %s, online %d/%d\n",
		info.GetProtocolVersion(), strings.TrimPrefix(info.GetLoginMode().String(), "LOGIN_MODE_"),
		info.GetOnlineUsers(), info.GetMaxUsers())
	_, _ = fmt.Fprintf(w, "self user id %d\n", welcome.GetSelfUserId())

	printChannelTree(w, v)

	if users := snapshot.GetUsers(); len(users) > 0 {
		_, _ = fmt.Fprintln(w, "users:")
		for _, user := range users {
			suffix := ""
			if user.GetId() == welcome.GetSelfUserId() {
				suffix += " (you)"
			}
			_, _ = fmt.Fprintf(w, "  #%d %s%s in %s\n", user.GetId(), user.GetNickname(), suffix,
				v.channelName(user.GetChannelId()))
		}
	}
	if perms := snapshot.GetPermissions().GetServer().GetPermissions(); len(perms) > 0 {
		_, _ = fmt.Fprintf(w, "server permissions: %d\n", len(perms))
	}
}

// printChannelTree prints the channels as an indented tree, siblings in order.
func printChannelTree(w io.Writer, v *view) {
	if len(v.channels) == 0 {
		return
	}
	children := make(map[uint64][]*rostalkv1.Channel)
	for _, channel := range v.channels {
		children[channel.GetParentId()] = append(children[channel.GetParentId()], channel)
	}
	for _, list := range children {
		sort.Slice(list, func(i, j int) bool {
			if list[i].GetPosition() != list[j].GetPosition() {
				return list[i].GetPosition() < list[j].GetPosition()
			}
			return list[i].GetId() < list[j].GetId()
		})
	}
	_, _ = fmt.Fprintln(w, "channels:")
	var walk func(parentID uint64, depth int)
	walk = func(parentID uint64, depth int) {
		for _, channel := range children[parentID] {
			details := []string{fmt.Sprintf("#%d", channel.GetId())}
			if channel.GetPasswordProtected() {
				details = append(details, "locked")
			}
			if channel.GetUserLimit() > 0 {
				details = append(details, fmt.Sprintf("limit %d", channel.GetUserLimit()))
			}
			if channel.GetTemporary() {
				details = append(details, "temporary")
			}
			if channel.GetUserCount() > 0 {
				details = append(details, fmt.Sprintf("users %d", channel.GetUserCount()))
			}
			_, _ = fmt.Fprintf(w, "%s- %s (%s)\n", strings.Repeat("  ", depth), channel.GetName(),
				strings.Join(details, ", "))
			walk(channel.GetId(), depth+1)
		}
	}
	walk(0, 0)
}

func defaultIdentityPath() string {
	if dir, err := os.UserConfigDir(); err == nil && dir != "" {
		return filepath.Join(dir, "rostalk", "identity.key")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".rostalk", "identity.key")
	}
	return "identity.key"
}
