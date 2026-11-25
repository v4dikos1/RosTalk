//! Serializable state model shared by the core and the UI.
//! These types are the IPC contract: they are generated into TypeScript by
//! `tauri-specta` and the UI treats them as read-only. Nothing secret ever
//! reaches them: media tokens and URLs stay inside the core (stage 2.2,
//! requirement 6), as do passwords and private keys.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::link::ServerMode;
use crate::proto;
use crate::settings::ProfileView;

/// Connection phase shown in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionPhase {
    /// No session and no pending attempt.
    Disconnected,
    /// The first handshake is in progress.
    Connecting,
    /// `Welcome` was received.
    Connected,
    /// An established session dropped; the core is retrying with backoff.
    Reconnecting,
}

/// Reconnect attempt details for the connection indicator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReconnectInfo {
    /// 1-based attempt number.
    pub attempt: u32,
    /// Delay before this attempt, milliseconds.
    pub delay_ms: u64,
}

/// How the server admits new users.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum LoginModeView {
    Invite,
    Password,
    Open,
}

/// Voice or text channel (design 4.5/4.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ChannelKindView {
    Voice,
    Text,
}

/// A role defined on the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RoleView {
    pub id: u64,
    pub name: String,
    /// `#rrggbb`, or `None` when the role has no colour.
    pub color: Option<String>,
    pub position: i32,
    /// Permission names in the same camelCase vocabulary as `PermissionsView`.
    pub permissions: Vec<String>,
    /// True for the roles the server creates itself; they cannot be deleted.
    pub builtin: bool,
}

/// Per-channel Opus/APM preset (design 5.2).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum VoiceProfileView {
    /// Mono, ~48 kbit/s, full audio processing. The default.
    #[default]
    Voice,
    /// Mono, ~96 kbit/s, full audio processing.
    VoiceHq,
    /// Stereo, ~192 kbit/s, processing disabled (music).
    Music,
}

/// Server identity and settings from `ServerInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    /// SHA-256 of the server's long-lived Ed25519 key, lowercase hex. This is
    /// `Challenge.server_id`, not the TLS fingerprint from the link (ADR 0004).
    pub id: String,
    pub name: String,
    pub version: String,
    pub protocol_version: u32,
    pub login_mode: LoginModeView,
    pub max_users: u32,
    pub online_users: u32,
    /// True when a server password is configured; the value never leaves the
    /// server.
    pub password_set: bool,
    /// Largest file the server accepts as one attachment, in bytes. The
    /// composer checks it before starting an upload (stage P3).
    pub max_attachment_bytes: u64,
}

/// One node of the channel tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelView {
    pub id: u64,
    pub parent_id: u64,
    pub position: i32,
    pub name: String,
    pub topic: String,
    pub kind: ChannelKindView,
    pub user_limit: u32,
    pub password_protected: bool,
    pub temporary: bool,
    pub user_count: u32,
    /// Opus/APM preset the server applies to the channel.
    pub voice_profile: VoiceProfileView,
    /// Server's idle channel: its occupants are muted by the server (ADR 0009).
    pub afk: bool,
}

/// Microphone/deafen/away flags of a user. Speaking is measured by the client
/// and never comes from the control plane (design 4.6).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStateView {
    pub self_muted: bool,
    pub self_deafened: bool,
    pub server_muted: bool,
    pub server_deafened: bool,
    pub away: bool,
    pub priority_speaker: bool,
}

/// An online user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UserView {
    pub id: u64,
    pub nickname: String,
    pub role_ids: Vec<u64>,
    /// Display colour of the highest coloured role, `#rrggbb`.
    pub color: Option<String>,
    /// Current channel, 0 when the user is connected but not in a channel.
    pub channel_id: u64,
    pub voice: VoiceStateView,
    pub streaming: bool,
    /// Screen shares this user watches, by streamer id (stage P12).
    /// Only live shares of the user's own channel ever appear here: the server
    /// drops everything else and clears the list when the user leaves, the
    /// stream stops or either session ends. The UI reads it as the audience of
    /// a stream and never writes it for anyone but the caller.
    pub watching_user_ids: Vec<u64>,
    pub connected_at_unix_ms: i64,
    /// SHA-256 hex of the 256x256 avatar, empty when the user has none (P11).
    pub avatar_hash: String,
}

/// Effective permissions of the caller. Advisory: the server checks again.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsView {
    /// Server-wide permission names, camelCase, for example `manageServer`.
    pub server: Vec<String>,
    /// Per-channel effective permission names.
    pub channels: Vec<ChannelPermissionsView>,
}

/// Effective permissions in one channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPermissionsView {
    pub channel_id: u64,
    pub permissions: Vec<String>,
}

/// One uploaded file of a message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentView {
    pub id: u64,
    pub file_name: String,
    pub content_type: String,
    pub size_bytes: u64,
    pub width: u32,
    pub height: u32,
    /// Raster image the UI may preview inline. Never SVG, HTML or a script.
    pub image: bool,
}

/// One chat message.
///
/// `recipient_id` is the stored recipient of a direct message (0 for a
/// channel). The conversation peer is `recipient_id` for an own message and
/// `sender_id` for an incoming one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    pub id: u64,
    pub channel_id: u64,
    pub sender_id: u64,
    pub recipient_id: u64,
    pub sender_nickname: String,
    pub body: String,
    pub created_at_unix_ms: i64,
    pub edited_at_unix_ms: i64,
    pub attachments: Vec<AttachmentView>,
    pub mention_user_ids: Vec<u64>,
}

/// Unread state of one conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UnreadView {
    /// Channel conversation, 0 for a direct message.
    pub channel_id: u64,
    /// The other participant of a direct conversation, 0 for a channel.
    pub peer_user_id: u64,
    pub unread: u32,
    pub mentions: u32,
    pub last_read_message_id: u64,
    /// Nickname of an offline direct-message peer.
    pub peer_nickname: String,
    pub last_message_id: u64,
}

/// Target of a chat request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatTarget {
    /// Channel conversation.
    Channel { channel_id: u64 },
    /// Direct conversation with this user.
    Dm { peer_id: u64 },
}

/// Loopback proxy coordinates handed to the WebView.
///
/// The token authenticates the page to the local proxy only. The server
/// session token and the pinned certificate stay in the core.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatProxyView {
    /// `http://127.0.0.1:<random port>`.
    pub base_url: String,
    /// Value for the `X-RosTalk-Proxy-Token` header.
    pub token: String,
}

/// How the user signed in to a saved server (ADR 0008).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum BookmarkLogin {
    /// An invitation link: the fingerprint came with the link.
    Invite,
    /// A typed `host:port`: the fingerprint was confirmed on first use.
    Direct,
}

/// A saved server. Several can be stored; only one connection is active.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ServerBookmark {
    /// Stable local id: `host:port`. It does not contain the certificate
    /// fingerprint, so a certificate change replaces the saved entry instead of
    /// leaving an orphaned duplicate (ADR 0004, ADR 0008).
    pub id: String,
    /// Display name learned from `Welcome`, or the host before the first login.
    pub name: String,
    /// `host:port` used to reach the server.
    pub host: String,
    /// TLS leaf fingerprint, lowercase hex.
    pub fingerprint: String,
    /// Trust mode recorded when the server was saved.
    pub mode: ServerMode,
    /// Which login flow saved this server.
    pub login: BookmarkLogin,
    /// Last nickname used on this server, so a returning user is not asked
    /// again. Empty when the server has not been reached yet.
    pub nickname: String,
    /// Server identity key fingerprint, lowercase hex, once known.
    pub server_id: Option<String>,
    /// When the client last completed a handshake with this server.
    pub last_connected_unix_ms: i64,
    /// Canonical link without the invite token, for reconnecting a known key.
    pub link: String,
}

/// The certificate a direct login would pin, for the confirmation dialog
/// (ADR 0008).
///
/// The probe never authenticates: this view only describes what the server
/// presented on a TLS handshake that was closed immediately.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ServerProbeView {
    /// `host:port` exactly as it will be used.
    pub host: String,
    /// Host without the port.
    pub hostname: String,
    pub port: u16,
    /// Pinned (IP address) or Web PKI (DNS name).
    pub mode: ServerMode,
    /// SHA-256 of the certificate the server presented, lowercase hex.
    pub fingerprint: String,
    /// Saved display name for this host, when the server is already known.
    pub known_name: Option<String>,
    /// Saved fingerprint for this host, when the server is already known.
    pub known_fingerprint: Option<String>,
    /// The presented certificate differs from the saved one: a direct login
    /// must be blocked until the user explicitly accepts it.
    pub certificate_changed: bool,
}

/// Everything the UI mirrors from the core.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoreState {
    pub connection: ConnectionPhase,
    pub reconnect: Option<ReconnectInfo>,
    pub server: Option<ServerView>,
    pub roles: Vec<RoleView>,
    pub channels: Vec<ChannelView>,
    pub users: Vec<UserView>,
    /// Id of the caller in `users`, 0 when not connected.
    pub self_user_id: u64,
    /// Own current nickname, empty when not connected.
    pub nickname: String,
    /// Local profile; survives disconnects and restarts.
    pub profile: ProfileView,
    pub permissions: Option<PermissionsView>,
    /// Unread and mention counters per conversation.
    pub unread: Vec<UnreadView>,
    /// Saved servers, newest first.
    pub servers: Vec<ServerBookmark>,
    /// Bookmark id of the active/last attempted server.
    pub active_server_id: Option<String>,
    /// Last fatal error, cleared by the next successful connect.
    pub error: Option<crate::error::CoreError>,
    pub protocol_version: u32,
    pub client_version: String,
}

impl CoreState {
    /// Empty state at startup, before any connection.
    #[must_use]
    pub fn disconnected() -> Self {
        Self {
            connection: ConnectionPhase::Disconnected,
            reconnect: None,
            server: None,
            roles: Vec::new(),
            channels: Vec::new(),
            users: Vec::new(),
            self_user_id: 0,
            nickname: String::new(),
            profile: ProfileView::default(),
            permissions: None,
            unread: Vec::new(),
            servers: Vec::new(),
            active_server_id: None,
            error: None,
            protocol_version: crate::PROTOCOL_VERSION,
            client_version: env!("CARGO_PKG_VERSION").to_owned(),
        }
    }
}

/// Connection phase, reconnect counter and/or fatal error changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDelta {
    pub connection: ConnectionPhase,
    pub reconnect: Option<ReconnectInfo>,
    pub error: Option<crate::error::CoreError>,
}

/// A user disconnected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UserLeftDelta {
    pub user_id: u64,
}

/// A user changed channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UserMovedDelta {
    pub user_id: u64,
    pub from_channel_id: u64,
    pub to_channel_id: u64,
}

/// A channel disappeared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDeletedDelta {
    pub channel_id: u64,
}

/// A message disappeared. The ids identify the conversation for both sides.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MessageDeletedDelta {
    pub message_id: u64,
    pub channel_id: u64,
    pub sender_id: u64,
    pub recipient_id: u64,
}

/// The connection was cleared: the UI must drop the tree, users and own
/// identity while keeping the saved servers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResetDelta {
    /// Saved servers, preserved across disconnects.
    pub servers: Vec<ServerBookmark>,
    /// Bookmark id of the last attempted server.
    pub active_server_id: Option<String>,
    /// Local profile, preserved across disconnects.
    pub profile: ProfileView,
    /// Fatal error that caused the reset, if any.
    pub error: Option<crate::error::CoreError>,
    pub protocol_version: u32,
    pub client_version: String,
}

/// One incremental state change. The UI applies it to its mirrored snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum StateDelta {
    /// Connection phase, reconnect counter and/or fatal error changed.
    Connection(ConnectionDelta),
    /// The session is gone; clear everything except the saved servers.
    Reset(ResetDelta),
    UserJoined(UserView),
    UserLeft(UserLeftDelta),
    UserMoved(UserMovedDelta),
    UserUpdated(UserView),
    ChannelCreated(ChannelView),
    ChannelUpdated(ChannelView),
    ChannelDeleted(ChannelDeletedDelta),
    ServerUpdated(ServerView),
    /// The role list changed; replace the cached roles.
    RolesUpdated(Vec<RoleView>),
    /// The caller's own effective permissions changed.
    PermissionsUpdated(PermissionsView),
    /// A chat message was created (also sent to its author).
    MessageCreated(MessageView),
    /// A message was edited.
    MessageUpdated(MessageView),
    /// A message was removed.
    MessageDeleted(MessageDeletedDelta),
    /// Unread or mention counters of one conversation changed.
    UnreadUpdated(UnreadView),
    /// Saved-server list changed.
    Bookmarks(Vec<ServerBookmark>),
    /// The local profile changed (nickname).
    Profile(ProfileView),
}

/// A typed event emitted to the UI through `tauri-specta`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum CoreEvent {
    /// Full replacement snapshot (after `Welcome`, including reconnects).
    Snapshot(Box<CoreState>),
    /// A single change to apply to the current snapshot.
    Delta(StateDelta),
}

/// Converts a server info block.
#[must_use]
pub fn server_view(info: &proto::ServerInfo) -> ServerView {
    ServerView {
        id: hex::encode(&info.id),
        name: info.name.clone(),
        version: info.version.clone(),
        protocol_version: info.protocol_version,
        login_mode: match proto::LoginMode::try_from(info.login_mode) {
            Ok(proto::LoginMode::Password) => LoginModeView::Password,
            Ok(proto::LoginMode::Open) => LoginModeView::Open,
            _ => LoginModeView::Invite,
        },
        max_users: info.max_users,
        online_users: info.online_users,
        password_set: info.password_set,
        // A server older than stage P3 does not send the field; the client
        // falls back to the same default the server would apply.
        max_attachment_bytes: if info.max_attachment_bytes > 0 {
            info.max_attachment_bytes
        } else {
            crate::proxy::default_max_upload()
        },
    }
}

/// Converts one role.
#[must_use]
pub fn role_view(role: &proto::Role) -> RoleView {
    RoleView {
        id: role.id,
        name: role.name.clone(),
        color: (role.color != 0).then(|| format!("#{:06x}", role.color & 0x00ff_ffff)),
        position: role.position,
        permissions: permission_names(role.permissions.as_ref()),
        builtin: role.builtin,
    }
}

/// Converts one channel.
#[must_use]
pub fn channel_view(channel: &proto::Channel) -> ChannelView {
    ChannelView {
        id: channel.id,
        parent_id: channel.parent_id,
        position: channel.position,
        name: channel.name.clone(),
        topic: channel.topic.clone(),
        kind: match proto::ChannelKind::try_from(channel.kind) {
            Ok(proto::ChannelKind::Text) => ChannelKindView::Text,
            _ => ChannelKindView::Voice,
        },
        user_limit: channel.user_limit,
        password_protected: channel.password_protected,
        temporary: channel.temporary,
        user_count: channel.user_count,
        voice_profile: match proto::VoiceProfile::try_from(channel.voice_profile) {
            Ok(proto::VoiceProfile::Music) => VoiceProfileView::Music,
            Ok(proto::VoiceProfile::VoiceHq) => VoiceProfileView::VoiceHq,
            _ => VoiceProfileView::Voice,
        },
        afk: channel.afk,
    }
}

/// Converts one user, resolving its display colour through the role list.
#[must_use]
pub fn user_view(user: &proto::User, roles: &HashMap<u64, &proto::Role>) -> UserView {
    let color = user
        .role_ids
        .iter()
        .filter_map(|id| roles.get(id).copied())
        .filter(|role| role.color != 0)
        .max_by_key(|role| role.position)
        .map(|role| format!("#{:06x}", role.color & 0x00ff_ffff));

    UserView {
        id: user.id,
        nickname: user.nickname.clone(),
        role_ids: user.role_ids.clone(),
        color,
        channel_id: user.channel_id,
        voice: voice_state_view(user.voice_state.as_ref()),
        streaming: user.streaming,
        watching_user_ids: user.watching_user_ids.clone(),
        connected_at_unix_ms: user.connected_at_unix_ms,
        avatar_hash: user.avatar_hash.clone(),
    }
}

fn voice_state_view(voice: Option<&proto::VoiceState>) -> VoiceStateView {
    match voice {
        Some(voice) => VoiceStateView {
            self_muted: voice.self_muted,
            self_deafened: voice.self_deafened,
            server_muted: voice.server_muted,
            server_deafened: voice.server_deafened,
            away: voice.away,
            priority_speaker: voice.priority_speaker,
        },
        None => VoiceStateView::default(),
    }
}

/// Converts the caller's permission view to stable camelCase names.
#[must_use]
pub fn permissions_view(permissions: Option<&proto::MyPermissions>) -> PermissionsView {
    let Some(permissions) = permissions else {
        return PermissionsView::default();
    };
    PermissionsView {
        server: permission_names(permissions.server.as_ref()),
        channels: permissions
            .channels
            .iter()
            .map(|entry| ChannelPermissionsView {
                channel_id: entry.channel_id,
                permissions: permission_names(entry.effective.as_ref()),
            })
            .collect(),
    }
}

/// Converts one chat message.
#[must_use]
pub fn message_view(message: &proto::Message) -> MessageView {
    MessageView {
        id: message.id,
        channel_id: message.channel_id,
        sender_id: message.sender_id,
        recipient_id: message.recipient_id,
        sender_nickname: message.sender_nickname.clone(),
        body: message.body.clone(),
        created_at_unix_ms: message.created_at_unix_ms,
        edited_at_unix_ms: message.edited_at_unix_ms,
        attachments: message
            .attachments
            .iter()
            .map(|attachment| AttachmentView {
                id: attachment.id,
                file_name: attachment.file_name.clone(),
                content_type: attachment.content_type.clone(),
                size_bytes: attachment.size_bytes,
                width: attachment.width,
                height: attachment.height,
                image: attachment.image,
            })
            .collect(),
        mention_user_ids: message.mention_user_ids.clone(),
    }
}

/// Converts one unread counter.
#[must_use]
pub fn unread_view(counter: &proto::UnreadCounter) -> UnreadView {
    UnreadView {
        channel_id: counter.channel_id,
        peer_user_id: counter.peer_user_id,
        unread: counter.unread,
        mentions: counter.mentions,
        last_read_message_id: counter.last_read_message_id,
        peer_nickname: counter.peer_nickname.clone(),
        last_message_id: counter.last_message_id,
    }
}

/// Converts the snapshot's unread block.
#[must_use]
pub fn unread_views(state: Option<&proto::UnreadState>) -> Vec<UnreadView> {
    state
        .map(|state| state.conversations.iter().map(unread_view).collect())
        .unwrap_or_default()
}

fn permission_names(set: Option<&proto::PermissionSet>) -> Vec<String> {
    let Some(set) = set else {
        return Vec::new();
    };
    let mut names: Vec<String> = set
        .permissions
        .iter()
        .filter_map(|value| proto::Permission::try_from(*value).ok())
        .filter(|permission| *permission != proto::Permission::Unspecified)
        .map(|permission| permission_name(permission).to_owned())
        .collect();
    names.sort_unstable();
    names.dedup();
    names
}

/// Stable camelCase name of a permission for the UI.
#[must_use]
pub fn permission_name(permission: proto::Permission) -> &'static str {
    use proto::Permission as P;
    match permission {
        P::Unspecified => "unspecified",
        P::ManageServer => "manageServer",
        P::ManageRoles => "manageRoles",
        P::ManageChannels => "manageChannels",
        P::ManageInvites => "manageInvites",
        P::ViewAuditLog => "viewAuditLog",
        P::Kick => "kick",
        P::Ban => "ban",
        P::MoveMembers => "moveMembers",
        P::MuteMembers => "muteMembers",
        P::DeafenMembers => "deafenMembers",
        P::ViewChannel => "viewChannel",
        P::JoinChannel => "joinChannel",
        P::Speak => "speak",
        P::UseVoiceActivation => "useVoiceActivation",
        P::PrioritySpeaker => "prioritySpeaker",
        P::BypassUserLimit => "bypassUserLimit",
        P::BypassChannelPassword => "bypassChannelPassword",
        P::Stream => "stream",
        P::StreamHq => "streamHq",
        P::CreateTempChannel => "createTempChannel",
        P::ChangeNickname => "changeNickname",
        P::SendMessages => "sendMessages",
        P::AttachFiles => "attachFiles",
        P::ManageMessages => "manageMessages",
    }
}

/// Sorts channels by parent, position and name so the tree is deterministic
/// regardless of the order the server used.
pub fn sort_channels(channels: &mut [ChannelView]) {
    channels.sort_by(|a, b| {
        a.parent_id
            .cmp(&b.parent_id)
            .then(a.position.cmp(&b.position))
            .then(a.name.cmp(&b.name))
            .then(a.id.cmp(&b.id))
    });
}

/// Sorts users by nickname (case-insensitive) then id.
pub fn sort_users(users: &mut [UserView]) {
    users.sort_by(|a, b| {
        a.nickname
            .to_lowercase()
            .cmp(&b.nickname.to_lowercase())
            .then(a.id.cmp(&b.id))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_kind_defaults_to_voice() {
        let channel = proto::Channel {
            id: 4,
            kind: proto::ChannelKind::Unspecified as i32,
            ..Default::default()
        };
        assert_eq!(channel_view(&channel).kind, ChannelKindView::Voice);

        let text = proto::Channel {
            id: 5,
            kind: proto::ChannelKind::Text as i32,
            ..Default::default()
        };
        assert_eq!(channel_view(&text).kind, ChannelKindView::Text);
    }

    #[test]
    fn user_colour_comes_from_the_highest_coloured_role() {
        let admin = proto::Role {
            id: 1,
            color: 0xff0000,
            position: 10,
            ..Default::default()
        };
        let member = proto::Role {
            id: 2,
            color: 0x00ff00,
            position: 1,
            ..Default::default()
        };
        let roles = HashMap::from([(1, &admin), (2, &member)]);
        let user = proto::User {
            id: 7,
            role_ids: vec![2, 1],
            ..Default::default()
        };
        let view = user_view(&user, &roles);
        assert_eq!(view.color.as_deref(), Some("#ff0000"));
    }

    #[test]
    fn user_without_roles_has_no_colour() {
        let roles = HashMap::new();
        let user = proto::User {
            id: 7,
            role_ids: vec![],
            ..Default::default()
        };
        assert!(user_view(&user, &roles).color.is_none());
    }

    #[test]
    fn user_view_carries_the_watched_streams() {
        let roles = HashMap::new();
        let user = proto::User {
            id: 7,
            streaming: true,
            watching_user_ids: vec![3, 5],
            ..Default::default()
        };
        let view = user_view(&user, &roles);
        assert!(view.streaming);
        assert_eq!(view.watching_user_ids, vec![3, 5]);
    }

    #[test]
    fn permission_names_are_camel_case_and_sorted() {
        let set = proto::PermissionSet {
            permissions: vec![
                proto::Permission::Speak as i32,
                proto::Permission::JoinChannel as i32,
                proto::Permission::Speak as i32,
            ],
        };
        let view = permissions_view(Some(&proto::MyPermissions {
            server: Some(proto::PermissionSet::default()),
            channels: vec![proto::ChannelPermissions {
                channel_id: 3,
                effective: Some(set),
            }],
        }));
        assert!(view.server.is_empty());
        assert_eq!(view.channels[0].permissions, vec!["joinChannel", "speak"]);
    }

    #[test]
    fn server_mode_and_login_are_part_of_bookmarks() {
        let bookmark = ServerBookmark {
            id: "192.168.0.13:7443".to_owned(),
            name: "RosTalk".to_owned(),
            host: "192.168.0.13:7443".to_owned(),
            fingerprint: "abc".to_owned(),
            mode: ServerMode::Pinned,
            login: BookmarkLogin::Direct,
            nickname: "alice".to_owned(),
            server_id: None,
            last_connected_unix_ms: 0,
            link: "rostalk://join?host=192.168.0.13:7443&fp=abc".to_owned(),
        };
        let json = serde_json::to_string(&bookmark).expect("json");
        assert!(json.contains("\"mode\":\"pinned\""));
        assert!(json.contains("\"login\":\"direct\""));
        assert!(json.contains("\"nickname\":\"alice\""));
    }

    fn channel(id: u64, parent_id: u64, position: i32, name: &str) -> ChannelView {
        ChannelView {
            id,
            parent_id,
            position,
            name: name.to_owned(),
            topic: String::new(),
            kind: ChannelKindView::Voice,
            user_limit: 0,
            password_protected: false,
            temporary: false,
            user_count: 0,
            voice_profile: VoiceProfileView::Voice,
            afk: false,
        }
    }

    fn user(id: u64, nickname: &str) -> UserView {
        UserView {
            id,
            nickname: nickname.to_owned(),
            role_ids: Vec::new(),
            color: None,
            channel_id: 0,
            voice: VoiceStateView::default(),
            streaming: false,
            watching_user_ids: Vec::new(),
            connected_at_unix_ms: 0,
            avatar_hash: String::new(),
        }
    }

    #[test]
    fn channels_sort_by_parent_position_name_and_id() {
        let mut channels = vec![
            channel(3, 0, 1, "bravo"),
            channel(1, 0, 2, "zulu"),
            channel(2, 0, 1, "alpha"),
            channel(4, 0, 1, "alpha"),
            channel(5, 0, 0, "zulu"),
            channel(6, 2, 0, "child"),
        ];
        sort_channels(&mut channels);
        let ids: Vec<u64> = channels.iter().map(|item| item.id).collect();
        // Same parent and position is broken by name, then by id; a child sorts
        // after every top-level row because the parent is its first key.
        assert_eq!(ids, vec![5, 2, 4, 3, 1, 6]);
    }

    #[test]
    fn users_sort_case_insensitively_then_by_id() {
        let mut users = vec![user(1, "Bob"), user(3, "alice"), user(2, "alice")];
        sort_users(&mut users);
        let ids: Vec<u64> = users.iter().map(|item| item.id).collect();
        assert_eq!(ids, vec![2, 3, 1]);
    }

    #[test]
    fn login_mode_and_voice_profile_are_mapped_explicitly() {
        let server = |mode: proto::LoginMode| {
            server_view(&proto::ServerInfo {
                login_mode: mode as i32,
                ..Default::default()
            })
            .login_mode
        };
        assert_eq!(server(proto::LoginMode::Password), LoginModeView::Password);
        assert_eq!(server(proto::LoginMode::Open), LoginModeView::Open);
        assert_eq!(server(proto::LoginMode::Invite), LoginModeView::Invite);
        assert_eq!(server(proto::LoginMode::Unspecified), LoginModeView::Invite);

        let profile = |kind: proto::VoiceProfile| {
            channel_view(&proto::Channel {
                voice_profile: kind as i32,
                ..Default::default()
            })
            .voice_profile
        };
        // A pre-P3 server sends no limit; the client uses the same default
        // instead of showing a zero-byte limit.
        assert_eq!(
            server_view(&proto::ServerInfo::default()).max_attachment_bytes,
            crate::proxy::default_max_upload()
        );
        assert_eq!(
            server_view(&proto::ServerInfo {
                max_attachment_bytes: 30 << 20,
                ..Default::default()
            })
            .max_attachment_bytes,
            30 << 20
        );
        assert_eq!(profile(proto::VoiceProfile::Music), VoiceProfileView::Music);
        assert_eq!(
            profile(proto::VoiceProfile::VoiceHq),
            VoiceProfileView::VoiceHq
        );
        assert_eq!(
            profile(proto::VoiceProfile::Unspecified),
            VoiceProfileView::Voice
        );
    }

    #[test]
    fn unread_views_keep_every_counter() {
        let state = proto::UnreadState {
            conversations: vec![proto::UnreadCounter {
                channel_id: 5,
                unread: 2,
                mentions: 1,
                ..Default::default()
            }],
        };
        let views = unread_views(Some(&state));
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].channel_id, 5);
        assert_eq!(views[0].unread, 2);
        assert_eq!(views[0].mentions, 1);
        assert!(unread_views(None).is_empty());
    }
}
