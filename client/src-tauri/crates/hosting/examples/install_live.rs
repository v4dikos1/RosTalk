//! Live installation against a real VPS (stage 6.1a, manual acceptance).
//!
//! This example drives the same `Installer` the wizard uses, but from a
//! terminal, so a real host can be exercised without clicking through the GUI.
//! It is not part of `make check`.
//!
//! Required environment:
//!   ROSTALK_SSH_HOST       address of the VPS
//!   ROSTALK_SSH_PASSWORD   SSH password (never passed as an argument)
//! Optional:
//!   ROSTALK_SSH_PORT       default 22
//!   ROSTALK_SSH_USER       default root
//!   ROSTALK_HTTPS_PORT     default 7443
//!   ROSTALK_PUBLIC_HOST    default `<host>:<https-port>`
//!   ROSTALK_SERVER_NAME    default "RosTalk"
//!   ROSTALK_DOMAIN         empty by default (IP + fingerprint)
//!   ROSTALK_ADVERTISE_IP   empty by default (public IP on the interface)
//!   ROSTALK_OPEN_FIREWALL  "1" to add the three RosTalk ports on the remote host
//!   ROSTALK_EXISTING       fresh | update | reinstall (default fresh)
//!   ROSTALK_SERVER_BUNDLE  default ../resources/server of this crate
//!   ROSTALK_EXPECT_FP      expected host-key fingerprint (optional)
//!   ROSTALK_PREFLIGHT_ONLY "1" to stop after the preflight report
//!
//!   cargo run -p rostalk-hosting --example install_live

use std::path::PathBuf;

use rostalk_hosting::ProgressEvent;
use rostalk_hosting::{
    Auth, ExistingAction, InstallRequest, Installer, LoginMode, Secret, SshSession, SshTarget,
};

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let host = env("ROSTALK_SSH_HOST").ok_or("ROSTALK_SSH_HOST is required")?;
    let password = env("ROSTALK_SSH_PASSWORD").ok_or("ROSTALK_SSH_PASSWORD is required")?;
    let port: u16 = env("ROSTALK_SSH_PORT")
        .unwrap_or_else(|| "22".to_owned())
        .parse()?;
    let user = env("ROSTALK_SSH_USER").unwrap_or_else(|| "root".to_owned());
    let https_port: u16 = env("ROSTALK_HTTPS_PORT")
        .unwrap_or_else(|| "7443".to_owned())
        .parse()?;
    let public_host = env("ROSTALK_PUBLIC_HOST").unwrap_or_else(|| format!("{host}:{https_port}"));
    let server_name = env("ROSTALK_SERVER_NAME").unwrap_or_else(|| "RosTalk".to_owned());
    let domain = env("ROSTALK_DOMAIN");
    let advertise_ip = env("ROSTALK_ADVERTISE_IP");
    let open_firewall = env("ROSTALK_OPEN_FIREWALL").as_deref() == Some("1");
    let existing = match env("ROSTALK_EXISTING").as_deref() {
        None | Some("fresh") => ExistingAction::Fresh,
        Some("update") => ExistingAction::Update,
        Some("reinstall") => ExistingAction::Reinstall,
        Some(other) => return Err(format!("unknown ROSTALK_EXISTING {other}").into()),
    };
    let bundle = env("ROSTALK_SERVER_BUNDLE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/server")
        });

    let known = std::env::temp_dir().join("rostalk-live-known-hosts.json");
    let make_target = || SshTarget {
        host: host.clone(),
        port,
        username: user.clone(),
        auth: Auth::Password {
            password: Secret::new(password.clone()),
        },
    };
    let make_sudo = || {
        if user == "root" {
            None
        } else {
            Some(Secret::new(password.clone()))
        }
    };

    println!("== probe {host}:{port} as {user}");
    let key =
        SshSession::probe(&make_target(), &rostalk_hosting::KnownHosts::load(&known)?).await?;
    println!(
        "host key: SHA256:{} ({}, {:?})",
        key.fingerprint, key.algorithm, key.status
    );
    if let Some(expected) = env("ROSTALK_EXPECT_FP") {
        if expected != key.fingerprint {
            return Err(format!(
                "host key mismatch: expected {expected}, got {}",
                key.fingerprint
            )
            .into());
        }
    }

    let installer =
        Installer::new(known.clone()).with_progress(std::sync::Arc::new(|event: ProgressEvent| {
            println!(
                "[{:>3}%] {:?}: {}",
                event.percent, event.stage, event.message
            );
        }));

    println!("== preflight");
    let report = installer
        .preflight(
            make_target(),
            Some(&key.fingerprint),
            true,
            domain.clone(),
            make_sudo(),
        )
        .await?;
    println!(
        "{} {} / {} / {} MB free / systemd={} / firewall={:?} / root={}",
        report.os_name,
        report.os_version,
        report.kernel_arch,
        report.free_disk_mb,
        report.systemd,
        report.firewall,
        report.is_root
    );
    println!(
        "tar={} sha256sum={} openssl={} rawin={} dnf={} apt={}",
        report.has_tar,
        report.has_sha256sum,
        report.has_openssl,
        report.openssl_rawin,
        report.has_dnf,
        report.has_apt
    );
    if let Some(openssl) = &report.openssl_version {
        println!("openssl: {openssl}");
    }
    for problem in &report.problems {
        println!("problem: {} — {}", problem.code, problem.message);
    }
    if !report.supported {
        return Err("preflight says this host is not supported".into());
    }
    if env("ROSTALK_PREFLIGHT_ONLY").as_deref() == Some("1") {
        return Ok(());
    }

    println!("== install");
    let request = InstallRequest {
        target: Some(make_target()),
        expected_host_key: Some(key.fingerprint.clone()),
        trust_host_key: true,
        sudo_password: make_sudo(),
        bundle_dir: bundle,
        server_name: Some(server_name),
        domain,
        public_host,
        advertise_ip,
        login_mode: LoginMode::Invite,
        server_password: None,
        max_users: None,
        open_firewall,
        install_packages: true,
        existing_action: existing,
    };
    let outcome = installer.install(request).await?;
    println!();
    println!("== done");
    println!("version: {}", outcome.server_version);
    println!("host:    {}", outcome.public_host);
    println!("fp:      {}", outcome.host_fingerprint);
    if let Some(backup) = &outcome.backup_path {
        println!("backup:  {backup}");
    }
    if let Some(link) = &outcome.admin_link {
        println!("admin:   {link}");
    }
    if let Some(link) = &outcome.member_link {
        println!("member:  {link}");
    }
    if !outcome.firewall_applied {
        println!("firewall: not fully applied; run manually:");
        for command in &outcome.firewall_commands {
            println!("  {command}");
        }
    }
    Ok(())
}
