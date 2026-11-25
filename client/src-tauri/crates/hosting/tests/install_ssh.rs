//! End-to-end installation against a throwaway sshd container.
//!
//! Ignored so `make check` stays fast. Run it through
//! `make test-client-install-docker`, which builds the image, starts sshd on
//! 127.0.0.1:2222 and maps the server HTTPS port to 127.0.0.1:17443.
//!
//! The test covers the real path: host-key TOFU, password and key auth, sudo,
//! port preflight, signed bundle upload, install.sh, admin settings, /healthz,
//! invite links and a client connection with `rostalk-core`. It then reinstalls
//! over the existing data and checks that a backup was made and the database
//! survived.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use rostalk_core::{ConnectRequest, ConnectTarget, CoreHandle};
use rostalk_hosting::{
    Auth, ExistingAction, InstallRequest, Installer, KnownHosts, LoginMode, Secret, SshSession,
    SshTarget,
};
use rostalk_platform::{IdentityVault, MemoryStore};

struct Config {
    host: String,
    ssh_port: u16,
    https_port: u16,
    user: String,
    password: String,
    root_user: String,
    key: Option<PathBuf>,
    bundle: PathBuf,
}

impl Config {
    fn from_env() -> Self {
        let address =
            std::env::var("ROSTALK_TEST_SSH_ADDR").unwrap_or_else(|_| "127.0.0.1:2222".to_owned());
        let (host, port) = address
            .rsplit_once(':')
            .expect("ROSTALK_TEST_SSH_ADDR must be host:port");
        Self {
            host: host.to_owned(),
            ssh_port: port.parse().expect("SSH port"),
            https_port: std::env::var("ROSTALK_TEST_HTTPS_PORT")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(17443),
            user: std::env::var("ROSTALK_TEST_SSH_USER")
                .unwrap_or_else(|_| "rostalktest".to_owned()),
            password: std::env::var("ROSTALK_TEST_SSH_PASSWORD")
                .unwrap_or_else(|_| "rostalkpass".to_owned()),
            root_user: std::env::var("ROSTALK_TEST_SSH_ROOT_USER")
                .unwrap_or_else(|_| "root".to_owned()),
            key: std::env::var("ROSTALK_TEST_SSH_KEY")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from),
            bundle: std::env::var("ROSTALK_SERVER_BUNDLE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/server")
                }),
        }
    }

    fn password_target(&self, user: &str, password: &str) -> SshTarget {
        SshTarget {
            host: self.host.clone(),
            port: self.ssh_port,
            username: user.to_owned(),
            auth: Auth::Password {
                password: Secret::new(password),
            },
        }
    }

    fn public_host(&self) -> String {
        format!("{}:{}", self.host, self.https_port)
    }
}

fn known_path(directory: &std::path::Path) -> PathBuf {
    directory.join("ssh_known_hosts.json")
}

fn install_request(config: &Config, fingerprint: &str, action: ExistingAction) -> InstallRequest {
    InstallRequest {
        target: Some(config.password_target(&config.user, &config.password)),
        expected_host_key: Some(fingerprint.to_owned()),
        trust_host_key: true,
        // The test user's sudo password equals the SSH password.
        sudo_password: Some(Secret::new(config.password.clone())),
        bundle_dir: config.bundle.clone(),
        server_name: Some("RosTalk Integration".to_owned()),
        domain: None,
        public_host: config.public_host(),
        advertise_ip: None,
        login_mode: LoginMode::Invite,
        server_password: None,
        max_users: Some(10),
        open_firewall: false,
        install_packages: true,
        existing_action: action,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs the sshd container from deploy/test-client-install-docker.sh"]
async fn install_update_and_client_connect() {
    let config = Config::from_env();
    let temp = tempfile::tempdir().expect("tempdir");
    let known = known_path(temp.path());
    let installer = Installer::new(known.clone());

    // 1. A wrong password must fail before anything else.
    let error = SshSession::connect(
        config.password_target(&config.user, "definitely-wrong"),
        None,
        true,
        &known,
    )
    .await
    .expect_err("wrong password must fail");
    assert_eq!(error.code, rostalk_hosting::HostingErrorCode::AuthFailed);
    eprintln!("negative: wrong SSH password rejected");

    // 2. First contact: TOFU returns a SHA-256 fingerprint and saves nothing.
    let probe_target = config.password_target(&config.user, &config.password);
    let probe = SshSession::probe(&probe_target, &KnownHosts::load(&known).expect("load"))
        .await
        .expect("probe");
    assert_eq!(probe.fingerprint.len(), 64);
    assert_eq!(probe.status, rostalk_hosting::HostKeyStatus::New);
    assert!(KnownHosts::load(&known).expect("load").saved("x").is_none());
    eprintln!("probe: host key SHA256:{}", probe.fingerprint);

    // 3. A deliberately wrong confirmed key is a hard error.
    let wrong = "00".repeat(32);
    let error = SshSession::connect(
        config.password_target(&config.user, &config.password),
        Some(&wrong),
        true,
        &known,
    )
    .await
    .expect_err("host key mismatch must fail");
    assert_eq!(
        error.code,
        rostalk_hosting::HostingErrorCode::HostKeyMismatch
    );
    eprintln!("negative: a changed host key is rejected");

    // 4. Key authentication as root, when the harness provided a key.
    if let Some(key) = &config.key {
        let target = SshTarget {
            host: config.host.clone(),
            port: config.ssh_port,
            username: config.root_user.clone(),
            auth: Auth::Key {
                path: key.clone(),
                passphrase: None,
            },
        };
        let (session, info) = SshSession::connect(target, Some(&probe.fingerprint), true, &known)
            .await
            .expect("key auth");
        assert!(session.is_root(), "root key login must be root");
        let output = session
            .run(&rostalk_hosting::RemoteCommand::user(["id", "-u"]))
            .await
            .expect("id");
        assert_eq!(output.stdout.trim(), "0");
        assert_eq!(info.fingerprint, probe.fingerprint);
        session.close().await;
        eprintln!("positive: key authentication as root");
    }

    // 5. Preflight on a clean machine.
    let report = installer
        .preflight(
            config.password_target(&config.user, &config.password),
            Some(&probe.fingerprint),
            true,
            None,
            Some(Secret::new(config.password.clone())),
        )
        .await
        .expect("preflight");
    assert!(report.supported, "problems: {:?}", report.problems);
    assert_eq!(report.arch, rostalk_hosting::Arch::Amd64);
    assert!(report.systemd);
    assert!(report.has_tar && report.has_sha256sum && report.has_openssl);
    assert!(!report.is_root, "the test user is not root");
    assert!(report.existing.is_none(), "the container starts clean");
    eprintln!(
        "preflight: {} {} / {} / {} MB free",
        report.os_name, report.os_version, report.kernel_arch, report.free_disk_mb
    );

    // 6. An occupied 7443 must be visible before install.sh runs.
    let (session, _) = SshSession::connect(
        config.password_target(&config.user, &config.password),
        Some(&probe.fingerprint),
        true,
        &known,
    )
    .await
    .expect("session");
    // 6a. A distribution outside the support matrix is refused before any
    // write. Temporarily replace os-release and restore it immediately.
    let sudo = Secret::new(config.password.clone());
    let fake_os = session
        .run(&rostalk_hosting::RemoteCommand::root(
            [
                "sh",
                "-c",
                "cp /etc/os-release /tmp/rostalk-os-release.bak && printf 'ID=arch\\nVERSION_ID=1\\nPRETTY_NAME=\"Arch Linux\"\\n' > /etc/os-release",
            ],
            Some(&sudo),
        ))
        .await
        .expect("fake os-release");
    assert!(fake_os.success(), "{}", fake_os.combined());
    let unsupported = installer
        .preflight(
            config.password_target(&config.user, &config.password),
            Some(&probe.fingerprint),
            true,
            None,
            Some(Secret::new(config.password.clone())),
        )
        .await
        .expect("preflight on an unsupported OS");
    assert!(!unsupported.supported);
    assert!(
        unsupported
            .problems
            .iter()
            .any(|problem| problem.code == "unsupportedOs"),
        "problems: {:?}",
        unsupported.problems
    );
    eprintln!("negative: an unsupported distribution is refused");
    let restored = session
        .run(&rostalk_hosting::RemoteCommand::root(
            ["mv", "/tmp/rostalk-os-release.bak", "/etc/os-release"],
            Some(&sudo),
        ))
        .await
        .expect("restore os-release");
    assert!(restored.success(), "{}", restored.combined());

    // 6b. An occupied 7443 must be visible before install.sh runs.
    let _ = session
        .run(&rostalk_hosting::RemoteCommand::user([
            "sh",
            "-c",
            "nohup nc -l -p 7443 >/dev/null 2>&1 &",
        ]))
        .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let busy = installer
        .preflight(
            config.password_target(&config.user, &config.password),
            Some(&probe.fingerprint),
            true,
            None,
            Some(Secret::new(config.password.clone())),
        )
        .await
        .expect("preflight with busy port");
    assert!(
        busy.problems
            .iter()
            .any(|problem| problem.code == "portBusy"),
        "problems: {:?}",
        busy.problems
    );
    eprintln!("negative: a busy 7443 is reported");
    let _ = session
        .run(&rostalk_hosting::RemoteCommand::user([
            "pkill",
            "-f",
            "nc -l -p 7443",
        ]))
        .await;
    session.close().await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    // 7. Full installation through sudo.
    let outcome = installer
        .install(install_request(
            &config,
            &probe.fingerprint,
            ExistingAction::Fresh,
        ))
        .await
        .expect("install");
    let admin_link = outcome.admin_link.clone().expect("admin link");
    assert!(admin_link.starts_with("rostalk://join?"));
    assert!(outcome
        .member_link
        .as_deref()
        .unwrap_or("")
        .starts_with("rostalk://join?"));
    assert_eq!(outcome.public_host, config.public_host());
    eprintln!(
        "install: version {} at {} (admin + member links)",
        outcome.server_version, outcome.public_host
    );

    // 8. The desktop core connects with the admin link and gets a session.
    let core = CoreHandle::new(
        Arc::new(IdentityVault::new(
            "rostalk-integration",
            MemoryStore::new(),
        )),
        temp.path(),
        Arc::new(|_| {}),
    )
    .expect("core");
    let state = core
        .connect(ConnectRequest {
            target: ConnectTarget::Link {
                link: admin_link.clone(),
            },
            nickname: "Integration".to_owned(),
            password: None,
            accept_new_certificate: false,
        })
        .await
        .expect("client connect");
    assert_eq!(state.connection, rostalk_core::ConnectionPhase::Connected);
    assert_eq!(
        state.server.as_ref().map(|server| server.name.as_str()),
        Some("RosTalk Integration")
    );
    let bookmark = state
        .servers
        .iter()
        .find(|server| server.host == config.public_host());
    assert!(bookmark.is_some(), "the admin link must be bookmarked");
    eprintln!("client: connected and bookmarked the server");
    let _ = core.disconnect().await;

    // 9. A second preflight sees the installation and offers update/reinstall.
    let before = installer
        .preflight(
            config.password_target(&config.user, &config.password),
            Some(&probe.fingerprint),
            true,
            None,
            Some(Secret::new(config.password.clone())),
        )
        .await
        .expect("preflight before reinstall");
    let existing = before.existing.expect("existing installation");
    assert!(existing.database_exists, "the database must be visible");
    eprintln!(
        "reinstall: detected {}",
        existing.version.as_deref().unwrap_or("unknown version")
    );

    // 10. Reinstall keeps the data and writes a backup.
    let mut reinstall = install_request(&config, &probe.fingerprint, ExistingAction::Reinstall);
    // Exercise password login too: the secret must travel on stdin, never in
    // the command line of the admin CLI.
    reinstall.login_mode = LoginMode::Password;
    reinstall.server_password = Some(Secret::new("integration-server-pass"));
    let again = installer.install(reinstall).await.expect("reinstall");
    let backup = again.backup_path.expect("backup path");
    assert!(backup.starts_with("/var/backups/rostalk/pre-reinstall-"));
    assert!(
        again.admin_link.is_none(),
        "an administrator already exists"
    );
    eprintln!("reinstall: backup at {backup}");

    // 11. The database survived and the service answers after the restart.
    let (session, _) = SshSession::connect(
        config.password_target(&config.user, &config.password),
        Some(&probe.fingerprint),
        true,
        &known,
    )
    .await
    .expect("session after reinstall");
    let output = session
        .run(&rostalk_hosting::RemoteCommand::root(
            ["test", "-f", "/var/lib/rostalk/rostalk.db"],
            Some(&Secret::new(config.password.clone())),
        ))
        .await
        .expect("test db");
    assert!(output.success(), "the database must survive a reinstall");
    let health = session
        .run(&rostalk_hosting::RemoteCommand::root(
            [
                "/usr/local/bin/rostalk-server",
                "healthcheck",
                "--data=/var/lib/rostalk",
                "--url=https://127.0.0.1:7443/healthz",
            ],
            Some(&Secret::new(config.password.clone())),
        ))
        .await
        .expect("health");
    assert!(
        health.success(),
        "health after reinstall: {}",
        health.combined()
    );
    let settings = session
        .run(&rostalk_hosting::RemoteCommand::root(
            [
                "/usr/local/bin/rostalk-server",
                "admin",
                "settings",
                "get",
                "--data=/var/lib/rostalk",
            ],
            Some(&Secret::new(config.password.clone())),
        ))
        .await
        .expect("settings");
    let settings_text = settings.combined();
    assert!(
        settings_text.contains("login_mode=password"),
        "settings: {settings_text}"
    );
    assert!(
        settings_text.contains("password_set=true"),
        "settings: {settings_text}"
    );
    if let Some(member_link) = again.member_link.clone() {
        let state = core
            .connect(ConnectRequest {
                target: ConnectTarget::Link { link: member_link },
                nickname: "Friend".to_owned(),
                password: Some("integration-server-pass".to_owned()),
                accept_new_certificate: false,
            })
            .await
            .expect("member connect with a server password");
        assert_eq!(state.connection, rostalk_core::ConnectionPhase::Connected);
        let _ = core.disconnect().await;
        eprintln!("reinstall: member link works in password mode");
    }
    session.close().await;
    eprintln!("reinstall: password login applied through stdin");
    eprintln!("reinstall: database preserved and /healthz is 200");
}
