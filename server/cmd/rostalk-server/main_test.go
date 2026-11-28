package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestExecuteVersionPrintsBuildIdentity(t *testing.T) {
	var stdout, stderr bytes.Buffer

	if err := execute([]string{"version"}, &stdout, &stderr); err != nil {
		t.Fatalf("execute(version) returned %v, stderr: %s", err, stderr.String())
	}
	if !strings.HasPrefix(stdout.String(), "rostalk-server ") {
		t.Fatalf("unexpected version output %q", stdout.String())
	}
}

func TestExecuteRequiresSubcommand(t *testing.T) {
	var stdout, stderr bytes.Buffer

	err := execute(nil, &stdout, &stderr)
	if err == nil {
		t.Fatal("expected an error for an empty command line")
	}
	if !strings.Contains(stderr.String(), "Usage:") {
		t.Fatalf("usage text was not printed, got %q", stderr.String())
	}
}

func TestExecuteRejectsUnknownSubcommand(t *testing.T) {
	var stdout, stderr bytes.Buffer

	if err := execute([]string{"frobnicate"}, &stdout, &stderr); err == nil {
		t.Fatal("expected an error for an unknown subcommand")
	}
}

func TestParseRunConfigDefaults(t *testing.T) {
	t.Setenv("ROSTALK_DATA", "")
	t.Setenv("ROSTALK_LISTEN", "")
	t.Setenv("ROSTALK_PUBLIC_HOST", "")
	t.Setenv("ROSTALK_DOMAIN", "")
	t.Setenv("ROSTALK_ADVERTISE_IP", "")
	t.Setenv("ROSTALK_LOOPBACK", "")
	t.Setenv("ROSTALK_LOGIN_MODE", "")
	t.Setenv("ROSTALK_SERVER_PASSWORD", "")
	var stderr bytes.Buffer

	cfg, err := parseRunConfig(nil, &stderr)
	if err != nil {
		t.Fatalf("parseRunConfig(nil) returned %v, stderr: %s", err, stderr.String())
	}
	if cfg.listen != ":7443" {
		t.Errorf("listen = %q, want :7443", cfg.listen)
	}
	if cfg.enableLoopbackCandidate {
		t.Error("enable_loopback_candidate must default to false (ADR 0001)")
	}
	if cfg.loginMode != "" || cfg.serverPassword != "" {
		t.Errorf("login overrides must be off by default: %+v", cfg)
	}
}

func TestParseRunConfigAcceptsPasswordLogin(t *testing.T) {
	var stderr bytes.Buffer

	cfg, err := parseRunConfig([]string{
		"--data=/data",
		"--login-mode=password",
		"--server-password=secret",
	}, &stderr)
	if err != nil {
		t.Fatalf("parseRunConfig returned %v, stderr: %s", err, stderr.String())
	}
	if cfg.loginMode != "password" || cfg.serverPassword != "secret" {
		t.Fatalf("unexpected login config %+v", cfg)
	}
}

func TestParseRunConfigRejectsBadLoginSettings(t *testing.T) {
	cases := map[string][]string{
		"unknown mode":              {"--login-mode", "sometimes"},
		"password without mode":     {"--server-password", "secret"},
		"password with invite mode": {"--login-mode", "invite", "--server-password", "secret"},
	}

	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			var stderr bytes.Buffer
			if _, err := parseRunConfig(args, &stderr); err == nil {
				t.Fatalf("expected an error for %v", args)
			}
			if strings.Contains(stderr.String(), "secret") {
				t.Fatal("the password must never be echoed in an error")
			}
		})
	}
}

func TestParseRunConfigComposeFlags(t *testing.T) {
	var stderr bytes.Buffer

	cfg, err := parseRunConfig([]string{
		"--data=/data",
		"--advertise-ip=192.168.1.10",
		"--enable-loopback-candidate=false",
	}, &stderr)
	if err != nil {
		t.Fatalf("parseRunConfig returned %v, stderr: %s", err, stderr.String())
	}
	if cfg.dataDir != "/data" || cfg.advertiseIP != "192.168.1.10" {
		t.Fatalf("unexpected config %+v", cfg)
	}
}

func TestParseRunConfigRejectsInvalidInput(t *testing.T) {
	cases := map[string][]string{
		"bad listen address": {"--listen", "7443"},
		"bad advertise ip":   {"--advertise-ip", "localhost"},
		"extra arguments":    {"extra"},
	}

	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			var stderr bytes.Buffer
			if _, err := parseRunConfig(args, &stderr); err == nil {
				t.Fatalf("expected an error for %v", args)
			}
		})
	}
}

func TestParseRunConfigReadsEnvironment(t *testing.T) {
	t.Setenv("ROSTALK_DATA", "/srv/rostalk")
	t.Setenv("ROSTALK_LISTEN", "127.0.0.1:8443")
	t.Setenv("ROSTALK_PUBLIC_HOST", "rostalk.example.test")
	t.Setenv("ROSTALK_LOOPBACK", "true")

	var stderr bytes.Buffer
	cfg, err := parseRunConfig(nil, &stderr)
	if err != nil {
		t.Fatalf("parseRunConfig: %v", err)
	}
	if cfg.dataDir != "/srv/rostalk" || cfg.listen != "127.0.0.1:8443" {
		t.Fatalf("environment was not applied: %+v", cfg)
	}
	if cfg.publicHost != "rostalk.example.test" || !cfg.enableLoopbackCandidate {
		t.Fatalf("environment was not applied: %+v", cfg)
	}

	// Flags win over the environment.
	cfg, err = parseRunConfig([]string{"--listen=:9000"}, &stderr)
	if err != nil {
		t.Fatalf("parseRunConfig with a flag: %v", err)
	}
	if cfg.listen != ":9000" {
		t.Fatalf("flag did not override the environment: %q", cfg.listen)
	}
}

func TestParseRunConfigRejectsBadEnvironmentBool(t *testing.T) {
	t.Setenv("ROSTALK_LOOPBACK", "sometimes")
	var stderr bytes.Buffer
	if _, err := parseRunConfig(nil, &stderr); err == nil {
		t.Fatal("expected an error for a non-boolean ROSTALK_LOOPBACK")
	}
}

func TestParseRunConfigNATMode(t *testing.T) {
	var stderr bytes.Buffer
	cfg, err := parseRunConfig([]string{"--nat=auto"}, &stderr)
	if err != nil || cfg.natMode != "auto" {
		t.Fatalf("--nat=auto: %+v, %v", cfg, err)
	}
	t.Setenv("ROSTALK_NAT", "pmp")
	cfg, err = parseRunConfig(nil, &stderr)
	if err != nil || cfg.natMode != "pmp" {
		t.Fatalf("ROSTALK_NAT=pmp: %+v, %v", cfg, err)
	}
	if _, err := parseRunConfig([]string{"--nat=carrier-pigeon"}, &stderr); err == nil {
		t.Fatal("an unknown --nat mode was accepted")
	}
}

func TestParseRunConfigNewYear(t *testing.T) {
	t.Setenv("ROSTALK_NEW_YEAR_DISABLED", "")
	t.Setenv("ROSTALK_NEW_YEAR_TZ", "")
	var stderr bytes.Buffer
	cfg, err := parseRunConfig(nil, &stderr)
	if err != nil || cfg.newYearDisabled || cfg.newYearTZ != "" {
		t.Fatalf("defaults: %+v, %v", cfg, err)
	}
	t.Setenv("ROSTALK_NEW_YEAR_DISABLED", "true")
	t.Setenv("ROSTALK_NEW_YEAR_TZ", "Europe/Moscow")
	cfg, err = parseRunConfig(nil, &stderr)
	if err != nil || !cfg.newYearDisabled || cfg.newYearTZ != "Europe/Moscow" {
		t.Fatalf("environment: %+v, %v", cfg, err)
	}
	cfg, err = parseRunConfig([]string{"--new-year-disabled=false", "--new-year-tz=UTC"}, &stderr)
	if err != nil || cfg.newYearDisabled || cfg.newYearTZ != "UTC" {
		t.Fatalf("flags: %+v, %v", cfg, err)
	}
	t.Setenv("ROSTALK_NEW_YEAR_DISABLED", "maybe")
	if _, err := parseRunConfig(nil, &stderr); err == nil {
		t.Fatal("a non-boolean ROSTALK_NEW_YEAR_DISABLED was accepted")
	}
}
