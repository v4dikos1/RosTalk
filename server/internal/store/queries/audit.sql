-- name: InsertAuditEntry :one
INSERT INTO audit_log (
    actor_id, actor_name, action, target_user_id, target_channel_id,
    target_role_id, details, created_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: ListAuditEntries :many
SELECT * FROM audit_log
WHERE (sqlc.arg(before_id) = 0 OR id < sqlc.arg(before_id))
ORDER BY id DESC
LIMIT sqlc.arg(page_size);

-- name: ListAuditEntriesFiltered :many
SELECT * FROM audit_log
WHERE (sqlc.arg(before_id) = 0 OR id < sqlc.arg(before_id))
  AND (sqlc.arg(action_prefix) = '' OR action LIKE sqlc.arg(action_prefix) || '%')
  AND (sqlc.arg(actor_id) = 0 OR actor_id = sqlc.arg(actor_id))
ORDER BY id DESC
LIMIT sqlc.arg(page_size);
