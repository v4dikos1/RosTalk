-- name: CreateInvite :exec
INSERT INTO invites (
    token_hash, created_by, grant_admin, max_uses, used_count,
    created_at, expires_at, bootstrap, role_id
)
VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?);

-- name: GetInviteByHash :one
SELECT * FROM invites WHERE token_hash = ?;

-- name: GetInviteByID :one
SELECT * FROM invites WHERE id = ?;

-- name: ListInvites :many
SELECT * FROM invites ORDER BY id DESC;

-- name: ConsumeInvite :one
UPDATE invites
SET used_count = used_count + 1
WHERE token_hash = ?
  AND revoked_at IS NULL
  AND used_count < max_uses
  AND (expires_at IS NULL OR expires_at > ?)
RETURNING *;

-- name: RevokeBootstrapInvites :exec
UPDATE invites
SET revoked_at = ?
WHERE bootstrap = 1
  AND revoked_at IS NULL
  AND used_count < max_uses;

-- name: RevokeInvite :exec
UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL;

-- name: DeleteInvite :exec
DELETE FROM invites WHERE token_hash = ?;
