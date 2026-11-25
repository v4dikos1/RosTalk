package chat

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"  // registers the GIF decoder for dimensions
	_ "image/jpeg" // registers the JPEG decoder for dimensions
	_ "image/png"  // registers the PNG decoder for dimensions
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/store"
	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

// Default attachment limits, used when the settings table has no row yet.
const (
	// DefaultMaxAttachmentBytes is also the value the admin API reports before
	// an administrator has chosen a limit.
	DefaultMaxAttachmentBytes = store.DefaultMaxAttachmentBytes
	DefaultAttachmentQuota    = 1 << 30 // 1 GiB per server
)

// sniffPrefix is how many leading bytes classify inspects. It matches what
// http.DetectContentType needs and is also enough for image dimensions in the
// formats we accept.
const sniffPrefix = 512

// Attachment is an image the client may render inline. SVG, HTML and anything
// the browser could execute are never in this set: they are rejected at upload.
func IsImageType(contentType string) bool {
	switch contentType {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}

// IsPlayableType reports whether a browser can show the attachment with a
// built-in media player. Video and audio are not scriptable, so they may be
// served inline after the upload sniffed their type.
func IsPlayableType(contentType string) bool {
	return strings.HasPrefix(contentType, "video/") || strings.HasPrefix(contentType, "audio/")
}

// IsInlineType reports whether the attachment may be rendered in the message
// instead of being downloaded. HTML, SVG, XML and archives are never here.
func IsInlineType(contentType string) bool {
	return IsImageType(contentType) || IsPlayableType(contentType)
}

// IsArchiveType reports whether the attachment is a compressed archive. These
// are accepted but only as downloads: the browser never unpacks them inline.
func IsArchiveType(contentType string) bool {
	switch contentType {
	case "application/zip", "application/x-rar-compressed", "application/x-7z-compressed":
		return true
	default:
		return false
	}
}

// attachLimits reads the current limits with their defaults.
func (s *Service) attachLimits() (maxFile, quota int64) {
	settings := s.settings()
	maxFile = settings.MaxAttachmentBytesOrDefault()
	quota = settings.AttachmentQuotaBytes
	if quota <= 0 {
		quota = DefaultAttachmentQuota
	}
	return maxFile, quota
}

// MaxAttachmentBytes returns the current per-file limit.
func (s *Service) MaxAttachmentBytes() int64 {
	maxFile, _ := s.attachLimits()
	return maxFile
}

// requireAttach checks PERMISSION_ATTACH_FILES for the target conversation.
func (s *Service) requireAttach(ctx context.Context, userID int64, conv Conversation) error {
	if err := conv.Validate(); err != nil {
		return err
	}
	if conv.IsDM() {
		if err := s.requirePeer(ctx, userID, conv); err != nil {
			return err
		}
		if !s.roles.Can(userID, rostalkv1.Permission_PERMISSION_ATTACH_FILES, 0) {
			return ErrPermissionDenied
		}
		return nil
	}
	if !s.roles.Can(userID, rostalkv1.Permission_PERMISSION_VIEW_CHANNEL, conv.ChannelID) {
		return ErrInvalidTarget
	}
	if !s.roles.Can(userID, rostalkv1.Permission_PERMISSION_ATTACH_FILES, conv.ChannelID) {
		return ErrPermissionDenied
	}
	return nil
}

// Upload stores one file and returns its attachment row. The row stays
// unclaimed until a SendMessage references it. fileName is a display name
// only: the stored path is always a server-generated random name.
//
// The body is written to a temporary file as it arrives: a 25 MiB video never
// sits in memory, and a client that disappears halfway leaves only a partial
// file that is removed before returning. The content type is decided by the
// first sniffPrefix bytes, the SHA-256 is computed while writing, and only a
// complete file is renamed into place (stage P3).
func (s *Service) Upload(ctx context.Context, userID int64, conv Conversation, fileName string, source io.Reader) (Attachment, error) {
	if err := s.requireAttach(ctx, userID, conv); err != nil {
		return Attachment{}, err
	}
	// Wait for a read slot before touching the disk. Requests queued here
	// have not written anything yet; a disconnected client leaves the queue
	// through its context.
	select {
	case s.uploadSlots <- struct{}{}:
		defer func() { <-s.uploadSlots }()
	case <-ctx.Done():
		return Attachment{}, ctx.Err()
	}
	maxFile, quota := s.attachLimits()

	// Fail fast instead of streaming a file that cannot fit. The quota is
	// checked again while writing and once more under the lock below; this
	// early read only keeps an obviously impossible upload off the disk.
	s.quotaMu.Lock()
	used, err := s.store.Queries().SumAttachmentBytes(ctx)
	s.quotaMu.Unlock()
	if err != nil {
		return Attachment{}, fmt.Errorf("sum attachment bytes: %w", err)
	}
	if used >= quota {
		return Attachment{}, ErrQuotaExceeded
	}

	storedName, err := randomStoredName()
	if err != nil {
		return Attachment{}, err
	}
	finalPath, err := s.storedPath(storedName)
	if err != nil {
		return Attachment{}, err
	}
	// The temporary file lives in the attachment directory on purpose:
	// os.Rename is only atomic inside one filesystem, and the data directory
	// may be a different volume from the system temporary directory.
	tmpPath := finalPath + ".upload"
	file, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return Attachment{}, fmt.Errorf("create attachment file: %w", err)
	}
	kept := false
	defer func() {
		_ = file.Close()
		_ = os.Remove(tmpPath)
		if !kept {
			_ = os.Remove(finalPath)
		}
	}()

	header := make([]byte, sniffPrefix)
	read, readErr := io.ReadFull(source, header)
	if readErr != nil && !errors.Is(readErr, io.ErrUnexpectedEOF) && !errors.Is(readErr, io.EOF) {
		return Attachment{}, uploadReadError(readErr)
	}
	if read == 0 {
		return Attachment{}, ErrUnsupportedType
	}
	contentType, width, height, err := classify(header[:read])
	if err != nil {
		return Attachment{}, err
	}
	hasher := sha256.New()
	if _, err := file.Write(header[:read]); err != nil {
		return Attachment{}, fmt.Errorf("write attachment: %w", err)
	}
	if _, err := hasher.Write(header[:read]); err != nil {
		return Attachment{}, fmt.Errorf("hash attachment: %w", err)
	}
	written := int64(read)

	// One extra byte beyond the limit is enough to tell "exactly at the limit"
	// from "too large" without reading the whole oversized body.
	remaining := io.LimitReader(source, maxFile+1-written)
	buffer := make([]byte, 64<<10)
	for {
		chunk, chunkErr := remaining.Read(buffer)
		if chunk > 0 {
			if used+written+int64(chunk) > quota {
				return Attachment{}, ErrQuotaExceeded
			}
			if _, err := file.Write(buffer[:chunk]); err != nil {
				return Attachment{}, fmt.Errorf("write attachment: %w", err)
			}
			if _, err := hasher.Write(buffer[:chunk]); err != nil {
				return Attachment{}, fmt.Errorf("hash attachment: %w", err)
			}
			written += int64(chunk)
			if written > maxFile {
				return Attachment{}, ErrUploadTooLarge
			}
		}
		if chunkErr == io.EOF {
			break
		}
		if chunkErr != nil {
			return Attachment{}, uploadReadError(chunkErr)
		}
	}

	// Flush to disk before the rename so a crash cannot expose a renamed but
	// empty file. Any error here removes the temporary file through defer.
	if err := file.Sync(); err != nil {
		return Attachment{}, fmt.Errorf("flush attachment: %w", err)
	}
	if err := file.Close(); err != nil {
		return Attachment{}, fmt.Errorf("close attachment: %w", err)
	}

	s.quotaMu.Lock()
	defer s.quotaMu.Unlock()
	// Re-read the quota after the stream: other uploads may have used the
	// remaining space while this body was arriving.
	used, err = s.store.Queries().SumAttachmentBytes(ctx)
	if err != nil {
		return Attachment{}, fmt.Errorf("sum attachment bytes: %w", err)
	}
	if used+written > quota {
		return Attachment{}, ErrQuotaExceeded
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return Attachment{}, fmt.Errorf("store attachment: %w", err)
	}
	row, err := s.store.Queries().InsertAttachment(ctx, db.InsertAttachmentParams{
		UploaderID:  userID,
		FileName:    sanitizeFileName(fileName),
		StoredName:  storedName,
		ContentType: contentType,
		SizeBytes:   written,
		Width:       width,
		Height:      height,
		CreatedAt:   s.now().UnixMilli(),
		Sha256:      hex.EncodeToString(hasher.Sum(nil)),
	})
	if err != nil {
		return Attachment{}, fmt.Errorf("insert attachment: %w", err)
	}
	kept = true
	return attachmentFromRow(row), nil
}

// uploadReadError maps a failure from the request body. MaxBytesReader
// reports a typed error when the handler's cap is hit; everything else is a
// transport failure and keeps its cause for the log.
func uploadReadError(err error) error {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return ErrUploadTooLarge
	}
	return fmt.Errorf("read upload: %w", err)
}

// Open resolves an attachment for one user and returns its path on disk. The
// caller must have received it in a message, or be its uploader before the
// upload is claimed.
func (s *Service) Open(ctx context.Context, userID, attachmentID int64) (Attachment, string, error) {
	row, err := s.store.Queries().GetAttachment(ctx, attachmentID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Attachment{}, "", ErrNotFound
		}
		return Attachment{}, "", fmt.Errorf("get attachment: %w", err)
	}
	attachment := attachmentFromRow(row)
	if !row.MessageID.Valid {
		if row.UploaderID != userID || s.now().Sub(time.UnixMilli(row.CreatedAt)) > UploadGrace {
			return Attachment{}, "", ErrNotFound
		}
		path, pathErr := s.storedPath(row.StoredName)
		if pathErr != nil {
			return Attachment{}, "", ErrNotFound
		}
		return attachment, path, nil
	}
	message, err := s.loadMessage(ctx, row.MessageID.Int64)
	if err != nil {
		return Attachment{}, "", err
	}
	if message.ChannelID != 0 {
		if !s.roles.Can(userID, rostalkv1.Permission_PERMISSION_VIEW_CHANNEL, message.ChannelID) {
			return Attachment{}, "", ErrNotFound
		}
	} else if message.SenderID != userID && message.RecipientID != userID {
		return Attachment{}, "", ErrNotFound
	}
	path, pathErr := s.storedPath(row.StoredName)
	if pathErr != nil {
		return Attachment{}, "", ErrNotFound
	}
	return attachment, path, nil
}

// checkAttachments validates the uploads a SendMessage wants to claim.
func (s *Service) checkAttachments(ctx context.Context, userID int64, ids []uint64) error {
	seen := make(map[uint64]struct{}, len(ids))
	for _, rawID := range ids {
		if rawID == 0 {
			return ErrAttachmentInvalid
		}
		if _, duplicate := seen[rawID]; duplicate {
			return ErrAttachmentInvalid
		}
		seen[rawID] = struct{}{}
		row, err := s.store.Queries().GetAttachment(ctx, int64(rawID))
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrAttachmentInvalid
			}
			return fmt.Errorf("get attachment %d: %w", rawID, err)
		}
		if row.UploaderID != userID || row.MessageID.Valid {
			return ErrAttachmentInvalid
		}
		if s.now().Sub(time.UnixMilli(row.CreatedAt)) > UploadGrace {
			return ErrAttachmentInvalid
		}
	}
	return nil
}

// Sweep removes messages older than the configured retention and orphaned
// uploads. It works in small batches, so a large history never holds a write
// transaction for long (design 4.1, "without blocking the whole server").
func (s *Service) Sweep(ctx context.Context) (int, error) {
	settings := s.settings()
	removed := 0
	if settings.MessageRetentionDays > 0 {
		cutoff := s.now().AddDate(0, 0, -settings.MessageRetentionDays).UnixMilli()
		for {
			ids, err := s.store.Queries().ListExpiredMessageIDs(ctx, db.ListExpiredMessageIDsParams{
				CreatedAt: cutoff,
				Limit:     200,
			})
			if err != nil {
				return removed, fmt.Errorf("list expired messages: %w", err)
			}
			if len(ids) == 0 {
				break
			}
			for _, id := range ids {
				files, fileErr := s.store.Queries().ListMessageAttachmentFiles(ctx, sql.NullInt64{Int64: id, Valid: true})
				if fileErr != nil {
					return removed, fmt.Errorf("list attachment files: %w", fileErr)
				}
				if err := s.store.Queries().DeleteMessage(ctx, id); err != nil {
					return removed, fmt.Errorf("delete expired message: %w", err)
				}
				for _, file := range files {
					if removeErr := s.removeStored(file.StoredName); removeErr != nil {
						s.logger.Warn("could not remove an expired attachment", "attachment_id", file.ID, "error", removeErr)
					}
				}
				removed++
			}
			if len(ids) < 200 {
				break
			}
			select {
			case <-ctx.Done():
				return removed, ctx.Err()
			default:
			}
		}
	}
	orphans, err := s.store.Queries().ListExpiredAttachments(ctx, db.ListExpiredAttachmentsParams{
		CreatedAt: s.now().Add(-UploadGrace).UnixMilli(),
		Limit:     200,
	})
	if err != nil {
		return removed, fmt.Errorf("list orphaned attachments: %w", err)
	}
	for _, orphan := range orphans {
		if err := s.store.Queries().DeleteAttachmentRow(ctx, orphan.ID); err != nil {
			return removed, fmt.Errorf("delete orphaned attachment: %w", err)
		}
		if removeErr := s.removeStored(orphan.StoredName); removeErr != nil {
			s.logger.Warn("could not remove an orphaned attachment", "attachment_id", orphan.ID, "error", removeErr)
		}
	}
	if removed > 0 {
		s.logger.Info("removed expired chat messages", "count", removed)
	}
	return removed, nil
}

// classify detects the content type from the leading bytes and extracts
// dimensions for raster images. Only formats a browser renders as inert data
// are accepted: HTML, SVG, XHTML, XML and scripts never pass.
//
// Video, audio and archives are accepted since stage P3. The first two are
// media the browser plays itself; archives are only ever served as a download
// with `Content-Disposition: attachment` and `nosniff`. None of them can run
// script, and the server decides the type from the bytes, not the file name.
func classify(data []byte) (contentType string, width, height int64, err error) {
	// net/http has no signature for 7-Zip, so a .7z file sniffs as
	// application/octet-stream. Recognise it here: archives are allowed, but
	// only as downloads, and the display name alone must not decide the type.
	if bytes.HasPrefix(data, []byte("7z\xbc\xaf\x27\x1c")) {
		return "application/x-7z-compressed", 0, 0, nil
	}
	detected := http.DetectContentType(data)
	switch {
	case IsImageType(detected):
		config, _, decodeErr := image.DecodeConfig(bytes.NewReader(data))
		if decodeErr == nil {
			width = int64(config.Width)
			height = int64(config.Height)
		}
		return detected, width, height, nil
	case detected == "application/pdf":
		return detected, 0, 0, nil
	case detected == "video/mp4", detected == "video/webm", detected == "audio/mpeg":
		return detected, 0, 0, nil
	case detected == "application/ogg":
		// Ogg carries audio (and sometimes video) in one container; the
		// canonical browser-facing name is audio/ogg.
		return "audio/ogg", 0, 0, nil
	case detected == "audio/wave", detected == "audio/x-wav":
		return "audio/wav", 0, 0, nil
	case IsArchiveType(detected):
		return detected, 0, 0, nil
	case strings.HasPrefix(detected, "text/plain"):
		// net/http does not recognise every markup dialect as such: a bare
		// <svg> or <html> body can sniff as text/plain. Refusing any text that
		// starts with a tag keeps HTML, SVG and XML out even when the browser
		// would not execute them under nosniff.
		if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 || looksLikeMarkup(data) {
			return "", 0, 0, ErrUnsupportedType
		}
		return "text/plain; charset=utf-8", 0, 0, nil
	case detected == "application/octet-stream":
		return detected, 0, 0, nil
	default:
		// text/html, image/svg+xml, text/xml and anything unrecognised are
		// refused: the attachment could be executed by a browser.
		return "", 0, 0, ErrUnsupportedType
	}
}

// looksLikeMarkup reports whether the first non-space byte opens a tag. Plain
// text that legitimately starts with "<" is rare enough to keep the stricter
// rule.
func looksLikeMarkup(data []byte) bool {
	trimmed := bytes.TrimLeft(data, " \t\r\n")
	return len(trimmed) > 0 && trimmed[0] == '<'
}

// sanitizeFileName keeps a display name safe and short. It is never a path.
func sanitizeFileName(raw string) string {
	name := strings.ReplaceAll(raw, "\\", "/")
	name = filepath.Base(name)
	name = strings.Map(func(r rune) rune {
		if r == 0 || unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	name = strings.Trim(name, ".")
	if name == "" {
		name = "file"
	}
	runes := []rune(name)
	if len(runes) > 200 {
		name = string(runes[:200])
	}
	return name
}

func randomStoredName() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate a stored file name: %w", err)
	}
	return hex.EncodeToString(raw), nil
}

// validStoredName accepts exactly what randomStoredName produces: 16 random
// bytes in lowercase hex. The value normally comes from our own insert, but the path
// is built from a database column; validating it here means a restored or
// manually edited row cannot turn an attachment read into a path traversal.
func validStoredName(name string) bool {
	if len(name) != 32 {
		return false
	}
	for _, c := range name {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func (s *Service) storedPath(storedName string) (string, error) {
	if !validStoredName(storedName) {
		return "", ErrNotFound
	}
	return filepath.Join(s.filesDir, storedName), nil
}

func (s *Service) removeStored(storedName string) error {
	path, err := s.storedPath(storedName)
	if err != nil {
		return nil
	}
	err = os.Remove(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func ensureDir(dir string) error {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("create attachment directory: %w", err)
	}
	return nil
}

func attachmentFromRow(row db.Attachment) Attachment {
	attachment := Attachment{
		ID:          row.ID,
		UploaderID:  row.UploaderID,
		FileName:    row.FileName,
		ContentType: row.ContentType,
		SizeBytes:   row.SizeBytes,
		Width:       row.Width,
		Height:      row.Height,
		Image:       IsImageType(row.ContentType),
		Sha256:      row.Sha256,
	}
	if row.MessageID.Valid {
		attachment.MessageID = row.MessageID.Int64
	}
	return attachment
}
