//! Client state store: a snapshot plus the events that change it.
//!
//! The server always sends a full snapshot after a successful handshake, so the
//! store never replays events: `apply_snapshot` replaces everything, and
//! `apply_event` applies one delta between snapshots (design 4.6).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreErrorCode};
use crate::link::InviteLink;
use crate::model::{
    self, BookmarkLogin, CoreState, ReconnectInfo, ServerBookmark, ServerView, StateDelta,
    UnreadView, UserView,
};
use crate::proto;
use crate::settings::ProfileView;

/// File with saved servers inside the app data directory.
pub const BOOKMARKS_FILE: &str = "servers.json";

/// Current bookmarks file format. Version 2 keys bookmarks by `host:port` and
/// stores the login mode and nickname (ADR 0008); version 1 keyed them by the
/// certificate fingerprint.
const BOOKMARKS_FORMAT_VERSION: u32 = 2;

/// In-memory state of one client.
#[derive(Debug)]
pub struct StateStore {
    state: CoreState,
}

impl StateStore {
    /// Creates a store with the disconnected state, the saved servers and the
    /// local profile.
    #[must_use]
    pub fn new(
        servers: Vec<ServerBookmark>,
        active_server_id: Option<String>,
        profile: ProfileView,
    ) -> Self {
        let mut state = CoreState::disconnected();
        state.servers = servers;
        state.active_server_id = active_server_id;
        state.profile = profile;
        Self { state }
    }

    /// Current snapshot.
    #[must_use]
    pub fn state(&self) -> &CoreState {
        &self.state
    }

    /// Mutable snapshot for the worker, which owns all transitions.
    pub fn state_mut(&mut self) -> &mut CoreState {
        &mut self.state
    }

    /// Replaces the whole snapshot after `Welcome`.
    pub fn apply_snapshot(
        &mut self,
        snapshot: &proto::ServerSnapshot,
        self_user_id: u64,
        connection: model::ConnectionPhase,
    ) {
        let roles: Vec<_> = snapshot.roles.iter().map(model::role_view).collect();
        let role_map: HashMap<u64, &proto::Role> =
            snapshot.roles.iter().map(|role| (role.id, role)).collect();

        let mut channels: Vec<_> = snapshot.channels.iter().map(model::channel_view).collect();
        model::sort_channels(&mut channels);

        let mut users: Vec<_> = snapshot
            .users
            .iter()
            .map(|user| model::user_view(user, &role_map))
            .collect();
        model::sort_users(&mut users);

        self.state.server = snapshot.server.as_ref().map(model::server_view);
        self.state.roles = roles;
        self.state.channels = channels;
        self.state.users = users;
        self.state.self_user_id = self_user_id;
        self.state.nickname = self
            .state
            .users
            .iter()
            .find(|user| user.id == self_user_id)
            .map_or_else(String::new, |user| user.nickname.clone());
        self.state.permissions = Some(model::permissions_view(snapshot.permissions.as_ref()));
        self.state.unread = model::unread_views(snapshot.unread.as_ref());
        self.state.connection = connection;
        self.state.reconnect = None;
        self.state.error = None;
    }

    /// Applies one server event. Returns the delta the UI should mirror, or
    /// `None` when the event changes nothing the client knows about.
    pub fn apply_event(&mut self, event: &proto::Event) -> Option<StateDelta> {
        let payload = event.payload.as_ref()?;
        match payload {
            proto::event::Payload::UserJoined(joined) => {
                let view = self.convert_user(joined.user.as_ref()?);
                self.upsert_user(view.clone());
                Some(StateDelta::UserJoined(view))
            }
            proto::event::Payload::UserLeft(left) => {
                let before = self.state.users.len();
                self.state.users.retain(|user| user.id != left.user_id);
                (before != self.state.users.len()).then_some(StateDelta::UserLeft(
                    model::UserLeftDelta {
                        user_id: left.user_id,
                    },
                ))
            }
            proto::event::Payload::UserMoved(moved) => {
                let user = self
                    .state
                    .users
                    .iter_mut()
                    .find(|user| user.id == moved.user_id)?;
                user.channel_id = moved.to_channel_id;
                // A viewer list only names streams of one channel. The server
                // clears it on a move, and the event itself carries no list, so
                // the mirror drops it here instead of keeping a stale audience.
                user.watching_user_ids.clear();
                Some(StateDelta::UserMoved(model::UserMovedDelta {
                    user_id: moved.user_id,
                    from_channel_id: moved.from_channel_id,
                    to_channel_id: moved.to_channel_id,
                }))
            }
            proto::event::Payload::UserUpdated(updated) => {
                let view = self.convert_user(updated.user.as_ref()?);
                self.upsert_user(view.clone());
                if view.id == self.state.self_user_id {
                    self.state.nickname = view.nickname.clone();
                }
                Some(StateDelta::UserUpdated(view))
            }
            proto::event::Payload::ChannelCreated(created) => {
                let view = model::channel_view(created.channel.as_ref()?);
                self.upsert_channel(view.clone());
                Some(StateDelta::ChannelCreated(view))
            }
            proto::event::Payload::ChannelUpdated(updated) => {
                let view = model::channel_view(updated.channel.as_ref()?);
                self.upsert_channel(view.clone());
                Some(StateDelta::ChannelUpdated(view))
            }
            proto::event::Payload::ChannelDeleted(deleted) => {
                let before = self.state.channels.len();
                self.state
                    .channels
                    .retain(|channel| channel.id != deleted.channel_id);
                (before != self.state.channels.len()).then_some(StateDelta::ChannelDeleted(
                    model::ChannelDeletedDelta {
                        channel_id: deleted.channel_id,
                    },
                ))
            }
            proto::event::Payload::ServerUpdated(updated) => {
                let view = model::server_view(updated.server.as_ref()?);
                self.state.server = Some(view.clone());
                Some(StateDelta::ServerUpdated(view))
            }
            proto::event::Payload::RolesUpdated(updated) => {
                let roles: Vec<_> = updated.roles.iter().map(model::role_view).collect();
                self.state.roles = roles.clone();
                Some(StateDelta::RolesUpdated(roles))
            }
            proto::event::Payload::PermissionsUpdated(updated) => {
                let view = model::permissions_view(updated.permissions.as_ref());
                self.state.permissions = Some(view.clone());
                Some(StateDelta::PermissionsUpdated(view))
            }
            proto::event::Payload::MessageCreated(created) => {
                let message = created.message.as_ref()?;
                Some(StateDelta::MessageCreated(model::message_view(message)))
            }
            proto::event::Payload::MessageUpdated(updated) => {
                let message = updated.message.as_ref()?;
                Some(StateDelta::MessageUpdated(model::message_view(message)))
            }
            proto::event::Payload::MessageDeleted(deleted) => {
                let message = deleted.message.as_ref()?;
                Some(StateDelta::MessageDeleted(model::MessageDeletedDelta {
                    message_id: message.id,
                    channel_id: message.channel_id,
                    sender_id: message.sender_id,
                    recipient_id: message.recipient_id,
                }))
            }
            proto::event::Payload::UnreadUpdated(updated) => {
                let counter = updated.counter.as_ref()?;
                let view = model::unread_view(counter);
                self.upsert_unread(view.clone());
                Some(StateDelta::UnreadUpdated(view))
            }
        }
    }

    /// Replaces the counter of one conversation.
    fn upsert_unread(&mut self, view: UnreadView) {
        if let Some(existing) = self.state.unread.iter_mut().find(|counter| {
            counter.channel_id == view.channel_id && counter.peer_user_id == view.peer_user_id
        }) {
            *existing = view;
            return;
        }
        self.state.unread.push(view);
    }

    /// Updates the connection phase and returns the delta to emit.
    pub fn set_connection(
        &mut self,
        connection: model::ConnectionPhase,
        reconnect: Option<ReconnectInfo>,
        error: Option<CoreError>,
    ) -> StateDelta {
        self.state.connection = connection;
        self.state.reconnect = reconnect;
        self.state.error = error.clone();
        StateDelta::Connection(model::ConnectionDelta {
            connection,
            reconnect,
            error,
        })
    }

    /// Clears the session but keeps the saved servers. Used by Disconnect and
    /// by a fatal connect error.
    pub fn clear_session(&mut self) {
        self.state.server = None;
        self.state.roles.clear();
        self.state.channels.clear();
        self.state.users.clear();
        self.state.self_user_id = 0;
        self.state.nickname.clear();
        self.state.permissions = None;
        self.state.unread.clear();
        self.state.connection = model::ConnectionPhase::Disconnected;
        self.state.reconnect = None;
        self.state.error = None;
    }

    /// Replaces the saved-server list.
    pub fn set_bookmarks(&mut self, servers: Vec<ServerBookmark>) {
        self.state.servers = servers;
    }

    /// Sets the active bookmark id.
    pub fn set_active_server(&mut self, id: Option<String>) {
        self.state.active_server_id = id;
    }

    /// Replaces the local profile and returns the delta to emit.
    pub fn set_profile(&mut self, profile: ProfileView) -> StateDelta {
        self.state.profile = profile.clone();
        StateDelta::Profile(profile)
    }

    /// Channel of the caller, 0 when not in a channel.
    #[must_use]
    pub fn own_channel_id(&self) -> u64 {
        self.state
            .users
            .iter()
            .find(|user| user.id == self.state.self_user_id)
            .map_or(0, |user| user.channel_id)
    }

    /// Server display name if connected.
    #[must_use]
    pub fn server_name(&self) -> Option<&str> {
        self.state
            .server
            .as_ref()
            .map(|server| server.name.as_str())
    }

    fn convert_user(&self, user: &proto::User) -> UserView {
        // The store keeps role views, not proto roles. Colour resolution is
        // repeated from the role list so events do not need the snapshot.
        let roles: HashMap<u64, &proto::Role> = HashMap::new();
        let mut view = model::user_view(user, &roles);
        view.color = self.highest_role_color(&view.role_ids);
        view
    }

    fn highest_role_color(&self, role_ids: &[u64]) -> Option<String> {
        role_ids
            .iter()
            .filter_map(|id| self.state.roles.iter().find(|role| role.id == *id))
            .filter(|role| role.color.is_some())
            .max_by_key(|role| role.position)
            .and_then(|role| role.color.clone())
    }

    fn upsert_user(&mut self, user: UserView) {
        if let Some(existing) = self.state.users.iter_mut().find(|item| item.id == user.id) {
            *existing = user;
        } else {
            self.state.users.push(user);
        }
        model::sort_users(&mut self.state.users);
    }

    fn upsert_channel(&mut self, channel: model::ChannelView) {
        if let Some(existing) = self
            .state
            .channels
            .iter_mut()
            .find(|item| item.id == channel.id)
        {
            *existing = channel;
        } else {
            self.state.channels.push(channel);
        }
        model::sort_channels(&mut self.state.channels);
    }
}

/// Saved servers on disk.
#[derive(Debug)]
pub struct BookmarkStore {
    path: PathBuf,
    servers: Vec<ServerBookmark>,
    active: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookmarksFile {
    version: u32,
    #[serde(default)]
    active: Option<String>,
    #[serde(default)]
    servers: Vec<ServerBookmark>,
}

/// Version 1 of `servers.json`: bookmarks were keyed by the TLS fingerprint
/// and had no login mode or nickname.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookmarksFileV1 {
    version: u32,
    #[serde(default)]
    active: Option<String>,
    #[serde(default)]
    servers: Vec<ServerBookmarkV1>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerBookmarkV1 {
    #[serde(default)]
    name: String,
    #[serde(default)]
    host: String,
    #[serde(default)]
    fingerprint: String,
    #[serde(default = "default_mode")]
    mode: crate::link::ServerMode,
    #[serde(default)]
    server_id: Option<String>,
    #[serde(default)]
    last_connected_unix_ms: i64,
    #[serde(default)]
    link: String,
}

fn default_mode() -> crate::link::ServerMode {
    crate::link::ServerMode::Pinned
}

impl ServerBookmarkV1 {
    fn into_current(self) -> ServerBookmark {
        let id = if self.host.is_empty() {
            self.fingerprint.clone()
        } else {
            self.host.clone()
        };
        ServerBookmark {
            id,
            name: self.name,
            host: self.host,
            fingerprint: self.fingerprint,
            mode: self.mode,
            login: BookmarkLogin::Invite,
            nickname: String::new(),
            server_id: self.server_id,
            last_connected_unix_ms: self.last_connected_unix_ms,
            link: self.link,
        }
    }
}

impl BookmarkStore {
    /// Loads the bookmark file from `dir`. A missing or damaged file yields an
    /// empty list: a broken bookmarks file must not prevent the client from
    /// starting. A version 1 file is migrated and rewritten in place.
    #[must_use]
    pub fn open(dir: &Path) -> Self {
        let path = dir.join(BOOKMARKS_FILE);
        let data = match std::fs::read(&path) {
            Ok(data) => Some(data),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => {
                log::warn!("could not read servers.json: {err}");
                None
            }
        };
        let (servers, active, migrated) = match data {
            Some(data) => match parse_bookmarks(&data) {
                Some(parsed) => parsed,
                None => {
                    log::warn!("servers.json is damaged or from a newer version; ignoring it");
                    (Vec::new(), None, false)
                }
            },
            None => (Vec::new(), None, false),
        };
        let store = Self {
            path,
            servers,
            active,
        };
        if migrated {
            if let Err(err) = store.save() {
                log::warn!(
                    "could not rewrite servers.json after migration: {}",
                    err.message
                );
            }
        }
        store
    }

    /// Creates an in-memory store without a file (unit tests).
    #[must_use]
    pub fn in_memory() -> Self {
        Self {
            path: PathBuf::new(),
            servers: Vec::new(),
            active: None,
        }
    }

    /// Saved servers, newest first.
    #[must_use]
    pub fn servers(&self) -> Vec<ServerBookmark> {
        self.servers.clone()
    }

    /// Currently selected bookmark.
    #[must_use]
    pub fn active(&self) -> Option<String> {
        self.active.clone()
    }

    /// Remembers a server after a successful handshake. Returns the updated
    /// list. The invite token is never written to disk.
    ///
    /// `fingerprint_hex` is the certificate the connection was pinned to, or
    /// the probed certificate for a DNS host (Web PKI). The bookmark id is the
    /// `host:port`, so a new certificate replaces the entry instead of adding a
    /// second one (ADR 0004, ADR 0008).
    pub fn remember_connected(
        &mut self,
        link: &InviteLink,
        server: &ServerView,
        login: BookmarkLogin,
        nickname: &str,
        fingerprint_hex: &str,
    ) -> Result<Vec<ServerBookmark>, CoreError> {
        let id = link.authority();
        let fingerprint = if fingerprint_hex.is_empty() {
            link.fingerprint_hex()
        } else {
            fingerprint_hex.to_owned()
        };
        let mut bookmark = self
            .servers
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .unwrap_or_else(|| ServerBookmark {
                id: id.clone(),
                name: server.name.clone(),
                host: id.clone(),
                fingerprint: fingerprint.clone(),
                mode: link.mode(),
                login,
                nickname: String::new(),
                server_id: None,
                last_connected_unix_ms: 0,
                link: link.without_invite(),
            });
        bookmark.name = server.name.clone();
        bookmark.host = id.clone();
        bookmark.fingerprint = fingerprint;
        bookmark.mode = link.mode();
        bookmark.login = login;
        if !nickname.is_empty() {
            bookmark.nickname = nickname.to_owned();
        }
        bookmark.server_id = Some(server.id.clone());
        bookmark.last_connected_unix_ms = now_unix_ms();
        bookmark.link = link.without_invite();

        self.servers.retain(|item| item.id != id);
        self.servers.insert(0, bookmark);
        self.active = Some(id);
        self.save()?;
        Ok(self.servers())
    }

    /// Saved bookmark for a `host:port`, if any.
    #[must_use]
    pub fn bookmark_for(&self, host: &str) -> Option<ServerBookmark> {
        self.servers.iter().find(|item| item.host == host).cloned()
    }

    /// Checks a certificate a direct login is about to pin against the saved
    /// one for the same host (ADR 0008).
    ///
    /// A mismatch is an error: a changed certificate must never be accepted
    /// silently. The caller may retry with an explicit user confirmation.
    pub fn check_certificate(
        &self,
        host: &str,
        fingerprint_hex: &str,
    ) -> Result<Option<ServerBookmark>, CoreError> {
        let Some(bookmark) = self.bookmark_for(host) else {
            return Ok(None);
        };
        if !bookmark.fingerprint.is_empty() && bookmark.fingerprint != fingerprint_hex {
            return Err(CoreError::new(
                CoreErrorCode::ServerCertificateChanged,
                "the server certificate changed since the last login; the new fingerprint must be confirmed",
            ));
        }
        Ok(Some(bookmark))
    }

    /// Remembers the last nickname used with a saved server.
    pub fn set_nickname(&mut self, id: &str, nickname: &str) -> Result<(), CoreError> {
        let Some(bookmark) = self.servers.iter_mut().find(|item| item.id == id) else {
            return Ok(());
        };
        bookmark.nickname = nickname.to_owned();
        self.save()
    }

    /// Checks a newly received server identity against the saved one.
    ///
    /// A changed identity on the same host is suspicious: the server key
    /// changed under an address we already knew (ADR 0004). Returns an error
    /// that stops the connection instead of silently trusting the new key.
    pub fn check_server_identity(
        &self,
        link: &InviteLink,
        server_id: &str,
    ) -> Result<(), CoreError> {
        let Some(bookmark) = self.bookmark_for(&link.authority()) else {
            return Ok(());
        };
        if let Some(known) = &bookmark.server_id {
            if !known.is_empty() && known != server_id {
                return Err(CoreError::new(
                    CoreErrorCode::ServerIdChanged,
                    "the server identity key changed; refuse to trust the new key automatically",
                ));
            }
        }
        Ok(())
    }

    /// Removes a saved server.
    pub fn remove(&mut self, id: &str) -> Result<Vec<ServerBookmark>, CoreError> {
        self.servers.retain(|item| item.id != id);
        if self.active.as_deref() == Some(id) {
            self.active = None;
        }
        self.save()?;
        Ok(self.servers())
    }

    /// Forgets the active server (after Disconnect).
    pub fn clear_active(&mut self) {
        self.active = None;
    }

    fn save(&self) -> Result<(), CoreError> {
        if self.path.as_os_str().is_empty() {
            return Ok(());
        }
        let file = BookmarksFile {
            version: BOOKMARKS_FORMAT_VERSION,
            active: self.active.clone(),
            servers: self.servers.clone(),
        };
        let data = serde_json::to_vec_pretty(&file)
            .map_err(|err| CoreError::internal(format!("encode servers.json: {err}")))?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| CoreError::internal(format!("create app data dir: {err}")))?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, data)
            .map_err(|err| CoreError::internal(format!("write servers.json: {err}")))?;
        std::fs::rename(&tmp, &self.path)
            .map_err(|err| CoreError::internal(format!("replace servers.json: {err}")))
    }
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

/// Parses a bookmarks file of any supported version.
///
/// Returns the servers, the active id in the **current** id space and whether
/// the file was migrated and must be rewritten.
fn parse_bookmarks(data: &[u8]) -> Option<(Vec<ServerBookmark>, Option<String>, bool)> {
    if let Ok(file) = serde_json::from_slice::<BookmarksFile>(data) {
        if file.version == BOOKMARKS_FORMAT_VERSION {
            return Some((file.servers, file.active, false));
        }
    }
    if let Ok(file) = serde_json::from_slice::<BookmarksFileV1>(data) {
        if file.version == 1 {
            let servers: Vec<ServerBookmark> = file
                .servers
                .into_iter()
                .map(ServerBookmarkV1::into_current)
                .collect();
            // Version 1 stored the fingerprint as the id; the active server is
            // the entry with that fingerprint.
            let active = file.active.and_then(|old| {
                servers
                    .iter()
                    .find(|server| server.fingerprint == old || server.id == old)
                    .map(|server| server.id.clone())
            });
            return Some((servers, active, true));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ChannelKindView, ConnectionPhase, LoginModeView, VoiceStateView};

    fn snapshot() -> proto::ServerSnapshot {
        proto::ServerSnapshot {
            server: Some(proto::ServerInfo {
                id: vec![1u8; 32],
                name: "RosTalk".to_owned(),
                version: "0.1.0".to_owned(),
                protocol_version: 1,
                login_mode: proto::LoginMode::Invite as i32,
                max_users: 50,
                online_users: 2,
                password_set: false,
                max_attachment_bytes: 25 << 20,
            }),
            roles: vec![proto::Role {
                id: 1,
                name: "Admin".to_owned(),
                color: 0xf0a04b,
                position: 10,
                ..Default::default()
            }],
            channels: vec![
                proto::Channel {
                    id: 2,
                    parent_id: 0,
                    position: 1,
                    name: "AFK".to_owned(),
                    kind: proto::ChannelKind::Voice as i32,
                    user_count: 0,
                    afk: true,
                    ..Default::default()
                },
                proto::Channel {
                    id: 1,
                    parent_id: 0,
                    position: 0,
                    name: "Lobby".to_owned(),
                    kind: proto::ChannelKind::Voice as i32,
                    user_count: 1,
                    ..Default::default()
                },
            ],
            users: vec![
                proto::User {
                    id: 10,
                    nickname: "zoe".to_owned(),
                    role_ids: vec![1],
                    channel_id: 1,
                    voice_state: Some(proto::VoiceState {
                        self_muted: true,
                        ..Default::default()
                    }),
                    connected_at_unix_ms: 100,
                    ..Default::default()
                },
                proto::User {
                    id: 20,
                    nickname: "alice".to_owned(),
                    channel_id: 0,
                    connected_at_unix_ms: 200,
                    ..Default::default()
                },
            ],
            permissions: None,
            unread: None,
        }
    }

    fn store() -> StateStore {
        let mut store = StateStore::new(Vec::new(), None, ProfileView::default());
        store.apply_snapshot(&snapshot(), 10, ConnectionPhase::Connected);
        store
    }

    #[test]
    fn snapshot_sorts_channels_and_users_and_finds_self() {
        let store = store();
        let state = store.state();
        assert_eq!(state.channels[0].name, "Lobby");
        assert_eq!(state.channels[1].name, "AFK");
        assert!(state.channels[1].afk);
        assert!(!state.channels[0].afk);
        assert_eq!(state.users[0].nickname, "alice");
        assert_eq!(state.users[1].nickname, "zoe");
        assert_eq!(state.self_user_id, 10);
        assert_eq!(state.nickname, "zoe");
        assert_eq!(state.users[1].color.as_deref(), Some("#f0a04b"));
        assert!(state.users[1].voice.self_muted);
        assert_eq!(
            state.server.as_ref().map(|s| s.name.as_str()),
            Some("RosTalk")
        );
        assert_eq!(
            state.server.as_ref().map(|s| s.login_mode),
            Some(LoginModeView::Invite)
        );
        assert_eq!(store.own_channel_id(), 1);
    }

    #[test]
    fn server_name_and_bookmarks_follow_the_state() {
        let mut store = store();
        assert_eq!(store.server_name(), Some("RosTalk"));

        store.set_active_server(Some("192.168.0.13:7443".to_owned()));
        store.set_bookmarks(vec![ServerBookmark {
            id: "192.168.0.13:7443".to_owned(),
            name: "RosTalk".to_owned(),
            host: "192.168.0.13:7443".to_owned(),
            fingerprint: String::new(),
            mode: crate::link::ServerMode::Pinned,
            login: BookmarkLogin::Direct,
            nickname: String::new(),
            server_id: None,
            last_connected_unix_ms: 0,
            link: String::new(),
        }]);
        assert_eq!(
            store.state().active_server_id.as_deref(),
            Some("192.168.0.13:7443")
        );
        assert_eq!(store.state().servers.len(), 1);

        let mut empty = StateStore::new(Vec::new(), None, ProfileView::default());
        assert_eq!(empty.server_name(), None);
        assert_eq!(empty.own_channel_id(), 0, "not connected means no channel");
        empty.set_active_server(None);
        assert_eq!(empty.state().active_server_id, None);
    }

    #[test]
    fn user_left_removes_and_reports_the_delta() {
        let mut store = store();
        let delta = store.apply_event(&proto::Event {
            payload: Some(proto::event::Payload::UserLeft(proto::UserLeft {
                user_id: 20,
            })),
        });
        assert_eq!(
            delta,
            Some(StateDelta::UserLeft(model::UserLeftDelta { user_id: 20 }))
        );
        assert!(store.state().users.iter().all(|user| user.id != 20));
        // A repeated event changes nothing and reports nothing.
        assert!(store
            .apply_event(&proto::Event {
                payload: Some(proto::event::Payload::UserLeft(proto::UserLeft {
                    user_id: 20,
                })),
            })
            .is_none());
    }

    #[test]
    fn user_moved_updates_the_channel_and_keeps_the_rest() {
        let mut store = store();
        let delta = store.apply_event(&proto::Event {
            payload: Some(proto::event::Payload::UserMoved(proto::UserMoved {
                user_id: 20,
                from_channel_id: 0,
                to_channel_id: 2,
            })),
        });
        assert_eq!(
            delta,
            Some(StateDelta::UserMoved(model::UserMovedDelta {
                user_id: 20,
                from_channel_id: 0,
                to_channel_id: 2
            }))
        );
        let alice = store
            .state()
            .users
            .iter()
            .find(|u| u.id == 20)
            .expect("alice");
        assert_eq!(alice.channel_id, 2);
        assert_eq!(alice.voice, VoiceStateView::default());
    }

    #[test]
    fn watching_follows_the_presence_and_ends_with_the_move() {
        let mut store = store();
        // The viewer list arrives with every user update and is mirrored as is.
        let delta = store.apply_event(&proto::Event {
            payload: Some(proto::event::Payload::UserUpdated(proto::UserUpdated {
                user: Some(proto::User {
                    id: 20,
                    nickname: "alice".to_owned(),
                    channel_id: 1,
                    watching_user_ids: vec![10],
                    connected_at_unix_ms: 200,
                    ..Default::default()
                }),
            })),
        });
        let Some(StateDelta::UserUpdated(view)) = delta else {
            panic!("expected a user update");
        };
        assert_eq!(view.watching_user_ids, vec![10]);
        let alice = store
            .state()
            .users
            .iter()
            .find(|u| u.id == 20)
            .expect("alice");
        assert_eq!(alice.watching_user_ids, vec![10]);

        // A move carries no viewer list: a user in another channel cannot watch
        // the stream of the old one, so the mirror drops it.
        store.apply_event(&proto::Event {
            payload: Some(proto::event::Payload::UserMoved(proto::UserMoved {
                user_id: 20,
                from_channel_id: 1,
                to_channel_id: 2,
            })),
        });
        let alice = store
            .state()
            .users
            .iter()
            .find(|u| u.id == 20)
            .expect("alice");
        assert!(alice.watching_user_ids.is_empty());
    }

    #[test]
    fn user_updated_replaces_and_recomputes_the_colour() {
        let mut store = store();
        let delta = store.apply_event(&proto::Event {
            payload: Some(proto::event::Payload::UserUpdated(proto::UserUpdated {
                user: Some(proto::User {
                    id: 20,
                    nickname: "alice".to_owned(),
                    role_ids: vec![1],
                    connected_at_unix_ms: 200,
                    ..Default::default()
                }),
            })),
        });
        let Some(StateDelta::UserUpdated(user)) = delta else {
            panic!("expected a user update");
        };
        assert_eq!(user.color.as_deref(), Some("#f0a04b"));
    }

    #[test]
    fn own_nickname_follows_a_user_updated_event() {
        let mut store = store();
        store.apply_event(&proto::Event {
            payload: Some(proto::event::Payload::UserUpdated(proto::UserUpdated {
                user: Some(proto::User {
                    id: 10,
                    nickname: "zoe2".to_owned(),
                    channel_id: 1,
                    connected_at_unix_ms: 100,
                    ..Default::default()
                }),
            })),
        });
        assert_eq!(store.state().nickname, "zoe2");
    }

    #[test]
    fn channel_events_keep_the_tree_sorted() {
        let mut store = store();
        store.apply_event(&proto::Event {
            payload: Some(proto::event::Payload::ChannelCreated(
                proto::ChannelCreated {
                    channel: Some(proto::Channel {
                        id: 3,
                        parent_id: 0,
                        position: 0,
                        name: "Ahead".to_owned(),
                        kind: proto::ChannelKind::Text as i32,
                        ..Default::default()
                    }),
                },
            )),
        });
        assert_eq!(store.state().channels[0].name, "Ahead");
        assert_eq!(store.state().channels[0].kind, ChannelKindView::Text);

        store.apply_event(&proto::Event {
            payload: Some(proto::event::Payload::ChannelDeleted(
                proto::ChannelDeleted { channel_id: 3 },
            )),
        });
        assert!(store.state().channels.iter().all(|channel| channel.id != 3));
    }

    #[test]
    fn server_updated_replaces_the_info() {
        let mut store = store();
        store.apply_event(&proto::Event {
            payload: Some(proto::event::Payload::ServerUpdated(proto::ServerUpdated {
                server: Some(proto::ServerInfo {
                    id: vec![1u8; 32],
                    name: "Renamed".to_owned(),
                    online_users: 5,
                    ..Default::default()
                }),
            })),
        });
        assert_eq!(
            store.state().server.as_ref().map(|s| s.name.as_str()),
            Some("Renamed")
        );
        assert_eq!(
            store.state().server.as_ref().map(|s| s.online_users),
            Some(5)
        );
    }

    #[test]
    fn user_and_channel_updates_replace_the_entry_with_the_same_id() {
        let mut store = store();
        store.apply_event(&proto::Event {
            payload: Some(proto::event::Payload::UserUpdated(proto::UserUpdated {
                user: Some(proto::User {
                    id: 20,
                    nickname: "alice2".to_owned(),
                    connected_at_unix_ms: 200,
                    ..Default::default()
                }),
            })),
        });
        let users = &store.state().users;
        assert_eq!(users.len(), 2, "an update must not replace another user");
        let alice = users.iter().find(|user| user.id == 20).expect("alice");
        assert_eq!(alice.nickname, "alice2");
        assert!(
            users
                .iter()
                .any(|user| user.id == 10 && user.nickname == "zoe"),
            "the other user is untouched"
        );

        store.apply_event(&proto::Event {
            payload: Some(proto::event::Payload::ChannelUpdated(
                proto::ChannelUpdated {
                    channel: Some(proto::Channel {
                        id: 1,
                        parent_id: 0,
                        position: 0,
                        name: "Lobby2".to_owned(),
                        kind: proto::ChannelKind::Voice as i32,
                        user_count: 1,
                        ..Default::default()
                    }),
                },
            )),
        });
        let channels = &store.state().channels;
        assert_eq!(channels.len(), 2, "an update must not add a channel");
        assert_eq!(channels[0].name, "Lobby2");
        assert_eq!(channels[0].id, 1);
    }

    #[test]
    fn clear_session_keeps_bookmarks() {
        let mut store = store();
        store.set_bookmarks(vec![bookmark()]);
        store.clear_session();
        assert_eq!(store.state().connection, ConnectionPhase::Disconnected);
        assert!(store.state().server.is_none());
        assert!(store.state().channels.is_empty());
        assert!(store.state().users.is_empty());
        assert_eq!(store.state().servers.len(), 1);
    }

    fn bookmark() -> ServerBookmark {
        ServerBookmark {
            id: "10.0.0.1:7443".to_owned(),
            name: "RosTalk".to_owned(),
            host: "10.0.0.1:7443".to_owned(),
            fingerprint: "fp".to_owned(),
            mode: crate::link::ServerMode::Pinned,
            login: BookmarkLogin::Invite,
            nickname: "alice".to_owned(),
            server_id: Some("id".to_owned()),
            last_connected_unix_ms: 1,
            link: "rostalk://join?host=10.0.0.1:7443&fp=fp".to_owned(),
        }
    }

    fn link() -> InviteLink {
        InviteLink {
            hostname: "10.0.0.1".to_owned(),
            port: 7443,
            fingerprint: [7u8; 32],
            invite: "secret-token".to_owned(),
            raw: String::new(),
        }
    }

    fn server() -> ServerView {
        ServerView {
            id: "aa".repeat(32),
            name: "RosTalk".to_owned(),
            version: "0.1.0".to_owned(),
            protocol_version: 1,
            login_mode: LoginModeView::Invite,
            max_users: 0,
            online_users: 1,
            password_set: false,
            max_attachment_bytes: 25 << 20,
        }
    }

    #[test]
    fn bookmarks_persist_without_the_invite_token() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = BookmarkStore::open(dir.path());
        let fingerprint = link().fingerprint_hex();
        let servers = store
            .remember_connected(
                &link(),
                &server(),
                BookmarkLogin::Invite,
                "alice",
                &fingerprint,
            )
            .expect("remember");
        assert_eq!(servers.len(), 1);
        assert_eq!(
            servers[0].server_id.as_deref(),
            Some("aa".repeat(32).as_str())
        );
        assert!(!servers[0].link.contains("secret-token"));
        assert_eq!(servers[0].id, "10.0.0.1:7443");
        assert_eq!(servers[0].nickname, "alice");
        assert_eq!(servers[0].login, BookmarkLogin::Invite);

        let reopened = BookmarkStore::open(dir.path());
        assert_eq!(reopened.servers(), servers);
    }

    #[test]
    fn a_changed_server_identity_is_refused() {
        let mut store = BookmarkStore::in_memory();
        let fingerprint = link().fingerprint_hex();
        store
            .remember_connected(
                &link(),
                &server(),
                BookmarkLogin::Invite,
                "alice",
                &fingerprint,
            )
            .expect("remember");
        assert!(store
            .check_server_identity(&link(), &"aa".repeat(32))
            .is_ok());
        let error = store
            .check_server_identity(&link(), &"bb".repeat(32))
            .expect_err("changed identity");
        assert_eq!(error.code, CoreErrorCode::ServerIdChanged);
    }

    #[test]
    fn a_changed_certificate_needs_an_explicit_confirmation() {
        let mut store = BookmarkStore::in_memory();
        let fingerprint = link().fingerprint_hex();
        store
            .remember_connected(
                &link(),
                &server(),
                BookmarkLogin::Direct,
                "alice",
                &fingerprint,
            )
            .expect("remember");

        // The same certificate is fine and returns the saved bookmark.
        let known = store
            .check_certificate("10.0.0.1:7443", &fingerprint)
            .expect("known certificate")
            .expect("bookmark");
        assert_eq!(known.nickname, "alice");

        // A different one is an error, never a silent replacement (ADR 0008).
        let error = store
            .check_certificate("10.0.0.1:7443", &"11".repeat(32))
            .expect_err("changed certificate");
        assert_eq!(error.code, CoreErrorCode::ServerCertificateChanged);
        assert_eq!(
            store
                .bookmark_for("10.0.0.1:7443")
                .expect("bookmark")
                .fingerprint,
            fingerprint
        );
    }

    #[test]
    fn a_server_learned_from_an_invite_link_can_be_entered_directly() {
        let mut store = BookmarkStore::in_memory();
        let fingerprint = link().fingerprint_hex();
        store
            .remember_connected(
                &link(),
                &server(),
                BookmarkLogin::Invite,
                "alice",
                &fingerprint,
            )
            .expect("remember");
        // ADR 0008: the saved fingerprint is what a direct login is checked
        // against, and the nickname is remembered per server.
        assert!(store
            .check_certificate("10.0.0.1:7443", &fingerprint)
            .expect("certificate")
            .is_some());
    }

    #[test]
    fn v1_bookmarks_are_migrated_to_host_ids() {
        let dir = tempfile::tempdir().expect("tempdir");
        let legacy = format!(
            r#"{{
              "version": 1,
              "active": "{fp}",
              "servers": [
                {{
                  "id": "{fp}",
                  "name": "RosTalk",
                  "host": "10.0.0.1:7443",
                  "fingerprint": "{fp}",
                  "mode": "pinned",
                  "serverId": "{sid}",
                  "lastConnectedUnixMs": 5,
                  "link": "rostalk://join?host=10.0.0.1:7443&fp={fp}"
                }}
              ]
            }}"#,
            fp = "77".repeat(32),
            sid = "aa".repeat(32),
        );
        std::fs::write(dir.path().join(BOOKMARKS_FILE), legacy.as_bytes()).expect("write");

        let store = BookmarkStore::open(dir.path());
        let servers = store.servers();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].id, "10.0.0.1:7443");
        assert_eq!(servers[0].login, BookmarkLogin::Invite);
        assert!(servers[0].nickname.is_empty());
        assert_eq!(store.active().as_deref(), Some("10.0.0.1:7443"));

        // The file was rewritten in the current format, so a second open does
        // not need the migration path.
        let raw = std::fs::read_to_string(dir.path().join(BOOKMARKS_FILE)).expect("read");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(value["version"], 2);
    }

    #[test]
    fn unknown_servers_are_not_checked() {
        let store = BookmarkStore::in_memory();
        assert!(store
            .check_server_identity(&link(), &"bb".repeat(32))
            .is_ok());
    }

    #[test]
    fn removing_a_server_clears_the_active_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = BookmarkStore::open(dir.path());
        let fingerprint = link().fingerprint_hex();
        store
            .remember_connected(
                &link(),
                &server(),
                BookmarkLogin::Invite,
                "alice",
                &fingerprint,
            )
            .expect("remember");
        assert!(store.active().is_some());
        store.remove(&link().authority()).expect("remove");
        assert!(store.servers().is_empty());
        assert!(store.active().is_none());
    }

    #[test]
    fn damaged_bookmarks_file_is_ignored() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(BOOKMARKS_FILE), b"{not json").expect("write");
        let store = BookmarkStore::open(dir.path());
        assert!(store.servers().is_empty());
    }

    #[test]
    fn set_nickname_updates_only_the_named_server() {
        let mut store = BookmarkStore::in_memory();
        store
            .remember_connected(
                &link(),
                &server(),
                BookmarkLogin::Invite,
                "alice",
                &link().fingerprint_hex(),
            )
            .expect("remember");
        store
            .set_nickname(&link().authority(), "bob")
            .expect("set nickname");
        assert_eq!(
            store.bookmark_for(&link().authority()).map(|b| b.nickname),
            Some("bob".to_owned())
        );
        // The connection timestamp is a real Unix millisecond value, not zero.
        let bookmark = store.bookmark_for(&link().authority()).expect("bookmark");
        assert!(
            bookmark.last_connected_unix_ms > 1_600_000_000_000,
            "timestamp looks wrong: {}",
            bookmark.last_connected_unix_ms
        );
        // An unknown id is a no-op, not an error: the server may be gone.
        store
            .set_nickname("203.0.113.9:7443", "carol")
            .expect("no-op");
        assert_eq!(
            store.bookmark_for(&link().authority()).map(|b| b.nickname),
            Some("bob".to_owned())
        );
    }

    #[test]
    fn unread_counters_are_keyed_by_channel_and_peer() {
        fn counter(channel_id: u64, peer_user_id: u64, unread: u32) -> UnreadView {
            UnreadView {
                channel_id,
                peer_user_id,
                unread,
                mentions: 0,
                last_read_message_id: 0,
                peer_nickname: String::new(),
                last_message_id: 0,
            }
        }

        let mut store = StateStore::new(Vec::new(), None, ProfileView::default());
        store.upsert_unread(counter(5, 0, 1));
        store.upsert_unread(counter(5, 7, 2));
        store.upsert_unread(counter(6, 0, 3));
        // Same channel and peer: replaced, not appended.
        store.upsert_unread(counter(5, 0, 9));

        let unread = &store.state().unread;
        assert_eq!(unread.len(), 3, "one counter per channel and peer");
        let channel = unread
            .iter()
            .find(|item| item.channel_id == 5 && item.peer_user_id == 0)
            .expect("channel counter");
        assert_eq!(channel.unread, 9);
        assert!(
            unread
                .iter()
                .any(|item| item.channel_id == 6 && item.peer_user_id == 0),
            "a different channel keeps its own counter"
        );
    }
}
