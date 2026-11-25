-- Stage 4.1 chat storage. Cursors are message ids: history returns ids lower
-- than the cursor, newest first, and the caller reverses the page.

-- name: InsertMessage :one
INSERT INTO messages (channel_id, sender_id, recipient_id, body, created_at)
VALUES (?, ?, ?, ?, ?)
RETURNING *;

-- name: GetMessage :one
SELECT * FROM messages WHERE id = ?;

-- name: UpdateMessageBody :exec
UPDATE messages SET body = ?, edited_at = ? WHERE id = ?;

-- name: DeleteMessage :exec
DELETE FROM messages WHERE id = ?;

-- name: ListChannelMessagesBefore :many
SELECT m.*, u.nickname AS sender_nickname
FROM messages m
JOIN users u ON u.id = m.sender_id
WHERE m.channel_id = ? AND m.id < ?
ORDER BY m.id DESC
LIMIT ?;

-- name: ListDMMessagesBefore :many
SELECT m.*, u.nickname AS sender_nickname
FROM messages m
JOIN users u ON u.id = m.sender_id
WHERE ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
  AND m.id < ?
ORDER BY m.id DESC
LIMIT ?;

-- name: GetMessageView :one
SELECT m.*, u.nickname AS sender_nickname
FROM messages m
JOIN users u ON u.id = m.sender_id
WHERE m.id = ?;

-- name: ListChannelMessagesAfter :many
SELECT m.*, u.nickname AS sender_nickname
FROM messages m
JOIN users u ON u.id = m.sender_id
WHERE m.channel_id = ? AND m.id > ?
ORDER BY m.id ASC
LIMIT ?;

-- name: ListDMMessagesAfter :many
SELECT m.*, u.nickname AS sender_nickname
FROM messages m
JOIN users u ON u.id = m.sender_id
WHERE ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
  AND m.id > ?
ORDER BY m.id ASC
LIMIT ?;

-- name: MaxChannelMessageID :one
SELECT CAST(coalesce(max(id), 0) AS INTEGER) FROM messages WHERE channel_id = ?;

-- name: MaxDMMessageID :one
SELECT CAST(coalesce(max(id), 0) AS INTEGER) FROM messages
WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?);

-- name: ListExpiredMessageIDs :many
SELECT id FROM messages WHERE created_at < ? ORDER BY id LIMIT ?;

-- name: CountUnreadChannel :one
SELECT count(*) FROM messages
WHERE channel_id = ? AND id > ? AND sender_id <> ?;

-- name: CountUnreadDM :one
SELECT count(*) FROM messages
WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
  AND id > ? AND sender_id <> ?;

-- name: ListChannelUnread :many
-- One aggregate for every visible channel instead of a marker, a count and a
-- mention count per channel. The join condition bounds the message range to
-- messages newer than the read marker, so the covering index
-- messages(channel_id, id, sender_id) supplies both the range and sender_id;
-- the table is not touched for a channel the user has fully read.
SELECT
    c.id AS channel_id,
    CAST(coalesce(rm.last_read_message_id, 0) AS INTEGER) AS last_read_message_id,
    CAST(count(m.id) AS INTEGER) AS unread,
    CAST(count(mm.message_id) AS INTEGER) AS mentions,
    CAST(CASE WHEN rm.user_id IS NULL THEN 0 ELSE 1 END AS INTEGER) AS has_marker
FROM channels c
LEFT JOIN read_markers rm
    ON rm.user_id = sqlc.arg(user_id)
   AND rm.channel_id = c.id
   AND rm.peer_id = 0
LEFT JOIN messages m
    ON m.channel_id = c.id
   AND m.id > coalesce(rm.last_read_message_id, 0)
   -- Own messages never count as unread (stage 4.1 B2).
   AND m.sender_id <> sqlc.arg(user_id)
LEFT JOIN message_mentions mm
    ON mm.message_id = m.id
   AND mm.user_id = sqlc.arg(user_id)
WHERE c.id IN (sqlc.slice(channel_ids))
GROUP BY c.id, rm.last_read_message_id, rm.user_id
ORDER BY c.id;

-- name: ListDMUnread :many
-- Every direct conversation of the user in one pass: the peer, its newest
-- message id, the unread and mention counters, and the peer nickname. The
-- read marker is joined per peer, so the message join only walks the messages
-- newer than that marker.
WITH peers AS (
    SELECT CAST(CASE WHEN sender_id = sqlc.arg(user_id) THEN recipient_id ELSE sender_id END AS INTEGER) AS peer_id,
           CAST(max(id) AS INTEGER) AS last_message_id
    FROM messages
    -- Channel messages have no recipient; without this filter the author's own
    -- channel messages would become a peer row with a NULL id.
    WHERE (sender_id = sqlc.arg(user_id) OR recipient_id = sqlc.arg(user_id))
      AND recipient_id IS NOT NULL
    GROUP BY peer_id
)
SELECT
    p.peer_id,
    p.last_message_id,
    CAST(coalesce(rm.last_read_message_id, 0) AS INTEGER) AS last_read_message_id,
    CAST(count(m.id) AS INTEGER) AS unread,
    CAST(count(mm.message_id) AS INTEGER) AS mentions,
    CAST(CASE WHEN rm.user_id IS NULL THEN 0 ELSE 1 END AS INTEGER) AS has_marker,
    u.nickname
FROM peers p
JOIN users u ON u.id = p.peer_id
LEFT JOIN read_markers rm
    ON rm.user_id = sqlc.arg(user_id)
   AND rm.peer_id = p.peer_id
   AND rm.channel_id = 0
LEFT JOIN messages m
    ON m.id > coalesce(rm.last_read_message_id, 0)
   AND m.id <= p.last_message_id
   AND m.recipient_id IS NOT NULL
   AND ((m.sender_id = sqlc.arg(user_id) AND m.recipient_id = p.peer_id)
        OR (m.sender_id = p.peer_id AND m.recipient_id = sqlc.arg(user_id)))
   AND m.sender_id <> sqlc.arg(user_id)
LEFT JOIN message_mentions mm
    ON mm.message_id = m.id
   AND mm.user_id = sqlc.arg(user_id)
GROUP BY p.peer_id, p.last_message_id, rm.last_read_message_id, rm.user_id, u.nickname
ORDER BY p.last_message_id DESC;

-- name: CountChannelMentions :one
SELECT count(*) FROM message_mentions mm
JOIN messages m ON m.id = mm.message_id
WHERE mm.user_id = ? AND m.channel_id = ? AND m.id > ?;

-- name: CountDMMentions :one
SELECT count(*) FROM message_mentions mm
JOIN messages m ON m.id = mm.message_id
WHERE mm.user_id = ?
  AND ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
  AND m.id > ?;

-- name: InsertMention :exec
INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?);

-- name: ListMessageMentions :many
SELECT user_id FROM message_mentions WHERE message_id = ? ORDER BY user_id;

-- name: GetReadMarker :one
SELECT * FROM read_markers WHERE user_id = ? AND channel_id = ? AND peer_id = ?;

-- name: UpsertReadMarker :exec
INSERT INTO read_markers (user_id, channel_id, peer_id, last_read_message_id, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (user_id, channel_id, peer_id) DO UPDATE SET
    last_read_message_id = max(read_markers.last_read_message_id, excluded.last_read_message_id),
    updated_at = excluded.updated_at;

-- name: DeleteReadMarkersForChannel :exec
DELETE FROM read_markers WHERE channel_id = ?;

-- name: InsertAttachment :one
INSERT INTO attachments (
    uploader_id, file_name, stored_name, content_type, size_bytes, width, height, created_at,
    sha256
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: GetAttachment :one
SELECT * FROM attachments WHERE id = ?;

-- name: ListMessageAttachments :many
SELECT * FROM attachments WHERE message_id = ? ORDER BY id;

-- name: ClaimAttachment :execrows
UPDATE attachments SET message_id = ?
WHERE id = ? AND uploader_id = ? AND message_id IS NULL;

-- name: DeleteAttachment :exec
DELETE FROM attachments WHERE id = ?;

-- name: ListMessageAttachmentFiles :many
SELECT id, stored_name FROM attachments WHERE message_id = ? ORDER BY id;

-- name: SumAttachmentBytes :one
SELECT CAST(coalesce(sum(size_bytes), 0) AS INTEGER) FROM attachments;

-- name: ListExpiredAttachments :many
SELECT id, stored_name FROM attachments
WHERE message_id IS NULL AND created_at < ?
ORDER BY id
LIMIT ?;

-- name: DeleteAttachmentRow :exec
DELETE FROM attachments WHERE id = ?;

-- name: DeleteMentions :exec
DELETE FROM message_mentions WHERE message_id = ?;

