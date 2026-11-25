package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/store/db"
)

// APIToken is the typed view of one row of api_tokens. The secret itself is
// never part of it: only the SHA-256 hash is stored.
type APIToken struct {
	ID         int64
	Name       string
	RoleID     int64
	CreatedBy  int64
	CreatedAt  time.Time
	ExpiresAt  *time.Time
	RevokedAt  *time.Time
	LastUsedAt *time.Time
}

// APITokenOptions describes a new token.
type APITokenOptions struct {
	Name      string
	RoleID    int64
	CreatedBy int64
	ExpiresAt *time.Time
}

// BanEntry is one row of the bans table for the admin API.
type BanEntry struct {
	ID        int64
	PublicKey []byte
	IP        string
	Reason    string
	CreatedBy int64
	CreatedAt time.Time
	ExpiresAt *time.Time
}

func apiTokenFromRow(row db.ApiToken) APIToken {
	token := APIToken{
		ID:        row.ID,
		Name:      row.Name,
		CreatedAt: time.UnixMilli(row.CreatedAt).UTC(),
	}
	if row.RoleID.Valid {
		token.RoleID = row.RoleID.Int64
	}
	if row.CreatedBy.Valid {
		token.CreatedBy = row.CreatedBy.Int64
	}
	if row.ExpiresAt.Valid {
		value := time.UnixMilli(row.ExpiresAt.Int64).UTC()
		token.ExpiresAt = &value
	}
	if row.RevokedAt.Valid {
		value := time.UnixMilli(row.RevokedAt.Int64).UTC()
		token.RevokedAt = &value
	}
	if row.LastUsedAt.Valid {
		value := time.UnixMilli(row.LastUsedAt.Int64).UTC()
		token.LastUsedAt = &value
	}
	return token
}

// HashAPIToken returns the SHA-256 hash stored in the api_tokens table.
func HashAPIToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// CreateAPIToken generates a token, stores only its hash and returns the
// plaintext once. The caller must show it to the user and then forget it.
func (s *Store) CreateAPIToken(ctx context.Context, opts APITokenOptions) (APIToken, string, error) {
	if opts.Name == "" {
		return APIToken{}, "", errors.New("api token name must not be empty")
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return APIToken{}, "", fmt.Errorf("generate api token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	var roleID sql.NullInt64
	if opts.RoleID != 0 {
		roleID = sql.NullInt64{Int64: opts.RoleID, Valid: true}
	}
	var createdBy sql.NullInt64
	if opts.CreatedBy != 0 {
		createdBy = sql.NullInt64{Int64: opts.CreatedBy, Valid: true}
	}
	var expires sql.NullInt64
	if opts.ExpiresAt != nil {
		expires = sql.NullInt64{Int64: opts.ExpiresAt.UnixMilli(), Valid: true}
	}
	row, err := s.q.InsertApiToken(ctx, db.InsertApiTokenParams{
		Name:      opts.Name,
		TokenHash: HashAPIToken(token),
		RoleID:    roleID,
		CreatedBy: createdBy,
		CreatedAt: time.Now().UnixMilli(),
		ExpiresAt: expires,
	})
	if err != nil {
		return APIToken{}, "", fmt.Errorf("insert api token: %w", err)
	}
	return apiTokenFromRow(row), token, nil
}

// APITokenByToken looks a token up by its plaintext value. It returns
// ErrNotFound for unknown, revoked and expired tokens so callers cannot learn
// which of the three happened.
func (s *Store) APITokenByToken(ctx context.Context, token string, now time.Time) (APIToken, error) {
	if token == "" {
		return APIToken{}, ErrNotFound
	}
	row, err := s.q.GetApiTokenByHash(ctx, HashAPIToken(token))
	if errors.Is(err, sql.ErrNoRows) {
		return APIToken{}, ErrNotFound
	}
	if err != nil {
		return APIToken{}, fmt.Errorf("get api token: %w", err)
	}
	out := apiTokenFromRow(row)
	if out.RevokedAt != nil || (out.ExpiresAt != nil && !out.ExpiresAt.After(now)) {
		return APIToken{}, ErrNotFound
	}
	return out, nil
}

// ListAPITokens returns every token, newest first, without secrets.
func (s *Store) ListAPITokens(ctx context.Context) ([]APIToken, error) {
	rows, err := s.q.ListApiTokens(ctx)
	if err != nil {
		return nil, fmt.Errorf("list api tokens: %w", err)
	}
	out := make([]APIToken, 0, len(rows))
	for _, row := range rows {
		out = append(out, apiTokenFromRow(row))
	}
	return out, nil
}

// RevokeAPIToken marks a token revoked at now.
func (s *Store) RevokeAPIToken(ctx context.Context, id int64, now time.Time) error {
	if err := s.q.RevokeApiToken(ctx, db.RevokeApiTokenParams{
		RevokedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true},
		ID:        id,
	}); err != nil {
		return fmt.Errorf("revoke api token %d: %w", id, err)
	}
	return nil
}

// TouchAPIToken records the last successful use without blocking the request on
// a failure: the caller may ignore the error.
func (s *Store) TouchAPIToken(ctx context.Context, id int64, now time.Time) error {
	if err := s.q.TouchApiToken(ctx, db.TouchApiTokenParams{
		LastUsedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true},
		ID:         id,
	}); err != nil {
		return fmt.Errorf("touch api token %d: %w", id, err)
	}
	return nil
}

// ListBans returns every ban, newest first, including expired ones. The caller
// filters by expiry when it wants active bans only.
func (s *Store) ListBans(ctx context.Context) ([]BanEntry, error) {
	rows, err := s.q.ListBans(ctx)
	if err != nil {
		return nil, fmt.Errorf("list bans: %w", err)
	}
	out := make([]BanEntry, 0, len(rows))
	for _, row := range rows {
		entry := BanEntry{
			ID:        row.ID,
			PublicKey: row.PublicKey,
			Reason:    row.Reason,
			CreatedAt: time.UnixMilli(row.CreatedAt).UTC(),
		}
		if row.Ip.Valid {
			entry.IP = row.Ip.String
		}
		if row.CreatedBy.Valid {
			entry.CreatedBy = row.CreatedBy.Int64
		}
		if row.ExpiresAt.Valid {
			value := time.UnixMilli(row.ExpiresAt.Int64).UTC()
			entry.ExpiresAt = &value
		}
		out = append(out, entry)
	}
	return out, nil
}
