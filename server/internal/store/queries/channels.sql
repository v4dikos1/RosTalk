-- name: ListChannels :many
SELECT * FROM channels ORDER BY (parent_id IS NOT NULL), parent_id, position, id;

-- name: GetChannel :one
SELECT * FROM channels WHERE id = ?;

-- name: InsertChannel :one
INSERT INTO channels (
    parent_id, position, name, topic, kind, user_limit, password_hash,
    voice_profile, temporary, afk, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: UpdateChannel :one
UPDATE channels SET
    parent_id     = ?,
    position      = ?,
    name          = ?,
    topic         = ?,
    kind          = ?,
    user_limit    = ?,
    password_hash = ?,
    voice_profile = ?,
    temporary     = ?,
    afk           = ?
WHERE id = ?
RETURNING *;

-- name: SetChannelPlacement :exec
UPDATE channels SET parent_id = ?, position = ? WHERE id = ?;

-- name: DeleteChannel :exec
DELETE FROM channels WHERE id = ?;

-- name: CountChannels :one
SELECT count(*) FROM channels;
