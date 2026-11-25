package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/tools/rostalkctl/client"
)

// TestChatSurvivesServerRestart is the stage 4.1 live smoke: two clients, a
// channel message, an attachment over HTTPS and the same history after the
// server process is restarted on the same data directory.
func TestChatSurvivesServerRestart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("rostalk-server runs only on Linux (CONTRIBUTING.md); make test-server-docker covers this")
	}
	if testing.Short() {
		t.Skip("skipping the end-to-end server build in -short mode")
	}

	repoRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("repo root: %v", err)
	}
	serverDir := filepath.Join(repoRoot, "server")
	binary := filepath.Join(t.TempDir(), "rostalk-server")
	build := exec.Command("go", "build", "-trimpath", "-o", binary, "./cmd/rostalk-server")
	build.Dir = serverDir
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build rostalk-server: %v\n%s", err, output)
	}

	port := freePort(t)
	dataDir := t.TempDir()
	server := startChatServer(t, binary, dataDir, port)
	defer server.stop()

	link, err := client.ParseLink(server.link)
	if err != nil {
		t.Fatalf("parse the admin link: %v", err)
	}
	adminIdentity, _, err := client.LoadOrCreateIdentity(filepath.Join(t.TempDir(), "admin.key"))
	if err != nil {
		t.Fatalf("admin identity: %v", err)
	}
	admin := chatConnect(t, link, adminIdentity, "admin")

	// A text channel; default channels are voice only.
	channel := createChatChannel(t, admin)
	memberLink := createInvite(t, admin, roleIDByName(admin.Welcome.GetSnapshot(), "Member"))
	memberIdentity, _, err := client.LoadOrCreateIdentity(filepath.Join(t.TempDir(), "member.key"))
	if err != nil {
		t.Fatalf("member identity: %v", err)
	}
	member := chatConnect(t, memberLink, memberIdentity, "member")

	for index := 0; index < 2; index++ {
		reply := chatRequest(t, admin, uint64(10+index), &rostalkv1.ClientFrame_ChatSend{
			ChatSend: &rostalkv1.ChatSend{
				Target: &rostalkv1.ChatTarget{Target: &rostalkv1.ChatTarget_ChannelId{ChannelId: channel}},
				Body:   fmt.Sprintf("before restart %d", index),
			},
		})
		if reply.GetError() != nil || reply.GetMessage() == nil {
			t.Fatalf("admin send %d: %v", index, reply.GetError())
		}
	}
	reply := chatRequest(t, member, 20, &rostalkv1.ClientFrame_ChatSend{
		ChatSend: &rostalkv1.ChatSend{
			Target: &rostalkv1.ChatTarget{Target: &rostalkv1.ChatTarget_ChannelId{ChannelId: channel}},
			Body:   "member before restart",
		},
	})
	if reply.GetError() != nil {
		t.Fatalf("member send: %v", reply.GetError())
	}

	attachmentID := uploadChatFile(t, port, admin.Welcome.GetHttpToken(), channel)
	attachReply := chatRequest(t, admin, 30, &rostalkv1.ClientFrame_ChatSend{
		ChatSend: &rostalkv1.ChatSend{
			Target:        &rostalkv1.ChatTarget{Target: &rostalkv1.ChatTarget_ChannelId{ChannelId: channel}},
			AttachmentIds: []uint64{attachmentID},
		},
	})
	if attachReply.GetError() != nil {
		t.Fatalf("send with attachment: %v", attachReply.GetError())
	}
	assertChatFile(t, port, member.Welcome.GetHttpToken(), attachmentID)

	_ = admin.Close()
	_ = member.Close()
	server.stop()

	restarted := startChatServer(t, binary, dataDir, port)
	defer restarted.stop()
	adminAgain := chatConnect(t, link, adminIdentity, "")
	page := chatRequest(t, adminAgain, 100, &rostalkv1.ClientFrame_ChatHistory{
		ChatHistory: &rostalkv1.ChatHistoryRequest{
			Target: &rostalkv1.ChatTarget{Target: &rostalkv1.ChatTarget_ChannelId{ChannelId: channel}},
			Limit:  50,
		},
	}).GetChatHistory()
	if page == nil || len(page.GetMessages()) != 4 {
		t.Fatalf("history after restart = %+v", page)
	}
	if page.GetMessages()[0].GetBody() != "before restart 0" {
		t.Fatalf("oldest message after restart = %q", page.GetMessages()[0].GetBody())
	}
	if len(page.GetMessages()[3].GetAttachments()) != 1 {
		t.Fatalf("attachment did not survive: %+v", page.GetMessages()[3])
	}
	assertChatFile(t, port, adminAgain.Welcome.GetHttpToken(), attachmentID)
}

type chatServer struct {
	cmd  *exec.Cmd
	link string
}

func startChatServer(t *testing.T, binary, dataDir string, port int) *chatServer {
	t.Helper()
	cmd := exec.Command(binary,
		"run",
		"--data="+dataDir,
		"--listen="+fmt.Sprintf("127.0.0.1:%d", port),
		"--public-host=127.0.0.1",
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start server: %v", err)
	}
	linkCh := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if strings.HasPrefix(line, "rostalk://join?") {
				select {
				case linkCh <- line:
				default:
				}
			}
		}
	}()

	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		response, err := client.Get(fmt.Sprintf("https://127.0.0.1:%d/healthz", port))
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}

	server := &chatServer{cmd: cmd}
	// The first start prints the administrator link; a restart with an existing
	// administrator does not, which is why the port is fixed by the caller.
	select {
	case server.link = <-linkCh:
	case <-time.After(2 * time.Second):
		if _, err := os.Stat(filepath.Join(dataDir, "admin-invite")); err == nil {
			t.Fatalf("server printed no admin link; stderr:\n%s", stderr.String())
		}
	}
	return server
}

func (s *chatServer) stop() {
	if s == nil || s.cmd == nil || s.cmd.Process == nil {
		return
	}
	_ = s.cmd.Process.Kill()
	_ = s.cmd.Wait()
	s.cmd = nil
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("free port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return port
}

func chatConnect(t *testing.T, link client.Link, identity *client.Identity, nickname string) *client.Session {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	session, err := client.Connect(ctx, link, identity, client.Options{
		Nickname: nickname,
		Timeout:  20 * time.Second,
	})
	if err != nil {
		t.Fatalf("connect %q: %v", nickname, err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func chatRequest(t *testing.T, session *client.Session, requestID uint64, payload any) *rostalkv1.ServerFrame {
	t.Helper()
	var frame *rostalkv1.ClientFrame
	switch value := payload.(type) {
	case *rostalkv1.ClientFrame_ChatSend:
		frame = &rostalkv1.ClientFrame{RequestId: requestID, Payload: value}
	case *rostalkv1.ClientFrame_ChatHistory:
		frame = &rostalkv1.ClientFrame{RequestId: requestID, Payload: value}
	case *rostalkv1.ClientFrame_AdminAction:
		frame = &rostalkv1.ClientFrame{RequestId: requestID, Payload: value}
	case *rostalkv1.ClientFrame_MarkRead:
		frame = &rostalkv1.ClientFrame{RequestId: requestID, Payload: value}
	default:
		t.Fatalf("unsupported chat request %T", payload)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := session.Send(ctx, frame); err != nil {
		t.Fatalf("send request: %v", err)
	}
	for {
		reply, err := session.Next(ctx)
		if err != nil {
			t.Fatalf("read reply: %v", err)
		}
		if reply.GetReplyTo() == requestID {
			return reply
		}
	}
}

func createChatChannel(t *testing.T, admin *client.Session) uint64 {
	t.Helper()
	reply := chatRequest(t, admin, 1, &rostalkv1.ClientFrame_AdminAction{
		AdminAction: &rostalkv1.AdminAction{Action: &rostalkv1.AdminAction_ChannelCreate{
			ChannelCreate: &rostalkv1.ChannelCreate{
				Name: "chat",
				Kind: rostalkv1.ChannelKind_CHANNEL_KIND_TEXT,
			},
		}},
	})
	if reply.GetError() != nil {
		t.Fatalf("create channel: %v", reply.GetError())
	}
	channel := reply.GetAdminResult().GetChannel()
	if channel == nil {
		t.Fatal("channel create returned no channel")
	}
	return channel.GetId()
}

func roleIDByName(snapshot *rostalkv1.ServerSnapshot, name string) uint64 {
	for _, role := range snapshot.GetRoles() {
		if role.GetName() == name {
			return role.GetId()
		}
	}
	return 0
}

func createInvite(t *testing.T, admin *client.Session, roleID uint64) client.Link {
	t.Helper()
	reply := chatRequest(t, admin, 2, &rostalkv1.ClientFrame_AdminAction{
		AdminAction: &rostalkv1.AdminAction{Action: &rostalkv1.AdminAction_InviteCreate{
			InviteCreate: &rostalkv1.InviteCreate{RoleId: roleID, MaxUses: 1},
		}},
	})
	if reply.GetError() != nil {
		t.Fatalf("create invite: %v", reply.GetError())
	}
	link, err := client.ParseLink(reply.GetAdminResult().GetInvite().GetUrl())
	if err != nil {
		t.Fatalf("parse the invite link: %v", err)
	}
	return link
}

func chatHTTPClient() *http.Client {
	return &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}}
}

func uploadChatFile(t *testing.T, port int, token string, channelID uint64) uint64 {
	t.Helper()
	var buffer bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	for x := 0; x < 2; x++ {
		for y := 0; y < 2; y++ {
			img.Set(x, y, color.RGBA{B: 255, A: 255})
		}
	}
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	request, err := http.NewRequest(http.MethodPost,
		fmt.Sprintf("https://127.0.0.1:%d/api/v1/chat/attachments?channelId=%d&name=smoke.png", port, channelID),
		bytes.NewReader(buffer.Bytes()))
	if err != nil {
		t.Fatalf("new upload: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := chatHTTPClient().Do(request)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("upload status %d: %s", response.StatusCode, body)
	}
	var created struct {
		Attachment struct {
			ID uint64 `json:"id"`
		} `json:"attachment"`
	}
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatalf("decode upload: %v", err)
	}
	return created.Attachment.ID
}

func assertChatFile(t *testing.T, port int, token string, attachmentID uint64) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet,
		fmt.Sprintf("https://127.0.0.1:%d/api/v1/chat/attachments/%d", port, attachmentID), nil)
	if err != nil {
		t.Fatalf("new attachment request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := chatHTTPClient().Do(request)
	if err != nil {
		t.Fatalf("get attachment: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("attachment status %d", response.StatusCode)
	}
	if response.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("attachment type = %q", response.Header.Get("Content-Type"))
	}
}
