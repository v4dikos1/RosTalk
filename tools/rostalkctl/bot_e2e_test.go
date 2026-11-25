package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/tools/rostalkctl/bot"
	"github.com/v4dikos1/RosTalk/tools/rostalkctl/client"
)

// This file is the stage 1.4 acceptance test: a real rostalk-server with the
// embedded LiveKit, real bots publishing mu-law audio through the gateway.
//
// It needs the Linux server binary, so it is skipped on Windows (CONTRIBUTING.md) and
// in -short mode; CI and `make test-server-docker` run it.

// serverBinary is built once per test process: starting the SFU is expensive.
var (
	serverBinary   string
	serverBinaryMu sync.Mutex
)

// buildServer compiles rostalk-server into the temporary directory.
func buildServer(t *testing.T) string {
	t.Helper()
	serverBinaryMu.Lock()
	defer serverBinaryMu.Unlock()
	if serverBinary != "" {
		return serverBinary
	}
	repoRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("repo root: %v", err)
	}
	serverDir := filepath.Join(repoRoot, "server")
	dir, err := os.MkdirTemp("", "rostalk-bot-e2e-")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	binary := filepath.Join(dir, "rostalk-server")
	build := exec.Command("go", "build", "-trimpath", "-o", binary, "./cmd/rostalk-server")
	build.Dir = serverDir
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build rostalk-server: %v\n%s", err, output)
	}
	serverBinary = binary
	return binary
}

// mediaPorts are the four ports one test server needs.
type mediaPorts struct {
	listen int
	signal int
	udp    int
	tcp    int
}

// freePorts reserves four ports and releases them for the server.
func freePorts(t *testing.T) mediaPorts {
	t.Helper()
	return mediaPorts{
		listen: freeTCPPort(t),
		signal: freeTCPPort(t),
		udp:    freeUDPPort(t),
		tcp:    freeTCPPort(t),
	}
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a TCP port: %v", err)
	}
	defer func() { _ = listener.Close() }()
	return listener.Addr().(*net.TCPAddr).Port
}

func freeUDPPort(t *testing.T) int {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("reserve a UDP port: %v", err)
	}
	defer func() { _ = conn.Close() }()
	return conn.LocalAddr().(*net.UDPAddr).Port
}

// testServer is one running rostalk-server process.
type testServer struct {
	cmd      *exec.Cmd
	link     string
	dataDir  string
	ports    mediaPorts
	stderr   *bytes.Buffer
	stopOnce sync.Once
}

// startServer starts the binary in a fresh data directory and waits for the
// invite link.
func startServer(t *testing.T, binary, dataDir string, ports mediaPorts) *testServer {
	t.Helper()
	server := launch(t, binary, dataDir, ports, "")
	if server.link == "" {
		t.Fatalf("server printed no invite link; stderr:\n%s", server.stderr.String())
	}
	return server
}

// restartServer starts the binary on an existing data directory. The bootstrap
// invite was used on the first run, so no link is printed; the caller keeps
// using the previous one (known keys are admitted without an invite).
func restartServer(t *testing.T, binary, dataDir string, ports mediaPorts, link string) *testServer {
	t.Helper()
	server := launch(t, binary, dataDir, ports, link)
	if server.link != "" && server.link != link {
		t.Fatalf("restarted server printed a different link: %s", server.link)
	}
	return server
}

// launch starts the binary and waits until the gateway answers. When link is
// not empty the caller already knows it and no link is expected on stdout.
func launch(t *testing.T, binary, dataDir string, ports mediaPorts, link string) *testServer {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	server := &testServer{
		link:    link,
		dataDir: dataDir,
		ports:   ports,
		stderr:  &bytes.Buffer{},
	}
	server.cmd = exec.CommandContext(ctx, binary,
		"run",
		"--data="+dataDir,
		"--listen="+fmt.Sprintf("127.0.0.1:%d", ports.listen),
		"--public-host=127.0.0.1",
		// A client in the same container reaches the SFU over loopback, so the
		// loopback candidate is required here. On a Windows dev host the
		// advertised address is the LAN IP instead (ADR 0001).
		"--advertise-ip=127.0.0.1",
		"--enable-loopback-candidate=true",
		"--media-signal-port="+fmt.Sprint(ports.signal),
		"--media-udp-port="+fmt.Sprint(ports.udp),
		"--media-tcp-port="+fmt.Sprint(ports.tcp),
	)
	stdout, err := server.cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	server.cmd.Stderr = server.stderr
	if err := server.cmd.Start(); err != nil {
		t.Fatalf("start server: %v", err)
	}
	t.Cleanup(server.stop)

	links := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if strings.HasPrefix(line, "rostalk://join?") {
				select {
				case links <- line:
				default:
				}
			}
		}
	}()

	if server.link == "" {
		select {
		case printed := <-links:
			server.link = printed
		case <-time.After(60 * time.Second):
			t.Fatalf("server printed no invite link; stderr:\n%s", server.stderr.String())
		}
	}

	parsed, err := client.ParseLink(server.link)
	if err != nil {
		t.Fatalf("parse server link %q: %v", server.link, err)
	}
	waitHealthy(t, parsed)
	return server
}

// waitHealthy polls /healthz with the pinned certificate until the gateway
// answers, so a test never races the restart.
func waitHealthy(t *testing.T, link client.Link) {
	t.Helper()
	expected, err := hex.DecodeString(link.Fingerprint)
	if err != nil {
		t.Fatalf("fingerprint %q: %v", link.Fingerprint, err)
	}
	client := &http.Client{
		Timeout: 2 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			MinVersion:         tls.VersionTLS12,
			InsecureSkipVerify: true, // the leaf is pinned below
			VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
				if len(raw) == 0 {
					return fmt.Errorf("no peer certificate")
				}
				sum := sha256.Sum256(raw[0])
				if !bytes.Equal(sum[:], expected) {
					return fmt.Errorf("certificate fingerprint mismatch")
				}
				return nil
			},
		}},
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := client.Get("https://" + link.Host + "/healthz")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("the gateway did not become healthy")
}

func (s *testServer) stop() {
	s.stopOnce.Do(func() {
		if s.cmd.Process != nil {
			_ = s.cmd.Process.Kill()
		}
		_ = s.cmd.Wait()
	})
}

// waitStopped stops the process and waits for the ports to be released.
func (s *testServer) waitStopped(t *testing.T) {
	t.Helper()
	s.stop()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", s.ports.listen))
		if err == nil {
			_ = listener.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("the control port was not released; stderr:\n%s", s.stderr.String())
}

// newInviteLink asks the running server for another invite and rebuilds it with
// the listen port and the pinned certificate.
func newInviteLink(t *testing.T, binary string, server *testServer, link client.Link) client.Link {
	t.Helper()
	cmd := exec.Command(binary,
		"invite",
		"--data="+server.dataDir,
		"--listen="+fmt.Sprintf("127.0.0.1:%d", server.ports.listen),
		"--public-host=127.0.0.1",
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("rostalk-server invite: %v\n%s", err, output)
	}
	invite, err := client.ParseLink(strings.TrimSpace(string(output)))
	if err != nil {
		t.Fatalf("parse the invite link %q: %v", output, err)
	}
	if invite.Host != link.Host {
		t.Fatalf("invite host = %q, want %q", invite.Host, link.Host)
	}
	return client.Link{Host: link.Host, Fingerprint: link.Fingerprint, Invite: invite.Invite}
}

// botKeys returns stable identity paths: the same user must be able to come
// back after a server restart without spending another invite.
func botKeys(t *testing.T) (alice, bob string) {
	t.Helper()
	dir := t.TempDir()
	return filepath.Join(dir, "alice.key"), filepath.Join(dir, "bob.key")
}

// testBot is a control-plane session of a bot plus its media session.
type testBot struct {
	nickname string
	control  *client.Session
	identity string
	room     string
	media    *bot.Session
	view     *view
}

// joinBot connects with the link, joins the channel and starts publishing. An
// empty identityPath creates a fresh identity; a path reuses (or creates) the
// key, which is how a test reconnects the same user after a server restart.
func joinBot(t *testing.T, ctx context.Context, link client.Link, identityPath, nickname, channelName string, frequency float64) *testBot {
	t.Helper()
	if identityPath == "" {
		identityPath = filepath.Join(t.TempDir(), nickname+".key")
	}
	identity, _, err := client.LoadOrCreateIdentity(identityPath)
	if err != nil {
		t.Fatalf("%s: identity: %v", nickname, err)
	}
	connectCtx, cancelConnect := context.WithTimeout(ctx, 30*time.Second)
	session, err := client.Connect(connectCtx, link, identity, client.Options{
		Nickname:      nickname,
		ClientVersion: "bot-e2e",
		Timeout:       30 * time.Second,
	})
	cancelConnect()
	if err != nil {
		t.Fatalf("%s: connect: %v", nickname, err)
	}

	state := newView(os.Stderr, session.Welcome)
	channelID, ok := state.channelID(channelName)
	if !ok {
		t.Fatalf("%s: channel %q not found", nickname, channelName)
	}
	const requestID uint64 = 3
	if err := session.Send(ctx, &rostalkv1.ClientFrame{
		RequestId: requestID,
		Payload: &rostalkv1.ClientFrame_JoinChannel{JoinChannel: &rostalkv1.JoinChannel{
			ChannelId: channelID,
		}},
	}); err != nil {
		t.Fatalf("%s: join: %v", nickname, err)
	}
	credentials, err := botCredentials(ctx, session, requestID)
	if err != nil {
		t.Fatalf("%s: join reply: %v", nickname, err)
	}

	botCtx, cancelBot := context.WithCancel(ctx)
	media, err := bot.Join(botCtx, bot.Config{
		URL:         credentials.GetUrl(),
		Token:       credentials.GetToken(),
		Identity:    credentials.GetParticipantIdentity(),
		Fingerprint: link.Fingerprint,
		Frequency:   frequency,
	})
	if err != nil {
		cancelBot()
		t.Fatalf("%s: media join: %v", nickname, err)
	}
	result := &testBot{
		nickname: nickname,
		control:  session,
		identity: credentials.GetParticipantIdentity(),
		room:     credentials.GetRoom(),
		media:    media,
		view:     state,
	}
	t.Cleanup(func() {
		cancelBot()
		media.Close()
		_ = session.Close()
	})
	return result
}

// botCredentials reads frames until the reply to the join request.
func botCredentials(ctx context.Context, session *client.Session, requestID uint64) (*rostalkv1.MediaCredentials, error) {
	readCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for {
		frame, err := session.Next(readCtx)
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
			return nil, fmt.Errorf("join reply = %T, want MediaCredentials", frame.GetPayload())
		}
		return credentials, nil
	}
}

// waitForAudio waits until every bot received packets from every other bot.
func waitForAudio(t *testing.T, bots []*testBot, timeout time.Duration) map[string]map[string]int64 {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		complete := true
		received := make(map[string]map[string]int64, len(bots))
		for _, listener := range bots {
			stats := listener.media.Stats()
			received[listener.identity] = stats.Received
			for _, publisher := range bots {
				if publisher == listener {
					continue
				}
				if stats.Received[publisher.identity] == 0 {
					complete = false
				}
			}
		}
		if complete {
			return received
		}
		time.Sleep(200 * time.Millisecond)
	}
	for _, listener := range bots {
		stats := listener.media.Stats()
		t.Logf("%s sent=%d received=%v remote=%d", listener.identity, stats.SentPackets, stats.Received, stats.Participants)
	}
	t.Fatalf("bots did not receive each other's audio in %v", timeout)
	return nil
}

func TestBotsHearEachOther(t *testing.T) {
	requireRealServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	binary := buildServer(t)
	aliceKey, bobKey := botKeys(t)
	server := startServer(t, binary, t.TempDir(), freePorts(t))
	adminLink, err := client.ParseLink(server.link)
	if err != nil {
		t.Fatalf("parse admin link: %v", err)
	}
	bobLink := newInviteLink(t, binary, server, adminLink)

	alice := joinBot(t, ctx, adminLink, aliceKey, "alice", "Лобби", 440)
	bob := joinBot(t, ctx, bobLink, bobKey, "bob", "Лобби", 550)

	if alice.room != bob.room {
		t.Fatalf("bots are in different rooms: %q and %q", alice.room, bob.room)
	}
	first := waitForAudio(t, []*testBot{alice, bob}, 30*time.Second)

	// The counters must keep growing: one burst is not a working call.
	time.Sleep(time.Second)
	second := waitForAudio(t, []*testBot{alice, bob}, 10*time.Second)
	for listener, publishers := range first {
		for publisher, before := range publishers {
			after := second[listener][publisher]
			if after <= before {
				t.Fatalf("%s received %d packets from %s, then %d", listener, before, publisher, after)
			}
		}
	}

	// A token for a channel the user is not in must not be issued.
	afkID := channelIDOf(t, alice, "AFK")
	sendFrame(t, alice, &rostalkv1.ClientFrame{
		RequestId: 21,
		Payload: &rostalkv1.ClientFrame_RequestMediaCredentials{
			RequestMediaCredentials: &rostalkv1.RequestMediaCredentials{
				ChannelId: afkID,
				Kind:      rostalkv1.MediaKind_MEDIA_KIND_VOICE,
			},
		},
	})
	if reply := awaitReply(t, alice, 21); reply.GetError() == nil {
		t.Fatalf("a token for a foreign channel was issued: %+v", reply.GetPayload())
	}

	// The screen-share participant of the same user gets its own identity.
	sendFrame(t, alice, &rostalkv1.ClientFrame{
		RequestId: 22,
		Payload: &rostalkv1.ClientFrame_RequestMediaCredentials{
			RequestMediaCredentials: &rostalkv1.RequestMediaCredentials{
				ChannelId: channelIDOf(t, alice, "Лобби"),
				Kind:      rostalkv1.MediaKind_MEDIA_KIND_STREAM,
			},
		},
	})
	stream := awaitReply(t, alice, 22).GetMediaCredentials()
	if stream == nil {
		t.Fatal("no stream credentials")
	}
	if want := fmt.Sprintf("%d:stream", alice.control.Welcome.GetSelfUserId()); stream.GetParticipantIdentity() != want {
		t.Fatalf("stream identity = %q, want %q", stream.GetParticipantIdentity(), want)
	}
	if stream.GetToken() == "" || stream.GetExpiresInSeconds() != 60 {
		t.Fatalf("stream credentials = %+v", stream)
	}

	// Leaving the channel removes the media participant from the room.
	sendFrame(t, bob, &rostalkv1.ClientFrame{
		RequestId: 23,
		Payload:   &rostalkv1.ClientFrame_LeaveChannel{LeaveChannel: &rostalkv1.LeaveChannel{}},
	})
	if reply := awaitReply(t, bob, 23); reply.GetError() != nil {
		t.Fatalf("leave: %v", reply.GetError())
	}
	waitForRemoteCount(t, alice, 0, 15*time.Second)
}

func TestBotLeavesMediaWhenControlConnectionDrops(t *testing.T) {
	requireRealServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	binary := buildServer(t)
	aliceKey, bobKey := botKeys(t)
	server := startServer(t, binary, t.TempDir(), freePorts(t))
	adminLink, err := client.ParseLink(server.link)
	if err != nil {
		t.Fatalf("parse admin link: %v", err)
	}
	bobLink := newInviteLink(t, binary, server, adminLink)

	alice := joinBot(t, ctx, adminLink, aliceKey, "alice", "Лобби", 440)
	bob := joinBot(t, ctx, bobLink, bobKey, "bob", "Лобби", 550)
	waitForAudio(t, []*testBot{alice, bob}, 30*time.Second)

	// Drop the control connection without saying goodbye. The server keeps the
	// media session for its grace period and then removes the participant, the
	// same path a kick will use (design 4.4).
	_ = bob.control.Close()

	waitForRemoteCount(t, alice, 0, 30*time.Second)
}

func TestMediaRoomsAreRecreatedAfterRestart(t *testing.T) {
	requireRealServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	binary := buildServer(t)
	aliceKey, bobKey := botKeys(t)
	dataDir := t.TempDir()
	ports := freePorts(t)
	server := startServer(t, binary, dataDir, ports)
	adminLink, err := client.ParseLink(server.link)
	if err != nil {
		t.Fatalf("parse admin link: %v", err)
	}
	bobLink := newInviteLink(t, binary, server, adminLink)

	alice := joinBot(t, ctx, adminLink, aliceKey, "alice", "Лобби", 440)
	bob := joinBot(t, ctx, bobLink, bobKey, "bob", "Лобби", 550)
	waitForAudio(t, []*testBot{alice, bob}, 30*time.Second)

	alice.media.Close()
	_ = alice.control.Close()
	bob.media.Close()
	_ = bob.control.Close()
	server.waitStopped(t)

	// The rooms lived only in memory; a new process must rebuild them for the
	// next join, with the same media key (it is in the settings table).
	restartServer(t, binary, dataDir, ports, adminLink.String())
	waitHealthy(t, adminLink)
	secondAlice := joinBot(t, ctx, adminLink, aliceKey, "alice", "Лобби", 660)
	secondBob := joinBot(t, ctx, bobLink, bobKey, "bob", "Лобби", 770)
	if secondAlice.room != alice.room {
		t.Fatalf("room after restart = %q, want %q", secondAlice.room, alice.room)
	}
	waitForAudio(t, []*testBot{secondAlice, secondBob}, 30*time.Second)
}

// waitForRemoteCount waits until the media session sees count remote
// participants.
func waitForRemoteCount(t *testing.T, b *testBot, count int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		stats := b.media.Stats()
		if stats.Participants == count {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("%s still sees %d remote participants, want %d",
		b.nickname, b.media.Stats().Participants, count)
}

// requireRealServer skips the suites that need the Linux server binary.
func requireRealServer(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("rostalk-server runs only on Linux (CONTRIBUTING.md); CI and make test-server-docker cover this test")
	}
	if testing.Short() {
		t.Skip("skipping the real-media test in -short mode")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skipf("the go toolchain is required to build the server: %v", err)
	}
}

func channelIDOf(t *testing.T, b *testBot, name string) uint64 {
	t.Helper()
	channelID, ok := b.view.channelID(name)
	if !ok {
		t.Fatalf("channel %q not found", name)
	}
	return channelID
}

func sendFrame(t *testing.T, b *testBot, frame *rostalkv1.ClientFrame) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := b.control.Send(ctx, frame); err != nil {
		t.Fatalf("%s: send request %d: %v", b.nickname, frame.GetRequestId(), err)
	}
}

func awaitReply(t *testing.T, b *testBot, requestID uint64) *rostalkv1.ServerFrame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for {
		frame, err := b.control.Next(ctx)
		if err != nil {
			t.Fatalf("%s: read reply %d: %v", b.nickname, requestID, err)
		}
		if frame.GetReplyTo() == requestID {
			return frame
		}
	}
}
