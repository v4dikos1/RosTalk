-- name: CreateBan :exec
INSERT INTO bans (public_key, ip, reason, created_by, created_at, expires_at)
VALUES (?, ?, ?, ?, ?, ?);

-- name: GetActiveBanByPublicKey :one
SELECT * FROM bans
WHERE public_key = ?
  AND (expires_at IS NULL OR expires_at > ?);

-- name: GetActiveBanByIP :one
SELECT * FROM bans
WHERE ip = ?
  AND (expires_at IS NULL OR expires_at > ?);

-- name: ListBans :many
SELECT * FROM bans ORDER BY id DESC;

-- name: DeleteExpiredBans :exec
DELETE FROM bans WHERE expires_at IS NOT NULL AND expires_at <= ?;

-- name: DeleteBanByPublicKey :exec
DELETE FROM bans WHERE public_key = ?;

-- name: DeleteBanByIP :exec
DELETE FROM bans WHERE ip = ?;
