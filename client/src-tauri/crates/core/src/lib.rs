//! RosTalk client core.
//!
//! Owns everything that is not a window: the local identity, the control-plane
//! connection, the state store, reconnection and the IPC contract (design 5.1).
//! The UI never talks to the server directly.
//!
//! Stage 2.2 originally shipped the generated protocol and the IPC health check
//! (`ping`). The health check stays because the settings pane uses it to
//! demonstrate a working IPC round trip.

use serde::{Deserialize, Serialize};

pub mod engine;
pub mod error;
pub mod identity;
pub mod link;
pub mod model;
pub mod proto;
pub mod protocol;
pub mod proxy;
pub mod settings;
pub mod state;
pub mod stream_proxy;
pub mod tls;

pub use engine::{
    ConnectRequest, ConnectTarget, CoreHandle, IdentityInfo, StreamCredentialsView,
    VoiceMediaCredentials, VoiceStatePatch,
};
pub use error::{CoreError, CoreErrorCode, ServerErrorCode};
pub use identity::IdentityProvider;
pub use link::{InviteLink, ServerMode};
pub use model::{
    AttachmentView, BookmarkLogin, ChannelKindView, ChannelPermissionsView, ChannelView,
    ChatProxyView, ChatTarget, ConnectionPhase, CoreEvent, CoreState, LoginModeView,
    MessageDeletedDelta, MessageView, PermissionsView, ReconnectInfo, ResetDelta, RoleView,
    ServerBookmark, ServerProbeView, ServerView, StateDelta, UnreadView, UserView,
    VoiceProfileView, VoiceStateView,
};
pub use protocol::{HelloParams, Incoming, Session};
pub use settings::{
    AudioProcessing, ClientSettings, CueSettings, DiagnosticsConsent, DiagnosticsSettings,
    GateSettings, HotkeyAction, HotkeyBinding, LocalePreference, NoiseSuppressor,
    ParticipantSettings, ProfileView, SoundSet, ThemePreference, VoicePreferences, VoiceSettings,
};

/// Wire protocol version implemented by this client. Must match
/// `Hello.protocol_version` and `ServerInfo.protocol_version` in
/// `proto/rostalk/v1`.
pub const PROTOCOL_VERSION: u32 = 1;

/// Reply to the stage 2.1 IPC health check.
///
/// The type lives in the core rather than in the Tauri shell so it can be
/// tested without linking the desktop shell, and so later commands can reuse
/// the same serialization rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PingReply {
    /// Human-readable answer, always `pong`.
    pub message: String,
    /// Wire protocol version implemented by this client.
    pub protocol_version: u32,
    /// Desktop client version from `Cargo.toml`.
    pub client_version: String,
}

/// Builds the reply for the IPC health check. Performs no I/O.
#[must_use]
pub fn ping() -> PingReply {
    PingReply {
        message: "pong".to_owned(),
        protocol_version: PROTOCOL_VERSION,
        client_version: env!("CARGO_PKG_VERSION").to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_reports_the_protocol_version() {
        let reply = ping();
        assert_eq!(reply.message, "pong");
        assert_eq!(reply.protocol_version, PROTOCOL_VERSION);
        assert!(!reply.client_version.is_empty());
    }
}
