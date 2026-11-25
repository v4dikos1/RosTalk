# RosTalk HTTP API `/api/v1`

Stage 3.2 adds a bearer-token HTTP API for bots and scripts. It is a thin
transport over the same control-plane operations the client uses: permissions,
hierarchy and the audit log are the code in `internal/perms`, `internal/roles`
and `internal/control`, not a second rule set.

- Full contract: [`openapi.yaml`](openapi.yaml).
- Base URL: `https://<LAN IP>:7443/api/v1` (the same certificate as the client;
  pin it with `--cacert` or the fingerprint from the invite link, ADR 0001).
- Every request needs `Authorization: Bearer <token>`.
- A token acts as exactly **one role**. Create it in the client under
  **Settings → Server → API** (or with `POST /tokens` using an existing
  administrator token). The plaintext is shown once; the database stores only
  its SHA-256 hash.
- Errors are JSON: `{"error":{"code":"permission_denied","message":"..."}}`.
  `401` — missing/unknown/expired/revoked token; `403` — the role may not do
  this; `404` — the object does not exist or is not visible; `400` — malformed
  input; `409` — the server refused the change.
- Secrets are never logged. Audit entries of API actions have `actorId: 0` and
  `actorName: "api:<token name>"`.

## Smoke test

```sh
HOST=192.168.0.13:7443
TOKEN=... # from Settings → Server → API, shown once

# 200: the token has the right
curl --cacert rostalk-ca.pem -H "Authorization: Bearer $TOKEN" \
  "https://$HOST/api/v1/users?online=true"

# 403: a Member token trying to kick
curl --cacert rostalk-ca.pem -X POST -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H 'Content-Type: application/json' -d '{"reason":"test"}' \
  "https://$HOST/api/v1/members/42/kick"
```

With a development server whose certificate is self-signed, `-k` is acceptable
for a local smoke test only.

## Users and channels

```sh
curl -H "Authorization: Bearer $TOKEN" "https://$HOST/api/v1/users"
curl -H "Authorization: Bearer $TOKEN" "https://$HOST/api/v1/users?q=anya&online=true"
curl -H "Authorization: Bearer $TOKEN" "https://$HOST/api/v1/channels"
```

`GET /channels` returns only channels the token role may view.

## Invites

```sh
# Create: role 3 (Member), 7 days, 5 logins. The url is in this reply only.
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"roleId":3,"maxUses":5,"expiresInSeconds":604800}' \
  "https://$HOST/api/v1/invites"

curl -H "Authorization: Bearer $TOKEN" \
  "https://$HOST/api/v1/invites?include_inactive=true"

curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://$HOST/api/v1/invites/12"
```

## Moderation

```sh
# Kick (reason is optional)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"reason":"AFK"}' \
  "https://$HOST/api/v1/members/42/kick"

# Ban by key and address for one day
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"spam","byKey":true,"byIp":true,"expiresInSeconds":86400}' \
  "https://$HOST/api/v1/members/42/ban"

# Move to channel 7; 0 removes the user from every channel
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"channelId":7}' \
  "https://$HOST/api/v1/members/42/move"

curl -H "Authorization: Bearer $TOKEN" "https://$HOST/api/v1/bans"
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://$HOST/api/v1/bans/ip/203.0.113.7"
```

An unknown or invisible channel returns `404`; a destination the target may not
join returns `403`, exactly like the client protocol.

## Audit

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://$HOST/api/v1/audit?limit=50&action=member."
# next page
curl -H "Authorization: Bearer $TOKEN" \
  "https://$HOST/api/v1/audit?limit=50&before_id=1200"
```

## Tokens

```sh
curl -H "Authorization: Bearer $TOKEN" "https://$HOST/api/v1/tokens"

# Mint a token for the Moderator role, valid for 30 days
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"deploy-bot","roleId":2,"expiresInSeconds":2592000}' \
  "https://$HOST/api/v1/tokens"

curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://$HOST/api/v1/tokens/4"
```

Revocation and expiry are checked on every request, so a revoked token fails
with `401` immediately. A token whose role was deleted stays valid but has no
rights and receives `403 permission_denied`.

## Chat

The chat HTTP endpoints are used by the desktop core's loopback proxy and
authenticate with the per-session token that the server returns in `Welcome`
(see ADR 0022). An API token created with `POST /tokens` acts as a role and is
**not** accepted here: messages belong to a user.

```sh
SESSION=... # from Welcome.http_token; never leaves the client core
TOKEN_HEADER="Authorization: Bearer $SESSION"

# Newest page of a text channel
curl -H "$TOKEN_HEADER" \
  "https://$HOST/api/v1/chat/history?channelId=7&limit=50"

# Older page: pass nextCursor from the previous reply
curl -H "$TOKEN_HEADER" \
  "https://$HOST/api/v1/chat/history?channelId=7&cursor=$CURSOR"

# Direct conversation with user 42
curl -H "$TOKEN_HEADER" \
  "https://$HOST/api/v1/chat/history?peerId=42"

# Upload (raw bytes); send the returned id with SendMessage over the WebSocket
curl -X POST -H "$TOKEN_HEADER" -H 'Content-Type: application/octet-stream' \
  --data-binary @photo.png \
  "https://$HOST/api/v1/chat/attachments?channelId=7&name=photo.png"

# Download; images, video and audio are inline, other files (PDF, text,
# archives) are attachments
curl -OJ -H "$TOKEN_HEADER" \
  "https://$HOST/api/v1/chat/attachments/15"
```

The type is sniffed from the first 512 bytes, never from the file name. PNG,
JPEG, GIF, WebP, `video/mp4`, `video/webm`, `audio/mpeg`, `audio/ogg`,
`audio/wav`, PDF, plain UTF-8 text, ZIP, RAR, 7z and `application/octet-stream`
are accepted; HTML, SVG and XML are rejected with `415 unsupported_type`.
Images and media are served `inline`; archives and other files always carry
`Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
Attachment reads use `http.ServeContent`, so `Range` requests answer `206` and
a player can seek. Uploads are written to a temporary file as they arrive; the
size limit and the disk quota are checked during the transfer.

Messages are sent, edited and deleted over the control WebSocket
(`ChatSend`, `EditMessage`, `DeleteMessage`, `ChatHistory`, `MarkRead`);
live updates arrive as `MessageCreated`, `MessageUpdated`, `MessageDeleted`
and `UnreadUpdated` events. The HTTP endpoints are only the paged history and
the file bytes, which are awkward inside the protobuf state channel.

Editing is restricted to the author: `manage_messages` allows deleting and
moderating another user's message, but not rewriting it (ADR 0025).

Limits: `max_attachment_bytes` (25 MiB by default, 1 MiB…2 GiB),
`attachment_quota_bytes` (1 GiB) and `message_retention_days` (0 = forever)
live in the settings table. The effective attachment limit is also part of
`ServerInfo.max_attachment_bytes`, so the client checks the same number the
server enforces. Change the limits in the admin UI (Server → General) or with:

```sh
rostalk-server admin settings set max_attachment_bytes 33554432
rostalk-server admin settings set message_retention_days 90
```

The retention sweeper runs every 15 minutes in batches and also removes
unclaimed uploads older than one hour.

History can be exported as JSON Lines; the server streams it in batches:

```sh
curl -OJ -H "$TOKEN_HEADER" \
  "https://$HOST/api/v1/chat/export?channelId=7"
```

## Avatars

Every user carries an `avatarHash` (see `User` in the snapshot and
`UserUpdated` events). An empty string means "no avatar". The bytes live at
`GET /api/v1/avatars/{hash}` and never change for one hash, so clients cache
them forever. The desktop core loads them through its loopback proxy; the page
never talks to the server.

These endpoints use the user session token from `Welcome`, like chat. An API
token acts as a role and is rejected.

```sh
# Set your own avatar: PNG, JPEG, WebP or GIF up to 4 MiB
curl -X PUT -H "$TOKEN_HEADER" -H 'Content-Type: image/png' \
  --data-binary @me.png "https://$HOST/api/v1/avatars/me"
# {"avatarHash":"9f86d0…"}

# Read any avatar (the shape is already 256x256, immutable)
curl -H "$TOKEN_HEADER" \
  "https://$HOST/api/v1/avatars/9f86d0…" -o avatar.png

# Remove your own
curl -X DELETE -H "$TOKEN_HEADER" \
  "https://$HOST/api/v1/avatars/me"

# An administrator resets someone else's avatar; the target may be offline
curl -X DELETE -H "$TOKEN_HEADER" \
  "https://$HOST/api/v1/members/42/avatar"
```

The server decodes the picture, centre-crops it to a square, scales it to
256×256 and re-encodes it as PNG (when it has transparency) or JPEG. The upload
name and declared type are ignored; the type is read from the bytes. The same
picture uploaded by two users is stored once. Changes are rate limited (five
quick changes, then one every 20 s) and each change is written to the audit log
(`avatar.update`, `avatar.clear`, `member.avatar_reset`).
