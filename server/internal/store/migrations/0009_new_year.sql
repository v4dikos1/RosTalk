CREATE TABLE ny_seasons (
    season TEXT NOT NULL PRIMARY KEY,
    zone TEXT NOT NULL
) STRICT;

CREATE TABLE ny_players (
    season TEXT NOT NULL REFERENCES ny_seasons (season) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    enrolled_ms INTEGER NOT NULL,
    water INTEGER NOT NULL DEFAULT 0 CHECK (water >= 0),
    flakes INTEGER NOT NULL DEFAULT 0 CHECK (flakes >= 0),
    background TEXT NOT NULL DEFAULT 'dusk' CHECK (background IN ('dusk', 'aurora')),
    layout_version INTEGER NOT NULL DEFAULT 0 CHECK (layout_version >= 0),
    last_chat_ms INTEGER DEFAULT NULL,
    PRIMARY KEY (season, user_id)
) STRICT;

CREATE TABLE ny_days (
    season TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL CHECK (length(day) = 10 AND day GLOB '2026-12-[0-3][0-9]'
                            AND day BETWEEN '2026-12-01' AND '2026-12-31'),
    claimed_item TEXT DEFAULT NULL,
    watered INTEGER NOT NULL DEFAULT 0 CHECK (watered IN (0, 1)),
    voice_flakes INTEGER NOT NULL DEFAULT 0 CHECK (voice_flakes BETWEEN 0 AND 24),
    chat_flakes INTEGER NOT NULL DEFAULT 0 CHECK (chat_flakes BETWEEN 0 AND 6),
    PRIMARY KEY (season, user_id, day),
    FOREIGN KEY (season, user_id) REFERENCES ny_players (season, user_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE ny_inventory (
    season TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    item TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
    PRIMARY KEY (season, user_id, item),
    FOREIGN KEY (season, user_id) REFERENCES ny_players (season, user_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE ny_layout (
    season TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 19),
    item TEXT NOT NULL,
    x INTEGER NOT NULL CHECK (x BETWEEN 0 AND 1000),
    y INTEGER NOT NULL CHECK (y BETWEEN 0 AND 1000),
    scale INTEGER NOT NULL CHECK (scale BETWEEN 60 AND 140),
    rotation INTEGER NOT NULL CHECK (rotation BETWEEN -45 AND 45),
    PRIMARY KEY (season, user_id, slot),
    FOREIGN KEY (season, user_id, item) REFERENCES ny_inventory (season, user_id, item) ON DELETE CASCADE
) STRICT;

CREATE TABLE ny_ledger (
    id INTEGER NOT NULL PRIMARY KEY,
    season TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    utc_ms INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('chat', 'voice', 'spin', 'duplicate')),
    delta INTEGER NOT NULL CHECK (delta <> 0),
    source TEXT NOT NULL,
    UNIQUE (season, user_id, kind, source),
    FOREIGN KEY (season, user_id) REFERENCES ny_players (season, user_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX ny_ledger_recent_idx ON ny_ledger (season, user_id, id DESC);

CREATE TABLE ny_spins (
    season TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    item TEXT NOT NULL,
    duplicate INTEGER NOT NULL CHECK (duplicate IN (0, 1)),
    refund INTEGER NOT NULL CHECK (refund = duplicate * 2),
    PRIMARY KEY (season, user_id, request_id),
    FOREIGN KEY (season, user_id) REFERENCES ny_players (season, user_id) ON DELETE CASCADE
) STRICT;
