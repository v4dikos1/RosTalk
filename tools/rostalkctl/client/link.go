// Package client is the Go client library for the RosTalk control protocol.
//
// It implements the link format, an Ed25519 identity and the
// Hello -> Challenge -> Authenticate -> Welcome handshake. rostalkctl and the
// integration tests use it.
package client

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// Link is a parsed rostalk://join link (design 4.3).
type Link struct {
	// Host is the server address as it appears in the link, e.g.
	// "192.168.1.10:7443".
	Host string
	// Fingerprint is the lowercase hex SHA-256 of the server's TLS leaf
	// certificate. Clients pin it instead of trusting a public CA.
	Fingerprint string
	// Invite is the one-time invite token, possibly empty on a server where
	// the key is already known.
	Invite string
	// Raw is the original link.
	Raw string
}

// ParseLink parses rostalk://join?host=...&fp=...&invite=... links.
func ParseLink(raw string) (Link, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil {
		return Link{}, fmt.Errorf("parse invite link: %w", err)
	}
	if u.Scheme != "rostalk" {
		return Link{}, fmt.Errorf("invite link must use the rostalk:// scheme, got %q", u.Scheme)
	}
	if u.Host != "join" {
		return Link{}, fmt.Errorf("invite link must be rostalk://join, got rostalk://%s", u.Host)
	}
	q := u.Query()
	host := strings.TrimSpace(q.Get("host"))
	if host == "" {
		return Link{}, fmt.Errorf("invite link has no host parameter")
	}
	if err := validateHost(host); err != nil {
		return Link{}, err
	}
	fp := strings.ToLower(strings.TrimSpace(q.Get("fp")))
	if len(fp) != 64 {
		return Link{}, fmt.Errorf("invite link fingerprint must be 64 hex characters, got %d", len(fp))
	}
	for _, r := range fp {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return Link{}, fmt.Errorf("invite link fingerprint is not hexadecimal")
		}
	}
	invite := strings.TrimSpace(q.Get("invite"))
	if invite == "" {
		return Link{}, fmt.Errorf("invite link has no invite parameter")
	}
	return Link{Host: host, Fingerprint: fp, Invite: invite, Raw: raw}, nil
}

// String rebuilds the link in the canonical form.
func (l Link) String() string {
	return "rostalk://join?host=" + l.Host + "&fp=" + l.Fingerprint + "&invite=" + l.Invite
}

// WSURL is the control-plane WebSocket URL.
func (l Link) WSURL() string {
	return "wss://" + l.Host + "/ws"
}

// Hostname returns the link host without its port.
func (l Link) Hostname() string {
	if h, _, err := net.SplitHostPort(l.Host); err == nil {
		return h
	}
	return strings.Trim(l.Host, "[]")
}

func validateHost(host string) error {
	if strings.Contains(host, "://") || strings.ContainsAny(host, "/?#@") {
		return fmt.Errorf("invite link host %q is not a plain host or host:port", host)
	}
	if _, _, err := net.SplitHostPort(host); err == nil {
		return nil
	}
	name := strings.Trim(host, "[]")
	if name == "" {
		return fmt.Errorf("invite link host is empty")
	}
	if ip := net.ParseIP(name); ip != nil {
		return nil
	}
	for _, label := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		if label == "" || len(label) > 63 {
			return fmt.Errorf("invite link host %q is not valid", host)
		}
		for i, r := range label {
			ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
				(r == '-' && i != 0 && i != len(label)-1)
			if !ok {
				return fmt.Errorf("invite link host %q is not valid", host)
			}
		}
	}
	return nil
}
