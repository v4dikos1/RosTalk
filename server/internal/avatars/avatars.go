// Package avatars stores one small picture per user (stage P11).
//
// An upload is decoded, centre-cropped to a square, scaled to 256x256 and
// re-encoded server side. The stored file is named by the SHA-256 of the
// re-encoded bytes, so two identical pictures share one file and a read may be
// cached forever. Client-supplied bytes, names and content types never reach
// the disk: only the decoder's output does.
package avatars

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // registers the WebP decoder; no CGO

	"github.com/v4dikos1/RosTalk/server/internal/state"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

const (
	// MaxBytes is the largest upload accepted, matching the API contract.
	MaxBytes = 4 << 20
	// Size is the side of the stored square.
	Size = 256
	// maxPixels bounds the decoded image before memory is allocated. A 4 MiB
	// PNG can describe a huge canvas; decoding it blindly is an OOM.
	maxPixels = 16 << 20
	// maxDimension is an additional guard against thin but enormous images.
	maxDimension = 8192
	// maxConcurrent bounds simultaneous decoders. One decoder peaks at a few
	// tens of MiB (16 MP RGBA plus the scaled copy).
	maxConcurrent = 2
	// rateBurst is how many changes a user may make back to back.
	rateBurst = 5
	// rateInterval is the refill period of one change.
	rateInterval = 20 * time.Second
	// hashHexLen is the length of a SHA-256 digest in hex.
	hashHexLen = 64
)

// Errors map to HTTP status codes in internal/httpapi.
var (
	ErrTooLarge        = errors.New("avatars: the picture is larger than 4 MiB")
	ErrUnsupportedType = errors.New("avatars: only PNG, JPEG, WebP and GIF are accepted")
	ErrInvalidImage    = errors.New("avatars: the picture could not be decoded")
	ErrRateLimited     = errors.New("avatars: too many avatar changes")
	ErrNotFound        = errors.New("avatars: avatar not found")
)

// Config wires the service.
type Config struct {
	Store  *store.Store
	Hub    *state.Hub
	Dir    string
	Logger *slog.Logger
	// Now overrides the clock in tests.
	Now func() time.Time
	// RateInterval overrides the refill period in tests.
	RateInterval time.Duration
}

// Service owns avatar files and the per-user rate limiter.
type Service struct {
	store    *store.Store
	hub      *state.Hub
	dir      string
	logger   *slog.Logger
	now      func() time.Time
	interval time.Duration

	// writeMu serialises the file/database/hub update, so two uploads of the
	// same user cannot interleave and leave the row pointing at a removed file.
	writeMu sync.Mutex

	limitMu sync.Mutex
	buckets map[int64]*bucket

	slots chan struct{}
}

type bucket struct {
	tokens float64
	last   time.Time
}

// Avatar is one stored picture.
type Avatar struct {
	Hash        string
	ContentType string
	Path        string
	Size        int64
	ModTime     time.Time
}

// New validates the wiring and creates the avatar directory.
func New(cfg Config) (*Service, error) {
	if cfg.Store == nil || cfg.Hub == nil {
		return nil, errors.New("avatars: store and hub are required")
	}
	if strings.TrimSpace(cfg.Dir) == "" {
		return nil, errors.New("avatars: directory is required")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	interval := cfg.RateInterval
	if interval <= 0 {
		interval = rateInterval
	}
	if err := os.MkdirAll(cfg.Dir, 0o750); err != nil {
		return nil, fmt.Errorf("avatars: create directory: %w", err)
	}
	return &Service{
		store:    cfg.Store,
		hub:      cfg.Hub,
		dir:      cfg.Dir,
		logger:   logger,
		now:      now,
		interval: interval,
		buckets:  make(map[int64]*bucket),
		slots:    make(chan struct{}, maxConcurrent),
	}, nil
}

// Set decodes, crops, scales and stores a picture for one user. It returns the
// content hash other clients use in User.avatar_hash.
func (s *Service) Set(ctx context.Context, userID int64, source io.Reader) (string, error) {
	if userID <= 0 {
		return "", ErrNotFound
	}
	if !s.allow(userID) {
		return "", ErrRateLimited
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	case <-ctx.Done():
		return "", ctx.Err()
	}

	processed, err := process(source)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(processed)
	avatarHash := hex.EncodeToString(hash[:])

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	// Read the previous hash before the update so an orphaned file can be
	// removed once no user references it anymore.
	previous := ""
	if user, lookupErr := s.store.UserByID(ctx, userID); lookupErr == nil {
		previous = user.AvatarHash
	} else if errors.Is(lookupErr, store.ErrNotFound) {
		return "", ErrNotFound
	}

	if err := s.writeFile(avatarHash, processed); err != nil {
		return "", err
	}
	if err := s.store.SetUserAvatar(ctx, userID, avatarHash); err != nil {
		return "", err
	}
	if _, hubErr := s.hub.SetAvatarHash(userID, avatarHash); hubErr != nil && !errors.Is(hubErr, state.ErrNotOnline) {
		s.logger.Warn("could not announce an avatar change", "user_id", userID, "error", hubErr)
	}
	s.removeUnreferenced(ctx, previous)
	return avatarHash, nil
}

// Clear removes the user's avatar. Other users sharing the same picture keep
// the file.
func (s *Service) Clear(ctx context.Context, userID int64) error {
	if userID <= 0 {
		return ErrNotFound
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	user, err := s.store.UserByID(ctx, userID)
	if err != nil {
		return err
	}
	if user.AvatarHash == "" {
		return nil
	}
	if err := s.store.SetUserAvatar(ctx, userID, ""); err != nil {
		return err
	}
	if _, hubErr := s.hub.SetAvatarHash(userID, ""); hubErr != nil && !errors.Is(hubErr, state.ErrNotOnline) {
		s.logger.Warn("could not announce an avatar removal", "user_id", userID, "error", hubErr)
	}
	s.removeUnreferenced(ctx, user.AvatarHash)
	return nil
}

// Open resolves one content hash to its stored file.
func (s *Service) Open(ctx context.Context, avatarHash string) (Avatar, error) {
	_ = ctx
	if !ValidHash(avatarHash) {
		return Avatar{}, ErrNotFound
	}
	path := filepath.Join(s.dir, avatarHash)
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Avatar{}, ErrNotFound
		}
		return Avatar{}, fmt.Errorf("open avatar %s: %w", avatarHash, err)
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return Avatar{}, fmt.Errorf("stat avatar %s: %w", avatarHash, err)
	}
	prefix := make([]byte, 512)
	read, _ := io.ReadFull(file, prefix)
	contentType := http.DetectContentType(prefix[:read])
	if contentType != "image/png" && contentType != "image/jpeg" {
		// The store only writes those two; anything else means a corrupted or
		// manually placed file and must not be served as an image.
		return Avatar{}, ErrNotFound
	}
	return Avatar{
		Hash:        avatarHash,
		ContentType: contentType,
		Path:        path,
		Size:        info.Size(),
		ModTime:     info.ModTime(),
	}, nil
}

// ValidHash reports whether value is a lowercase SHA-256 hex digest. The hash
// becomes a path component, so anything else must never reach the filesystem.
func ValidHash(value string) bool {
	if len(value) != hashHexLen {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

// removeUnreferenced deletes the file of a replaced hash when no user points
// at it anymore.
func (s *Service) removeUnreferenced(ctx context.Context, avatarHash string) {
	if !ValidHash(avatarHash) {
		return
	}
	count, err := s.store.CountUsersWithAvatar(ctx, avatarHash)
	if err != nil {
		s.logger.Warn("could not count avatar references", "error", err)
		return
	}
	if count > 0 {
		return
	}
	if err := os.Remove(filepath.Join(s.dir, avatarHash)); err != nil && !errors.Is(err, os.ErrNotExist) {
		s.logger.Warn("could not remove an unreferenced avatar", "error", err)
	}
}

func (s *Service) writeFile(avatarHash string, data []byte) error {
	finalPath := filepath.Join(s.dir, avatarHash)
	if _, err := os.Stat(finalPath); err == nil {
		// Content-addressed: the same hash means the same bytes.
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("stat avatar file: %w", err)
	}
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		return fmt.Errorf("name avatar temp file: %w", err)
	}
	tmpPath := finalPath + ".tmp-" + hex.EncodeToString(suffix)
	file, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create avatar file: %w", err)
	}
	cleanup := true
	defer func() {
		_ = file.Close()
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := file.Write(data); err != nil {
		return fmt.Errorf("write avatar: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("flush avatar: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close avatar: %w", err)
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return fmt.Errorf("store avatar: %w", err)
	}
	cleanup = false
	return nil
}

func (s *Service) allow(userID int64) bool {
	now := s.now()
	s.limitMu.Lock()
	defer s.limitMu.Unlock()
	current, ok := s.buckets[userID]
	if !ok {
		current = &bucket{tokens: rateBurst, last: now}
		s.buckets[userID] = current
	}
	elapsed := now.Sub(current.last)
	if elapsed > 0 {
		current.tokens += elapsed.Seconds() / s.interval.Seconds()
		if current.tokens > rateBurst {
			current.tokens = rateBurst
		}
	}
	current.last = now
	if current.tokens < 1 {
		return false
	}
	current.tokens -= 1
	if len(s.buckets) > 1024 {
		for id, entry := range s.buckets {
			if now.Sub(entry.last) > time.Minute {
				delete(s.buckets, id)
			}
		}
	}
	return true
}

// process validates and normalises the upload. It returns PNG or JPEG bytes;
// the caller never sees the client's bytes.
func process(source io.Reader) ([]byte, error) {
	limited := &io.LimitedReader{R: source, N: MaxBytes + 1}
	raw, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("read avatar: %w", err)
	}
	if len(raw) == 0 {
		return nil, ErrUnsupportedType
	}
	if int64(len(raw)) > MaxBytes {
		return nil, ErrTooLarge
	}
	prefix := raw
	if len(prefix) > 512 {
		prefix = prefix[:512]
	}
	detected := http.DetectContentType(prefix)
	switch detected {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
	default:
		return nil, ErrUnsupportedType
	}
	img, decodeErr := decodeImage(raw)
	if decodeErr != nil {
		return nil, decodeErr
	}
	scaled := image.NewRGBA(image.Rect(0, 0, Size, Size))
	draw.CatmullRom.Scale(scaled, scaled.Bounds(), img, centreSquare(img.Bounds()), draw.Src, nil)

	var buffer bytes.Buffer
	if hasAlpha(scaled) {
		if err := png.Encode(&buffer, scaled); err != nil {
			return nil, fmt.Errorf("encode avatar png: %w", err)
		}
		return buffer.Bytes(), nil
	}
	if err := jpeg.Encode(&buffer, scaled, &jpeg.Options{Quality: 90}); err != nil {
		return nil, fmt.Errorf("encode avatar jpeg: %w", err)
	}
	return buffer.Bytes(), nil
}

// decodeImage reads the header first and refuses a picture that would decode
// into too much memory. The recover guards against a decoder panic on malformed
// input: a bad file must never take the server down.
func decodeImage(raw []byte) (img image.Image, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			img = nil
			err = ErrInvalidImage
		}
	}()
	config, _, configErr := image.DecodeConfig(bytes.NewReader(raw))
	if configErr != nil {
		return nil, ErrInvalidImage
	}
	if config.Width <= 0 || config.Height <= 0 ||
		config.Width > maxDimension || config.Height > maxDimension ||
		int64(config.Width)*int64(config.Height) > maxPixels {
		return nil, ErrInvalidImage
	}
	decoded, _, decodeErr := image.Decode(bytes.NewReader(raw))
	if decodeErr != nil {
		return nil, ErrInvalidImage
	}
	return decoded, nil
}

// centreSquare is the largest square in the middle of the picture.
func centreSquare(bounds image.Rectangle) image.Rectangle {
	width := bounds.Dx()
	height := bounds.Dy()
	if width == height {
		return bounds
	}
	if width > height {
		offset := (width - height) / 2
		return image.Rect(bounds.Min.X+offset, bounds.Min.Y, bounds.Min.X+offset+height, bounds.Min.Y+height)
	}
	offset := (height - width) / 2
	return image.Rect(bounds.Min.X, bounds.Min.Y+offset, bounds.Min.X+width, bounds.Min.Y+offset+width)
}

func hasAlpha(img *image.RGBA) bool {
	for index := 3; index < len(img.Pix); index += 4 {
		if img.Pix[index] != 0xff {
			return true
		}
	}
	return false
}
