package auth

import (
	"sync"
	"time"
)

// rateLimiter is a per-key sliding window of connection attempts. The key is
// the client IP address: the handshake has no other stable identity before the
// signature is verified.
type rateLimiter struct {
	mu        sync.Mutex
	limit     int
	window    time.Duration
	now       func() time.Time
	attempts  map[string][]time.Time
	lastPrune time.Time
}

func newRateLimiter(limit int, window time.Duration, now func() time.Time) *rateLimiter {
	if limit < 1 {
		limit = 1
	}
	if window <= 0 {
		window = time.Minute
	}
	if now == nil {
		now = time.Now
	}
	return &rateLimiter{
		limit:     limit,
		window:    window,
		now:       now,
		attempts:  make(map[string][]time.Time),
		lastPrune: now(),
	}
}

// allow records an attempt and reports whether it is within the limit.
//
// A bucket never grows beyond limit: once the limit is reached, further
// attempts are rejected without appending timestamps, so an attacker cannot
// grow memory by hammering one address. Buckets for other addresses are
// dropped by a periodic prune (at most every window) of empty and expired
// entries.
func (r *rateLimiter) allow(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := r.now()
	if now.Sub(r.lastPrune) >= r.window {
		r.pruneLocked(now)
		r.lastPrune = now
	}

	cutoff := now.Add(-r.window)
	kept := pruneTimestamps(r.attempts[key], cutoff)
	if len(kept) >= r.limit {
		r.attempts[key] = kept
		return false
	}
	kept = append(kept, now)
	r.attempts[key] = kept
	return true
}

// reset forgets a key after a successful authentication, so normal reconnects
// do not accumulate against the limit.
func (r *rateLimiter) reset(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.attempts, key)
}

// prune removes empty and expired buckets. The server calls it periodically
// from allow; tests call it directly.
func (r *rateLimiter) prune() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneLocked(r.now())
}

func (r *rateLimiter) pruneLocked(now time.Time) {
	cutoff := now.Add(-r.window)
	for key, list := range r.attempts {
		kept := pruneTimestamps(list, cutoff)
		if len(kept) == 0 {
			delete(r.attempts, key)
			continue
		}
		r.attempts[key] = kept
	}
}

func pruneTimestamps(list []time.Time, cutoff time.Time) []time.Time {
	kept := list[:0]
	for _, at := range list {
		if at.After(cutoff) {
			kept = append(kept, at)
		}
	}
	return kept
}
