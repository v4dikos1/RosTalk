// Package sessionauth maps short-lived HTTP bearer tokens to authenticated
// control-plane sessions (stage 4.1).
//
// The WebView cannot open the server's self-signed TLS connection and must not
// see the control-plane WebSocket. Chat history, uploads and attachment reads
// therefore go through the core's loopback proxy, which forwards an
// `Authorization: Bearer` header with a token issued in `Welcome`. The token
// identifies one authenticated session: it is revoked when that session ends,
// and it carries no user-visible rights of its own because every request is
// checked again through internal/perms.
//
// Only the SHA-256 of a token is kept, exactly like invite and API tokens. The
// plaintext exists in the Welcome frame and in the core's memory.
package sessionauth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"sync"
	"time"
)

// DefaultTTL is how long a session token stays valid without a reconnect. The
// client receives a fresh token in every Welcome, so a long-lived session
// renews it automatically.
const DefaultTTL = 24 * time.Hour

// ErrInvalid is returned for unknown, expired or revoked tokens.
var ErrInvalid = errors.New("session token is invalid or expired")

// ErrEmpty is returned when a token is empty.
var ErrEmpty = errors.New("session token must not be empty")

type entry struct {
	userID    int64
	expiresAt time.Time
}

// Registry holds the active session tokens.
type Registry struct {
	mu     sync.Mutex
	tokens map[[32]byte]entry
	ttl    time.Duration
	now    func() time.Time
}

// New creates an empty registry. A zero ttl uses DefaultTTL.
func New(ttl time.Duration) *Registry {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	return &Registry{
		tokens: make(map[[32]byte]entry),
		ttl:    ttl,
		now:    time.Now,
	}
}

// TTL returns the lifetime of a newly issued token.
func (r *Registry) TTL() time.Duration { return r.ttl }

// Issue creates a token for userID and returns it with its expiration time.
func (r *Registry) Issue(userID int64) (string, time.Time, error) {
	if userID <= 0 {
		return "", time.Time{}, errors.New("session token needs a positive user id")
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", time.Time{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	expires := r.now().Add(r.ttl)
	r.mu.Lock()
	r.tokens[sha256.Sum256([]byte(token))] = entry{userID: userID, expiresAt: expires}
	r.mu.Unlock()
	return token, expires, nil
}

// Lookup returns the user id behind a token.
func (r *Registry) Lookup(token string) (int64, error) {
	if token == "" {
		return 0, ErrEmpty
	}
	if r == nil {
		return 0, ErrInvalid
	}
	key := sha256.Sum256([]byte(token))
	r.mu.Lock()
	defer r.mu.Unlock()
	found, ok := r.tokens[key]
	if !ok {
		return 0, ErrInvalid
	}
	if !r.now().Before(found.expiresAt) {
		delete(r.tokens, key)
		return 0, ErrInvalid
	}
	return found.userID, nil
}

// Revoke removes a token. Revoking an unknown token is not an error: sessions
// may end before the token was ever used.
func (r *Registry) Revoke(token string) {
	if token == "" || r == nil {
		return
	}
	r.mu.Lock()
	delete(r.tokens, sha256.Sum256([]byte(token)))
	r.mu.Unlock()
}

// RevokeUser removes every token of a user. Kick and ban call it so a revoked
// session cannot keep reading history through the HTTP API.
func (r *Registry) RevokeUser(userID int64) {
	if r == nil {
		return
	}
	r.mu.Lock()
	for key, found := range r.tokens {
		if found.userID == userID {
			delete(r.tokens, key)
		}
	}
	r.mu.Unlock()
}

// Count returns the number of live tokens, for diagnostics and tests.
func (r *Registry) Count() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	for key, found := range r.tokens {
		if !now.Before(found.expiresAt) {
			delete(r.tokens, key)
		}
	}
	return len(r.tokens)
}
