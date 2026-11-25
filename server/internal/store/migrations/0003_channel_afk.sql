-- Stage 2.3.1d: the idle-channel flag (ADR 0009).
--
-- `afk` marks a channel whose occupants are muted by the server. The flag, not
-- the channel name, is what the server reads; the default channel keeps its
-- usual display name only because the name is user-visible text.
--
-- The column is added with a default, so rows of an existing database stay
-- valid without a rewrite. The one-time UPDATE marks the channel the original
-- bootstrap created under its historic default name: before this migration the
-- flag did not exist and that name was the only way to recognise it. After the
-- migration nothing reads channel names.

ALTER TABLE channels ADD COLUMN afk INTEGER NOT NULL DEFAULT 0
    CHECK (afk IN (0, 1));

UPDATE channels SET afk = 1 WHERE name = 'AFK';
