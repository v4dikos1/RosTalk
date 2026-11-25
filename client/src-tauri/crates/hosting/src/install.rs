//! The installation pipeline: preflight, verified upload, install, settings,
//! firewall, health check, links and rollback.
//!
//! Everything that changes the remote machine happens after a successful
//! preflight. The only writes before `install.sh` are a temporary directory and,
//! for a reinstall, a backup archive under `/var/backups/rostalk`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::command::RemoteCommand;
use crate::error::{HostingError, HostingErrorCode, Result};
use crate::preflight::{self, FirewallKind, PreflightReport};
use crate::release::Bundle;
use crate::secret::{Redactor, Secret};
use crate::ssh::{Auth, CommandOutput, HostKeyInfo, SshSession, SshTarget};
use crate::{ProgressEvent, ProgressFn, Stage};

const DATA_DIR: &str = "/var/lib/rostalk";
const BINARY: &str = "/usr/local/bin/rostalk-server";
const UNIT: &str = "/etc/systemd/system/rostalk-server.service";
const BACKUP_DIR: &str = "/var/backups/rostalk";
const INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// What to do when RosTalk is already installed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExistingAction {
    /// Only a fresh machine; an existing install is an error.
    Fresh,
    /// Replace the signed binary and unit, keep the data directory.
    Update,
    /// Make a backup first, then replace the binary and unit.
    Reinstall,
}

/// Admission policy written after installation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LoginMode {
    Invite,
    Password,
    Open,
}

impl LoginMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Invite => "invite",
            Self::Password => "password",
            Self::Open => "open",
        }
    }
}

/// Everything one installation needs.
pub struct InstallRequest {
    /// SSH target. Taken by [`Installer::install`] before authentication.
    pub target: Option<SshTarget>,
    /// Fingerprint confirmed in the wizard.
    pub expected_host_key: Option<String>,
    /// Allow the first contact after the wizard showed the fingerprint.
    pub trust_host_key: bool,
    pub sudo_password: Option<Secret>,

    pub bundle_dir: PathBuf,

    pub server_name: Option<String>,
    pub domain: Option<String>,
    /// Host used in invite links. Empty means "detect on the server".
    pub public_host: String,
    /// Address announced for ICE; required behind 1:1 NAT.
    pub advertise_ip: Option<String>,
    pub login_mode: LoginMode,
    pub server_password: Option<Secret>,
    pub max_users: Option<u32>,
    pub open_firewall: bool,
    pub install_packages: bool,
    pub existing_action: ExistingAction,
}

impl std::fmt::Debug for InstallRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InstallRequest")
            .field("target", &self.target)
            .field("expected_host_key", &self.expected_host_key)
            .field("trust_host_key", &self.trust_host_key)
            .field("sudo_password", &self.sudo_password.is_some())
            .field("bundle_dir", &self.bundle_dir)
            .field("server_name", &self.server_name)
            .field("domain", &self.domain)
            .field("public_host", &self.public_host)
            .field("advertise_ip", &self.advertise_ip)
            .field("login_mode", &self.login_mode)
            .field("server_password", &self.server_password.is_some())
            .field("max_users", &self.max_users)
            .field("open_firewall", &self.open_firewall)
            .field("install_packages", &self.install_packages)
            .field("existing_action", &self.existing_action)
            .finish()
    }
}

/// The result shown on the "done" step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallOutcome {
    /// First-start administrator link, when the server still had no admin.
    pub admin_link: Option<String>,
    /// Member invite for friends; absent when the server refused.
    pub member_link: Option<String>,
    /// `host:port` the client should connect to.
    pub public_host: String,
    pub server_version: String,
    pub host_fingerprint: String,
    pub backup_path: Option<String>,
    /// Exact commands for manual firewall setup.
    pub firewall_commands: Vec<String>,
    /// Whether the wizard also applied the rules.
    pub firewall_applied: bool,
    /// Non-fatal problems such as an inactive firewall; shown on the last step.
    pub warnings: Vec<String>,
    /// Redacted tail of `journalctl` after a rollback; absent otherwise.
    pub journal: Option<String>,
}

/// Runs one installation with progress and a cancellation switch.
pub struct Installer {
    known_hosts_path: PathBuf,
    progress: Option<ProgressFn>,
    cancel: Arc<AtomicBool>,
}

impl Installer {
    /// Creates an installer writing host keys next to the client state.
    #[must_use]
    pub fn new(known_hosts_path: PathBuf) -> Self {
        Self {
            known_hosts_path,
            progress: None,
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Installs a progress callback.
    #[must_use]
    pub fn with_progress(mut self, progress: ProgressFn) -> Self {
        self.progress = Some(progress);
        self
    }

    /// Shares the cancellation flag with the IPC layer.
    #[must_use]
    pub fn cancellation(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    /// Read-only checks. The session is closed before returning.
    pub async fn preflight(
        &self,
        target: SshTarget,
        expected_host_key: Option<&str>,
        trust_new: bool,
        domain: Option<String>,
        sudo_password: Option<Secret>,
    ) -> Result<PreflightReport> {
        self.emit(Stage::Connecting, 5, "Connecting to the server over SSH…");
        let (session, info) =
            SshSession::connect(target, expected_host_key, trust_new, &self.known_hosts_path)
                .await?;
        self.emit(
            Stage::Preflight,
            12,
            format!(
                "Host key {} confirmed.",
                short_fingerprint(&info.fingerprint)
            ),
        );
        let report = preflight::run(
            &session,
            &preflight::PreflightRequest { domain },
            sudo_password.as_ref(),
        )
        .await;
        session.close().await;
        let report = report?;
        self.emit(
            Stage::Preflight,
            20,
            if report.supported {
                format!(
                    "{} {} on {} is supported.",
                    report.os_name, report.os_version, report.kernel_arch
                )
            } else {
                "The server does not meet the requirements.".to_owned()
            },
        );
        Ok(report)
    }

    /// Full installation. Cancellation is checked between stages; a running
    /// installer is allowed to finish so the remote machine is never left in a
    /// half-written state.
    pub async fn install(&self, mut request: InstallRequest) -> Result<InstallOutcome> {
        validate_request(&request)?;
        let target = request.target.take().ok_or_else(|| {
            HostingError::new(HostingErrorCode::Internal, "The SSH target is missing.")
        })?;
        if request.public_host.trim().is_empty() {
            request.public_host = target.host.clone();
        }
        let mut redactor = Redactor::default();
        match &target.auth {
            Auth::Password { password } => redactor.add(password.expose()),
            Auth::Key { passphrase, .. } => {
                if let Some(passphrase) = passphrase {
                    redactor.add(passphrase.expose());
                }
            }
        }
        if let Some(password) = &request.sudo_password {
            redactor.add(password.expose());
        }
        if let Some(password) = &request.server_password {
            redactor.add(password.expose());
        }

        self.check_cancel()?;
        self.emit(Stage::Connecting, 5, "Connecting to the server over SSH…");
        let (session, host_key) = SshSession::connect(
            target,
            request.expected_host_key.as_deref(),
            request.trust_host_key,
            &self.known_hosts_path,
        )
        .await?;
        let result = self
            .install_on(&session, &request, &host_key, &redactor)
            .await;
        session.close().await;
        match &result {
            Ok(_) => self.emit(Stage::Done, 100, "The server is installed and answering."),
            Err(error) => self.emit(
                Stage::Failed,
                100,
                format!("Installation failed: {}", error.message),
            ),
        }
        result
    }

    async fn install_on(
        &self,
        session: &SshSession,
        request: &InstallRequest,
        host_key: &HostKeyInfo,
        redactor: &Redactor,
    ) -> Result<InstallOutcome> {
        self.check_cancel()?;

        self.emit(Stage::Preflight, 12, "Checking the remote system…");
        let report = preflight::run(
            session,
            &preflight::PreflightRequest {
                domain: request.domain.clone(),
            },
            request.sudo_password.as_ref(),
        )
        .await?;
        if !report.supported {
            let problem = report.blocking().first().map(|problem| (*problem).clone());
            let (code, reason) = match problem {
                Some(problem) => {
                    let code = match problem.code.as_str() {
                        "portBusy" => HostingErrorCode::PortBusy,
                        "domainMismatch" => HostingErrorCode::Dns,
                        "noSystemd" => HostingErrorCode::NoSystemd,
                        "lowDisk" => HostingErrorCode::DiskSpace,
                        "unsupportedArch" => HostingErrorCode::UnsupportedArch,
                        _ => HostingErrorCode::UnsupportedOs,
                    };
                    (code, problem.message)
                }
                None => (
                    HostingErrorCode::UnsupportedOs,
                    "The server does not meet the requirements.".to_owned(),
                ),
            };
            return Err(HostingError::new(code, reason));
        }
        let missing = preflight::missing_packages(&report);
        if !missing.is_empty() && !request.install_packages {
            return Err(HostingError::new(
                HostingErrorCode::MissingTool,
                format!(
                    "The server is missing {} and package installation was not allowed.",
                    missing.join(", ")
                ),
            ));
        }
        if !missing.is_empty() {
            self.emit(
                Stage::Preflight,
                16,
                format!(
                    "Installing {} with the system package manager…",
                    missing.join(", ")
                ),
            );
            self.install_missing_packages(session, &report, request, redactor)
                .await?;
        }

        let existing = report.existing.clone();
        match (&existing, request.existing_action) {
            (Some(_), ExistingAction::Fresh) => {
                return Err(HostingError::new(
                    HostingErrorCode::InstallFailed,
                    "RosTalk is already installed on this server. Choose “Update” or “Reinstall”.",
                )
                .with_detail(
                    existing
                        .as_ref()
                        .and_then(|value| value.version.clone())
                        .unwrap_or_default(),
                ));
            }
            (None, ExistingAction::Update) | (None, ExistingAction::Reinstall) => {
                // Nothing to update; install normally. The UI hides the choice
                // on a clean machine, but a race is harmless.
            }
            _ => {}
        }

        self.check_cancel()?;
        self.emit(Stage::Verifying, 22, "Verifying the signed server bundle…");
        let bundle = Bundle::open(&request.bundle_dir, report.arch)?;
        self.emit(
            Stage::Verifying,
            28,
            format!(
                "Bundle {} verified (signature and SHA-256).",
                bundle.version
            ),
        );

        let backup_path = if request.existing_action == ExistingAction::Reinstall {
            // Ask the server itself rather than trusting an earlier report: a
            // reinstall always backs up an existing database.
            let database = RemoteCommand::root(
                ["test", "-f", "/var/lib/rostalk/rostalk.db"],
                request.sudo_password.as_ref(),
            );
            if session
                .run(&database)
                .await
                .map(|output| output.success())
                .unwrap_or(false)
            {
                self.emit(
                    Stage::BackingUp,
                    32,
                    "Writing a backup before reinstalling…",
                );
                Some(self.backup(session, request, redactor).await?)
            } else {
                None
            }
        } else {
            None
        };

        self.check_cancel()?;
        self.emit(
            Stage::Uploading,
            38,
            "Uploading and unpacking the server bundle as root…",
        );
        let install = self
            .stream_install(session, &bundle, request, redactor)
            .await;
        self.emit(Stage::Installing, 50, "Installing the RosTalk server…");

        let install = match install {
            Ok(output) => output,
            Err(error) => {
                let journal = self.rollback(session, request, redactor).await;
                return Err(with_journal(error, journal));
            }
        };
        if !install.success() {
            let journal = self.rollback(session, request, redactor).await;
            return Err(HostingError::new(
                HostingErrorCode::InstallFailed,
                "install.sh failed; the previous binary is restored when it existed.",
            )
            .with_detail(redactor.redact(&format!("{}\n\n{journal}", install.combined()))));
        }

        self.check_cancel()?;
        self.emit(Stage::Configuring, 68, "Applying the server settings…");
        self.configure(session, request, redactor).await?;

        self.check_cancel()?;
        let firewall_commands = firewall_commands(report.firewall, request.domain.is_some());
        let mut firewall_applied = false;
        let mut warnings = Vec::new();
        if request.open_firewall {
            self.emit(
                Stage::Firewall,
                76,
                "Opening the RosTalk ports in the remote firewall…",
            );
            let (applied, firewall_warnings) = self
                .apply_firewall(session, report.firewall, request, redactor)
                .await;
            firewall_applied = applied;
            warnings.extend(firewall_warnings);
            if !warnings.is_empty() {
                self.emit(
                    Stage::Firewall,
                    80,
                    "The firewall was not changed completely; open the ports manually on the last step.",
                );
            }
        } else {
            self.emit(
                Stage::Firewall,
                76,
                "Firewall unchanged; the exact commands are shown on the last step.",
            );
        }

        self.check_cancel()?;
        self.emit(Stage::Healthcheck, 84, "Waiting for /healthz…");
        let health = self.healthcheck(session, request, redactor).await;
        if let Err(error) = health {
            let journal = self.rollback(session, request, redactor).await;
            return Err(with_journal(
                HostingError::new(
                    HostingErrorCode::HealthcheckFailed,
                    "The service did not answer /healthz after installation. The previous binary is restored when it existed.",
                ),
                journal,
            )
            .with_detail(redactor.redact(&error.message)));
        }

        self.check_cancel()?;
        self.emit(Stage::Links, 92, "Creating invite links…");
        let admin_link = self.admin_link(session, request, redactor).await;
        let member_link = self.member_link(session, request, redactor).await;
        let public_host = effective_public_host(request);

        self.emit(Stage::Links, 98, "Invite links are ready.");

        Ok(InstallOutcome {
            admin_link,
            member_link,
            public_host,
            server_version: bundle.version,
            host_fingerprint: host_key.fingerprint.clone(),
            backup_path,
            firewall_commands,
            firewall_applied,
            warnings,
            journal: None,
        })
    }

    fn emit(&self, stage: Stage, percent: u8, message: impl Into<String>) {
        if let Some(progress) = &self.progress {
            progress(ProgressEvent::new(stage, percent, message));
        }
    }

    fn check_cancel(&self) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(HostingError::new(
                HostingErrorCode::Cancelled,
                "Installation cancelled by the user.",
            ))
        } else {
            Ok(())
        }
    }

    async fn install_missing_packages(
        &self,
        session: &SshSession,
        report: &PreflightReport,
        request: &InstallRequest,
        redactor: &Redactor,
    ) -> Result<()> {
        let packages = preflight::missing_packages(report);
        if packages.is_empty() {
            return Ok(());
        }
        if report.has_apt {
            let update = RemoteCommand::root(["apt-get", "update"], request.sudo_password.as_ref());
            let output = session.run_with_timeout(&update, UPLOAD_TIMEOUT).await?;
            if !output.success() {
                return Err(package_error("apt-get update", &output, redactor));
            }
            let mut argv = vec!["apt-get".to_owned(), "install".to_owned(), "-y".to_owned()];
            argv.extend(
                packages
                    .iter()
                    .map(|package| apt_package(package).to_owned()),
            );
            let install = RemoteCommand::root(argv, request.sudo_password.as_ref());
            let output = session.run_with_timeout(&install, UPLOAD_TIMEOUT).await?;
            if !output.success() {
                return Err(package_error("apt-get install", &output, redactor));
            }
            return Ok(());
        }
        if report.has_dnf {
            let mut argv = vec!["dnf".to_owned(), "install".to_owned(), "-y".to_owned()];
            argv.extend(packages.iter().map(|package| (*package).to_owned()));
            let install = RemoteCommand::root(argv, request.sudo_password.as_ref());
            let output = session.run_with_timeout(&install, UPLOAD_TIMEOUT).await?;
            if !output.success() {
                return Err(package_error("dnf install", &output, redactor));
            }
            return Ok(());
        }
        Err(HostingError::new(
            HostingErrorCode::MissingTool,
            "No supported package manager (apt-get or dnf) was found.",
        ))
    }

    async fn backup(
        &self,
        session: &SshSession,
        request: &InstallRequest,
        redactor: &Redactor,
    ) -> Result<String> {
        let create = RemoteCommand::root(
            ["install", "-d", "-m", "0700", BACKUP_DIR],
            request.sudo_password.as_ref(),
        );
        let output = session.run(&create).await?;
        if !output.success() {
            return Err(HostingError::new(
                HostingErrorCode::InstallFailed,
                "Could not create /var/backups/rostalk.",
            )
            .with_detail(redactor.redact(&output.combined())));
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0);
        let path = format!("{BACKUP_DIR}/pre-reinstall-{stamp}.tar.gz");
        let command = RemoteCommand::root(
            [BINARY, "backup", "--data", DATA_DIR, "--out", path.as_str()],
            request.sudo_password.as_ref(),
        );
        let output = session.run_with_timeout(&command, UPLOAD_TIMEOUT).await?;
        if !output.success() {
            return Err(HostingError::new(
                HostingErrorCode::InstallFailed,
                "The pre-reinstall backup failed. Reinstall stopped; data was not touched.",
            )
            .with_detail(redactor.redact(&output.combined())));
        }
        self.emit(Stage::BackingUp, 35, format!("Backup written to {path}."));
        Ok(path)
    }

    /// Streams the verified bundle into one root shell that unpacks it into a
    /// root-owned directory and runs `install.sh` from there.
    ///
    /// The previous flow unpacked into `/tmp/rostalk-install.XXXX` owned by the
    /// SSH user and then ran `sudo sh …/install.sh`: any process running as that
    /// user on the target host could replace the script (or, on OpenSSL < 3,
    /// the binary and `SHA256SUMS`) between the unpack and the privileged exec.
    /// Now `mktemp`, `tar`, the script and its temporary data are all created by
    /// root under `umask 077`, and the directory disappears through the EXIT
    /// trap even when the install fails.
    ///
    /// The sudo password and the tar share stdin (`sudo -S` reads exactly one
    /// line with `read(2)`, so the archive after it stays for `tar`; verified
    /// against sudo 1.9). A root session has no password line at all.
    async fn stream_install(
        &self,
        session: &SshSession,
        bundle: &Bundle,
        request: &InstallRequest,
        redactor: &Redactor,
    ) -> Result<CommandOutput> {
        let tar = bundle.tar_stream()?;
        let script = install_script(&bundle.binary_name, request);
        let command = RemoteCommand::root(
            ["sh", "-c", script.as_str()],
            request.sudo_password.as_ref(),
        )
        .with_stdin(tar);
        let output = session.run_with_timeout(&command, INSTALL_TIMEOUT).await?;
        if !output.success() {
            log::warn!(
                "hosting: install.sh exited with {:?}: {}",
                output.status,
                redactor.redact(&output.combined())
            );
        }
        Ok(output)
    }

    async fn configure(
        &self,
        session: &SshSession,
        request: &InstallRequest,
        redactor: &Redactor,
    ) -> Result<()> {
        if let Some(name) = request
            .server_name
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            self.admin_set(session, "server_name", name, request, redactor)
                .await?;
        }
        if let Some(limit) = request.max_users {
            self.admin_set(session, "max_users", &limit.to_string(), request, redactor)
                .await?;
        }
        // The server refuses to switch to password login without a hash, so
        // the secret must be written first. It travels on stdin.
        if request.login_mode == LoginMode::Password {
            let password = request.server_password.as_ref().ok_or_else(|| {
                HostingError::new(
                    HostingErrorCode::Internal,
                    "Password login was selected without a server password.",
                )
            })?;
            self.admin_set_secret(session, "server_password", password, request, redactor)
                .await?;
        }
        self.admin_set(
            session,
            "login_mode",
            request.login_mode.as_str(),
            request,
            redactor,
        )
        .await?;
        Ok(())
    }

    async fn admin_set(
        &self,
        session: &SshSession,
        key: &str,
        value: &str,
        request: &InstallRequest,
        redactor: &Redactor,
    ) -> Result<()> {
        let command = RemoteCommand::root(
            [
                BINARY, "admin", "settings", "set", "--data", DATA_DIR, key, value,
            ],
            request.sudo_password.as_ref(),
        );
        let output = session.run(&command).await?;
        if !output.success() {
            return Err(HostingError::new(
                HostingErrorCode::InstallFailed,
                format!("Could not apply the server setting {key}."),
            )
            .with_detail(redactor.redact(&output.combined())));
        }
        Ok(())
    }

    /// Sets a secret setting without putting it on the command line. The value
    /// is read from stdin by a fixed shell fragment; only the key is in argv.
    async fn admin_set_secret(
        &self,
        session: &SshSession,
        key: &str,
        value: &Secret,
        request: &InstallRequest,
        redactor: &Redactor,
    ) -> Result<()> {
        let script = format!(
            "IFS= read -r v; exec {} admin settings set --data {} {} \"$v\"",
            crate::command::shell_quote(BINARY),
            crate::command::shell_quote(DATA_DIR),
            crate::command::shell_quote(key)
        );
        let mut command = RemoteCommand::root(
            ["sh", "-c", script.as_str()],
            request.sudo_password.as_ref(),
        );
        command.stdin.extend_from_slice(value.expose().as_bytes());
        command.stdin.push(b'\n');
        let output = session.run(&command).await?;
        if !output.success() {
            return Err(HostingError::new(
                HostingErrorCode::InstallFailed,
                format!("Could not apply the server setting {key}."),
            )
            .with_detail(redactor.redact(&output.combined())));
        }
        Ok(())
    }

    async fn apply_firewall(
        &self,
        session: &SshSession,
        kind: FirewallKind,
        request: &InstallRequest,
        redactor: &Redactor,
    ) -> (bool, Vec<String>) {
        let commands: Vec<Vec<&str>> = match kind {
            FirewallKind::Ufw => vec![
                vec!["ufw", "allow", "7443/tcp"],
                vec!["ufw", "allow", "7881/tcp"],
                vec!["ufw", "allow", "7882/udp"],
            ],
            FirewallKind::Firewalld => vec![
                vec!["firewall-cmd", "--permanent", "--add-port=7443/tcp"],
                vec!["firewall-cmd", "--permanent", "--add-port=7881/tcp"],
                vec!["firewall-cmd", "--permanent", "--add-port=7882/udp"],
                vec!["firewall-cmd", "--reload"],
            ],
            FirewallKind::None => {
                return (
                    false,
                    vec![
                        "No active ufw or firewalld was found; open the ports manually.".to_owned(),
                    ],
                )
            }
        };
        let mut applied = true;
        let mut warnings = Vec::new();
        for argv in commands {
            let command = RemoteCommand::root(argv, request.sudo_password.as_ref());
            match session.run(&command).await {
                Ok(output) if output.success() => {}
                Ok(output) => {
                    applied = false;
                    warnings.push(format!(
                        "A firewall command failed: {}",
                        redactor.redact(&output.combined())
                    ));
                }
                Err(error) => {
                    applied = false;
                    warnings.push(format!(
                        "The firewall command could not run: {}",
                        error.message
                    ));
                }
            }
        }
        (applied, warnings)
    }

    async fn healthcheck(
        &self,
        session: &SshSession,
        request: &InstallRequest,
        redactor: &Redactor,
    ) -> Result<()> {
        let mut last = String::new();
        for attempt in 0..4 {
            let mut argv = vec![
                BINARY.to_owned(),
                "healthcheck".to_owned(),
                format!("--data={DATA_DIR}"),
            ];
            if let Some(domain) = request.domain.as_deref().filter(|value| !value.is_empty()) {
                argv.push(format!("--domain={domain}"));
            } else {
                argv.push("--url=https://127.0.0.1:7443/healthz".to_owned());
            }
            let command = RemoteCommand::root(argv, request.sudo_password.as_ref());
            let output = session.run(&command).await?;
            if output.success() {
                return Ok(());
            }
            last = redactor.redact(&output.combined());
            if attempt < 3 {
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
        Err(HostingError::new(
            HostingErrorCode::HealthcheckFailed,
            "The service is not answering /healthz.",
        )
        .with_detail(last))
    }

    async fn admin_link(
        &self,
        session: &SshSession,
        request: &InstallRequest,
        redactor: &Redactor,
    ) -> Option<String> {
        let mut argv = vec![
            BINARY.to_owned(),
            "link".to_owned(),
            format!("--data={DATA_DIR}"),
        ];
        append_link_arguments(&mut argv, request);
        let command = RemoteCommand::root(argv, request.sudo_password.as_ref());
        let output = session.run(&command).await.ok()?;
        if !output.success() {
            // An administrator already exists (update/reinstall).
            return None;
        }
        let _ = redactor;
        first_link(&output.stdout)
    }

    async fn member_link(
        &self,
        session: &SshSession,
        request: &InstallRequest,
        redactor: &Redactor,
    ) -> Option<String> {
        let mut argv = vec![
            BINARY.to_owned(),
            "invite".to_owned(),
            format!("--data={DATA_DIR}"),
            "--max-uses".to_owned(),
            "1".to_owned(),
            "--expires".to_owned(),
            "168h".to_owned(),
        ];
        append_link_arguments(&mut argv, request);
        let command = RemoteCommand::root(argv, request.sudo_password.as_ref());
        let output = session.run(&command).await.ok()?;
        if !output.success() {
            log::warn!(
                "hosting: member invite failed: {}",
                redactor.redact(&output.combined())
            );
            return None;
        }
        first_link(&output.stdout)
    }

    async fn rollback(
        &self,
        session: &SshSession,
        request: &InstallRequest,
        redactor: &Redactor,
    ) -> String {
        self.emit(
            Stage::Installing,
            62,
            "The service did not start; restoring the previous binary and unit…",
        );
        // `if` is a shell builtin; every path is a fixed constant.
        let script = format!(
            "if [ -f {bin}.bak ]; then cp -f {bin}.bak {bin}; fi; \
             if [ -f {unit}.bak ]; then cp -f {unit}.bak {unit}; fi; \
             systemctl daemon-reload >/dev/null 2>&1 || true; \
             systemctl restart rostalk-server >/dev/null 2>&1 || systemctl start rostalk-server >/dev/null 2>&1 || true",
            bin = crate::command::shell_quote(BINARY),
            unit = crate::command::shell_quote(UNIT),
        );
        let command = RemoteCommand::root(
            ["sh", "-c", script.as_str()],
            request.sudo_password.as_ref(),
        );
        let _ = session.run(&command).await;
        let journal = RemoteCommand::root(
            [
                "journalctl",
                "-u",
                "rostalk-server",
                "-n",
                "50",
                "--no-pager",
            ],
            request.sudo_password.as_ref(),
        );
        match session.run(&journal).await {
            Ok(output) => redactor.redact(&output.combined()),
            Err(error) => format!("journalctl unavailable: {}", error.message),
        }
    }
}

/// Exact commands for manual firewall setup. `domain` adds the ACME ports.
#[must_use]
pub fn firewall_commands(kind: FirewallKind, domain: bool) -> Vec<String> {
    let mut commands = Vec::new();
    match kind {
        FirewallKind::Ufw => {
            commands.push("sudo ufw allow 7443/tcp".to_owned());
            commands.push("sudo ufw allow 7881/tcp".to_owned());
            commands.push("sudo ufw allow 7882/udp".to_owned());
            if domain {
                commands.push("sudo ufw allow 80/tcp".to_owned());
                commands.push("sudo ufw allow 443/tcp".to_owned());
            }
        }
        FirewallKind::Firewalld => {
            commands.push("sudo firewall-cmd --permanent --add-port=7443/tcp".to_owned());
            commands.push("sudo firewall-cmd --permanent --add-port=7881/tcp".to_owned());
            commands.push("sudo firewall-cmd --permanent --add-port=7882/udp".to_owned());
            if domain {
                commands.push("sudo firewall-cmd --permanent --add-port=80/tcp".to_owned());
                commands.push("sudo firewall-cmd --permanent --add-port=443/tcp".to_owned());
            }
            commands.push("sudo firewall-cmd --reload".to_owned());
        }
        FirewallKind::None => {
            commands.push("Open TCP 7443 and TCP 7881 and UDP 7882 in your firewall.".to_owned());
            if domain {
                commands.push(
                    "Also open TCP 80 and TCP 443 for the Let's Encrypt certificate.".to_owned(),
                );
            }
        }
    }
    commands.push(
        "Open the same ports in the provider panel (Hetzner, OVH, …): SSH cannot change it."
            .to_owned(),
    );
    commands
}

/// POSIX shell fragment that unpacks the bundle from stdin as root and runs it.
///
/// `$d` is expanded by the remote shell, so the paths built from it are written
/// with double quotes while every caller-supplied value goes through
/// [`crate::command::shell_quote`]. `set -e` plus the EXIT trap means a failed
/// step aborts the install and still removes the root-owned staging directory.
#[must_use]
fn install_script(binary_name: &str, request: &InstallRequest) -> String {
    let mut install =
        format!("sh \"$d/install.sh\" --from-file \"$d/{binary_name}\" --sums \"$d/SHA256SUMS\"");
    // The client verified the Ed25519 signature with ring before upload. This
    // lets install.sh fall back to checksum-only on OpenSSL 1.1.1 (AlmaLinux 8)
    // with an explicit warning.
    install.push_str(" --preverified-signature");
    let host = effective_public_host(request);
    if !host.is_empty() {
        install.push_str(" --public-host ");
        install.push_str(&crate::command::shell_quote(&host));
    }
    if let Some(domain) = request.domain.as_deref().filter(|value| !value.is_empty()) {
        install.push_str(" --domain ");
        install.push_str(&crate::command::shell_quote(domain));
    }
    if let Some(ip) = request
        .advertise_ip
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        install.push_str(" --advertise-ip ");
        install.push_str(&crate::command::shell_quote(ip));
    }
    format!(
        "set -eu; umask 077; d=$(mktemp -d /var/tmp/rostalk-install.XXXXXX); \
         trap 'rm -rf \"$d\"' EXIT HUP INT TERM; \
         tar -xzf - -C \"$d\"; {install}"
    )
}

fn effective_public_host(request: &InstallRequest) -> String {
    request.public_host.trim().to_owned()
}

fn append_link_arguments(argv: &mut Vec<String>, request: &InstallRequest) {
    let host = request.public_host.trim();
    if !host.is_empty() {
        argv.push("--public-host".to_owned());
        argv.push(host.to_owned());
    }
    if let Some(domain) = request.domain.as_deref().filter(|value| !value.is_empty()) {
        argv.push("--domain".to_owned());
        argv.push(domain.to_owned());
    }
    if let Some(ip) = request
        .advertise_ip
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        argv.push("--advertise-ip".to_owned());
        argv.push(ip.to_owned());
    }
}

fn first_link(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| line.starts_with("rostalk://"))
        .map(str::to_owned)
}

fn validate_request(request: &InstallRequest) -> Result<()> {
    let target = request.target.as_ref().ok_or_else(|| {
        HostingError::new(HostingErrorCode::Internal, "The SSH target is missing.")
    })?;
    if target.host.trim().is_empty() || target.username.trim().is_empty() {
        return Err(HostingError::new(
            HostingErrorCode::Internal,
            "The server address and the SSH user are required.",
        ));
    }
    if target.port == 0 {
        return Err(HostingError::new(
            HostingErrorCode::Internal,
            "The SSH port must be between 1 and 65535.",
        ));
    }
    if let Some(name) = &request.server_name {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
            return Err(HostingError::new(
                HostingErrorCode::Internal,
                "The server name must be 1..64 characters.",
            ));
        }
    }
    if let Some(domain) = &request.domain {
        validate_hostname(domain, "domain")?;
    }
    if !request.public_host.trim().is_empty() {
        validate_hostname(request.public_host.trim(), "public host")?;
    }
    if let Some(ip) = &request.advertise_ip {
        if !ip.trim().is_empty() && ip.trim().parse::<std::net::IpAddr>().is_err() {
            return Err(HostingError::new(
                HostingErrorCode::Internal,
                "The advertised IP is not a valid IPv4 or IPv6 address.",
            ));
        }
    }
    if let Some(limit) = request.max_users {
        if limit > 100_000 {
            return Err(HostingError::new(
                HostingErrorCode::Internal,
                "The online limit must be between 0 and 100000.",
            ));
        }
    }
    if let Some(sudo) = &request.sudo_password {
        if sudo.expose().contains(['\n', '\r', '\0']) {
            return Err(HostingError::new(
                HostingErrorCode::SudoDenied,
                "The sudo password must not contain line breaks.",
            ));
        }
    }
    if request.login_mode == LoginMode::Password {
        let password = request.server_password.as_ref().ok_or_else(|| {
            HostingError::new(
                HostingErrorCode::Internal,
                "Password login needs a server password.",
            )
        })?;
        if password.expose().chars().count() < 4 || password.expose().contains(['\n', '\r', '\0']) {
            return Err(HostingError::new(
                HostingErrorCode::Internal,
                "The server password must be at least 4 characters and must not contain line breaks.",
            ));
        }
    }
    Ok(())
}

fn validate_hostname(value: &str, what: &str) -> Result<()> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > 253
        || value.chars().any(|ch| {
            ch.is_whitespace()
                || ch.is_control()
                || matches!(ch, '/' | '\\' | '"' | '\'' | '$' | '`')
        })
    {
        return Err(HostingError::new(
            HostingErrorCode::Internal,
            format!("The {what} is not a valid host name."),
        ));
    }
    Ok(())
}

/// Debian/Ubuntu package names for the shared preflight names.
fn apt_package(package: &str) -> &str {
    match package {
        "iproute" => "iproute2",
        other => other,
    }
}

fn package_error(command: &str, output: &CommandOutput, redactor: &Redactor) -> HostingError {
    HostingError::new(
        HostingErrorCode::MissingTool,
        format!("{command} failed while installing the missing packages."),
    )
    .with_detail(redactor.redact(&output.combined()))
}

fn with_journal(mut error: HostingError, journal: String) -> HostingError {
    if !journal.trim().is_empty() {
        let detail = match error.detail.take() {
            Some(detail) => format!("{detail}\n\n{journal}"),
            None => journal,
        };
        error.detail = Some(detail);
    }
    error
}

fn short_fingerprint(value: &str) -> String {
    if value.len() <= 16 {
        return value.to_owned();
    }
    format!("{}…{}", &value[..8], &value[value.len() - 8..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> InstallRequest {
        InstallRequest {
            target: Some(SshTarget {
                host: "203.0.113.5".to_owned(),
                port: 22,
                username: "root".to_owned(),
                auth: Auth::Password {
                    password: Secret::new("secret"),
                },
            }),
            expected_host_key: Some("a".repeat(64)),
            trust_host_key: false,
            sudo_password: None,
            bundle_dir: PathBuf::from("resources/server"),
            server_name: Some("Очаг".to_owned()),
            domain: None,
            public_host: "203.0.113.5".to_owned(),
            advertise_ip: None,
            login_mode: LoginMode::Invite,
            server_password: None,
            max_users: Some(25),
            open_firewall: false,
            install_packages: true,
            existing_action: ExistingAction::Fresh,
        }
    }

    #[test]
    fn valid_request_passes() {
        validate_request(&request()).expect("valid");
    }

    #[test]
    fn password_mode_needs_a_password() {
        let mut value = request();
        value.login_mode = LoginMode::Password;
        assert!(validate_request(&value).is_err());
        value.server_password = Some(Secret::new("long enough"));
        validate_request(&value).expect("valid");
        value.server_password = Some(Secret::new("a\nb"));
        assert!(validate_request(&value).is_err());
    }

    #[test]
    fn the_install_script_unpacks_as_root_and_quotes_its_arguments() {
        let mut value = request();
        // `validate_request` rejects this earlier; the fragment must still be
        // safe if it is ever built from unvalidated input.
        value.public_host = "203.0.113.5; reboot".to_owned();
        value.domain = Some("rostalk.example.com".to_owned());
        value.advertise_ip = Some("198.51.100.7".to_owned());
        value.server_password = Some(Secret::new("integration-server-pass"));

        let script = install_script("rostalk-server_1.2.3_linux_amd64", &value);
        assert!(script
            .starts_with("set -eu; umask 077; d=$(mktemp -d /var/tmp/rostalk-install.XXXXXX);"));
        assert!(script.contains("trap 'rm -rf \"$d\"' EXIT HUP INT TERM"));
        assert!(script.contains("tar -xzf - -C \"$d\""));
        assert!(script.contains(
            "sh \"$d/install.sh\" --from-file \"$d/rostalk-server_1.2.3_linux_amd64\" \
             --sums \"$d/SHA256SUMS\" --preverified-signature"
        ));
        assert!(script.contains("--public-host '203.0.113.5; reboot'"));
        assert!(script.contains("--domain rostalk.example.com"));
        assert!(script.contains("--advertise-ip 198.51.100.7"));
        // Secrets never enter the script: the server password goes through the
        // admin CLI's stdin, the sudo password through sudo's stdin.
        assert!(!script.contains("integration-server-pass"));
    }

    #[test]
    fn host_names_reject_shell_noise() {
        let mut value = request();
        value.public_host = "1.2.3.4; reboot".to_owned();
        assert!(validate_request(&value).is_err());
        value.public_host = "rostalk.example.com".to_owned();
        validate_request(&value).expect("valid");
    }

    #[test]
    fn links_are_extracted_without_tokens_in_logs() {
        let text = "first\n  rostalk://join?host=x&fp=aa&invite=token\nlast";
        assert_eq!(
            first_link(text).as_deref(),
            Some("rostalk://join?host=x&fp=aa&invite=token")
        );
        assert_eq!(first_link("nothing"), None);
    }

    #[test]
    fn firewall_preview_has_exactly_the_three_ports() {
        let commands = firewall_commands(FirewallKind::Ufw, false);
        assert!(commands.iter().any(|line| line.contains("7443/tcp")));
        assert!(commands.iter().any(|line| line.contains("7881/tcp")));
        assert!(commands.iter().any(|line| line.contains("7882/udp")));
        assert!(!commands.iter().any(|line| line.contains("80/tcp")));
        assert!(commands.last().expect("last").contains("provider panel"));
        let with_domain = firewall_commands(FirewallKind::Ufw, true);
        assert!(with_domain.iter().any(|line| line.contains("80/tcp")));
    }

    #[test]
    fn short_fingerprint_is_compact() {
        let value = "1234567890abcdef".repeat(4);
        let short = short_fingerprint(&value);
        assert!(short.starts_with("12345678"));
        assert!(short.ends_with(&value[value.len() - 8..]));
    }
}
