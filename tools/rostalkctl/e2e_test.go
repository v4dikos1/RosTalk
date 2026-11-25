package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/pem"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/v4dikos1/RosTalk/tools/rostalkctl/client"
)

// TestEndToEndServerPrintsLinkAndAcceptsClient is the stage 1.2 acceptance
// test: a server started in an empty data directory prints a rostalk:// link and
// the client library gets Welcome with it.
//
// The server runs only on Linux (CONTRIBUTING.md), so the test is skipped on Windows
// and covered by CI and make test-server-docker.
func TestEndToEndServerPrintsLinkAndAcceptsClient(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("rostalk-server runs only on Linux (CONTRIBUTING.md); CI and make test-server-docker cover this test")
	}
	if testing.Short() {
		t.Skip("skipping the end-to-end server build in -short mode")
	}

	repoRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("repo root: %v", err)
	}
	serverDir := filepath.Join(repoRoot, "server")
	if _, err := os.Stat(filepath.Join(serverDir, "cmd", "rostalk-server")); err != nil {
		t.Fatalf("server sources not found: %v", err)
	}

	binary := filepath.Join(t.TempDir(), "rostalk-server")
	build := exec.Command("go", "build", "-trimpath", "-o", binary, "./cmd/rostalk-server")
	build.Dir = serverDir
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build rostalk-server: %v\n%s", err, output)
	}

	dataDir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, binary,
		"run",
		"--data="+dataDir,
		"--listen=127.0.0.1:0",
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
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

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

	var linkLine string
	select {
	case linkLine = <-linkCh:
	case <-time.After(30 * time.Second):
		t.Fatalf("server printed no invite link; stderr:\n%s", stderr.String())
	}

	link, err := client.ParseLink(linkLine)
	if err != nil {
		t.Fatalf("parse printed link %q: %v", linkLine, err)
	}
	if strings.Contains(link.Host, "localhost") {
		t.Fatalf("invite link uses localhost: %s", linkLine)
	}

	caPEM, err := os.ReadFile(filepath.Join(dataDir, "ca.crt"))
	if err != nil {
		t.Fatalf("read ca.crt: %v", err)
	}
	if block, _ := pem.Decode(caPEM); block == nil {
		t.Fatal("ca.crt is not PEM")
	}
	roots, err := client.LoadRootCAs(caPEM)
	if err != nil {
		t.Fatalf("LoadRootCAs: %v", err)
	}

	identity, _, err := client.LoadOrCreateIdentity(filepath.Join(t.TempDir(), "identity.key"))
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	connectCtx, connectCancel := context.WithTimeout(ctx, 20*time.Second)
	defer connectCancel()
	session, err := client.Connect(connectCtx, link, identity, client.Options{
		Nickname:      "e2e",
		ClientVersion: "e2e-test",
		RootCAs:       roots,
		Timeout:       20 * time.Second,
	})
	if err != nil {
		t.Fatalf("connect: %v\nserver stderr:\n%s", err, stderr.String())
	}
	defer func() { _ = session.Close() }()

	welcome := session.Welcome
	if welcome.GetSelfUserId() == 0 {
		t.Fatal("Welcome has self_user_id 0")
	}
	if got := welcome.GetSnapshot().GetServer().GetName(); got != "RosTalk" {
		t.Fatalf("server name = %q", got)
	}
	if got := welcome.GetSnapshot().GetServer().GetOnlineUsers(); got != 1 {
		t.Fatalf("online users = %d, want 1", got)
	}
	if len(welcome.GetSnapshot().GetPermissions().GetServer().GetPermissions()) == 0 {
		t.Fatal("the bootstrap invite did not grant administrator rights")
	}
}
