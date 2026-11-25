package media

import (
	"sync"
	"sync/atomic"
)

// DefaultEventBuffer is how many media events may be pending before new ones
// are dropped. Media events are advisory for the control plane in this stage
// (the client measures who speaks itself, design 4.6), so a slow consumer must
// never stall the media plane or the reconciler.
const DefaultEventBuffer = 256

// EventBus is the event stream of a backend.
//
// Publishing never blocks: when the buffer is full the event is dropped and
// counted, which keeps a stalled consumer from stalling the SFU poller. The
// supervisor publishes into it; the server reads from Events.
type EventBus struct {
	ch      chan Event
	dropped atomic.Uint64

	// mu makes Publish and Close mutually exclusive. A plain atomic flag is
	// not enough: a publisher that observed "open" could still reach the send
	// after Close closed the channel and panic the whole server at shutdown.
	mu     sync.RWMutex
	closed bool
}

// NewEventBus creates a bus with room for size events.
func NewEventBus(size int) *EventBus {
	if size <= 0 {
		size = DefaultEventBuffer
	}
	return &EventBus{ch: make(chan Event, size)}
}

// Events returns the receive side.
func (b *EventBus) Events() <-chan Event { return b.ch }

// Publish queues one event without blocking.
func (b *EventBus) Publish(event Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.closed {
		return
	}
	select {
	case b.ch <- event:
	default:
		b.dropped.Add(1)
	}
}

// Dropped returns how many events were dropped because nobody consumed them.
func (b *EventBus) Dropped() uint64 { return b.dropped.Load() }

// Close closes the stream. Further Publish calls are ignored.
func (b *EventBus) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	close(b.ch)
}
