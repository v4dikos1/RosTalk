package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExecuteVersionPrintsBuildIdentity(t *testing.T) {
	var stdout, stderr bytes.Buffer

	if err := execute([]string{"version"}, &stdout, &stderr); err != nil {
		t.Fatalf("execute(version) returned %v, stderr: %s", err, stderr.String())
	}
	if !strings.HasPrefix(stdout.String(), "rostalkctl ") {
		t.Fatalf("unexpected version output %q", stdout.String())
	}
}

func TestExecuteRequiresSubcommand(t *testing.T) {
	var stdout, stderr bytes.Buffer

	if err := execute(nil, &stdout, &stderr); err == nil {
		t.Fatal("expected an error for an empty command line")
	}
	if !strings.Contains(stderr.String(), "Usage:") {
		t.Fatalf("usage text was not printed, got %q", stderr.String())
	}
}

func TestExecuteRejectsUnknownSubcommand(t *testing.T) {
	var stdout, stderr bytes.Buffer

	if err := execute([]string{"bot"}, &stdout, &stderr); err == nil {
		t.Fatal("expected an error for a subcommand of a later stage")
	}
}

func TestExecuteIdentityNew(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.key")
	var stdout, stderr bytes.Buffer

	if err := execute([]string{"identity", "new", "--out", path}, &stdout, &stderr); err != nil {
		t.Fatalf("execute(identity new) returned %v, stderr: %s", err, stderr.String())
	}
	if !strings.Contains(stdout.String(), "public key") {
		t.Fatalf("unexpected output %q", stdout.String())
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("identity file was not created: %v", err)
	}
}

func TestExecuteConnectRejectsBadLink(t *testing.T) {
	var stdout, stderr bytes.Buffer

	err := execute([]string{"connect", "https://example.test"}, &stdout, &stderr)
	if err == nil {
		t.Fatal("expected an error for a non-rostalk link")
	}
}

func TestParseBotFlagsAcceptsLoop(t *testing.T) {
	settings, _, err := parseBotFlags([]string{
		"--channel", "Lobby", "--play", "testdata/quality.wav", "--loop", "--duration", "60s",
	})
	if err != nil {
		t.Fatalf("parseBotFlags returned %v", err)
	}
	if !settings.loop {
		t.Fatal("--loop was not recorded")
	}
	if settings.play != "testdata/quality.wav" {
		t.Fatalf("--play = %q", settings.play)
	}
	if settings.duration.String() != "1m0s" {
		t.Fatalf("--duration = %s", settings.duration)
	}
}

func TestParseBotFlagsDefaultsToATone(t *testing.T) {
	settings, _, err := parseBotFlags([]string{"--channel", "Lobby"})
	if err != nil {
		t.Fatalf("parseBotFlags returned %v", err)
	}
	if !settings.tone || settings.loop || settings.play != "" {
		t.Fatalf("unexpected defaults: %+v", settings)
	}
}
