//! The SSH side: host-key confirmation, authentication and one-command exec.
//!
//! The client never authenticates before the host key is confirmed. A password
//! is handed only to `russh`; the sudo password and the server password are
//! written to the remote stdin, never to the command line.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use russh::client::{self, AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use tokio::time::timeout;

use crate::command::RemoteCommand;
use crate::error::{HostingError, HostingErrorCode, Result};
use crate::known_hosts::{fingerprint_of, HostKeyStatus, KnownHosts};
use crate::secret::Secret;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

/// How the user authenticates to SSH.
pub enum Auth {
    /// OpenSSH private key file and an optional passphrase.
    Key {
        path: std::path::PathBuf,
        passphrase: Option<Secret>,
    },
    /// Account password; keyboard-interactive is tried after plain password.
    Password { password: Secret },
}

impl std::fmt::Debug for Auth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Key { path, .. } => f.debug_struct("Auth::Key").field("path", path).finish(),
            Self::Password { .. } => f.write_str("Auth::Password([redacted])"),
        }
    }
}

/// Where to connect and who to authenticate as.
#[derive(Debug)]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: Auth,
}

impl SshTarget {
    /// `host:port` used as the known-hosts key and in messages.
    #[must_use]
    pub fn label(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// A confirmed host key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKeyInfo {
    pub fingerprint: String,
    pub algorithm: String,
    pub status: HostKeyStatus,
    /// Saved fingerprint when the status is [`HostKeyStatus::Mismatch`].
    pub saved_fingerprint: Option<String>,
}

#[derive(Clone)]
struct Trust {
    /// Empty means "accept to learn, do not authenticate yet".
    expected: Option<String>,
}

struct Seen {
    fingerprint: Option<String>,
    algorithm: Option<String>,
}

struct ClientHandler {
    trust: Trust,
    seen: Arc<Mutex<Seen>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let public = server_public_key.public_key();
        let blob = public
            .to_bytes()
            .map_err(|_| russh::Error::WrongServerSig)?;
        let fingerprint = fingerprint_of(&blob);
        let algorithm = public
            .to_openssh()
            .ok()
            .and_then(|text| text.split_whitespace().next().map(str::to_owned))
            .unwrap_or_else(|| "ssh".to_owned());
        if let Ok(mut seen) = self.seen.lock() {
            seen.fingerprint = Some(fingerprint.clone());
            seen.algorithm = Some(algorithm);
        }
        // Returning false after an unconfirmed key aborts the handshake before
        // any credential is sent, which is exactly the TOFU first-contact path.
        Ok(match &self.trust.expected {
            Some(expected) => expected == &fingerprint,
            None => true,
        })
    }
}

/// An authenticated session.
pub struct SshSession {
    handle: Handle<ClientHandler>,
    is_root: bool,
    target: SshTarget,
}

impl std::fmt::Debug for SshSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshSession")
            .field("host", &self.target.label())
            .field("root", &self.is_root)
            .finish_non_exhaustive()
    }
}

impl SshSession {
    /// Probes a host key without authenticating. The key is not saved here.
    pub async fn probe(target: &SshTarget, known: &KnownHosts) -> Result<HostKeyInfo> {
        let seen = Arc::new(Mutex::new(Seen {
            fingerprint: None,
            algorithm: None,
        }));
        let handler = ClientHandler {
            trust: Trust { expected: None },
            seen: seen.clone(),
        };
        let address = (target.host.as_str(), target.port);
        let config = Arc::new(client::Config::default());
        let result = timeout(CONNECT_TIMEOUT, client::connect(config, address, handler)).await;
        let handle = match result {
            Err(_) => {
                return Err(HostingError::new(
                    HostingErrorCode::Timeout,
                    "The server did not answer the SSH handshake in 20 seconds.",
                ))
            }
            Ok(Err(error)) => return Err(connection_error(error)),
            Ok(Ok(handle)) => handle,
        };
        let (fingerprint, algorithm) = seen_values(&seen)?;
        let _ = handle
            .disconnect(Disconnect::ByApplication, "probe complete", "en")
            .await;
        let status = known.check(&target.label(), &fingerprint);
        let saved = known
            .saved(&target.label())
            .map(|host| host.fingerprint.clone());
        Ok(HostKeyInfo {
            fingerprint,
            algorithm,
            status,
            saved_fingerprint: if status == HostKeyStatus::Mismatch {
                saved
            } else {
                None
            },
        })
    }

    /// Connects and authenticates.
    ///
    /// `expected` is the fingerprint the user confirmed. `trust_new` allows the
    /// first contact; the key is saved only after a successful authentication.
    pub async fn connect(
        target: SshTarget,
        expected: Option<&str>,
        trust_new: bool,
        known_hosts_path: &Path,
    ) -> Result<(Self, HostKeyInfo)> {
        let seen = Arc::new(Mutex::new(Seen {
            fingerprint: None,
            algorithm: None,
        }));
        let handler = ClientHandler {
            trust: Trust {
                // The handshake always completes with `Any`; the trust decision
                // is made below, before any credential is sent.
                expected: None,
            },
            seen: seen.clone(),
        };
        let address = (target.host.as_str(), target.port);
        let config = Arc::new(client::Config::default());
        let result = timeout(CONNECT_TIMEOUT, client::connect(config, address, handler)).await;
        let mut handle = match result {
            Err(_) => {
                return Err(HostingError::new(
                    HostingErrorCode::Timeout,
                    "The server did not answer the SSH handshake in 20 seconds.",
                ))
            }
            Ok(Err(error)) => return Err(connection_error(error)),
            Ok(Ok(handle)) => handle,
        };
        let (fingerprint, algorithm) = seen_values(&seen)?;

        let known = KnownHosts::load(known_hosts_path)?;
        let saved_status = known.check(&target.label(), &fingerprint);
        let info = HostKeyInfo {
            fingerprint: fingerprint.clone(),
            algorithm: algorithm.clone(),
            status: saved_status,
            saved_fingerprint: known
                .saved(&target.label())
                .map(|host| host.fingerprint.clone()),
        };

        if let Some(expected) = expected {
            if expected != fingerprint {
                let _ = handle
                    .disconnect(Disconnect::ByApplication, "host key mismatch", "en")
                    .await;
                return Err(HostingError::new(
                    HostingErrorCode::HostKeyMismatch,
                    "The SSH host key differs from the confirmed one. This can be a man-in-the-middle attack or a reinstalled server. Installation stopped.",
                )
                .with_fingerprint(fingerprint)
                .with_detail(format!(
                    "expected {}, got {}",
                    expected,
                    info.saved_fingerprint.as_deref().unwrap_or(expected)
                )));
            }
        } else if saved_status == HostKeyStatus::Mismatch {
            let _ = handle
                .disconnect(Disconnect::ByApplication, "host key mismatch", "en")
                .await;
            return Err(HostingError::new(
                HostingErrorCode::HostKeyMismatch,
                "The SSH host key differs from the saved one. This can be a man-in-the-middle attack or a reinstalled server. Installation stopped.",
            )
            .with_fingerprint(fingerprint)
            .with_detail(format!(
                "saved {}, got {}",
                info.saved_fingerprint.as_deref().unwrap_or(""),
                info.fingerprint
            )));
        } else if saved_status == HostKeyStatus::New && !trust_new {
            let _ = handle
                .disconnect(Disconnect::ByApplication, "host key not confirmed", "en")
                .await;
            return Err(HostingError::new(
                HostingErrorCode::HostKeyUnknown,
                "This server's SSH host key has not been confirmed yet.",
            )
            .with_fingerprint(fingerprint));
        }

        authenticate(&mut handle, &target).await?;

        // The credential was accepted, so the key is worth pinning.
        if saved_status != HostKeyStatus::Known {
            let mut hosts = KnownHosts::load(known_hosts_path)?;
            hosts.remember(
                &target.label(),
                &fingerprint,
                &algorithm,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|value| value.as_secs())
                    .unwrap_or(0),
            );
            hosts.save(known_hosts_path)?;
        }

        let mut session = Self {
            handle,
            is_root: false,
            target,
        };
        session.is_root = session.detect_root().await?;
        Ok((session, info))
    }

    /// True when the SSH account is root.
    #[must_use]
    pub fn is_root(&self) -> bool {
        self.is_root
    }

    /// `host:port` of the session.
    #[must_use]
    pub fn label(&self) -> String {
        self.target.label()
    }

    /// Runs one command and collects stdout, stderr and the exit status.
    pub async fn run(&self, command: &RemoteCommand) -> Result<CommandOutput> {
        self.run_with_timeout(command, COMMAND_TIMEOUT).await
    }

    /// Runs one command with an explicit timeout (installation can take long).
    pub async fn run_with_timeout(
        &self,
        command: &RemoteCommand,
        limit: Duration,
    ) -> Result<CommandOutput> {
        let line = command.command_line(self.is_root)?;
        log::debug!(
            "hsm: exec {} on {}",
            line.split_whitespace().next().unwrap_or("?"),
            self.target.label()
        );
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(connection_error)?;
        channel
            .exec(true, line.into_bytes())
            .await
            .map_err(connection_error)?;
        if !command.stdin.is_empty() {
            // A root session ignores the sudo password, but the same vector
            // still contains it so the command can run as sudo on a normal
            // user. Never send that first line to a direct root command.
            let stdin = stdin_for(command, self.is_root);
            if !stdin.is_empty() {
                channel.data(stdin).await.map_err(connection_error)?;
            }
        }
        channel.eof().await.map_err(connection_error)?;

        let collect = async {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut status = None;
            let mut signal = None;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, ext: 1 } => stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                    ChannelMsg::ExitSignal {
                        signal_name,
                        error_message,
                        ..
                    } => signal = Some(format!("{signal_name:?} {error_message}")),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            (stdout, stderr, status, signal)
        };

        match timeout(limit, collect).await {
            Err(_) => Err(HostingError::new(
                HostingErrorCode::Timeout,
                "The remote command did not finish in time.",
            )),
            Ok((stdout, stderr, status, signal)) => {
                let stderr_text = String::from_utf8_lossy(&stderr);
                // sudo writes its own diagnostics. A wrong sudo password is a
                // distinct, actionable error rather than a generic install
                // failure.
                let lower = stderr_text.to_ascii_lowercase();
                if status != Some(0)
                    && (lower.contains("incorrect password")
                        || lower.contains("a password is required")
                        || lower.contains("a terminal is required")
                        || lower.contains("no tty present"))
                {
                    return Err(HostingError::new(
                        HostingErrorCode::SudoDenied,
                        "sudo rejected the password. Check the sudo password or use the root account.",
                    )
                    .with_detail(stderr_text.trim().to_owned()));
                }
                Ok(CommandOutput {
                    status,
                    signal,
                    stdout: String::from_utf8_lossy(&stdout).into_owned(),
                    stderr: stderr_text.into_owned(),
                })
            }
        }
    }

    async fn detect_root(&self) -> Result<bool> {
        let output = self.run(&RemoteCommand::user(["id", "-u"])).await?;
        if output.success() {
            match output.stdout.trim() {
                "0" => return Ok(true),
                _ => return Ok(false),
            }
        }
        Err(HostingError::new(
            HostingErrorCode::Internal,
            "Could not determine whether the SSH user is root.",
        )
        .with_detail(output.stderr))
    }

    /// Closes the SSH session politely.
    pub async fn close(self) {
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "done", "en")
            .await;
    }
}

/// Removes the sudo password prefix when the session is already root.
fn stdin_for(command: &RemoteCommand, is_root: bool) -> &[u8] {
    if is_root && command.sudo_password {
        match command.stdin.iter().position(|byte| *byte == b'\n') {
            Some(index) => &command.stdin[index + 1..],
            None => &[],
        }
    } else {
        &command.stdin
    }
}

fn seen_values(seen: &Arc<Mutex<Seen>>) -> Result<(String, String)> {
    let seen = seen.lock().map_err(|_| {
        HostingError::new(
            HostingErrorCode::Internal,
            "The SSH host key could not be read.",
        )
    })?;
    match (seen.fingerprint.clone(), seen.algorithm.clone()) {
        (Some(fingerprint), Some(algorithm)) => Ok((fingerprint, algorithm)),
        _ => Err(HostingError::new(
            HostingErrorCode::Internal,
            "The SSH server did not present a host key.",
        )),
    }
}

async fn authenticate(handle: &mut Handle<ClientHandler>, target: &SshTarget) -> Result<()> {
    match &target.auth {
        Auth::Key { path, passphrase } => {
            let key = russh::keys::load_secret_key(path, passphrase.as_ref().map(Secret::expose))
                .map_err(|error| {
                HostingError::new(
                    HostingErrorCode::AuthFailed,
                    "The SSH private key could not be read. Check the file and its passphrase.",
                )
                .with_detail(error.to_string())
            })?;
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
            match handle
                .authenticate_publickey(target.username.clone(), key)
                .await
                .map_err(connection_error)?
            {
                AuthResult::Success => Ok(()),
                AuthResult::Failure { .. } => Err(HostingError::new(
                    HostingErrorCode::AuthFailed,
                    "The server rejected the SSH key. Add the public key to authorized_keys on the server.",
                )),
            }
        }
        Auth::Password { password } => {
            let plain = password.expose().to_owned();
            match handle
                .authenticate_password(target.username.clone(), plain)
                .await
                .map_err(connection_error)?
            {
                AuthResult::Success => return Ok(()),
                AuthResult::Failure { .. } => {}
            }
            // OpenSSH commonly offers only keyboard-interactive. The response
            // is the same password for every prompt (usually one).
            let mut response = handle
                .authenticate_keyboard_interactive_start(target.username.clone(), None)
                .await
                .map_err(connection_error)?;
            for _ in 0..4 {
                match response {
                    KeyboardInteractiveAuthResponse::Success => return Ok(()),
                    KeyboardInteractiveAuthResponse::Failure { .. } => break,
                    KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                        let answers = vec![password.expose().to_owned(); prompts.len()];
                        response = handle
                            .authenticate_keyboard_interactive_respond(answers)
                            .await
                            .map_err(connection_error)?;
                    }
                }
            }
            Err(HostingError::new(
                HostingErrorCode::AuthFailed,
                "The server rejected the SSH password. Check the user and the password (or use a key).",
            ))
        }
    }
}

fn connection_error(error: russh::Error) -> HostingError {
    let text = error.to_string();
    let lower = text.to_ascii_lowercase();
    let code = if lower.contains("name or service not known")
        || lower.contains("failed to lookup")
        || lower.contains("dns")
        || lower.contains("no such host")
    {
        HostingErrorCode::Dns
    } else if lower.contains("refused") || lower.contains("unreachable") {
        HostingErrorCode::ConnectionRefused
    } else if lower.contains("timed out") || lower.contains("timeout") {
        HostingErrorCode::Timeout
    } else {
        HostingErrorCode::Internal
    };
    let message = match code {
        HostingErrorCode::Dns => {
            "The server address does not resolve. Check the VPS address or DNS record."
        }
        HostingErrorCode::ConnectionRefused => {
            "The server refused the SSH connection. Check the address, the port and the provider firewall."
        }
        HostingErrorCode::Timeout => "The SSH connection timed out.",
        _ => "The SSH connection failed.",
    };
    HostingError::new(code, message).with_detail(text)
}

/// Result of one remote command.
#[derive(Debug, Clone, Default)]
pub struct CommandOutput {
    pub status: Option<u32>,
    pub signal: Option<String>,
    pub stdout: String,
    pub stderr: String,
}

impl CommandOutput {
    /// True when the process exited with status 0.
    #[must_use]
    pub fn success(&self) -> bool {
        self.status == Some(0)
    }

    /// Combined output for an error message.
    #[must_use]
    pub fn combined(&self) -> String {
        let mut value = String::new();
        if !self.stdout.trim().is_empty() {
            value.push_str(self.stdout.trim());
        }
        if !self.stderr.trim().is_empty() {
            if !value.is_empty() {
                value.push('\n');
            }
            value.push_str(self.stderr.trim());
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_errors_have_human_codes() {
        let refused = connection_error(russh::Error::IO(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "Connection refused",
        )));
        assert_eq!(refused.code, HostingErrorCode::ConnectionRefused);
        assert!(refused.message.contains("refused"));
    }

    #[test]
    fn output_success_and_combined() {
        let output = CommandOutput {
            status: Some(0),
            stdout: "ok\n".to_owned(),
            ..CommandOutput::default()
        };
        assert!(output.success());
        assert_eq!(output.combined(), "ok");
        assert!(!CommandOutput::default().success());
    }

    #[test]
    fn root_never_receives_the_sudo_password_on_stdin() {
        let password = Secret::new("hunter2");
        let command =
            RemoteCommand::root(["sh", "-c", "cat"], Some(&password)).with_stdin("data\n");
        assert_eq!(stdin_for(&command, true), b"data\n");
        assert_eq!(stdin_for(&command, false), b"hunter2\ndata\n");
    }
}
