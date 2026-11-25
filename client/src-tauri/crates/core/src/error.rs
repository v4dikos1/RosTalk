//! Client-visible error model.
//!
//! The UI never shows the server's English `Error.message`; it maps
//! [`CoreErrorCode`] (and, for rejected requests, [`ServerErrorCode`]) to a
//! localised string. The technical message is for logs and bug reports and must
//! not contain tokens, passwords or message contents.

use serde::{Deserialize, Serialize};

use crate::proto;

/// Failure categories produced by the Rust core itself (transport, TLS, local
/// identity, IPC) as opposed to an `Error` frame from the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum CoreErrorCode {
    /// The invite link is not a valid `rostalk://join` URL.
    InvalidLink,
    /// The link's `fp` is not a 64-character hex SHA-256.
    InvalidFingerprint,
    /// The local identity is missing or the keychain refused access.
    IdentityUnavailable,
    /// The identity export file is malformed or from a newer client.
    IdentityFile,
    /// The password does not open the identity export.
    InvalidPassword,
    /// The TLS leaf certificate does not match `fp` from the link. This is
    /// fatal: the client never retries through a different certificate.
    TlsFingerprintMismatch,
    /// The certificate chain did not verify against Web PKI.
    Tls,
    /// The TCP/TLS/WebSocket connection failed before a session existed.
    ConnectionFailed,
    /// A request or the reconnect attempt timed out.
    Timeout,
    /// The server speaks another protocol version (checked in `Welcome` and in
    /// the handshake error frame).
    ProtocolVersionUnsupported,
    /// `Challenge.server_id` and `Welcome.snapshot.server.id` disagree.
    ServerIdMismatch,
    /// The server identity key changed for a bookmark we already knew.
    ServerIdChanged,
    /// The certificate of a saved server changed. A direct login stops instead
    /// of trusting the new certificate silently; the user must confirm it
    /// (ADR 0008).
    ServerCertificateChanged,
    /// A request was rejected by the server; `server_code` says why.
    ServerError,
    /// A command needs an established session and there is none.
    NotConnected,
    /// The request is invalid for the current state.
    InvalidRequest,
    /// Unexpected internal failure.
    Internal,
}

/// Server-side failure reason, mirrored from `rostalk.v1.ErrorCode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ServerErrorCode {
    Unspecified,
    InvalidFrame,
    InvalidRequest,
    ProtocolVersionUnsupported,
    Unauthenticated,
    AuthFailed,
    InviteInvalid,
    InviteExpired,
    Banned,
    WrongPassword,
    RateLimited,
    SessionReplaced,
    PermissionDenied,
    NotFound,
    ChannelPasswordRequired,
    ChannelPasswordInvalid,
    ChannelFull,
    Rejected,
    Internal,
    ServerShuttingDown,
    /// A moderator disconnected this client; reconnecting may be possible
    /// unless a ban follows.
    Kicked,
    /// The action was rejected by the role hierarchy.
    Hierarchy,
}

impl ServerErrorCode {
    #[must_use]
    pub fn from_proto(code: proto::ErrorCode) -> Self {
        use proto::ErrorCode as E;
        match code {
            E::Unspecified => Self::Unspecified,
            E::InvalidFrame => Self::InvalidFrame,
            E::InvalidRequest => Self::InvalidRequest,
            E::ProtocolVersionUnsupported => Self::ProtocolVersionUnsupported,
            E::Unauthenticated => Self::Unauthenticated,
            E::AuthFailed => Self::AuthFailed,
            E::InviteInvalid => Self::InviteInvalid,
            E::InviteExpired => Self::InviteExpired,
            E::Banned => Self::Banned,
            E::WrongPassword => Self::WrongPassword,
            E::RateLimited => Self::RateLimited,
            E::SessionReplaced => Self::SessionReplaced,
            E::PermissionDenied => Self::PermissionDenied,
            E::NotFound => Self::NotFound,
            E::ChannelPasswordRequired => Self::ChannelPasswordRequired,
            E::ChannelPasswordInvalid => Self::ChannelPasswordInvalid,
            E::ChannelFull => Self::ChannelFull,
            E::Rejected => Self::Rejected,
            E::Internal => Self::Internal,
            E::ServerShuttingDown => Self::ServerShuttingDown,
            E::Kicked => Self::Kicked,
            E::Hierarchy => Self::Hierarchy,
        }
    }
}

/// An error returned by an IPC command or carried by a connection delta.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoreError {
    /// Stable machine-readable category.
    pub code: CoreErrorCode,
    /// Technical description in English, no secrets. Not shown to users as is.
    pub message: String,
    /// True when repeating the same action may succeed later.
    pub retryable: bool,
    /// Optional link the user should open (for example a client download page
    /// from an unsupported-protocol-version error).
    pub action_url: Option<String>,
    /// Server `ErrorCode` for [`CoreErrorCode::ServerError`], otherwise `None`.
    pub server_code: Option<ServerErrorCode>,
}

impl CoreError {
    #[must_use]
    pub fn new(code: CoreErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            action_url: None,
            server_code: None,
        }
    }

    #[must_use]
    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    #[must_use]
    pub fn with_action(mut self, action_url: impl Into<String>) -> Self {
        self.action_url = Some(action_url.into());
        self
    }

    #[must_use]
    pub fn from_server(error: &proto::Error) -> Self {
        let code = proto::ErrorCode::try_from(error.code).unwrap_or(proto::ErrorCode::Unspecified);
        let server_code = ServerErrorCode::from_proto(code);
        let mut out =
            Self::new(CoreErrorCode::ServerError, error.message.clone()).retryable(error.retryable);
        out.server_code = Some(server_code);
        if !error.action_url.is_empty() {
            out.action_url = Some(error.action_url.clone());
        }
        if code == proto::ErrorCode::ProtocolVersionUnsupported {
            out.code = CoreErrorCode::ProtocolVersionUnsupported;
        }
        out
    }

    #[must_use]
    pub fn not_connected() -> Self {
        Self::new(CoreErrorCode::NotConnected, "not connected to a server")
    }

    #[must_use]
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(CoreErrorCode::Internal, message)
    }
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for CoreError {}

impl From<rostalk_platform::PlatformError> for CoreError {
    fn from(value: rostalk_platform::PlatformError) -> Self {
        use rostalk_platform::PlatformError as P;
        let (code, retryable) = match value {
            P::InvalidPassword => (CoreErrorCode::InvalidPassword, false),
            P::InvalidFile | P::UnsupportedVersion(_) | P::InvalidParameters | P::InvalidSeed => {
                (CoreErrorCode::IdentityFile, false)
            }
            P::Keychain(_) | P::Unsupported | P::NoIdentity | P::Corrupted => {
                (CoreErrorCode::IdentityUnavailable, true)
            }
            P::Io(_) | P::Random | P::InputHook(_) => (CoreErrorCode::Internal, false),
        };
        let mut error = Self::new(code, value.to_string());
        error.retryable = retryable;
        error
    }
}

impl From<url::ParseError> for CoreError {
    fn from(value: url::ParseError) -> Self {
        Self::new(
            CoreErrorCode::InvalidLink,
            format!("malformed link: {value}"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_error_keeps_the_code_and_is_retryable() {
        let error = CoreError::from_server(&proto::Error {
            code: proto::ErrorCode::RateLimited as i32,
            message: "slow down".to_owned(),
            retryable: true,
            action_url: String::new(),
        });
        assert_eq!(error.code, CoreErrorCode::ServerError);
        assert_eq!(error.server_code, Some(ServerErrorCode::RateLimited));
        assert!(error.retryable);
        assert!(error.action_url.is_none());
    }

    #[test]
    fn unsupported_protocol_has_its_own_code() {
        let error = CoreError::from_server(&proto::Error {
            code: proto::ErrorCode::ProtocolVersionUnsupported as i32,
            message: "new client needed".to_owned(),
            retryable: false,
            action_url: "https://example.invalid/download".to_owned(),
        });
        assert_eq!(error.code, CoreErrorCode::ProtocolVersionUnsupported);
        assert_eq!(
            error.action_url.as_deref(),
            Some("https://example.invalid/download")
        );
    }

    #[test]
    fn platform_errors_map_without_leaking_details_as_success() {
        let error = CoreError::from(rostalk_platform::PlatformError::InvalidPassword);
        assert_eq!(error.code, CoreErrorCode::InvalidPassword);
        assert!(!error.retryable);

        let error = CoreError::from(rostalk_platform::PlatformError::Keychain(
            "access denied".to_owned(),
        ));
        assert_eq!(error.code, CoreErrorCode::IdentityUnavailable);
        assert!(error.retryable);
    }

    #[test]
    fn display_carries_the_code_and_the_message() {
        let error = CoreError::new(CoreErrorCode::Tls, "handshake failed");
        assert_eq!(format!("{error}"), "Tls: handshake failed");
    }
}
