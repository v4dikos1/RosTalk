//! Installation of a RosTalk server from the desktop client over SSH.
//!
//! Stage 6.1a, ADR 0021. The crate is deliberately independent of Tauri: the
//! shell passes a bundle directory, a few secrets and a progress callback, and
//! receives a plain outcome. This keeps the security-sensitive part unit-testable
//! on any platform.
//!
//! Boundaries:
//! - only the RosTalk installation is touched on the remote machine;
//! - the local Windows firewall, services and processes are never touched;
//! - a credential is never written to a log, an event, an error or argv.

mod command;
mod error;
mod install;
mod known_hosts;
mod preflight;
mod release;
mod secret;
mod ssh;

pub use command::{shell_join, shell_quote, RemoteCommand};
pub use error::{HostingError, HostingErrorCode};
pub use install::{
    firewall_commands, ExistingAction, InstallOutcome, InstallRequest, Installer, LoginMode,
};
pub use known_hosts::{known_hosts_path, HostKeyStatus, KnownHosts, KNOWN_HOSTS_FILE};
pub use preflight::{
    check_domain, missing_packages, FirewallKind, PreflightProblem, PreflightReport,
    PreflightRequest,
};
pub use release::{Arch, Bundle};
pub use secret::{Redactor, Secret};
pub use ssh::{Auth, CommandOutput, HostKeyInfo, SshSession, SshTarget};

use serde::{Deserialize, Serialize};

/// Phase of the wizard shown by the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Connecting,
    Preflight,
    Verifying,
    BackingUp,
    Uploading,
    Installing,
    Configuring,
    Firewall,
    Healthcheck,
    Links,
    Done,
    Failed,
    Cancelled,
}

/// One progress step. Messages are fixed strings or redacted remote output;
/// they never contain a password, a key or an invite token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressEvent {
    pub stage: Stage,
    /// 0..100.
    pub percent: u8,
    pub message: String,
    /// Optional redacted command output for the journal disclosure.
    pub detail: Option<String>,
}

impl ProgressEvent {
    /// Builds one event.
    #[must_use]
    pub fn new(stage: Stage, percent: u8, message: impl Into<String>) -> Self {
        Self {
            stage,
            percent,
            message: message.into(),
            detail: None,
        }
    }

    /// Adds redacted detail.
    #[must_use]
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        if !detail.is_empty() {
            self.detail = Some(detail);
        }
        self
    }
}

/// Receives progress steps. Implementations must be cheap and non-blocking.
pub type ProgressFn = std::sync::Arc<dyn Fn(ProgressEvent) + Send + Sync>;
