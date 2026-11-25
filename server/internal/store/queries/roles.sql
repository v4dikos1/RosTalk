-- name: ListRoles :many
SELECT * FROM roles ORDER BY position, id;

-- name: GetRole :one
SELECT * FROM roles WHERE id = ?;

-- name: GetRoleByName :one
SELECT * FROM roles WHERE name = ? COLLATE NOCASE;

-- name: InsertRole :one
INSERT INTO roles (name, color, position, permissions, builtin, created_at)
VALUES (?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: UpdateRole :one
UPDATE roles SET
    name        = ?,
    color       = ?,
    position    = ?,
    permissions = ?
WHERE id = ?
RETURNING *;

-- name: SetRolePosition :exec
UPDATE roles SET position = ? WHERE id = ?;

-- name: DeleteRole :exec
DELETE FROM roles WHERE id = ?;

-- name: CountRoles :one
SELECT count(*) FROM roles;

-- name: ListUserRoles :many
SELECT user_id, role_id FROM user_roles ORDER BY user_id, role_id;

-- name: ListUserRolesOfUser :many
SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY role_id;

-- name: AssignUserRole :exec
INSERT INTO user_roles (user_id, role_id, assigned_at)
VALUES (?, ?, ?)
ON CONFLICT (user_id, role_id) DO NOTHING;

-- name: UnassignUserRole :exec
DELETE FROM user_roles WHERE user_id = ? AND role_id = ?;

-- name: DeleteUserRoles :exec
DELETE FROM user_roles WHERE user_id = ?;

-- name: ListChannelOverrides :many
SELECT * FROM channel_overrides ORDER BY channel_id, role_id;

-- name: UpsertChannelOverride :exec
INSERT INTO channel_overrides (channel_id, role_id, allow, deny)
VALUES (?, ?, ?, ?)
ON CONFLICT (channel_id, role_id) DO UPDATE SET
    allow = excluded.allow,
    deny  = excluded.deny;

-- name: DeleteChannelOverride :exec
DELETE FROM channel_overrides WHERE channel_id = ? AND role_id = ?;

-- name: DeleteChannelOverrides :exec
DELETE FROM channel_overrides WHERE channel_id = ?;
