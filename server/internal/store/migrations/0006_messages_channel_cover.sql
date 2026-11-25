-- Stage 7.2: one covering index for channel history and unread badges.
--
-- Every unread count and every history page starts with the same two columns
-- (channel_id, id); the unread query also filters sender_id and would touch the
-- table for each row without it. Extending the old index with sender_id turns
-- both into index-only range scans: on a channel with 5 000 messages unread
-- went from ~11 ms to ~0.3 ms (docs/PERF.md).
--
-- The new index has the old index's prefix, so it replaces messages_channel_idx
-- for history, max-id and retention lookups as well; keeping both would only
-- add write cost.
CREATE INDEX messages_channel_cover_idx ON messages (channel_id, id, sender_id);
DROP INDEX messages_channel_idx;
