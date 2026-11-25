//! Errors of the SSH installer.
//!
//! Every variant maps to one stable `code` for the UI. Messages are written for
//! a human and never contain a password, a private key or an invite token.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Stable machine-readable category shown by the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostingErrorCode {
    /// The host name does not resolve.
    Dns,
    /// TCP connection was refused or unreachable.
    ConnectionRefused,
    /// The operation exceeded its timeout.
    Timeout,
    /// SSH authentication failed.
    AuthFailed,
    /// The host key is not known yet and has not been confirmed.
    HostKeyUnknown,
    /// The host key differs from the saved one.
    HostKeyMismatch,
    /// The user is not root and sudo refused the password.
    SudoDenied,
    /// The remote system is not Linux.
    UnsupportedOs,
    /// The CPU architecture has no RosTalk build.
    UnsupportedArch,
    /// systemd is missing.
    NoSystemd,
    /// A required command (tar, sha256sum, openssl) is missing.
    MissingTool,
    /// A RosTalk port is already in use.
    PortBusy,
    /// Not enough free disk space.
    DiskSpace,
    /// The client bundle with server binaries is missing or incomplete.
    BundleMissing,
    /// The release signature or a checksum does not match.
    ReleaseInvalid,
    /// `install.sh` failed.
    InstallFailed,
    /// The service did not answer `/healthz` after installation.
    HealthcheckFailed,
    /// The user cancelled the operation.
    Cancelled,
    /// Anything else; the message explains it.
    Internal,
}

/// One failure with a stable code and a human-readable message.
#[derive(Debug, Clone, Serialize, Deserialize, Error)]
#[error("{message}")]
pub struct HostingError {
    pub code: HostingErrorCode,
    pub message: String,
    /// Optional technical detail for the log and the "details" disclosure.
    /// Already redacted; never shown as the primary text.
    pub detail: Option<String>,
    /// Host-key fingerprint when the failure is about trust.
    pub fingerprint: Option<String>,
}

impl HostingError {
    /// Builds an error with a stable code.
    #[must_use]
    pub fn new(code: HostingErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
            fingerprint: None,
        }
    }

    /// Adds redacted technical detail.
    #[must_use]
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        if !detail.is_empty() {
            self.detail = Some(detail);
        }
        self
    }

    /// Adds the host-key fingerprint the user has to compare.
    #[must_use]
    pub fn with_fingerprint(mut self, fingerprint: impl Into<String>) -> Self {
        self.fingerprint = Some(fingerprint.into());
        self
    }

    /// Short form for logs.
    #[must_use]
    pub fn code_str(&self) -> &'static str {
        match self.code {
            HostingErrorCode::Dns => "dns",
            HostingErrorCode::ConnectionRefused => "connectionRefused",
            HostingErrorCode::Timeout => "timeout",
            HostingErrorCode::AuthFailed => "authFailed",
            HostingErrorCode::HostKeyUnknown => "hostKeyUnknown",
            HostingErrorCode::HostKeyMismatch => "hostKeyMismatch",
            HostingErrorCode::SudoDenied => "sudoDenied",
            HostingErrorCode::UnsupportedOs => "unsupportedOs",
            HostingErrorCode::UnsupportedArch => "unsupportedArch",
            HostingErrorCode::NoSystemd => "noSystemd",
            HostingErrorCode::MissingTool => "missingTool",
            HostingErrorCode::PortBusy => "portBusy",
            HostingErrorCode::DiskSpace => "diskSpace",
            HostingErrorCode::BundleMissing => "bundleMissing",
            HostingErrorCode::ReleaseInvalid => "releaseInvalid",
            HostingErrorCode::InstallFailed => "installFailed",
            HostingErrorCode::HealthcheckFailed => "healthcheckFailed",
            HostingErrorCode::Cancelled => "cancelled",
            HostingErrorCode::Internal => "internal",
        }
    }
}

impl From<russh::Error> for HostingError {
    fn from(error: russh::Error) -> Self {
        Self::new(
            HostingErrorCode::Internal,
            "SSH connection failed. Check the address, the port and the network.",
        )
        .with_detail(error.to_string())
    }
}

impl From<std::io::Error> for HostingError {
    fn from(error: std::io::Error) -> Self {
        Self::new(
            HostingErrorCode::Internal,
            "Could not read or write a local file.",
        )
        .with_detail(error.to_string())
    }
}

impl From<serde_json::Error> for HostingError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(
            HostingErrorCode::Internal,
            "Could not read or write the known-hosts file.",
        )
        .with_detail(error.to_string())
    }
}

/// Convenience alias used across the crate.
pub type Result<T> = std::result::Result<T, HostingError>;
