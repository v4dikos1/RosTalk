-- Stage 4.1: chat messages, attachments, mentions and read markers.
--
-- A message belongs either to a channel (channel_id set, recipient_id NULL) or
-- to a direct conversation (channel_id NULL, recipient_id set). The CHECK keeps
-- the two cases exclusive; a direct message stores both participants, so the
-- pair is unambiguous without a separate conversations table.
--
-- Attachments are uploaded before the message exists (message_id NULL) and are
-- claimed by the send. An orphan is removed by the retention sweeper. The file
-- on disk is named by stored_name, a server-generated random name: the display
-- name is never used as a path.
--
-- Read markers are per user and conversation. For a direct conversation
-- peer_id is the other participant as seen by the owner of the marker.

CREATE TABLE messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id   INTEGER REFERENCES channels (id) ON DELETE CASCADE,
    sender_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    recipient_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
    body         TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    edited_at    INTEGER,
    CHECK ((channel_id IS NULL) <> (recipient_id IS NULL)),
    CHECK (channel_id IS NULL OR channel_id > 0),
    CHECK (recipient_id IS NULL OR (recipient_id > 0 AND recipient_id <> sender_id)),
    CHECK (created_at >= 0)
);

CREATE INDEX messages_channel_idx ON messages (channel_id, id);
CREATE INDEX messages_dm_out_idx ON messages (sender_id, recipient_id, id);
CREATE INDEX messages_dm_in_idx ON messages (recipient_id, sender_id, id);
CREATE INDEX messages_created_idx ON messages (created_at, id);

CREATE TABLE attachments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    -- NULL until a SendMessage claims the upload; orphaned rows are swept.
    message_id   INTEGER REFERENCES messages (id) ON DELETE CASCADE,
    uploader_id  INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Display name only, sanitised; never used as a path.
    file_name    TEXT    NOT NULL,
    -- Server-generated random name of the stored file.
    stored_name  TEXT    NOT NULL UNIQUE,
    content_type TEXT    NOT NULL,
    size_bytes   INTEGER NOT NULL,
    width        INTEGER NOT NULL DEFAULT 0,
    height       INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    CHECK (size_bytes >= 0),
    CHECK (width >= 0 AND height >= 0),
    CHECK (created_at >= 0)
);

CREATE INDEX attachments_message_idx ON attachments (message_id, id);
CREATE INDEX attachments_uploader_idx ON attachments (uploader_id, message_id);
CREATE INDEX attachments_created_idx ON attachments (created_at);

CREATE TABLE message_mentions (
    message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
);

CREATE INDEX message_mentions_user_idx ON message_mentions (user_id, message_id);

CREATE TABLE read_markers (
    user_id              INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Exactly one of the two identifies the conversation.
    channel_id           INTEGER NOT NULL DEFAULT 0,
    peer_id              INTEGER NOT NULL DEFAULT 0,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    updated_at           INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id, peer_id),
    CHECK (channel_id >= 0),
    CHECK (peer_id >= 0),
    CHECK ((channel_id = 0) <> (peer_id = 0))
);

CREATE INDEX read_markers_user_idx ON read_markers (user_id);

-- Built-in roles gain the chat rights of stage 4.1:
--   bit 50 send_messages, bit 51 attach_files, bit 52 manage_messages.
-- Guest keeps its baseline (view, join, change nickname). Member may write and
-- attach; Moderator and Admin may also manage messages.
UPDATE roles SET permissions = permissions | ((1 << 50) | (1 << 51))
WHERE builtin = 1 AND name = 'Member';
UPDATE roles SET permissions = permissions | ((1 << 50) | (1 << 51) | (1 << 52))
WHERE builtin = 1 AND name IN ('Moderator', 'Admin');
