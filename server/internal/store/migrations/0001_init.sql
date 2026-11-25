-- Stage 1.2 schema: settings, users, invites, bans.
--
-- Timestamps are Unix milliseconds (UTC). BLOB keys are raw 32-byte Ed25519
-- public keys or SHA-256 hashes; secrets themselves are never stored.

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key   BLOB NOT NULL UNIQUE,
    nickname     TEXT NOT NULL,
    is_admin     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    CHECK (length(public_key) = 32),
    CHECK (is_admin IN (0, 1))
);

CREATE TABLE invites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash  BLOB NOT NULL UNIQUE,
    -- User who created the invite; NULL for the bootstrap admin invite.
    created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
    grant_admin INTEGER NOT NULL DEFAULT 0,
    max_uses    INTEGER NOT NULL DEFAULT 1,
    used_count  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    -- NULL means the invite never expires.
    expires_at  INTEGER,
    revoked_at  INTEGER,
    -- 1 marks the single bootstrap invite whose token is reprinted at startup
    -- while the server still has no administrator.
    bootstrap   INTEGER NOT NULL DEFAULT 0,
    CHECK (length(token_hash) = 32),
    CHECK (grant_admin IN (0, 1)),
    CHECK (bootstrap IN (0, 1)),
    CHECK (max_uses > 0),
    CHECK (used_count >= 0 AND used_count <= max_uses)
);

CREATE INDEX invites_expires_at_idx ON invites (expires_at);

CREATE TABLE bans (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Exactly one subject per row: a public key or an IP address.
    public_key BLOB,
    ip         TEXT,
    reason     TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    -- NULL means the ban never expires.
    expires_at INTEGER,
    CHECK (public_key IS NOT NULL OR ip IS NOT NULL),
    CHECK (public_key IS NULL OR length(public_key) = 32)
);

CREATE UNIQUE INDEX bans_public_key_uq ON bans (public_key) WHERE public_key IS NOT NULL;
CREATE UNIQUE INDEX bans_ip_uq ON bans (ip) WHERE ip IS NOT NULL;

-- Server defaults. Everything that is not a startup flag lives here (design 4.5).
INSERT INTO settings (key, value, updated_at) VALUES
    ('server_name', 'RosTalk', 0),
    ('login_mode', 'invite', 0),
    ('max_users', '0', 0),
    ('server_password_hash', '', 0),
    ('auth_attempts_limit', '10', 0),
    ('auth_attempts_window_seconds', '60', 0);
