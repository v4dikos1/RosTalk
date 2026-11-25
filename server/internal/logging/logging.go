// Package logging provides the server's size-based log rotation.
//
// The shipped unit already writes to the journal, but an operator who keeps a
// file next to the data directory must not lose the current line when the file
// grows. The writer rotates before it writes the line that would cross the
// limit: the active file is renamed to ".1", older files shift, and a fresh
// file is opened. Nothing is truncated, so every line survives.
package logging

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

// DefaultMaxSize is 10 MiB: a busy server with 50 users writes a few hundred
// kilobytes a day, so this is several weeks of history.
const DefaultMaxSize int64 = 10 << 20

// DefaultKeep is how many rotated files are kept next to the active one.
const DefaultKeep = 5

// RotatingWriter is an io.Writer that keeps path under maxSize bytes and
// rotates through path.1 .. path.<keep>. It is safe for concurrent use.
type RotatingWriter struct {
	mu      sync.Mutex
	path    string
	maxSize int64
	keep    int
	file    *os.File
	size    int64
}

// New opens (or creates) path and its directory. Permissions are 0600: the log
// carries user ids and channel names, never tokens or message bodies.
func New(path string, maxSize int64, keep int) (*RotatingWriter, error) {
	if path == "" {
		return nil, errors.New("logging: log file path must not be empty")
	}
	if maxSize <= 0 {
		maxSize = DefaultMaxSize
	}
	if keep <= 0 {
		keep = DefaultKeep
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("logging: create %q: %w", filepath.Dir(path), err)
	}
	w := &RotatingWriter{path: path, maxSize: maxSize, keep: keep}
	if err := w.open(); err != nil {
		return nil, err
	}
	return w, nil
}

// Write appends p, rotating first when the write would cross the limit. A
// single line larger than the limit is still written whole to the new file so
// the log never contains a partial line from the writer itself.
func (w *RotatingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		if err := w.open(); err != nil {
			return 0, err
		}
	}
	if w.size > 0 && w.size+int64(len(p)) > w.maxSize {
		if err := w.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := w.file.Write(p)
	w.size += int64(n)
	return n, err
}

// Close closes the active file.
func (w *RotatingWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

// Size returns the current size of the active file (tests and diagnostics).
func (w *RotatingWriter) Size() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.size
}

func (w *RotatingWriter) open() error {
	file, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("logging: open %q: %w", w.path, err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return fmt.Errorf("logging: stat %q: %w", w.path, err)
	}
	w.file = file
	w.size = info.Size()
	return nil
}

// rotate closes the active file, shifts path.N to path.N+1 and reopens an
// empty path. The oldest file beyond keep is removed. A missing file is not an
// error: the first rotation simply creates the chain.
func (w *RotatingWriter) rotate() error {
	if err := w.file.Close(); err != nil {
		return fmt.Errorf("logging: close %q: %w", w.path, err)
	}
	w.file = nil

	if w.keep > 0 {
		_ = os.Remove(w.shifted(w.keep))
		for i := w.keep - 1; i >= 1; i-- {
			if err := os.Rename(w.shifted(i), w.shifted(i+1)); err != nil && !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("logging: rotate %q: %w", w.shifted(i), err)
			}
		}
		if err := os.Rename(w.path, w.shifted(1)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("logging: rotate %q: %w", w.path, err)
		}
	} else if err := os.Remove(w.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("logging: remove %q: %w", w.path, err)
	}
	return w.open()
}

func (w *RotatingWriter) shifted(index int) string {
	return w.path + "." + strconv.Itoa(index)
}
