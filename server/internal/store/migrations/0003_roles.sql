-- Stage 3.1 schema: roles, role assignments, channel overrides, audit log.
--
-- Roles carry a permission bitmask: bit N is rostalk.v1.Permission with numeric
-- value N. Values are part of the wire contract and must never be renumbered.
-- Channel overrides subtract denies first and then add allows, exactly like the
-- pure function in internal/perms.
--
-- The four built-in roles are created here and every existing user gets one:
-- administrators keep their rights through the Admin role, everybody else
-- becomes a Member. New installations start with the same roles, so the
-- bootstrap admin invite only has to grant the Admin role.
--
-- name is unique case-insensitively so the CLI can accept a role by name.

CREATE TABLE roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    color       INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL,
    -- Permission bitmask; see the comment above.
    permissions INTEGER NOT NULL DEFAULT 0,
    -- 1 for the four roles the server creates itself. Built-in roles cannot be
    -- deleted.
    builtin     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    CHECK (length(name) > 0),
    CHECK (position >= 0),
    CHECK (permissions >= 0),
    CHECK (builtin IN (0, 1))
);

CREATE UNIQUE INDEX roles_name_uq ON roles (name COLLATE NOCASE);
CREATE INDEX roles_position_idx ON roles (position, id);

CREATE TABLE user_roles (
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role_id     INTEGER NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    assigned_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, role_id)
);

CREATE INDEX user_roles_role_idx ON user_roles (role_id);

CREATE TABLE channel_overrides (
    channel_id INTEGER NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    -- Permission bitmasks.
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, role_id),
    CHECK (allow >= 0),
    CHECK (deny >= 0)
);

CREATE INDEX channel_overrides_role_idx ON channel_overrides (role_id);

CREATE TABLE audit_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    -- NULL for actions made through the local admin socket.
    actor_id          INTEGER REFERENCES users (id) ON DELETE SET NULL,
    actor_name        TEXT    NOT NULL DEFAULT '',
    action            TEXT    NOT NULL,
    target_user_id    INTEGER,
    target_channel_id INTEGER,
    target_role_id    INTEGER,
    details           TEXT    NOT NULL DEFAULT '',
    created_at        INTEGER NOT NULL,
    CHECK (length(action) > 0)
);

CREATE INDEX audit_log_created_idx ON audit_log (id);
CREATE INDEX audit_log_action_idx ON audit_log (action, id);

-- 1 << 0 is unused; the mask starts at the first real permission.
INSERT INTO roles (name, color, position, permissions, builtin, created_at) VALUES
    ('Guest',     0x9AA0A6, 0,   2199026401280, 1, 0),
    ('Member',    0x8AB4F8, 10,  3299624353792, 1, 0),
    ('Moderator', 0xFDD663, 50,  3299725019120, 1, 0),
    ('Admin',     0xF28B82, 100, 3301889279998, 1, 0);

-- Existing administrators keep their rights through the Admin role; everyone
-- else becomes a Member so no user is left without the baseline role.
INSERT INTO user_roles (user_id, role_id, assigned_at)
SELECT u.id, r.id, 0
FROM users u
JOIN roles r ON r.name = CASE WHEN u.is_admin = 1 THEN 'Admin' ELSE 'Member' END;

-- Invites can now grant a role instead of only the administrator flag.
ALTER TABLE invites ADD COLUMN role_id INTEGER REFERENCES roles (id) ON DELETE SET NULL;
