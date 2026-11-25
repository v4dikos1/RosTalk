-- name: InsertApiToken :one
INSERT INTO api_tokens (name, token_hash, role_id, created_by, created_at, expires_at)
VALUES (?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: GetApiTokenByHash :one
SELECT * FROM api_tokens WHERE token_hash = ?;

-- name: ListApiTokens :many
SELECT * FROM api_tokens ORDER BY id DESC;

-- name: RevokeApiToken :exec
UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL;

-- name: TouchApiToken :exec
UPDATE api_tokens SET last_used_at = ? WHERE id = ?;
