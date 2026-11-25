-- Stage P11: one avatar per user.
--
-- The column stores the SHA-256 (lowercase hex) of the re-encoded 256x256
-- image in <data>/avatars. The bytes are content-addressed and immutable, so
-- reads may be cached forever. An empty string means "no avatar".
ALTER TABLE users ADD COLUMN avatar_hash TEXT NOT NULL DEFAULT '';
