-- Stage P3: attachments are streamed to disk, so the content hash is computed
-- while the bytes are written instead of reading the file a second time.
--
-- The column is not used for lookups yet. It records the exact bytes the server
-- stored: a backup tool or a future duplicate check can verify a file without
-- trusting its random name. Existing rows predate the column and keep the empty
-- default.
ALTER TABLE attachments ADD COLUMN sha256 TEXT NOT NULL DEFAULT '';
