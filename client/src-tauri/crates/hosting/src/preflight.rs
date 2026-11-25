//! Read-only checks before anything is changed on the remote machine.
//!
//! Preflight runs `uname`, reads `/etc/os-release`, checks systemd, tar,
//! sha256sum, openssl, free space, the RosTalk ports and an existing install.
//! A failed check is an error before the first write (ADR 0021).

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::command::RemoteCommand;
use crate::error::{HostingError, HostingErrorCode, Result};
use crate::release::Arch;
use crate::ssh::SshSession;

const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(20);
const MIN_DISK_MB: u64 = 200;

/// Which firewall the remote machine uses, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FirewallKind {
    None,
    Ufw,
    Firewalld,
}

/// One checked port.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortCheck {
    pub port: u16,
    /// `tcp` or `udp`.
    pub protocol: String,
    /// `false` when the check was not possible (`ss` missing).
    pub checked: bool,
    pub in_use: bool,
}

/// An existing RosTalk installation found on the machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExistingInstall {
    /// Output of `rostalk-server version`, when the binary starts.
    pub version: Option<String>,
    pub data_dir_exists: bool,
    pub database_exists: bool,
    /// A first-start admin invite is still waiting to be used.
    pub admin_invite_pending: bool,
}

/// DNS result for an optional domain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainCheck {
    pub domain: String,
    pub domain_addresses: Vec<String>,
    pub server_addresses: Vec<String>,
    pub matches: bool,
}

/// A human-readable reason preflight refused the machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightProblem {
    /// Stable code for localization.
    pub code: String,
    /// English fallback and technical detail.
    pub message: String,
}

/// Everything the UI needs for the "check" step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightReport {
    pub os_name: String,
    pub os_id: String,
    pub os_version: String,
    pub kernel_arch: String,
    pub arch: Arch,
    pub supported: bool,
    pub problems: Vec<PreflightProblem>,
    pub systemd: bool,
    pub systemd_version: Option<String>,
    pub has_tar: bool,
    pub has_sha256sum: bool,
    pub has_openssl: bool,
    /// `openssl version` text, when the command exists.
    pub openssl_version: Option<String>,
    /// OpenSSL supports `pkeyutl -rawin` (needed for Ed25519 SHA256SUMS).
    pub openssl_rawin: bool,
    pub has_ss: bool,
    pub has_apt: bool,
    pub has_dnf: bool,
    pub free_disk_mb: u64,
    pub ports: Vec<PortCheck>,
    pub existing: Option<ExistingInstall>,
    pub firewall: FirewallKind,
    pub is_root: bool,
    pub domain: Option<DomainCheck>,
}

impl PreflightReport {
    /// True when installation may proceed (possibly after installing packages).
    #[must_use]
    pub fn can_install(&self) -> bool {
        self.supported
    }

    /// Errors that cannot be fixed by the wizard.
    #[must_use]
    pub fn blocking(&self) -> Vec<&PreflightProblem> {
        self.problems
            .iter()
            .filter(|problem| {
                matches!(
                    problem.code.as_str(),
                    "unsupportedOs"
                        | "unsupportedArch"
                        | "noSystemd"
                        | "lowDisk"
                        | "domainMismatch"
                        | "portBusy"
                        | "legacyInstall"
                )
            })
            .collect()
    }
}

/// Input of the preflight.
#[derive(Debug)]
pub struct PreflightRequest {
    pub domain: Option<String>,
}

/// Runs the checks over an authenticated session.
///
/// `sudo` is needed for files inside `/var/lib/rostalk`: the service user owns
/// the data directory with mode 0750, so a non-root SSH account cannot stat the
/// database even when it can read `/var/lib`.
pub async fn run(
    session: &SshSession,
    request: &PreflightRequest,
    sudo: Option<&crate::secret::Secret>,
) -> Result<PreflightReport> {
    let uname = optional_text(session, &["uname", "-m"]).await;
    let kernel_arch = uname.unwrap_or_default().trim().to_owned();
    let arch = Arch::from_uname(&kernel_arch).ok_or_else(|| {
        HostingError::new(
            HostingErrorCode::UnsupportedArch,
            format!(
                "The server reports architecture \"{kernel_arch}\". RosTalk has builds only for x86_64 and aarch64."
            ),
        )
    })?;

    let os_release = optional_text(session, &["cat", "/etc/os-release"])
        .await
        .ok_or_else(|| {
            HostingError::new(
                HostingErrorCode::UnsupportedOs,
                "The server has no /etc/os-release. RosTalk supports Ubuntu, Debian and Fedora.",
            )
        })?;
    let os = parse_os_release(&os_release);

    let systemd = command_exists(session, "systemctl").await
        && path_exists(session, "/run/systemd/system").await;
    let systemd_version = optional_text(session, &["systemctl", "--version"])
        .await
        .and_then(|text| text.lines().next().map(str::trim).map(str::to_owned));
    let has_tar = command_exists(session, "tar").await;
    let has_sha256sum = command_exists(session, "sha256sum").await;
    let has_openssl = command_exists(session, "openssl").await;
    let openssl_version = if has_openssl {
        optional_text(session, &["openssl", "version"])
            .await
            .map(|text| text.trim().to_owned())
    } else {
        None
    };
    let openssl_rawin = if has_openssl {
        openssl_supports_rawin(session, openssl_version.as_deref()).await
    } else {
        false
    };
    let has_ss = command_exists(session, "ss").await;
    let has_apt = command_exists(session, "apt-get").await;
    let has_dnf = command_exists(session, "dnf").await;
    let has_ufw = command_exists(session, "ufw").await;
    let has_firewalld = command_exists(session, "firewall-cmd").await;
    let firewall = if has_ufw {
        FirewallKind::Ufw
    } else if has_firewalld {
        FirewallKind::Firewalld
    } else {
        FirewallKind::None
    };

    let free_disk_mb = optional_text(session, &["df", "-Pk", "/"])
        .await
        .and_then(|text| parse_df(&text))
        .unwrap_or(0);

    let mut ports = Vec::new();
    for (port, protocol, scheme) in [
        (7443u16, "tcp", "-ltn"),
        (7881, "tcp", "-ltn"),
        (7882, "udp", "-lun"),
    ] {
        let in_use = if has_ss {
            optional_text(session, &["ss", "-H", scheme])
                .await
                .map(|text| port_listed(&text, port))
                .unwrap_or(false)
        } else {
            false
        };
        ports.push(PortCheck {
            port,
            protocol: protocol.to_owned(),
            checked: has_ss,
            in_use,
        });
    }

    let existing = detect_existing(session, sudo).await?;
    // A server installed under the old name keeps its data in /var/lib/hearth.
    // The wizard's backup and update steps work on the new paths only, so the
    // operator moves it once with install.sh, which migrates in place (ADR 0033).
    let legacy_install = existing.is_none()
        && (path_exists(session, LEGACY_BINARY).await
            || path_exists(session, LEGACY_DATA_DIR).await);

    let mut problems = Vec::new();
    let has_existing = existing.is_some() || legacy_install;
    if legacy_install {
        problems.push(PreflightProblem {
            code: "legacyInstall".to_owned(),
            message: format!(
                "A server installed as Hearth was found ({LEGACY_DATA_DIR}). Update it once on the server with install.sh from the latest RosTalk release (see docs/INSTALL.md): it moves the data to /var/lib/rostalk and keeps the identity, users and channels. Then run this wizard again."
            ),
        });
    }
    if !os.supported {
        problems.push(PreflightProblem {
            code: "unsupportedOs".to_owned(),
            message: format!(
                "{} {} is not supported. Use Ubuntu 22.04+, Debian 12+, Fedora 38+, or AlmaLinux/Rocky/RHEL/Oracle Linux 8+ (CentOS Stream 9+).",
                os.pretty_name, os.version_id
            ),
        });
    }
    if !systemd {
        problems.push(PreflightProblem {
            code: "noSystemd".to_owned(),
            message: "systemd is not running. RosTalk installs a systemd service; containers without systemd are not supported."
                .to_owned(),
        });
    }
    if !has_tar {
        problems.push(PreflightProblem {
            code: "missingTar".to_owned(),
            message: "tar is missing.".to_owned(),
        });
    }
    if !has_sha256sum {
        problems.push(PreflightProblem {
            code: "missingSha256sum".to_owned(),
            message: "sha256sum is missing (coreutils).".to_owned(),
        });
    }
    if !has_openssl {
        problems.push(PreflightProblem {
            code: "missingOpenssl".to_owned(),
            message: "openssl is missing; it verifies the release signature.".to_owned(),
        });
    }
    if free_disk_mb < MIN_DISK_MB {
        problems.push(PreflightProblem {
            code: "lowDisk".to_owned(),
            message: format!(
                "Only {free_disk_mb} MB is free on /; at least {MIN_DISK_MB} MB is needed."
            ),
        });
    }
    for port in &ports {
        if port.checked && port.in_use && !has_existing {
            problems.push(PreflightProblem {
                code: "portBusy".to_owned(),
                message: format!(
                    "{} {}/{} is already in use. Stop the process or choose another server.",
                    port.port,
                    port.protocol,
                    if port.protocol == "udp" { "udp" } else { "tcp" }
                ),
            });
        }
    }

    let domain_check = match &request.domain {
        Some(domain) if !domain.trim().is_empty() => {
            Some(check_domain(domain.trim(), &session_label_host(session)).await?)
        }
        _ => None,
    };
    if let Some(check) = &domain_check {
        if !check.matches {
            problems.push(PreflightProblem {
                code: "domainMismatch".to_owned(),
                message: format!(
                    "{} resolves to {}, but the SSH address resolves to {}. Point the A/AAAA record at this VPS first.",
                    check.domain,
                    check.domain_addresses.join(", "),
                    check.server_addresses.join(", ")
                ),
            });
        }
    }

    let supported = !problems.iter().any(|problem| {
        matches!(
            problem.code.as_str(),
            "unsupportedOs"
                | "noSystemd"
                | "lowDisk"
                | "domainMismatch"
                | "portBusy"
                | "legacyInstall"
        )
    });

    Ok(PreflightReport {
        os_name: os.pretty_name,
        os_id: os.id,
        os_version: os.version_id,
        kernel_arch,
        arch,
        supported,
        problems,
        systemd,
        systemd_version,
        has_tar,
        has_sha256sum,
        has_openssl,
        openssl_version,
        openssl_rawin,
        has_ss,
        has_apt,
        has_dnf,
        free_disk_mb,
        ports,
        existing,
        firewall,
        is_root: session.is_root(),
        domain: domain_check,
    })
}

/// Which packages are missing and can be installed by the wizard.
#[must_use]
pub fn missing_packages(report: &PreflightReport) -> Vec<&'static str> {
    let mut packages = Vec::new();
    if !report.has_tar {
        packages.push("tar");
    }
    if !report.has_sha256sum {
        packages.push("coreutils");
    }
    if !report.has_openssl {
        packages.push("openssl");
        packages.push("ca-certificates");
    }
    if !report.has_ss {
        // `ss` is in `iproute2` on Debian/Ubuntu and `iproute` on RHEL.
        packages.push("iproute");
    }
    packages
}

struct OsInfo {
    id: String,
    version_id: String,
    pretty_name: String,
    supported: bool,
}

fn parse_os_release(text: &str) -> OsInfo {
    let mut id = String::new();
    let mut version_id = String::new();
    let mut pretty_name = String::new();
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim().trim_matches('"').to_owned();
        match key.trim() {
            "ID" => id = value.to_ascii_lowercase(),
            "VERSION_ID" => version_id = value,
            "PRETTY_NAME" => pretty_name = value,
            _ => {}
        }
    }
    let supported = match id.as_str() {
        "ubuntu" => version_at_least(&version_id, 22, 4),
        "debian" => version_at_least(&version_id, 12, 0),
        "fedora" => version_at_least(&version_id, 38, 0),
        // RHEL 8 rebuilds and Oracle Linux 8+.
        "almalinux" | "rocky" | "rhel" | "ol" => version_at_least(&version_id, 8, 0),
        // CentOS Linux 8 is EOL; only CentOS Stream 9+ is supported.
        "centos" => version_at_least(&version_id, 9, 0),
        _ => false,
    };
    if pretty_name.is_empty() {
        pretty_name = if id.is_empty() {
            "Unknown Linux".to_owned()
        } else {
            format!("{id} {version_id}")
        };
    }
    OsInfo {
        id,
        version_id,
        pretty_name,
        supported,
    }
}

fn version_at_least(value: &str, major: u32, minor: u32) -> bool {
    let mut parts = value.split('.');
    let parsed_major = parts.next().and_then(|part| part.parse::<u32>().ok());
    let parsed_minor = parts
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .unwrap_or(0);
    match parsed_major {
        Some(found) => (found, parsed_minor) >= (major, minor),
        None => false,
    }
}

fn parse_df(text: &str) -> Option<u64> {
    let line = text.lines().nth(1)?;
    let fields: Vec<&str> = line.split_whitespace().collect();
    let kib: u64 = fields.get(3)?.parse().ok()?;
    // `df -Pk` prints 1 KiB blocks; the report speaks megabytes.
    Some(kib / 1024)
}

fn port_listed(text: &str, port: u16) -> bool {
    let suffix = format!(":{port}");
    text.lines().any(|line| {
        line.split_whitespace()
            .any(|column| column.ends_with(&suffix) || column == format!("*:{port}"))
    })
}

/// Paths of a server installed before the RosTalk rename (ADR 0033).
const LEGACY_BINARY: &str = "/usr/local/bin/hearth-server";
const LEGACY_DATA_DIR: &str = "/var/lib/hearth";

async fn detect_existing(
    session: &SshSession,
    sudo: Option<&crate::secret::Secret>,
) -> Result<Option<ExistingInstall>> {
    let binary = path_exists(session, "/usr/local/bin/rostalk-server").await;
    let data_dir_exists = path_exists(session, "/var/lib/rostalk").await;
    let database_exists = root_path_exists(session, "/var/lib/rostalk/rostalk.db", sudo).await?;
    let admin_invite_pending =
        root_path_exists(session, "/var/lib/rostalk/admin-invite", sudo).await?;
    // An empty pre-created /var/lib/rostalk is not an installation.
    if !binary && !database_exists && !admin_invite_pending {
        return Ok(None);
    }
    let version = if binary {
        optional_text(session, &["/usr/local/bin/rostalk-server", "version"])
            .await
            .and_then(|text| text.lines().next().map(str::trim).map(str::to_owned))
    } else {
        None
    };
    Ok(Some(ExistingInstall {
        version,
        data_dir_exists,
        database_exists,
        admin_invite_pending,
    }))
}

/// True when OpenSSL can verify an Ed25519 signature over the raw checksum
/// file. OpenSSL 1.1.1 (for example on AlmaLinux 8) lacks `pkeyutl -rawin`;
/// in that case the client has already verified the signature with `ring`.
async fn openssl_supports_rawin(session: &SshSession, version: Option<&str>) -> bool {
    if version.is_some_and(|text| text.contains("OpenSSL 3.")) {
        return true;
    }
    session
        .run_with_timeout(
            &RemoteCommand::user(["openssl", "pkeyutl", "-help"]),
            PREFLIGHT_TIMEOUT,
        )
        .await
        .map(|output| output.combined().contains("-rawin"))
        .unwrap_or(false)
}

async fn command_exists(session: &SshSession, name: &str) -> bool {
    // `command -v` is a shell builtin; the fragment is fixed.
    let script = format!("command -v {}", crate::command::shell_quote(name));
    session
        .run_with_timeout(
            &RemoteCommand::user(["sh", "-c", script.as_str()]),
            PREFLIGHT_TIMEOUT,
        )
        .await
        .map(|output| output.success())
        .unwrap_or(false)
}

async fn path_exists(session: &SshSession, path: &str) -> bool {
    session
        .run_with_timeout(
            &RemoteCommand::user(["test", "-e", path]),
            PREFLIGHT_TIMEOUT,
        )
        .await
        .map(|output| output.success())
        .unwrap_or(false)
}

async fn root_path_exists(
    session: &SshSession,
    path: &str,
    sudo: Option<&crate::secret::Secret>,
) -> Result<bool> {
    Ok(session
        .run_with_timeout(
            &RemoteCommand::root(["test", "-e", path], sudo),
            PREFLIGHT_TIMEOUT,
        )
        .await?
        .success())
}

async fn optional_text(session: &SshSession, argv: &[&str]) -> Option<String> {
    session
        .run_with_timeout(
            &RemoteCommand::user(argv.iter().copied()),
            PREFLIGHT_TIMEOUT,
        )
        .await
        .ok()
        .filter(|output| output.success())
        .map(|output| output.stdout)
}

/// Resolves a domain and the SSH address and checks that they overlap.
pub async fn check_domain(domain: &str, ssh_host: &str) -> Result<DomainCheck> {
    let domain_addresses = resolve(domain, 443).await?;
    let server_addresses = resolve(ssh_host, 22).await?;
    let matches = domain_addresses
        .iter()
        .any(|address| server_addresses.contains(address));
    Ok(DomainCheck {
        domain: domain.to_owned(),
        domain_addresses,
        server_addresses,
        matches,
    })
}

async fn resolve(host: &str, port: u16) -> Result<Vec<String>> {
    let values = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| {
            HostingError::new(HostingErrorCode::Dns, format!("Could not resolve {host}."))
                .with_detail(error.to_string())
        })?;
    let mut addresses: Vec<String> = values.map(|value| value.ip().to_string()).collect();
    addresses.sort();
    addresses.dedup();
    if addresses.is_empty() {
        return Err(HostingError::new(
            HostingErrorCode::Dns,
            format!("{host} has no addresses."),
        ));
    }
    Ok(addresses)
}

/// A host name from the SSH session, used for the DNS comparison.
fn session_label_host(session: &SshSession) -> String {
    session
        .label()
        .rsplit_once(':')
        .map(|(host, _)| host.to_owned())
        .unwrap_or_else(|| session.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_release_matrix() {
        let ubuntu =
            parse_os_release("ID=ubuntu\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n");
        assert!(ubuntu.supported);
        assert_eq!(ubuntu.id, "ubuntu");
        let old = parse_os_release("ID=ubuntu\nVERSION_ID=\"20.04\"\n");
        assert!(!old.supported);
        let debian = parse_os_release("ID=debian\nVERSION_ID=\"12\"\n");
        assert!(debian.supported);
        let fedora = parse_os_release("ID=fedora\nVERSION_ID=41\n");
        assert!(fedora.supported);
        let arch = parse_os_release("ID=arch\n");
        assert!(!arch.supported);
        let centos = parse_os_release("ID=centos\nVERSION_ID=\"9\"\n");
        assert!(centos.supported);
        let centos8 = parse_os_release("ID=centos\nVERSION_ID=\"8\"\n");
        assert!(!centos8.supported);
        let alma = parse_os_release("ID=almalinux\nVERSION_ID=\"8.10\"\n");
        assert!(alma.supported);
        let alma7 = parse_os_release("ID=almalinux\nVERSION_ID=\"7.9\"\n");
        assert!(!alma7.supported);
        let rocky = parse_os_release("ID=rocky\nVERSION_ID=\"9.3\"\n");
        assert!(rocky.supported);
        let rhel = parse_os_release("ID=rhel\nVERSION_ID=\"8.8\"\n");
        assert!(rhel.supported);
        let ol = parse_os_release("ID=ol\nVERSION_ID=\"9.4\"\n");
        assert!(ol.supported);
        assert!(!parse_os_release("ID=centos\nVERSION_ID=\"8\"\n").supported);
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(version_at_least("22.04", 22, 4));
        assert!(version_at_least("22.10", 22, 4));
        assert!(!version_at_least("9.13", 12, 0));
        assert!(!version_at_least("", 1, 0));
    }

    #[test]
    fn df_output_is_parsed() {
        let text = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 41152736 1 40000000 1% /\n";
        assert_eq!(parse_df(text), Some(39_062));
    }

    #[test]
    fn port_matching_handles_ipv4_and_ipv6() {
        let text = "LISTEN 0 128 0.0.0.0:7443 0.0.0.0:*\nLISTEN 0 128 [::]:7881 [::]:*\n";
        assert!(port_listed(text, 7443));
        assert!(port_listed(text, 7881));
        assert!(!port_listed(text, 7882));
    }
}
