-- name: InsertNYSeason :execrows
INSERT INTO ny_seasons (season, zone) VALUES (?, ?)
ON CONFLICT (season) DO NOTHING;

-- name: GetNYSeason :one
SELECT zone FROM ny_seasons WHERE season = ?;

-- name: DeleteNYSeason :execrows
DELETE FROM ny_seasons WHERE season = ?;

-- name: EnrollNYPlayer :execrows
INSERT INTO ny_players (season, user_id, enrolled_ms) VALUES (?, ?, ?)
ON CONFLICT (season, user_id) DO NOTHING;

-- name: GetNYPlayer :one
SELECT * FROM ny_players WHERE season = ? AND user_id = ?;

-- name: LockNYPlayer :execrows
UPDATE ny_players SET enrolled_ms = enrolled_ms WHERE season = ? AND user_id = ?;

-- name: EnsureNYDay :execrows
INSERT INTO ny_days (season, user_id, day) VALUES (?, ?, ?)
ON CONFLICT (season, user_id, day) DO NOTHING;

-- name: ClaimNYDay :execrows
UPDATE ny_days SET claimed_item = ?
WHERE season = ? AND user_id = ? AND day = ? AND claimed_item IS NULL;

-- name: WaterNYDay :execrows
UPDATE ny_days SET watered = 1
WHERE season = ? AND user_id = ? AND day = ? AND watered = 0;

-- name: ListNYDays :many
SELECT day, claimed_item, watered FROM ny_days
WHERE season = ? AND user_id = ? AND (claimed_item IS NOT NULL OR watered = 1)
ORDER BY day;

-- name: CountNYWateredDays :one
SELECT count(*) FROM ny_days WHERE season = ? AND user_id = ? AND watered = 1;

-- name: CreditNYWater :execrows
UPDATE ny_players SET water = water + 1 WHERE season = ? AND user_id = ?;

-- name: SpendNYWater :execrows
UPDATE ny_players SET water = water - 1 WHERE season = ? AND user_id = ? AND water >= 1;

-- name: CreditNYFlakes :execrows
UPDATE ny_players SET flakes = flakes + sqlc.arg(amount) WHERE season = sqlc.arg(season) AND user_id = sqlc.arg(user_id);

-- name: SpendNYFlakes :execrows
UPDATE ny_players SET flakes = flakes - sqlc.arg(amount)
WHERE season = sqlc.arg(season) AND user_id = sqlc.arg(user_id) AND flakes >= sqlc.arg(amount);

-- name: CreditNYChatDay :execrows
UPDATE ny_days SET chat_flakes = chat_flakes + 1
WHERE season = ? AND user_id = ? AND day = ? AND chat_flakes < 6;

-- name: CreditNYVoiceDay :execrows
UPDATE ny_days SET voice_flakes = voice_flakes + 2
WHERE season = ? AND user_id = ? AND day = ? AND voice_flakes <= 22;

-- name: MarkNYChatReward :execrows
UPDATE ny_players SET last_chat_ms = sqlc.arg(utc_ms)
WHERE season = sqlc.arg(season) AND user_id = sqlc.arg(user_id) AND (last_chat_ms IS NULL OR last_chat_ms <= sqlc.arg(cutoff_ms));

-- name: IncrementNYInventory :execrows
INSERT INTO ny_inventory (season, user_id, item) VALUES (?, ?, ?)
ON CONFLICT (season, user_id, item) DO UPDATE SET qty = qty + 1;

-- name: ListNYInventory :many
SELECT item, qty FROM ny_inventory WHERE season = ? AND user_id = ? ORDER BY item;

-- name: HasNYItem :one
SELECT CAST(EXISTS(SELECT 1 FROM ny_inventory WHERE season = ? AND user_id = ? AND item = ?) AS INTEGER);

-- name: AddNYLedger :execrows
INSERT INTO ny_ledger (season, user_id, utc_ms, kind, delta, source) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (season, user_id, kind, source) DO NOTHING;

-- name: ListNYLedger :many
SELECT utc_ms, kind, delta FROM ny_ledger WHERE season = ? AND user_id = ? ORDER BY id DESC LIMIT 20;

-- name: GetNYSpin :one
SELECT * FROM ny_spins WHERE season = ? AND user_id = ? AND request_id = ?;

-- name: AddNYSpin :execrows
INSERT INTO ny_spins (season, user_id, request_id, item, duplicate, refund) VALUES (?, ?, ?, ?, ?, ?);

-- name: UpdateNYLayout :execrows
UPDATE ny_players SET layout_version = layout_version + 1, background = ?
WHERE season = ? AND user_id = ? AND layout_version = ?;

-- name: ClearNYLayout :exec
DELETE FROM ny_layout WHERE season = ? AND user_id = ?;

-- name: AddNYPlacement :execrows
INSERT INTO ny_layout (season, user_id, slot, item, x, y, scale, rotation) VALUES (?, ?, ?, ?, ?, ?, ?, ?);

-- name: ListNYLayout :many
SELECT item, x, y, scale, rotation FROM ny_layout WHERE season = ? AND user_id = ? ORDER BY slot;


-- name: LockNYSeason :execrows
UPDATE ny_seasons SET zone = zone WHERE season = ?;

-- name: GetNYDay :one
SELECT * FROM ny_days WHERE season = ? AND user_id = ? AND day = ?;
