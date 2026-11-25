//! Integration tests of the client core against a real `rostalk-server`.
//!
//! These tests are `#[ignore]` because they need a server. Two ways to run them:
//!
//! - **Linux / CI:** set `ROSTALK_SERVER_BIN` to a built `rostalk-server`. The
//!   test spawns it on a free loopback port in a temporary data directory,
//!   creates a second invite with `rostalk-server invite`, and can restart the
//!   process to exercise reconnection. This is the mode the CI job runs:
//!
//!   ```text
//!   ROSTALK_SERVER_BIN=/path/to/rostalk-server \
//!     cargo test -p rostalk-core --test server_integration -- --ignored --test-threads=1
//!   ```
//!
//! - **Windows against Docker Desktop:** start the dev server as described in
//!   CONTRIBUTING.md with `ROSTALK_ADVERTISE_IP=<LAN IP>`, then pass the printed link
//!   and the commands that create an invite or restart the container:
//!
//!   ```text
//!   ROSTALK_TEST_LINK=rostalk://join?...
//!   ROSTALK_TEST_INVITE_CMD=docker compose -f deploy/dev/compose.yaml exec -T server rostalk-server invite --data=/data --public-host=192.168.0.13 --listen=:7443
//!   ROSTALK_TEST_RESTART_CMD=docker compose -f deploy/dev/compose.yaml restart server
//!   ```
//!
//! The direct-login tests (ADR 0008) need a password-login server. On Linux CI
//! that is a second spawned server; on Windows point
//! `ROSTALK_TEST_PASSWORD_LINK` at a container started with
//! `--login-mode=password --server-password=…`. Without either they skip.
//!
//! Recorded in the PR: which mode was run locally and which one only in CI.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rostalk_core::{
    ConnectRequest, ConnectTarget, ConnectionPhase, CoreErrorCode, CoreHandle, CoreState,
    InviteLink,
};
use rostalk_platform::{IdentityVault, MemoryStore};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const START_TIMEOUT: Duration = Duration::from_secs(60);
const SETTLE_TIMEOUT: Duration = Duration::from_secs(30);

/// A server the test controls, or an already running dev server.
struct TestServer {
    link: String,
    kind: ServerKind,
}

enum ServerKind {
    /// A process spawned by the test (Linux CI).
    Spawned(Box<Spawned>),
    /// An external dev server (Docker Desktop on Windows).
    External(External),
}

struct Spawned {
    binary: PathBuf,
    data_dir: tempfile::TempDir,
    listen: String,
    public_host: String,
    child: Child,
    link: String,
}

struct External {
    invite_cmd: Option<String>,
    restart_cmd: Option<String>,
}

impl TestServer {
    async fn from_env() -> Option<Self> {
        if let Ok(binary) = std::env::var("ROSTALK_SERVER_BIN") {
            if !binary.is_empty() {
                let path = PathBuf::from(binary);
                let mut last = None;
                let mut spawned = None;
                // Media binds fixed ports (7881/tcp, 7882/udp); a previous test
                // may still be releasing them, so retry the startup a few times.
                for _ in 0..3 {
                    match Spawned::start(path.clone()).await {
                        Ok(server) => {
                            spawned = Some(server);
                            break;
                        }
                        Err(err) => {
                            last = Some(err);
                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
                    }
                }
                let spawned = spawned.unwrap_or_else(|| {
                    panic!("could not start the server: {last:?}");
                });
                let link = spawned.link.clone();
                return Some(Self {
                    link,
                    kind: ServerKind::Spawned(Box::new(spawned)),
                });
            }
        }
        let link = std::env::var("ROSTALK_TEST_LINK")
            .ok()
            .filter(|v| !v.is_empty())?;
        Some(Self {
            link,
            kind: ServerKind::External(External {
                invite_cmd: std::env::var("ROSTALK_TEST_INVITE_CMD")
                    .ok()
                    .filter(|v| !v.is_empty()),
                restart_cmd: std::env::var("ROSTALK_TEST_RESTART_CMD")
                    .ok()
                    .filter(|v| !v.is_empty()),
            }),
        })
    }

    /// A link that has not been used yet. In spawned mode each test owns a
    /// fresh server and can spend the bootstrap invite; against an external
    /// server a new invite is minted with `ROSTALK_TEST_INVITE_CMD` when it is
    /// configured.
    fn link_for_new_user(&self) -> Option<String> {
        match &self.kind {
            ServerKind::Spawned(spawned) => Some(spawned.link.clone()),
            ServerKind::External(external) => match &external.invite_cmd {
                Some(command) => match run_shell(command) {
                    Ok(out) => extract_link(&out),
                    Err(err) => {
                        eprintln!("invite command failed: {err}");
                        None
                    }
                },
                None => Some(self.link.clone()),
            },
        }
    }

    /// A second, distinct invite for another identity.
    fn another_invite(&self) -> Option<String> {
        match &self.kind {
            ServerKind::Spawned(spawned) => Some(spawned.create_invite()),
            ServerKind::External(external) => external
                .invite_cmd
                .as_deref()
                .and_then(|command| run_shell(command).ok())
                .and_then(|output| extract_link(&output)),
        }
    }

    fn can_restart(&self) -> bool {
        match &self.kind {
            ServerKind::Spawned(_) => true,
            ServerKind::External(external) => external.restart_cmd.is_some(),
        }
    }

    /// A server with password login, for the direct-login tests of ADR 0008.
    ///
    /// `ROSTALK_TEST_PASSWORD_LINK` points at an already running password-login
    /// server (the same link format as `ROSTALK_TEST_LINK`). Otherwise the test
    /// starts one from `ROSTALK_SERVER_BIN` with `--login-mode=password`; an
    /// external dev server cannot be reconfigured, so those tests skip in
    /// `ROSTALK_TEST_LINK` mode.
    async fn password_server() -> Option<Self> {
        if let Ok(link) = std::env::var("ROSTALK_TEST_PASSWORD_LINK") {
            if !link.is_empty() {
                return Some(Self {
                    link,
                    kind: ServerKind::External(External {
                        invite_cmd: None,
                        restart_cmd: None,
                    }),
                });
            }
        }
        let binary = std::env::var("ROSTALK_SERVER_BIN")
            .ok()
            .filter(|value| !value.is_empty())?;
        let mut last = None;
        for _ in 0..3 {
            match Spawned::start_with(
                PathBuf::from(&binary),
                &[
                    "--login-mode=password",
                    "--server-password=rostalk-test-password",
                ],
            )
            .await
            {
                Ok(spawned) => {
                    let link = spawned.link.clone();
                    return Some(Self {
                        link,
                        kind: ServerKind::Spawned(Box::new(spawned)),
                    });
                }
                Err(err) => {
                    last = Some(err);
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
        panic!("could not start a password-login server: {last:?}");
    }

    async fn restart(&mut self) {
        match &mut self.kind {
            ServerKind::Spawned(spawned) => spawned.restart().await,
            ServerKind::External(external) => {
                let command = external
                    .restart_cmd
                    .as_deref()
                    .expect("restart capability checked by the caller");
                run_shell_async(command).await;
            }
        }
    }
}

impl Spawned {
    async fn start(binary: PathBuf) -> io::Result<Self> {
        Self::start_with(binary, &[]).await
    }

    /// Starts a server with extra command-line arguments (for example a
    /// password-login server for the direct-login tests of ADR 0008).
    async fn start_with(binary: PathBuf, extra: &[&str]) -> io::Result<Self> {
        let data_dir = tempfile::tempdir()?;
        let port = free_port()?;
        let listen = format!("127.0.0.1:{port}");
        let public_host = listen.clone();
        let mut child =
            server_command(&binary, data_dir.path(), &listen, &public_host, extra).spawn()?;
        let link = wait_for_link(&mut child).await?;
        Ok(Self {
            binary,
            data_dir,
            listen,
            public_host,
            child,
            link,
        })
    }

    fn spawn(&self) -> io::Result<Child> {
        server_command(
            &self.binary,
            self.data_dir.path(),
            &self.listen,
            &self.public_host,
            &[],
        )
        .spawn()
    }

    fn create_invite(&self) -> String {
        let output = std::process::Command::new(&self.binary)
            .arg("invite")
            .arg(format!("--data={}", self.data_dir.path().display()))
            .arg(format!("--listen={}", self.listen))
            .arg(format!("--public-host={}", self.public_host))
            .output()
            .expect("run rostalk-server invite");
        let stdout = String::from_utf8_lossy(&output.stdout);
        extract_link(&stdout).unwrap_or_else(|| {
            panic!(
                "rostalk-server invite printed no link; stdout: {stdout}\nstderr: {}",
                String::from_utf8_lossy(&output.stderr)
            )
        })
    }

    async fn restart(&mut self) {
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
        // Give the kernel a moment to release the listener.
        tokio::time::sleep(Duration::from_millis(300)).await;
        // The first start consumed the bootstrap invite; a restart prints no
        // link, so wait for the socket to accept connections instead.
        for attempt in 0..3 {
            self.child = self.spawn().expect("restart the server");
            if wait_for_port(&self.listen, Duration::from_secs(15)).await {
                return;
            }
            let _ = self.child.start_kill();
            let _ = self.child.wait().await;
            tokio::time::sleep(Duration::from_millis(300 * (attempt + 1))).await;
        }
        panic!(
            "server did not reopen {} after three restart attempts",
            self.listen
        );
    }
}

impl Drop for Spawned {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

fn free_port() -> io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Command that starts the control plane on loopback with media bound to
/// loopback too: these tests exercise the control plane only.
fn server_command(
    binary: &Path,
    data_dir: &Path,
    listen: &str,
    public_host: &str,
    extra: &[&str],
) -> Command {
    let mut command = Command::new(binary);
    command
        .arg("run")
        .arg(format!("--data={}", data_dir.display()))
        .arg(format!("--listen={listen}"))
        .arg(format!("--public-host={public_host}"))
        .arg("--advertise-ip=127.0.0.1")
        .arg("--enable-loopback-candidate=true")
        .args(extra)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}

fn extract_link(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| line.starts_with("rostalk://join?"))
        .map(str::to_owned)
}

async fn wait_for_link(child: &mut Child) -> io::Result<String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("server stdout is not piped"))?;
    let mut lines = BufReader::new(stdout).lines();
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    loop {
        let line = match tokio::time::timeout_at(deadline, lines.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => return Err(io::Error::other("server exited before printing a link")),
            Ok(Err(err)) => return Err(err),
            Err(_) => return Err(io::Error::other("server printed no invite link in time")),
        };
        if let Some(link) = extract_link(&line) {
            return Ok(link);
        }
    }
}

async fn wait_for_port(address: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if tokio::net::TcpStream::connect(address).await.is_ok() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

fn run_shell(command: &str) -> io::Result<String> {
    let output = if cfg!(windows) {
        std::process::Command::new("cmd")
            .args(["/C", command])
            .output()?
    } else {
        std::process::Command::new("sh")
            .args(["-c", command])
            .output()?
    };
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "command failed ({}): {}\n{}",
            output.status,
            command,
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn run_shell_async(command: &str) {
    let command = command.to_owned();
    let result = tokio::task::spawn_blocking(move || run_shell(&command)).await;
    match result {
        Ok(Ok(_)) => {}
        Ok(Err(err)) => panic!("restart command failed: {err}"),
        Err(err) => panic!("restart command task failed: {err}"),
    }
}

/// A client core with an in-memory keychain and a temporary data directory.
fn make_core() -> (Arc<CoreHandle>, tempfile::TempDir) {
    let (core, _recorder, dir) = make_recorded_core();
    (core, dir)
}

/// Snapshot/delta counters fed by the core event stream. Snapshots on every
/// `Welcome` are how the test proves a real reconnect happened.
#[derive(Default)]
struct Recorder {
    snapshots: AtomicUsize,
    deltas: AtomicUsize,
    resets: AtomicUsize,
}

impl Recorder {
    fn push(&self, event: &rostalk_core::CoreEvent) {
        match event {
            rostalk_core::CoreEvent::Snapshot(_) => {
                self.snapshots.fetch_add(1, Ordering::SeqCst);
            }
            rostalk_core::CoreEvent::Delta(rostalk_core::StateDelta::Reset(_)) => {
                self.resets.fetch_add(1, Ordering::SeqCst);
                self.deltas.fetch_add(1, Ordering::SeqCst);
            }
            rostalk_core::CoreEvent::Delta(_) => {
                self.deltas.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    fn snapshots(&self) -> usize {
        self.snapshots.load(Ordering::SeqCst)
    }

    fn deltas(&self) -> usize {
        self.deltas.load(Ordering::SeqCst)
    }

    fn resets(&self) -> usize {
        self.resets.load(Ordering::SeqCst)
    }
}

fn make_recorded_core() -> (Arc<CoreHandle>, Arc<Recorder>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("temp dir");
    let vault = IdentityVault::new("rostalk-integration", MemoryStore::new());
    let recorder = Arc::new(Recorder::default());
    let sink = recorder.clone();
    let events = Arc::new(move |event: rostalk_core::CoreEvent| sink.push(&event));
    let core = CoreHandle::new(Arc::new(vault), dir.path(), events).expect("core");
    (Arc::new(core), recorder, dir)
}

/// A core with an existing vault and data directory, as after an application
/// restart: the identity (keychain) and the files stay.
fn make_core_with<S: rostalk_platform::SecretStore + 'static>(
    vault: &Arc<IdentityVault<S>>,
    dir: &Path,
) -> Arc<CoreHandle> {
    Arc::new(CoreHandle::new(vault.clone(), dir, Arc::new(|_| {})).expect("core"))
}

/// A TCP proxy that can drop every active connection and refuse new ones for a
/// while. It lets the tests simulate a short network change without stopping
/// the server: the control connection dies, the media plane and the server stay
/// as they are.
struct PausableProxy {
    port: u16,
    paused: Arc<AtomicBool>,
    tasks: Arc<tokio::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

impl PausableProxy {
    async fn start(host: String, upstream_port: u16) -> io::Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let paused = Arc::new(AtomicBool::new(false));
        let tasks: Arc<tokio::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>> =
            Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let proxy_paused = paused.clone();
        let proxy_tasks = tasks.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut downstream, _)) = listener.accept().await else {
                    return;
                };
                if proxy_paused.load(Ordering::SeqCst) {
                    continue;
                }
                let Ok(mut upstream) =
                    tokio::net::TcpStream::connect((host.as_str(), upstream_port)).await
                else {
                    continue;
                };
                let task = tokio::spawn(async move {
                    let _ = tokio::io::copy_bidirectional(&mut downstream, &mut upstream).await;
                });
                proxy_tasks.lock().await.push(task);
            }
        });
        Ok(Self {
            port,
            paused,
            tasks,
        })
    }

    async fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
        let mut tasks = self.tasks.lock().await;
        for task in tasks.drain(..) {
            task.abort();
        }
    }

    fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
    }
}

async fn connect(core: &CoreHandle, link: &str, nickname: &str) -> CoreState {
    core.connect(ConnectRequest {
        target: ConnectTarget::Link {
            link: link.to_owned(),
        },
        nickname: nickname.to_owned(),
        password: None,
        accept_new_certificate: false,
    })
    .await
    .unwrap_or_else(|err| panic!("connect as {nickname}: {err}"))
}

/// Connects to `link` by `host:port` with a server password (ADR 0008).
async fn connect_direct(
    core: &CoreHandle,
    link: &InviteLink,
    nickname: &str,
    password: &str,
    fingerprint: &str,
    accept_new_certificate: bool,
) -> Result<CoreState, rostalk_core::CoreError> {
    core.connect(ConnectRequest {
        target: ConnectTarget::Direct {
            host: link.authority(),
            port: link.port,
            fingerprint: Some(fingerprint.to_owned()),
        },
        nickname: nickname.to_owned(),
        password: Some(password.to_owned()),
        accept_new_certificate,
    })
    .await
}

async fn wait_until<F: Fn(&CoreState) -> bool>(
    core: &CoreHandle,
    what: &str,
    check: F,
) -> CoreState {
    let deadline = Instant::now() + SETTLE_TIMEOUT;
    loop {
        let state = core.state();
        if check(&state) {
            return state;
        }
        if Instant::now() > deadline {
            panic!("timed out waiting for {what}; state: {state:?}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn voice_channel(state: &CoreState) -> u64 {
    state
        .channels
        .iter()
        .find(|channel| channel.kind == rostalk_core::ChannelKindView::Voice)
        .map(|channel| channel.id)
        .expect("server has a voice channel")
}

async fn server_or_skip() -> Option<TestServer> {
    match TestServer::from_env().await {
        Some(server) => Some(server),
        None => {
            eprintln!(
                "skipping: set ROSTALK_SERVER_BIN (Linux) or ROSTALK_TEST_LINK (external server)"
            );
            None
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN or ROSTALK_TEST_LINK"]
async fn connects_and_receives_a_snapshot() {
    let Some(server) = server_or_skip().await else {
        return;
    };
    let Some(link) = server.link_for_new_user() else {
        return;
    };
    let (core, recorder, _dir) = make_recorded_core();
    let state = connect(&core, &link, "alice").await;

    assert_eq!(state.connection, ConnectionPhase::Connected);
    assert!(state.server.is_some());
    assert!(state.self_user_id != 0);
    assert_eq!(state.nickname, "alice");
    assert!(!state.channels.is_empty());
    assert!(state
        .channels
        .iter()
        .any(|c| c.kind == rostalk_core::ChannelKindView::Voice));
    assert!(state.users.iter().any(|u| u.id == state.self_user_id));
    assert_eq!(state.protocol_version, 1);

    core.disconnect().await.expect("disconnect");
    let state = core.state();
    assert_eq!(state.connection, ConnectionPhase::Disconnected);
    assert!(state.server.is_none());
    assert!(state.channels.is_empty());
    assert!(state.users.is_empty());
    assert!(state.roles.is_empty());
    assert_eq!(state.self_user_id, 0);
    assert!(state.nickname.is_empty());
    assert!(state.permissions.is_none());
    assert!(state.reconnect.is_none());
    // The saved server survives the reset for the next connect.
    assert!(!state.servers.is_empty());
    assert!(recorder.resets() > 0, "disconnect must emit a reset delta");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN or ROSTALK_TEST_LINK"]
async fn a_saved_server_reconnects_without_the_invite() {
    let Some(server) = server_or_skip().await else {
        return;
    };
    let Some(link) = server.link_for_new_user() else {
        return;
    };
    let (core, _dir) = make_core();
    connect(&core, &link, "alice").await;
    core.disconnect().await.expect("disconnect");

    let state = core.state();
    let bookmark = state.servers.first().expect("a saved server").clone();
    // The invite is never written to disk; the canonical link is enough for a
    // returning key (ADR 0008).
    assert!(!bookmark.link.contains("invite="));
    assert!(!bookmark.link.is_empty());

    // An empty nickname uses the one saved for this server, and no invite is
    // needed: the server recognises the public key.
    let state = connect(&core, &bookmark.link, "").await;
    assert_eq!(state.connection, ConnectionPhase::Connected);
    assert_eq!(state.nickname, "alice");
    assert_eq!(
        state.servers.first().map(|item| item.nickname.clone()),
        Some("alice".to_owned())
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN or ROSTALK_TEST_LINK"]
async fn rejects_a_foreign_certificate_fingerprint() {
    let Some(server) = server_or_skip().await else {
        return;
    };
    let Some(link) = server.link_for_new_user() else {
        return;
    };
    let link = InviteLink::parse(&link).expect("parse link");
    let bad_link = format!(
        "rostalk://join?host={}&fp={}&invite={}",
        link.authority(),
        "00".repeat(32),
        link.invite
    );

    let (core, _dir) = make_core();
    let error = core
        .connect(ConnectRequest {
            target: ConnectTarget::Link { link: bad_link },
            nickname: "alice".to_owned(),
            password: None,
            accept_new_certificate: false,
        })
        .await
        .expect_err("a wrong fingerprint must be rejected");
    assert_eq!(error.code, CoreErrorCode::TlsFingerprintMismatch, "{error}");
    let state = core.state();
    assert_eq!(state.connection, ConnectionPhase::Disconnected);
    assert_eq!(state.error.as_ref().map(|e| e.code), Some(error.code));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN or ROSTALK_TEST_LINK"]
async fn join_stores_media_credentials_in_memory_only() {
    let Some(server) = server_or_skip().await else {
        return;
    };
    let Some(link) = server.link_for_new_user() else {
        return;
    };
    let (core, _dir) = make_core();
    let state = connect(&core, &link, "alice").await;
    let channel = voice_channel(&state);

    core.join_channel(channel, None).await.expect("join");
    let state = wait_until(&core, "the user to be in the channel", |state| {
        state
            .users
            .iter()
            .any(|user| user.id == state.self_user_id && user.channel_id == channel)
    })
    .await;

    // Stage 1.4+ returns MediaCredentials; the token must live in the core and
    // must never be part of the IPC snapshot.
    let credentials = core
        .voice_credentials()
        .expect("voice credentials after joining a channel");
    assert_eq!(credentials.channel_id, channel);
    assert!(credentials.url.starts_with("wss://"));
    assert!(credentials.room.starts_with("channel-"));
    assert!(!credentials.participant_identity.is_empty());
    assert!(!credentials.token.is_empty());
    // Stage 2.3: the voice engine needs the profile, the session generation and
    // the pinned leaf fingerprint (ADR 0006).
    assert_eq!(credentials.bitrate_bps, 48_000);
    assert!(!credentials.stereo);
    assert!(credentials.processing_enabled);
    assert!(credentials.generation >= 1);
    assert!(!credentials.tls_fingerprint.is_empty());
    assert!(state
        .channels
        .iter()
        .any(|entry| entry.id == channel
            && entry.voice_profile == rostalk_core::VoiceProfileView::Voice));
    let json = serde_json::to_string(&state).expect("serialize state");
    assert!(!json.contains(&credentials.token));
    assert!(!json.contains(&credentials.url));

    core.leave_channel().await.expect("leave");
    wait_until(&core, "the user to leave the channel", |state| {
        state
            .users
            .iter()
            .all(|user| user.id != state.self_user_id || user.channel_id == 0)
    })
    .await;
    assert!(core.voice_credentials().is_none());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN or ROSTALK_TEST_LINK"]
async fn reconnects_after_a_server_restart_and_restores_the_snapshot() {
    let Some(mut server) = server_or_skip().await else {
        return;
    };
    if !server.can_restart() {
        eprintln!("skipping: this external server has no ROSTALK_TEST_RESTART_CMD");
        return;
    }
    let Some(link) = server.link_for_new_user() else {
        return;
    };
    let (core, recorder, _dir) = make_recorded_core();
    let state = connect(&core, &link, "alice").await;
    let channel = voice_channel(&state);
    core.join_channel(channel, None).await.expect("join");
    wait_until(&core, "the user to join before the restart", |state| {
        state
            .users
            .iter()
            .any(|user| user.id == state.self_user_id && user.channel_id == channel)
    })
    .await;
    let snapshots_before = recorder.snapshots();

    server.restart().await;

    // A fresh `Welcome` (and therefore a new snapshot) proves that the client
    // really reconnected instead of never noticing the drop.
    let state = wait_until(&core, "a new snapshot after the restart", |_state| {
        recorder.snapshots() > snapshots_before
    })
    .await;
    assert_eq!(state.connection, ConnectionPhase::Connected);
    wait_until(&core, "the snapshot to be restored", |state| {
        state.server.is_some()
            && !state.channels.is_empty()
            && state.users.iter().any(|user| user.id == state.self_user_id)
    })
    .await;
    // The core re-joins the channel it was in before the drop.
    let state = wait_until(&core, "the client to re-join its channel", |state| {
        state
            .users
            .iter()
            .any(|user| user.id == state.self_user_id && user.channel_id == channel)
    })
    .await;
    assert_eq!(state.connection, ConnectionPhase::Connected);
    // The voice session was held across the restart (the reconnect is within
    // the 10 s grace) and the re-join returned credentials for the same room.
    let credentials = core
        .voice_credentials()
        .expect("media survived the restart");
    assert_eq!(credentials.channel_id, channel);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN or ROSTALK_TEST_LINK"]
async fn a_short_control_outage_keeps_the_voice_session() {
    let Some(server) = server_or_skip().await else {
        return;
    };
    let Some(link_text) = server.link_for_new_user() else {
        return;
    };
    let link = InviteLink::parse(&link_text).expect("invite link");
    // The proxy sits between the client and the real server, so the test can
    // cut the control connection while the server stays up. Only the control
    // plane goes through it; media credentials still point at the server.
    let proxy = PausableProxy::start(link.hostname.clone(), link.port)
        .await
        .expect("start the proxy");
    let proxied = format!(
        "rostalk://join?host=127.0.0.1:{}&fp={}&invite={}",
        proxy.port,
        link.fingerprint_hex(),
        link.invite
    );

    let (core, recorder, _dir) = make_recorded_core();
    let state = core
        .connect(ConnectRequest {
            target: ConnectTarget::Link {
                link: proxied.clone(),
            },
            nickname: "alice".to_owned(),
            password: None,
            accept_new_certificate: false,
        })
        .await
        .expect("connect through the proxy");
    let channel = voice_channel(&state);
    core.join_channel(channel, None).await.expect("join");
    wait_until(&core, "the media credentials", |_state| {
        core.voice_credentials().is_some()
    })
    .await;
    let credentials_before = core.voice_credentials().expect("credentials");
    let snapshots_before = recorder.snapshots();
    let resets_before = recorder.resets();

    proxy.pause().await;
    // Long enough for the core to notice the dead connection and start its
    // first retry, which the paused proxy refuses.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    proxy.resume();

    let state = wait_until(&core, "a new snapshot after the outage", |_state| {
        recorder.snapshots() > snapshots_before
    })
    .await;
    assert_eq!(state.connection, ConnectionPhase::Connected);
    assert_eq!(
        recorder.resets(),
        resets_before,
        "a short outage must not reset the session"
    );
    // The hold in the core is 10 s; the reconnect above is much faster, so the
    // voice session must still be the same room and channel.
    let credentials = core.voice_credentials().expect("media survived the outage");
    assert_eq!(credentials.channel_id, channel);
    assert_eq!(credentials.room, credentials_before.room);
    core.disconnect().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN or ROSTALK_TEST_LINK plus ROSTALK_TEST_RESTART_CMD"]
async fn nickname_set_after_login_survives_a_restart() {
    let Some(mut server) = server_or_skip().await else {
        return;
    };
    if !server.can_restart() {
        eprintln!("skipping: this external server has no ROSTALK_TEST_RESTART_CMD");
        return;
    }
    let Some(link) = server.link_for_new_user() else {
        return;
    };
    let (core, recorder, _dir) = make_recorded_core();
    connect(&core, &link, "alice").await;
    core.set_nickname("alice2".to_owned())
        .await
        .expect("set nickname");
    wait_until(&core, "the nickname change", |state| {
        state.nickname == "alice2"
    })
    .await;

    let snapshots_before = recorder.snapshots();
    server.restart().await;
    wait_until(&core, "a new snapshot after the restart", |_state| {
        recorder.snapshots() > snapshots_before
    })
    .await;

    // The reconnect sends an empty nickname, so the server keeps the name
    // saved by SetNickname instead of reverting to the one from the first Hello.
    let state = wait_until(&core, "the nickname to survive the restart", |state| {
        state.connection == ConnectionPhase::Connected && state.nickname == "alice2"
    })
    .await;
    assert_eq!(state.nickname, "alice2");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN or ROSTALK_TEST_LINK plus ROSTALK_TEST_RESTART_CMD"]
async fn self_mute_survives_a_reconnect() {
    let Some(mut server) = server_or_skip().await else {
        return;
    };
    if !server.can_restart() {
        eprintln!("skipping: this external server has no ROSTALK_TEST_RESTART_CMD");
        return;
    }
    let Some(link) = server.link_for_new_user() else {
        return;
    };
    let (core, recorder, _dir) = make_recorded_core();
    connect(&core, &link, "alice").await;
    core.set_voice_state(rostalk_core::VoiceStatePatch {
        self_muted: Some(true),
        self_deafened: Some(false),
        away: None,
    })
    .await
    .expect("mute");
    wait_until(&core, "the server to show the mute", |state| {
        own_voice(state).is_some_and(|voice| voice.self_muted)
    })
    .await;
    assert!(core.voice_preferences().self_muted);

    // A new session starts from the server defaults; the client restores the
    // flags it saved in the profile (tech debt of stage 2.2).
    let snapshots_before = recorder.snapshots();
    server.restart().await;
    wait_until(&core, "a new snapshot after the restart", |_state| {
        recorder.snapshots() > snapshots_before
    })
    .await;
    wait_until(&core, "the mute to survive the reconnect", |state| {
        state.connection == ConnectionPhase::Connected
            && own_voice(state).is_some_and(|voice| voice.self_muted)
    })
    .await;
}

fn own_voice(state: &CoreState) -> Option<&rostalk_core::VoiceStateView> {
    state
        .users
        .iter()
        .find(|user| user.id == state.self_user_id)
        .map(|user| &user.voice)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN or ROSTALK_TEST_LINK plus ROSTALK_TEST_RESTART_CMD"]
async fn a_new_connect_forgets_the_previous_channel() {
    let Some(mut server) = server_or_skip().await else {
        return;
    };
    if !server.can_restart() {
        eprintln!("skipping: this external server has no ROSTALK_TEST_RESTART_CMD");
        return;
    }
    let Some(link) = server.link_for_new_user() else {
        return;
    };
    let (core, recorder, _dir) = make_recorded_core();
    let state = connect(&core, &link, "alice").await;
    let channel = voice_channel(&state);
    core.join_channel(channel, None).await.expect("join");
    wait_until(&core, "the user to be in the channel", |state| {
        state
            .users
            .iter()
            .any(|user| user.id == state.self_user_id && user.channel_id == channel)
    })
    .await;

    // A new Connect (as when switching servers) starts a new session. It must
    // drop the remembered channel even though the same server is used here.
    let state = connect(&core, &link, "alice").await;
    let own_channel = state
        .users
        .iter()
        .find(|user| user.id == state.self_user_id)
        .map_or(0, |user| user.channel_id);
    assert_eq!(own_channel, 0, "a new Connect starts outside of channels");

    let snapshots_before = recorder.snapshots();
    server.restart().await;
    wait_until(&core, "a new snapshot after the restart", |_state| {
        recorder.snapshots() > snapshots_before
    })
    .await;
    wait_until(&core, "the client to come back", |state| {
        state.connection == ConnectionPhase::Connected
            && state.users.iter().any(|user| user.id == state.self_user_id)
    })
    .await;
    // The re-join after an automatic reconnect would arrive immediately; give
    // it time and then require that it did not happen.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let state = core.state();
    let own_channel = state
        .users
        .iter()
        .find(|user| user.id == state.self_user_id)
        .map_or(0, |user| user.channel_id);
    assert_eq!(
        own_channel, 0,
        "the previous channel must not leak into a new connection"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN or ROSTALK_TEST_LINK plus ROSTALK_TEST_INVITE_CMD"]
async fn two_clients_see_each_other_move_between_channels() {
    let Some(server) = server_or_skip().await else {
        return;
    };
    let second_link = match server.another_invite() {
        Some(link) => link,
        None => {
            eprintln!("skipping: set ROSTALK_TEST_INVITE_CMD to create a second invite");
            return;
        }
    };

    let (alice, alice_events, _alice_dir) = make_recorded_core();
    let (bob, _bob_dir) = make_core();
    let Some(alice_link) = server.link_for_new_user() else {
        return;
    };
    let alice_state = connect(&alice, &alice_link, "alice").await;
    let bob_state = connect(&bob, &second_link, "bob").await;
    assert_ne!(alice_state.self_user_id, bob_state.self_user_id);

    let channels: Vec<u64> = alice_state.channels.iter().map(|c| c.id).collect();
    let first = voice_channel(&alice_state);
    let second = channels
        .iter()
        .copied()
        .find(|id| *id != first)
        .expect("a second channel");

    alice.join_channel(first, None).await.expect("alice joins");
    bob.join_channel(second, None).await.expect("bob joins");

    // Alice sees Bob appear in the second channel.
    wait_until(&alice, "alice to see bob", |state| {
        state
            .users
            .iter()
            .any(|user| user.nickname == "bob" && user.channel_id == second)
    })
    .await;
    // Bob sees Alice in the first one.
    wait_until(&bob, "bob to see alice", |state| {
        state
            .users
            .iter()
            .any(|user| user.nickname == "alice" && user.channel_id == first)
    })
    .await;

    // A move is a delta, not a new snapshot: Alice must follow it.
    let deltas_before = alice_events.deltas();
    let snapshots_before = alice_events.snapshots();
    bob.join_channel(first, None).await.expect("bob moves");
    wait_until(&alice, "alice to see bob move", |state| {
        state
            .users
            .iter()
            .any(|user| user.nickname == "bob" && user.channel_id == first)
    })
    .await;
    assert!(
        alice_events.deltas() > deltas_before,
        "the move must arrive as a delta"
    );
    assert_eq!(
        alice_events.snapshots(),
        snapshots_before,
        "a move must not trigger a fresh snapshot"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN or ROSTALK_TEST_LINK plus ROSTALK_TEST_INVITE_CMD"]
async fn a_moderator_move_gives_the_moved_client_voice_credentials() {
    use prost::Message as _;
    use rostalk_core::proto;

    let Some(server) = server_or_skip().await else {
        return;
    };

    let (alice, _alice_events, _alice_dir) = make_recorded_core();
    let (bob, _bob_dir) = make_core();
    // Alice goes first: on a spawned server the bootstrap invite makes her the
    // administrator who is allowed to move Bob.
    let Some(alice_link) = server.link_for_new_user() else {
        return;
    };
    let second_link = match server.another_invite() {
        Some(link) => link,
        None => {
            eprintln!("skipping: set ROSTALK_TEST_INVITE_CMD to create a second invite");
            return;
        }
    };
    let alice_state = connect(&alice, &alice_link, "alice").await;
    let bob_state = connect(&bob, &second_link, "bob").await;

    // Two distinct voice channels: the move target must support a media room.
    let voice: Vec<u64> = alice_state
        .channels
        .iter()
        .filter(|channel| channel.kind == rostalk_core::ChannelKindView::Voice)
        .map(|channel| channel.id)
        .collect();
    assert!(
        voice.len() >= 2,
        "the fixture server needs two voice channels"
    );
    let first = voice[0];
    let second = voice[1];

    bob.join_channel(second, None).await.expect("bob joins");
    wait_until(&bob, "bob to be in the channel", |state| {
        state
            .users
            .iter()
            .any(|user| user.id == state.self_user_id && user.channel_id == second)
    })
    .await;
    let before = bob
        .voice_credentials()
        .expect("bob has credentials before the move");
    assert_eq!(before.channel_id, second);

    // A moderator move changes the presence and removes the old media
    // participant, but issues no credentials of its own. The client must ask.
    let action = proto::AdminAction {
        action: Some(proto::admin_action::Action::MemberMove(proto::MemberMove {
            user_id: bob_state.self_user_id,
            channel_id: first,
        })),
    };
    alice
        .admin_action(action.encode_to_vec())
        .await
        .expect("alice moves bob");

    wait_until(&bob, "bob to be moved", |state| {
        state
            .users
            .iter()
            .any(|user| user.id == state.self_user_id && user.channel_id == first)
    })
    .await;

    let deadline = Instant::now() + SETTLE_TIMEOUT;
    let after = loop {
        if let Some(credentials) = bob.voice_credentials() {
            if credentials.channel_id == first {
                break credentials;
            }
        }
        if Instant::now() > deadline {
            panic!("bob received no voice credentials for the channel he was moved to");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(after.channel_id, first);
    assert_ne!(
        after.generation, before.generation,
        "a different room must start a new media generation"
    );
    assert_ne!(after.room, before.room);
}

// ---------------------------------------------------------------------------
// Direct login without an invite (ADR 0008)
// ---------------------------------------------------------------------------

const TEST_SERVER_PASSWORD: &str = "rostalk-test-password";

async fn password_server_or_skip() -> Option<TestServer> {
    match TestServer::password_server().await {
        Some(server) => Some(server),
        None => {
            eprintln!(
                "skipping: direct-login tests need ROSTALK_SERVER_BIN to start a password-login server"
            );
            None
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN (starts a password-login server)"]
async fn direct_login_with_the_right_password_needs_no_invite() {
    let Some(server) = password_server_or_skip().await else {
        return;
    };
    let link = InviteLink::parse(&server.link).expect("parse link");
    assert!(
        !link.invite.is_empty(),
        "the bootstrap invite is irrelevant here"
    );
    let (core, _dir) = make_core();
    let fingerprint = link.fingerprint_hex();

    let state = connect_direct(
        &core,
        &link,
        "alice",
        TEST_SERVER_PASSWORD,
        &fingerprint,
        false,
    )
    .await
    .expect("a direct login with the right password");

    assert_eq!(state.connection, ConnectionPhase::Connected);
    assert_eq!(state.nickname, "alice");
    assert_eq!(state.profile.nickname, "alice");
    let bookmark = state.servers.first().expect("a saved server");
    assert_eq!(bookmark.login, rostalk_core::BookmarkLogin::Direct);
    assert_eq!(bookmark.host, link.authority());
    assert_eq!(bookmark.fingerprint, fingerprint);
    assert_eq!(bookmark.nickname, "alice");
    assert!(!bookmark.link.contains(&link.invite));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN (starts a password-login server)"]
async fn direct_login_rejects_a_wrong_server_password() {
    let Some(server) = password_server_or_skip().await else {
        return;
    };
    let link = InviteLink::parse(&server.link).expect("parse link");
    let (core, _dir) = make_core();

    let error = connect_direct(
        &core,
        &link,
        "alice",
        "not-the-password",
        &link.fingerprint_hex(),
        false,
    )
    .await
    .expect_err("a wrong server password must be rejected");
    assert_eq!(error.code, CoreErrorCode::ServerError);
    assert_eq!(
        error.server_code,
        Some(rostalk_core::ServerErrorCode::WrongPassword)
    );
    assert_eq!(core.state().connection, ConnectionPhase::Disconnected);
    assert!(
        core.state().servers.is_empty(),
        "no bookmark on a failed login"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN (starts a password-login server)"]
async fn direct_login_rejects_a_foreign_fingerprint() {
    let Some(server) = password_server_or_skip().await else {
        return;
    };
    let link = InviteLink::parse(&server.link).expect("parse link");
    let (core, _dir) = make_core();

    let error = connect_direct(
        &core,
        &link,
        "alice",
        TEST_SERVER_PASSWORD,
        &"00".repeat(32),
        false,
    )
    .await
    .expect_err("a wrong fingerprint must be rejected");
    assert_eq!(error.code, CoreErrorCode::TlsFingerprintMismatch);
    assert_eq!(core.state().connection, ConnectionPhase::Disconnected);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN (starts a password-login server)"]
async fn a_changed_certificate_blocks_a_direct_login_until_confirmed() {
    let Some(server) = password_server_or_skip().await else {
        return;
    };
    let link = InviteLink::parse(&server.link).expect("parse link");
    let fingerprint = link.fingerprint_hex();
    let (core, _dir) = make_core();
    connect_direct(
        &core,
        &link,
        "alice",
        TEST_SERVER_PASSWORD,
        &fingerprint,
        false,
    )
    .await
    .expect("first direct login");

    // A different certificate for the same host is refused before anything is
    // sent: the saved fingerprint protects the user (ADR 0008).
    let error = connect_direct(
        &core,
        &link,
        "alice",
        TEST_SERVER_PASSWORD,
        &"11".repeat(32),
        false,
    )
    .await
    .expect_err("a changed certificate must be blocked");
    assert_eq!(error.code, CoreErrorCode::ServerCertificateChanged);
    // The saved bookmark still has the old certificate.
    assert_eq!(
        core.state()
            .servers
            .first()
            .map(|bookmark| bookmark.fingerprint.clone()),
        Some(fingerprint.clone())
    );

    // An explicit confirmation only allows replacing the saved fingerprint; it
    // never bypasses TLS. A digest that does not match the live certificate
    // still fails the handshake.
    let error = connect_direct(
        &core,
        &link,
        "alice",
        TEST_SERVER_PASSWORD,
        &"11".repeat(32),
        true,
    )
    .await
    .expect_err("TLS must still check the certificate");
    assert_eq!(error.code, CoreErrorCode::TlsFingerprintMismatch);

    // The real certificate still works.
    let state = connect_direct(
        &core,
        &link,
        "alice",
        TEST_SERVER_PASSWORD,
        &fingerprint,
        true,
    )
    .await
    .expect("the real certificate is accepted");
    assert_eq!(state.connection, ConnectionPhase::Connected);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN (starts a password-login server)"]
async fn a_nickname_change_survives_a_client_restart() {
    let Some(server) = password_server_or_skip().await else {
        return;
    };
    let link = InviteLink::parse(&server.link).expect("parse link");
    let fingerprint = link.fingerprint_hex();
    let dir = tempfile::tempdir().expect("temp dir");
    let vault = Arc::new(IdentityVault::new(
        "rostalk-integration",
        MemoryStore::new(),
    ));

    {
        let core = make_core_with(&vault, dir.path());
        connect_direct(
            &core,
            &link,
            "alice",
            TEST_SERVER_PASSWORD,
            &fingerprint,
            false,
        )
        .await
        .expect("direct login");
        core.set_nickname("alice2".to_owned())
            .await
            .expect("set nickname");
        wait_until(&core, "the nickname change", |state| {
            state.nickname == "alice2"
        })
        .await;
    }

    // A new core on the same data directory and keychain is an application
    // restart: the profile and the bookmark keep the nickname.
    let core = make_core_with(&vault, dir.path());
    let state = core.state();
    assert_eq!(state.profile.nickname, "alice2");
    assert_eq!(
        state
            .servers
            .first()
            .map(|bookmark| bookmark.nickname.clone()),
        Some("alice2".to_owned())
    );

    // Reconnecting without typing a nickname uses the saved one and does not
    // need the invite again.
    let state = connect_direct(&core, &link, "", TEST_SERVER_PASSWORD, &fingerprint, false)
        .await
        .expect("reconnect with the saved nickname");
    assert_eq!(state.nickname, "alice2");
}
