package avatars

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/state"
	"github.com/v4dikos1/RosTalk/server/internal/store"
)

type fixture struct {
	service *Service
	store   *store.Store
	dir     string
	now     time.Time
}

func newFixture(t testing.TB) *fixture {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "rostalk.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	service, err := New(Config{
		Store:        st,
		Hub:          state.NewHub(state.Config{}),
		Dir:          filepath.Join(dir, "avatars"),
		Now:          func() time.Time { return now },
		RateInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("new avatars: %v", err)
	}
	return &fixture{service: service, store: st, dir: filepath.Join(dir, "avatars"), now: now}
}

func (f *fixture) user(t testing.TB, key byte, nickname string) int64 {
	t.Helper()
	publicKey := bytes.Repeat([]byte{key}, 32)
	user, err := f.store.UpsertUser(context.Background(), publicKey, nickname, f.now)
	if err != nil {
		t.Fatalf("create user %s: %v", nickname, err)
	}
	return user.ID
}

func encodeRaster(t testing.TB, format string, width, height int, alpha bool) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			a := uint8(255)
			if alpha {
				a = 128
			}
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: 90, A: a})
		}
	}
	var buffer bytes.Buffer
	var err error
	switch format {
	case "jpeg":
		err = jpeg.Encode(&buffer, img, &jpeg.Options{Quality: 90})
	case "gif":
		err = gif.Encode(&buffer, img, nil)
	default:
		err = png.Encode(&buffer, img)
	}
	if err != nil {
		t.Fatalf("encode %s: %v", format, err)
	}
	return buffer.Bytes()
}

func TestSetNormalisesEveryAcceptedFormat(t *testing.T) {
	// A 2x2 transparent WebP, the smallest valid sample.
	webpData, err := base64.StdEncoding.DecodeString("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")
	if err != nil {
		t.Fatalf("decode webp fixture: %v", err)
	}
	cases := []struct {
		name   string
		data   []byte
		want   string
		format string
	}{
		{name: "png with alpha", data: encodeRaster(t, "png", 320, 200, true), want: "image/png"},
		{name: "jpeg", data: encodeRaster(t, "jpeg", 200, 400, false), want: "image/jpeg"},
		{name: "gif", data: encodeRaster(t, "gif", 90, 90, false)},
		{name: "webp", data: webpData},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := newFixture(t)
			userID := fixture.user(t, 1, "alice")
			hash, err := fixture.service.Set(context.Background(), userID, bytes.NewReader(testCase.data))
			if err != nil {
				t.Fatalf("Set: %v", err)
			}
			if !ValidHash(hash) {
				t.Fatalf("hash %q is not a sha256 hex digest", hash)
			}
			stored, err := os.ReadFile(filepath.Join(fixture.dir, hash))
			if err != nil {
				t.Fatalf("read stored avatar: %v", err)
			}
			sum := sha256.Sum256(stored)
			if hex.EncodeToString(sum[:]) != hash {
				t.Fatal("the file name is not the hash of its bytes")
			}
			decoded, format, err := image.Decode(bytes.NewReader(stored))
			if err != nil {
				t.Fatalf("decode stored avatar: %v", err)
			}
			if format != "png" && format != "jpeg" {
				t.Fatalf("stored format = %q, want png or jpeg", format)
			}
			if decoded.Bounds().Dx() != Size || decoded.Bounds().Dy() != Size {
				t.Fatalf("stored size = %v, want %dx%d", decoded.Bounds(), Size, Size)
			}
			if testCase.want != "" && format != testCase.want[6:] {
				t.Fatalf("format = %q, want %q", format, testCase.want[6:])
			}
			avatar, err := fixture.service.Open(context.Background(), hash)
			if err != nil {
				t.Fatalf("Open: %v", err)
			}
			if avatar.ContentType != testCase.want && testCase.want != "" {
				t.Fatalf("content type = %q, want %q", avatar.ContentType, testCase.want)
			}
			if avatar.Size <= 0 || avatar.Path == "" {
				t.Fatalf("unexpected avatar: %+v", avatar)
			}
			user, err := fixture.store.UserByID(context.Background(), userID)
			if err != nil {
				t.Fatalf("read user: %v", err)
			}
			if user.AvatarHash != hash {
				t.Fatalf("stored hash = %q, want %q", user.AvatarHash, hash)
			}
		})
	}
}

func TestSetRejectsBadInputWithoutPanicking(t *testing.T) {
	garbage := []byte("<html><script>alert(1)</script></html>")
	cases := []struct {
		name string
		data []byte
		want error
	}{
		{name: "html", data: garbage, want: ErrUnsupportedType},
		{name: "empty", data: nil, want: ErrUnsupportedType},
		{name: "truncated png", data: encodeRaster(t, "png", 8, 8, false)[:40], want: ErrInvalidImage},
		{name: "oversized", data: bytes.Repeat([]byte{0x89}, MaxBytes+1), want: ErrTooLarge},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := newFixture(t)
			userID := fixture.user(t, 2, "bob")
			if _, err := fixture.service.Set(context.Background(), userID, bytes.NewReader(testCase.data)); !errors.Is(err, testCase.want) {
				t.Fatalf("Set error = %v, want %v", err, testCase.want)
			}
			// The server is still usable after the bad request.
			if _, err := fixture.service.Set(context.Background(), userID, bytes.NewReader(encodeRaster(t, "png", 16, 16, false))); err != nil {
				t.Fatalf("valid upload after a bad one: %v", err)
			}
		})
	}
}

func TestHugeDimensionsAreRefusedBeforeDecoding(t *testing.T) {
	data := pngHeader(20000, 20000)
	if _, err := decodeImage(data); !errors.Is(err, ErrInvalidImage) {
		t.Fatalf("decodeImage = %v, want ErrInvalidImage", err)
	}
}

// pngHeader builds a PNG signature and a valid IHDR chunk with the requested
// dimensions and no pixels. DecodeConfig reads only that chunk.
func pngHeader(width, height uint32) []byte {
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], width)
	binary.BigEndian.PutUint32(ihdr[4:8], height)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // colour type RGBA
	chunk := make([]byte, 0, 4+4+13+4)
	chunk = append(chunk, []byte{0, 0, 0, 13}...)
	chunk = append(chunk, []byte("IHDR")...)
	chunk = append(chunk, ihdr...)
	crc := crc32.NewIEEE()
	_, _ = crc.Write([]byte("IHDR"))
	_, _ = crc.Write(ihdr)
	chunk = binary.BigEndian.AppendUint32(chunk, crc.Sum32())
	return append([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, chunk...)
}

func TestRateLimitBoundsChanges(t *testing.T) {
	fixture := newFixture(t)
	now := fixture.now
	fixture.service.now = func() time.Time { return now }
	fixture.service.interval = 10 * time.Second
	userID := fixture.user(t, 3, "carol")
	data := encodeRaster(t, "png", 20, 20, false)
	for index := 0; index < rateBurst; index++ {
		if _, err := fixture.service.Set(context.Background(), userID, bytes.NewReader(data)); err != nil {
			t.Fatalf("change %d: %v", index, err)
		}
	}
	if _, err := fixture.service.Set(context.Background(), userID, bytes.NewReader(data)); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("sixth change = %v, want ErrRateLimited", err)
	}
	now = now.Add(10 * time.Second)
	fixture.service.now = func() time.Time { return now }
	if _, err := fixture.service.Set(context.Background(), userID, bytes.NewReader(data)); err != nil {
		t.Fatalf("change after refill: %v", err)
	}
}

func TestSharedAndReplacedFilesAreCleanedUp(t *testing.T) {
	fixture := newFixture(t)
	alice := fixture.user(t, 4, "alice")
	bob := fixture.user(t, 5, "bob")
	shared := encodeRaster(t, "png", 30, 30, false)
	aliceHash, err := fixture.service.Set(context.Background(), alice, bytes.NewReader(shared))
	if err != nil {
		t.Fatalf("alice Set: %v", err)
	}
	bobHash, err := fixture.service.Set(context.Background(), bob, bytes.NewReader(shared))
	if err != nil {
		t.Fatalf("bob Set: %v", err)
	}
	if aliceHash != bobHash {
		t.Fatalf("identical pictures have different hashes: %s and %s", aliceHash, bobHash)
	}

	if err := fixture.service.Clear(context.Background(), alice); err != nil {
		t.Fatalf("alice Clear: %v", err)
	}
	if _, err := os.Stat(filepath.Join(fixture.dir, aliceHash)); err != nil {
		t.Fatalf("a file shared with bob was removed: %v", err)
	}
	if err := fixture.service.Clear(context.Background(), bob); err != nil {
		t.Fatalf("bob Clear: %v", err)
	}
	if _, err := os.Stat(filepath.Join(fixture.dir, aliceHash)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the last reference did not remove the file: %v", err)
	}

	// Replacing a picture drops the previous file.
	first, err := fixture.service.Set(context.Background(), alice, bytes.NewReader(encodeRaster(t, "png", 40, 40, false)))
	if err != nil {
		t.Fatalf("first Set: %v", err)
	}
	if _, err := fixture.service.Set(context.Background(), alice, bytes.NewReader(encodeRaster(t, "png", 60, 60, false))); err != nil {
		t.Fatalf("second Set: %v", err)
	}
	if _, err := os.Stat(filepath.Join(fixture.dir, first)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the replaced file survived: %v", err)
	}
}

func TestOpenRejectsMalformedHashes(t *testing.T) {
	fixture := newFixture(t)
	for _, hash := range []string{
		"",
		"..",
		"../../etc/passwd",
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"0123456789abcdef",
	} {
		if _, err := fixture.service.Open(context.Background(), hash); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Open(%q) = %v, want ErrNotFound", hash, err)
		}
	}
}
