-- Stage 1.3 schema: the channel tree.
--
-- Channels form a tree through parent_id (NULL for a top-level channel) and are
-- ordered among siblings by position, starting at 0. Deletion cascades to the
-- whole subtree; the service renumbers the remaining siblings.
--
-- kind, voice_profile and temporary repeat the wire enums of
-- rostalk.v1.ChannelKind / VoiceProfile so the database can be inspected without
-- the protocol definitions; values must never change meaning.

CREATE TABLE channels (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    -- NULL means a top-level channel.
    parent_id     INTEGER REFERENCES channels (id) ON DELETE CASCADE,
    position      INTEGER NOT NULL DEFAULT 0,
    name          TEXT    NOT NULL,
    topic         TEXT    NOT NULL DEFAULT '',
    kind          INTEGER NOT NULL DEFAULT 1,
    user_limit    INTEGER NOT NULL DEFAULT 0,
    -- argon2id encoded hash; empty when the channel has no password. The
    -- password itself is never stored.
    password_hash TEXT    NOT NULL DEFAULT '',
    voice_profile INTEGER NOT NULL DEFAULT 1,
    temporary     INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    CHECK (parent_id IS NULL OR parent_id <> id),
    CHECK (length(name) > 0),
    CHECK (position >= 0),
    CHECK (kind IN (1, 2)),
    CHECK (user_limit >= 0),
    CHECK (voice_profile IN (1, 2, 3)),
    CHECK (temporary IN (0, 1))
);

CREATE INDEX channels_parent_position_idx ON channels (parent_id, position);
