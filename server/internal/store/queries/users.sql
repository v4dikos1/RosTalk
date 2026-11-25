-- name: GetUserByPublicKey :one
SELECT * FROM users WHERE public_key = ?;

-- name: GetUserByID :one
SELECT * FROM users WHERE id = ?;

-- name: ListUsers :many
SELECT * FROM users ORDER BY id;

-- name: UpsertUser :one
INSERT INTO users (public_key, nickname, created_at, last_seen_at)
VALUES (?, ?, ?, ?)
ON CONFLICT (public_key) DO UPDATE SET
    nickname     = excluded.nickname,
    last_seen_at = excluded.last_seen_at
RETURNING *;

-- name: SetUserAdmin :one
UPDATE users SET is_admin = 1 WHERE public_key = ? RETURNING *;

-- name: CountAdmins :one
SELECT count(*) FROM users WHERE is_admin = 1;

-- name: CountUsers :one
SELECT count(*) FROM users;

-- name: UpdateUserNickname :exec
UPDATE users SET nickname = ?, last_seen_at = ? WHERE id = ?;

-- name: SetUserAvatar :exec
UPDATE users SET avatar_hash = ? WHERE id = ?;

-- name: CountUsersWithAvatar :one
SELECT count(*) FROM users WHERE avatar_hash = ?;

-- name: FindUserByNickname :one
SELECT * FROM users WHERE nickname = ? COLLATE NOCASE LIMIT 1;

