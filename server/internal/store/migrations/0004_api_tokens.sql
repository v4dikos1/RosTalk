-- Stage 3.2: bearer tokens for the HTTP API (design 4.4).
--
-- A token acts as exactly one role: permission checks reuse internal/perms and
-- internal/roles instead of a second rule set. Only the SHA-256 hash of the
-- token is stored; the plaintext exists once in the create reply. Revoking or
-- expiring a token invalidates it immediately because authentication reads this
-- table on every request.

CREATE TABLE api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    token_hash   BLOB    NOT NULL UNIQUE,
    -- The role the token acts as. Deleting the role leaves the token valid but
    -- powerless; the API answers 403, never 200 with no rights.
    role_id      INTEGER REFERENCES roles (id) ON DELETE SET NULL,
    -- User who minted the token; NULL for the local admin socket.
    created_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL,
    -- NULL means the token never expires.
    expires_at   INTEGER,
    -- NULL means the token is active.
    revoked_at   INTEGER,
    last_used_at INTEGER,
    CHECK (length(name) > 0),
    CHECK (length(token_hash) = 32)
);

CREATE INDEX api_tokens_role_idx ON api_tokens (role_id);
CREATE INDEX api_tokens_expires_at_idx ON api_tokens (expires_at);
