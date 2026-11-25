//! IPC surface of the server installation wizard (stage 6.1a, moved out of
//! the desktop client into `rostalk-server-setup` by P13, ADR 0026).
//!
//! The UI never opens an SSH connection itself: it sends a typed request here,
//! receives progress events and, at the end, invite links. Passwords cross the
//! in-process IPC bridge once and are not logged.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tauri_specta::Event as _;

use rostalk_hosting::{
    firewall_commands, Auth, ExistingAction, FirewallKind, HostKeyStatus, InstallOutcome,
    InstallRequest, Installer, KnownHosts, LoginMode, PreflightReport, ProgressEvent, Secret,
    SshTarget, Stage,
};
use rostalk_platform::{KeyringStore, SecretStore};

/// Keychain service used for optional remembered SSH credentials. Credentials
/// remembered by the installer published as "Hearth" are not carried over
/// (the keychain cannot list them); the wizard simply asks again (ADR 0033).
const HOSTING_KEYCHAIN_SERVICE: &str = "dev.rostalk.hosting";

/// Running wizard operations, keyed by operation id.
#[derive(Default)]
pub struct HostingState {
    cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl HostingState {
    fn insert(&self, id: &str, flag: Arc<AtomicBool>) {
        if let Ok(mut map) = self.cancel.lock() {
            map.insert(id.to_owned(), flag);
        }
    }

    fn cancel(&self, id: &str) -> bool {
        self.cancel
            .lock()
            .ok()
            .and_then(|map| map.get(id).cloned())
            .map(|flag| {
                flag.store(true, Ordering::Relaxed);
                true
            })
            .unwrap_or(false)
    }

    fn remove(&self, id: &str) {
        if let Ok(mut map) = self.cancel.lock() {
            map.remove(id);
        }
    }
}

fn next_operation_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    format!("host-{now}-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// One error for the wizard.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingErrorView {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
    pub fingerprint: Option<String>,
}

impl From<rostalk_hosting::HostingError> for HostingErrorView {
    fn from(error: rostalk_hosting::HostingError) -> Self {
        Self {
            code: error.code_str().to_owned(),
            message: error.message,
            detail: error.detail,
            fingerprint: error.fingerprint,
        }
    }
}

/// SSH credentials as typed in step 1.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingCredentials {
    /// `key` or `password`.
    pub method: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Absolute path of an OpenSSH private key.
    pub key_path: Option<String>,
    /// Passphrase of an encrypted key.
    pub key_passphrase: Option<String>,
    /// SSH account password.
    pub password: Option<String>,
    /// Sudo password when it differs from the account password.
    pub sudo_password: Option<String>,
}

/// Probe request: no password is sent, only the host key is read.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingProbeRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
}

/// Host-key result shown before any credential is used.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingHostKeyView {
    /// Lowercase SHA-256 hex.
    pub fingerprint: String,
    pub algorithm: String,
    /// `known`, `new` or `mismatch`.
    pub status: String,
    pub saved_fingerprint: Option<String>,
}

/// Preflight request.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingPreflightRequest {
    pub credentials: HostingCredentials,
    pub expected_host_key: Option<String>,
    pub trust_host_key: bool,
    pub domain: Option<String>,
}

/// One preflight problem.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingProblemView {
    pub code: String,
    pub message: String,
}

/// One port.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingPortView {
    pub port: u16,
    pub protocol: String,
    pub checked: bool,
    pub in_use: bool,
}

/// Existing installation summary.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingExistingView {
    pub version: Option<String>,
    pub data_dir_exists: bool,
    pub database_exists: bool,
    pub admin_invite_pending: bool,
}

/// Domain DNS summary.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingDomainView {
    pub domain: String,
    pub domain_addresses: Vec<String>,
    pub server_addresses: Vec<String>,
    pub matches: bool,
}

/// Preflight summary for step 2.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingPreflightView {
    pub os_name: String,
    pub os_id: String,
    pub os_version: String,
    pub kernel_arch: String,
    /// `amd64` or `arm64`.
    pub arch: String,
    pub supported: bool,
    pub problems: Vec<HostingProblemView>,
    pub systemd: bool,
    pub systemd_version: Option<String>,
    pub has_tar: bool,
    pub has_sha256sum: bool,
    pub has_openssl: bool,
    pub openssl_version: Option<String>,
    pub openssl_rawin: bool,
    pub has_ss: bool,
    pub has_apt: bool,
    pub has_dnf: bool,
    pub free_disk_mb: u32,
    pub ports: Vec<HostingPortView>,
    pub existing: Option<HostingExistingView>,
    /// `none`, `ufw` or `firewalld`.
    pub firewall: String,
    pub is_root: bool,
    pub domain: Option<HostingDomainView>,
    /// Exact commands for the manual path.
    pub firewall_commands: Vec<String>,
    /// Packages the wizard would install when allowed.
    pub missing_packages: Vec<String>,
}

impl From<PreflightReport> for HostingPreflightView {
    fn from(report: PreflightReport) -> Self {
        let firewall = match report.firewall {
            FirewallKind::None => "none",
            FirewallKind::Ufw => "ufw",
            FirewallKind::Firewalld => "firewalld",
        };
        let domain_any = report.domain.is_some();
        let missing_packages = rostalk_hosting::missing_packages(&report)
            .into_iter()
            .map(str::to_owned)
            .collect();
        Self {
            os_name: report.os_name,
            os_id: report.os_id,
            os_version: report.os_version,
            kernel_arch: report.kernel_arch,
            arch: report.arch.release_name().to_owned(),
            supported: report.supported,
            problems: report
                .problems
                .into_iter()
                .map(|problem| HostingProblemView {
                    code: problem.code,
                    message: problem.message,
                })
                .collect(),
            systemd: report.systemd,
            systemd_version: report.systemd_version,
            has_tar: report.has_tar,
            has_sha256sum: report.has_sha256sum,
            has_openssl: report.has_openssl,
            openssl_version: report.openssl_version,
            openssl_rawin: report.openssl_rawin,
            has_ss: report.has_ss,
            has_apt: report.has_apt,
            has_dnf: report.has_dnf,
            free_disk_mb: u32::try_from(report.free_disk_mb).unwrap_or(u32::MAX),
            ports: report
                .ports
                .into_iter()
                .map(|port| HostingPortView {
                    port: port.port,
                    protocol: port.protocol,
                    checked: port.checked,
                    in_use: port.in_use,
                })
                .collect(),
            existing: report.existing.map(|existing| HostingExistingView {
                version: existing.version,
                data_dir_exists: existing.data_dir_exists,
                database_exists: existing.database_exists,
                admin_invite_pending: existing.admin_invite_pending,
            }),
            firewall: firewall.to_owned(),
            is_root: report.is_root,
            domain: report.domain.map(|domain| HostingDomainView {
                domain: domain.domain,
                domain_addresses: domain.domain_addresses,
                server_addresses: domain.server_addresses,
                matches: domain.matches,
            }),
            firewall_commands: firewall_commands(report.firewall, domain_any),
            missing_packages,
        }
    }
}

/// Full installation request from step 2/3.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingInstallRequest {
    pub credentials: HostingCredentials,
    pub expected_host_key: Option<String>,
    pub trust_host_key: bool,

    pub server_name: Option<String>,
    pub domain: Option<String>,
    pub public_host: String,
    pub advertise_ip: Option<String>,
    /// `invite`, `password` or `open`.
    pub login_mode: String,
    pub server_password: Option<String>,
    pub max_users: Option<u32>,
    pub open_firewall: bool,
    pub install_packages: bool,
    /// `fresh`, `update` or `reinstall`.
    pub existing_action: String,
    /// Store SSH and sudo passwords in Windows Credential Manager.
    pub remember_password: bool,
}

/// Bundle status shown when the client has no server binaries.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingBundleView {
    pub available: bool,
    pub directory: String,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// Result of a successful installation.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingOutcomeView {
    pub admin_link: Option<String>,
    pub member_link: Option<String>,
    pub public_host: String,
    pub server_version: String,
    pub host_fingerprint: String,
    pub backup_path: Option<String>,
    pub firewall_commands: Vec<String>,
    pub firewall_applied: bool,
    pub warnings: Vec<String>,
    pub journal: Option<String>,
}

impl From<InstallOutcome> for HostingOutcomeView {
    fn from(outcome: InstallOutcome) -> Self {
        Self {
            admin_link: outcome.admin_link,
            member_link: outcome.member_link,
            public_host: outcome.public_host,
            server_version: outcome.server_version,
            host_fingerprint: outcome.host_fingerprint,
            backup_path: outcome.backup_path,
            firewall_commands: outcome.firewall_commands,
            firewall_applied: outcome.firewall_applied,
            warnings: outcome.warnings,
            journal: outcome.journal,
        }
    }
}

/// Progress and terminal event of one operation.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct HostingEventMessage {
    pub operation_id: String,
    /// `connecting`, `preflight`, … `done`, `failed`, `cancelled`.
    pub stage: String,
    pub percent: u8,
    pub message: String,
    pub detail: Option<String>,
    /// True for the last event of the operation.
    pub finished: bool,
    pub outcome: Option<HostingOutcomeView>,
    pub error: Option<HostingErrorView>,
}

/// Saved credentials loaded back from the keychain.
///
/// Only presence flags cross the IPC bridge. The values stay in Rust: the
/// WebView receives them neither in this reply nor in a log line, and
/// [`hosting_install_start`]/[`hosting_preflight`] fill an empty field from the
/// keychain themselves.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingSavedCredentials {
    pub has_password: bool,
    pub has_sudo_password: bool,
}

/// Opens a file dialog for an OpenSSH private key.
#[tauri::command]
#[specta::specta]
pub async fn hosting_pick_key() -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("SSH private key")
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

/// Reads the SSH host key. No credential is sent and nothing is saved.
#[tauri::command]
#[specta::specta]
pub async fn hosting_probe(
    app: tauri::AppHandle,
    request: HostingProbeRequest,
) -> Result<HostingHostKeyView, HostingErrorView> {
    let target = SshTarget {
        host: request.host.trim().to_owned(),
        port: request.port,
        username: request.username.trim().to_owned(),
        // The probe never authenticates; the empty secret is unreachable.
        auth: Auth::Password {
            password: Secret::new(""),
        },
    };
    let known = KnownHosts::load(&known_hosts(&app)?).map_err(HostingErrorView::from)?;
    let info = rostalk_hosting::SshSession::probe(&target, &known)
        .await
        .map_err(HostingErrorView::from)?;
    Ok(HostingHostKeyView {
        fingerprint: info.fingerprint,
        algorithm: info.algorithm,
        status: status_str(info.status).to_owned(),
        saved_fingerprint: info.saved_fingerprint,
    })
}

/// Runs the read-only preflight checks.
#[tauri::command]
#[specta::specta]
pub async fn hosting_preflight(
    app: tauri::AppHandle,
    request: HostingPreflightRequest,
) -> Result<HostingPreflightView, HostingErrorView> {
    // An empty field means "use the remembered secret": the WebView never sees
    // the value, it is read here.
    let mut credentials = request.credentials;
    let store = KeyringStore::new(HOSTING_KEYCHAIN_SERVICE);
    fill_saved_secrets(
        &store,
        &credentials.host,
        &credentials.username,
        &mut credentials.password,
        &mut credentials.sudo_password,
    );
    let sudo_password = credentials
        .sudo_password
        .clone()
        .filter(|value| !value.is_empty());
    let target = build_target(credentials)?;
    let installer = Installer::new(known_hosts(&app)?);
    let report = installer
        .preflight(
            target,
            request.expected_host_key.as_deref(),
            request.trust_host_key,
            request.domain,
            sudo_password.map(Secret::new),
        )
        .await
        .map_err(HostingErrorView::from)?;
    Ok(report.into())
}

/// Reports whether a verified server bundle is next to the installer.
#[tauri::command]
#[specta::specta]
pub fn hosting_bundle_status(app: tauri::AppHandle) -> HostingBundleView {
    match bundle_directory(&app) {
        Some(directory) => {
            let version = std::fs::read_to_string(directory.join("release.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                .and_then(|value| value.get("version")?.as_str().map(str::to_owned));
            HostingBundleView {
                available: directory.join("SHA256SUMS").is_file(),
                directory: directory.to_string_lossy().into_owned(),
                version,
                error: None,
            }
        }
        None => HostingBundleView {
            available: false,
            directory: String::new(),
            version: None,
            error: Some(
                "No server bundle found: keep the server folder next to rostalk-server-setup.exe (unpack the whole zip)."
                    .to_owned(),
            ),
        },
    }
}

/// Starts the installation and returns the operation id. Progress arrives as
/// [`HostingEventMessage`] events; the command itself never blocks the UI.
#[tauri::command]
#[specta::specta]
pub async fn hosting_install_start(
    app: tauri::AppHandle,
    state: State<'_, HostingState>,
    request: HostingInstallRequest,
) -> Result<String, HostingErrorView> {
    let operation_id = next_operation_id();
    // Resolve remembered secrets before the target is built. Only values the
    // user typed (or the keychain holds) ever reach the SSH layer; an empty
    // password field is not sent as an empty password.
    let mut resolved = request.credentials.clone();
    let store = KeyringStore::new(HOSTING_KEYCHAIN_SERVICE);
    fill_saved_secrets(
        &store,
        &resolved.host,
        &resolved.username,
        &mut resolved.password,
        &mut resolved.sudo_password,
    );
    let target = build_target(resolved.clone())?;
    let bundle_dir = bundle_directory(&app).ok_or_else(|| {
        HostingErrorView::from(rostalk_hosting::HostingError::new(
            rostalk_hosting::HostingErrorCode::BundleMissing,
            "No server bundle found: keep the server folder next to rostalk-server-setup.exe (unpack the whole zip).",
        ))
    })?;
    let login_mode = match request.login_mode.as_str() {
        "invite" => LoginMode::Invite,
        "password" => LoginMode::Password,
        "open" => LoginMode::Open,
        other => {
            return Err(HostingErrorView::from(rostalk_hosting::HostingError::new(
                rostalk_hosting::HostingErrorCode::Internal,
                format!("Unknown login mode {other}."),
            )))
        }
    };
    let existing_action = match request.existing_action.as_str() {
        "fresh" => ExistingAction::Fresh,
        "update" => ExistingAction::Update,
        "reinstall" => ExistingAction::Reinstall,
        other => {
            return Err(HostingErrorView::from(rostalk_hosting::HostingError::new(
                rostalk_hosting::HostingErrorCode::Internal,
                format!("Unknown existing-install action {other}."),
            )))
        }
    };
    let have_passwords = request.remember_password;
    // Remember what was actually used (a typed password, or the one the
    // keychain already held), never an empty string.
    let credentials = resolved;

    let installer = Installer::new(known_hosts(&app)?);
    let cancel = installer.cancellation();
    state.insert(&operation_id, cancel);

    let emit_handle = app.clone();
    let progress_id = operation_id.clone();
    let installer = installer.with_progress(Arc::new(move |event: ProgressEvent| {
        emit_progress(&emit_handle, &progress_id, event);
    }));

    let install_request = InstallRequest {
        target: Some(target),
        expected_host_key: request.expected_host_key,
        trust_host_key: request.trust_host_key,
        sudo_password: credentials
            .sudo_password
            .clone()
            .filter(|value| !value.is_empty())
            .map(Secret::new),
        bundle_dir,
        server_name: request.server_name,
        domain: request.domain,
        public_host: request.public_host,
        advertise_ip: request.advertise_ip,
        login_mode,
        server_password: request
            .server_password
            .clone()
            .filter(|value| !value.is_empty())
            .map(Secret::new),
        max_users: request.max_users,
        open_firewall: request.open_firewall,
        install_packages: request.install_packages,
        existing_action,
    };

    let app_for_done = app.clone();
    let id_for_done = operation_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = installer.install(install_request).await;
        if let Some(state) = app_for_done.try_state::<HostingState>() {
            state.remove(&id_for_done);
        }
        match result {
            Ok(outcome) => {
                if have_passwords {
                    remember_credentials(&credentials);
                }
                let event = HostingEventMessage {
                    operation_id: id_for_done.clone(),
                    stage: "done".to_owned(),
                    percent: 100,
                    message: "The server is installed and answering.".to_owned(),
                    detail: None,
                    finished: true,
                    outcome: Some(outcome.into()),
                    error: None,
                };
                emit_terminal(&app_for_done, event);
            }
            Err(error) => {
                let stage = if error.code == rostalk_hosting::HostingErrorCode::Cancelled {
                    "cancelled"
                } else {
                    "failed"
                };
                let event = HostingEventMessage {
                    operation_id: id_for_done.clone(),
                    stage: stage.to_owned(),
                    percent: 100,
                    message: error.message.clone(),
                    detail: error.detail.clone(),
                    finished: true,
                    outcome: None,
                    error: Some(error.into()),
                };
                emit_terminal(&app_for_done, event);
            }
        }
    });

    Ok(operation_id)
}

/// Requests cancellation of a running operation.
#[tauri::command]
#[specta::specta]
pub fn hosting_cancel(state: State<'_, HostingState>, operation_id: String) -> bool {
    state.cancel(&operation_id)
}

/// Reports whether remembered SSH credentials exist for a server and user.
///
/// The password values themselves never leave Rust; see
/// [`HostingSavedCredentials`].
#[tauri::command]
#[specta::specta]
pub fn hosting_load_credentials(host: String, username: String) -> HostingSavedCredentials {
    let store = KeyringStore::new(HOSTING_KEYCHAIN_SERVICE);
    saved_credentials(&store, &host, &username)
}

/// Removes remembered SSH credentials.
#[tauri::command]
#[specta::specta]
pub fn hosting_forget_credentials(host: String, username: String) {
    let store = KeyringStore::new(HOSTING_KEYCHAIN_SERVICE);
    let _ = store.delete(&account(&host, &username, "ssh"));
    let _ = store.delete(&account(&host, &username, "sudo"));
}

fn build_target(credentials: HostingCredentials) -> Result<SshTarget, HostingErrorView> {
    if credentials.host.trim().is_empty() || credentials.username.trim().is_empty() {
        return Err(HostingErrorView::from(rostalk_hosting::HostingError::new(
            rostalk_hosting::HostingErrorCode::Internal,
            "The server address and the SSH user are required.",
        )));
    }
    if credentials.port == 0 {
        return Err(HostingErrorView::from(rostalk_hosting::HostingError::new(
            rostalk_hosting::HostingErrorCode::Internal,
            "The SSH port must be between 1 and 65535.",
        )));
    }
    let auth = match credentials.method.as_str() {
        "key" => {
            let path = credentials
                .key_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    HostingErrorView::from(rostalk_hosting::HostingError::new(
                        rostalk_hosting::HostingErrorCode::AuthFailed,
                        "Choose an SSH private key file.",
                    ))
                })?;
            Auth::Key {
                path: PathBuf::from(path),
                passphrase: credentials
                    .key_passphrase
                    .filter(|value| !value.is_empty())
                    .map(Secret::new),
            }
        }
        "password" => {
            let password = credentials
                .password
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    HostingErrorView::from(rostalk_hosting::HostingError::new(
                        rostalk_hosting::HostingErrorCode::AuthFailed,
                        "Enter the SSH password.",
                    ))
                })?;
            Auth::Password {
                password: Secret::new(password),
            }
        }
        other => {
            return Err(HostingErrorView::from(rostalk_hosting::HostingError::new(
                rostalk_hosting::HostingErrorCode::Internal,
                format!("Unknown SSH auth method {other}."),
            )))
        }
    };
    Ok(SshTarget {
        host: credentials.host.trim().to_owned(),
        port: credentials.port,
        username: credentials.username.trim().to_owned(),
        auth,
    })
}

fn status_str(status: HostKeyStatus) -> &'static str {
    match status {
        HostKeyStatus::Known => "known",
        HostKeyStatus::New => "new",
        HostKeyStatus::Mismatch => "mismatch",
    }
}

fn known_hosts(app: &tauri::AppHandle) -> Result<PathBuf, HostingErrorView> {
    let data_dir = app.path().app_data_dir().map_err(|error| {
        HostingErrorView::from(
            rostalk_hosting::HostingError::new(
                rostalk_hosting::HostingErrorCode::Internal,
                "Could not locate the application data directory.",
            )
            .with_detail(error.to_string()),
        )
    })?;
    // Keep the SSH host keys pinned by the installer published as "Hearth"
    // (ADR 0033): dropping them would turn a known host back into "new".
    if let Some(parent) = data_dir.parent() {
        let legacy = parent.join(rostalk_platform::legacy::LEGACY_SERVER_SETUP_IDENTIFIER);
        if let Err(error) = rostalk_platform::legacy::adopt_dir(&legacy, &data_dir) {
            log::warn!("hosting: could not adopt the previous known hosts: {error}");
        }
    }
    std::fs::create_dir_all(&data_dir).map_err(|error| {
        HostingErrorView::from(
            rostalk_hosting::HostingError::new(
                rostalk_hosting::HostingErrorCode::Internal,
                "Could not create the application data directory.",
            )
            .with_detail(error.to_string()),
        )
    })?;
    Ok(rostalk_hosting::known_hosts_path(&data_dir))
}

/// Bundle lookup, in order: resource dir, executable dir, dev env var.
///
/// The environment variable is a development aid and must not redirect a
/// release install: it is only consulted in a debug build or with the explicit
/// `ROSTALK_DEV_BUNDLE=1` opt-in. Otherwise an attacker who can set the
/// environment of the launched process could point the installer at an older,
/// validly signed bundle (a downgrade).
fn bundle_directory(app: &tauri::AppHandle) -> Option<PathBuf> {
    let resource = app.path().resource_dir().ok().map(|dir| dir.join("server"));
    let executable = app
        .path()
        .executable_dir()
        .ok()
        .map(|dir| dir.join("server"));
    let adjacent = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .map(|dir| dir.join("server"));
    let dev = std::env::var("ROSTALK_SERVER_BUNDLE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let dev_allowed = dev_bundle_allowed(
        cfg!(debug_assertions),
        std::env::var("ROSTALK_DEV_BUNDLE").ok().as_deref(),
    );
    bundle_candidates(resource, executable, adjacent, dev, dev_allowed)
        .into_iter()
        .find(|path| path.join("SHA256SUMS").is_file())
}

/// Whether `ROSTALK_SERVER_BUNDLE` may override the shipped bundle.
fn dev_bundle_allowed(debug_build: bool, opt_in: Option<&str>) -> bool {
    debug_build || opt_in.is_some_and(|value| value.trim() == "1")
}

/// Ordered bundle candidates. The environment path is last and only present
/// when `dev_allowed` says so.
fn bundle_candidates(
    resource: Option<PathBuf>,
    executable: Option<PathBuf>,
    adjacent: Option<PathBuf>,
    dev: Option<PathBuf>,
    dev_allowed: bool,
) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = [resource, executable, adjacent]
        .into_iter()
        .flatten()
        .collect();
    if dev_allowed {
        if let Some(dev) = dev {
            candidates.push(dev);
        }
    }
    candidates
}

fn emit_progress(app: &tauri::AppHandle, operation_id: &str, event: ProgressEvent) {
    let message = HostingEventMessage {
        operation_id: operation_id.to_owned(),
        stage: stage_str(event.stage).to_owned(),
        percent: event.percent,
        message: event.message,
        detail: event.detail,
        finished: false,
        outcome: None,
        error: None,
    };
    if let Err(error) = message.emit(app) {
        eprintln!("rostalk: failed to emit hosting progress: {error}");
    }
}

fn emit_terminal(app: &tauri::AppHandle, event: HostingEventMessage) {
    if let Err(error) = event.emit(app) {
        eprintln!("rostalk: failed to emit hosting result: {error}");
    }
}

fn stage_str(stage: Stage) -> &'static str {
    match stage {
        Stage::Connecting => "connecting",
        Stage::Preflight => "preflight",
        Stage::Verifying => "verifying",
        Stage::BackingUp => "backingUp",
        Stage::Uploading => "uploading",
        Stage::Installing => "installing",
        Stage::Configuring => "configuring",
        Stage::Firewall => "firewall",
        Stage::Healthcheck => "healthcheck",
        Stage::Links => "links",
        Stage::Done => "done",
        Stage::Failed => "failed",
        Stage::Cancelled => "cancelled",
    }
}

fn account(host: &str, username: &str, kind: &str) -> String {
    format!("hosting:{host}:{username}:{kind}")
}

/// Reads one remembered secret. Only called inside Rust: the value is never
/// serialized, formatted or logged.
fn read_secret(store: &dyn SecretStore, host: &str, username: &str, kind: &str) -> Option<String> {
    store
        .get(&account(host.trim(), username.trim(), kind))
        .ok()
        .flatten()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

/// Reports which remembered secrets exist, without returning their values.
fn saved_credentials(
    store: &dyn SecretStore,
    host: &str,
    username: &str,
) -> HostingSavedCredentials {
    HostingSavedCredentials {
        has_password: read_secret(store, host, username, "ssh").is_some(),
        has_sudo_password: read_secret(store, host, username, "sudo").is_some(),
    }
}

/// Fills empty password fields from the keychain.
///
/// A typed value always wins, so the user can override a remembered password
/// for one run without forgetting it.
fn fill_saved_secrets(
    store: &dyn SecretStore,
    host: &str,
    username: &str,
    password: &mut Option<String>,
    sudo_password: &mut Option<String>,
) {
    if password.as_deref().is_none_or(str::is_empty) {
        *password = read_secret(store, host, username, "ssh");
    }
    if sudo_password.as_deref().is_none_or(str::is_empty) {
        *sudo_password = read_secret(store, host, username, "sudo");
    }
}

fn remember_credentials(credentials: &HostingCredentials) {
    let store = KeyringStore::new(HOSTING_KEYCHAIN_SERVICE);
    let host = credentials.host.trim();
    let username = credentials.username.trim();
    if let Some(password) = credentials
        .password
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        if let Err(error) = store.set(&account(host, username, "ssh"), password.as_bytes()) {
            log::warn!("hosting: could not remember the SSH password: {}", error);
        }
    }
    if let Some(password) = credentials
        .sudo_password
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        if let Err(error) = store.set(&account(host, username, "sudo"), password.as_bytes()) {
            log::warn!("hosting: could not remember the sudo password: {}", error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rostalk_platform::MemoryStore;

    const SSH: &str = "hunter2-ssh";
    const SUDO: &str = "hunter2-sudo";

    fn store() -> MemoryStore {
        let store = MemoryStore::new();
        store
            .set(&account("vps", "root", "ssh"), SSH.as_bytes())
            .expect("ssh");
        store
            .set(&account("vps", "root", "sudo"), SUDO.as_bytes())
            .expect("sudo");
        store
    }

    #[test]
    fn the_saved_credentials_view_has_no_values() {
        let view = saved_credentials(&store(), "vps", "root");
        assert!(view.has_password);
        assert!(view.has_sudo_password);

        let json = serde_json::to_string(&view).expect("json");
        assert!(!json.contains(SSH), "{json}");
        assert!(!json.contains(SUDO), "{json}");
        assert!(json.contains("\"hasPassword\":true"), "{json}");
        assert!(json.contains("\"hasSudoPassword\":true"), "{json}");
    }

    #[test]
    fn a_typed_password_wins_and_empty_fields_use_the_keychain() {
        let store = store();

        let mut password = None;
        let mut sudo = None;
        fill_saved_secrets(&store, "vps", "root", &mut password, &mut sudo);
        assert_eq!(password.as_deref(), Some(SSH));
        assert_eq!(sudo.as_deref(), Some(SUDO));

        let mut password = Some("typed".to_owned());
        let mut sudo = Some(String::new());
        fill_saved_secrets(&store, "vps", "root", &mut password, &mut sudo);
        assert_eq!(password.as_deref(), Some("typed"));
        assert_eq!(sudo.as_deref(), Some(SUDO));
    }

    #[test]
    fn the_dev_bundle_needs_a_debug_build_or_an_explicit_opt_in() {
        assert!(dev_bundle_allowed(true, None));
        assert!(dev_bundle_allowed(true, Some("0")));
        assert!(dev_bundle_allowed(false, Some("1")));
        assert!(!dev_bundle_allowed(false, None));
        assert!(!dev_bundle_allowed(false, Some("")));
        assert!(!dev_bundle_allowed(false, Some("true")));

        let dev = PathBuf::from(r"D:\dev\server");
        let resource = PathBuf::from(r"C:\app\resources\server");
        let candidates = bundle_candidates(
            Some(resource.clone()),
            Some(PathBuf::from(r"C:\app\server")),
            Some(PathBuf::from(r"C:\app\server")),
            Some(dev.clone()),
            false,
        );
        assert_eq!(candidates.first(), Some(&resource));
        assert!(
            !candidates.contains(&dev),
            "release must ignore the env var"
        );

        let candidates = bundle_candidates(Some(resource), None, None, Some(dev.clone()), true);
        assert_eq!(candidates.last(), Some(&dev));
    }

    #[test]
    fn another_host_has_no_saved_credentials() {
        let view = saved_credentials(&store(), "other", "root");
        assert!(!view.has_password);
        assert!(!view.has_sudo_password);

        // An empty field with no saved entry stays empty, so `build_target`
        // reports "Enter the SSH password" instead of authenticating with "".
        let mut password = Some(String::new());
        fill_saved_secrets(&store(), "other", "root", &mut password, &mut None);
        assert_eq!(password, None);
    }
}
