//! Audio pipeline and media-plane integration tests (stage 2.3).
//!
//! The `test-audio` feature replaces the microphone with a tone or a WAV file
//! and the speakers with a WAV recorder, so the pipeline runs on machines
//! without audio hardware.
//!
//! The live tests are `#[ignore]` because they need a running `rostalk-server`
//! and the `rostalkctl` bot binary:
//!
//! ```text
//! ROSTALK_SERVER_BIN=/path/to/rostalk-server \
//! ROSTALK_HCTL_BIN=/path/to/rostalkctl \
//!   cargo test -p rostalk-voice --features test-audio -- --ignored --test-threads=1
//! ```
//!
//! On Windows the server runs in Docker Desktop; pass the invitation and the
//! bot binary instead of `ROSTALK_SERVER_BIN`, as documented in the stage 2.2
//! integration test.

#![cfg(feature = "test-audio")]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rostalk_core::CoreHandle;
use rostalk_platform::{IdentityVault, MemoryStore};
use rostalk_voice::{
    GateMode, MediaCredentials, MediaPhase, MediaUpdate, NoiseModel, ProcessingSettings,
    TestAudioConfig, VoiceConfig, VoiceEvent, VoiceState,
};

/// Long enough for the connect cue and a few gated tone frames.
const SETTLE: Duration = Duration::from_secs(2);

/// The test microphone plays a pure 440 Hz tone. RNNoise removes steady tones
/// as noise, so these tests keep the pre-2.3.2e WebRTC suppressor (stage
/// 2.3.2e, ADR 0014).
fn tone_processing() -> ProcessingSettings {
    ProcessingSettings {
        noise_model: NoiseModel::WebRtc,
        ..ProcessingSettings::default()
    }
}

fn make_core() -> (CoreHandle, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let vault = IdentityVault::new("test", MemoryStore::new());
    let core = CoreHandle::new(Arc::new(vault), dir.path(), Arc::new(|_| {})).expect("core");
    (core, dir)
}

fn voice_config(output: &Path) -> VoiceConfig {
    VoiceConfig {
        processing: tone_processing(),
        test: Some(TestAudioConfig {
            tone_hz: Some(440.0),
            input_wav: None,
            output_wav: Some(output.to_path_buf()),
            ..TestAudioConfig::default()
        }),
        ..VoiceConfig::default()
    }
}

fn read_wav(path: &Path) -> Vec<f32> {
    let mut reader = hound::WavReader::open(path).expect("open recording");
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, 48_000);
    assert_eq!(spec.channels, 1);
    reader
        .samples::<i16>()
        .map(|sample| f32::from(sample.expect("sample")) / f32::from(i16::MAX))
        .collect()
}

/// Goertzel power of one frequency in the whole signal.
fn tone_power(samples: &[f32], frequency: f32) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let omega = std::f32::consts::TAU * frequency / 48_000.0;
    let (mut real, mut imag) = (0.0f32, 0.0f32);
    for (index, sample) in samples.iter().enumerate() {
        let phase = omega * index as f32;
        real += sample * phase.cos();
        imag += sample * phase.sin();
    }
    (real * real + imag * imag) / (samples.len() as f32).powi(2)
}

/// Root-mean-square amplitude of a window given in seconds.
fn rms_window(samples: &[f32], from: f32, to: f32) -> f32 {
    let start = (from * 48_000.0) as usize;
    let end = ((to * 48_000.0) as usize).min(samples.len());
    if start >= end {
        return 0.0;
    }
    let sum: f32 = samples[start..end]
        .iter()
        .map(|sample| sample * sample)
        .sum();
    (sum / (end - start) as f32).sqrt()
}

fn wait_for_file(path: &Path, minimum_bytes: u64) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if std::fs::metadata(path)
            .map(|meta| meta.len() > minimum_bytes)
            .unwrap_or(false)
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Capture → APM → loopback → recorder, without any server or hardware.
#[test]
fn mic_test_loops_the_tone_to_the_recorder() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = dir.path().join("loop.wav");
    let (events, _events_rx) = std::sync::mpsc::channel();
    let sink: Arc<dyn Fn(VoiceEvent) + Send + Sync> = Arc::new(move |event| {
        let _ = events.send(event);
    });
    let voice = rostalk_voice::start(voice_config(&output), sink).expect("voice engine");

    // The tone runs through APM and the gate; loopback mixes it into the
    // recorder even though no room is connected.
    voice.set_mic_test(true).expect("mic test");
    std::thread::sleep(SETTLE);
    wait_for_file(&output, 20_000);
    voice.shutdown();
    std::thread::sleep(Duration::from_millis(300));

    let samples = read_wav(&output);
    assert!(samples.len() > 24_000, "recording is too short");
    let tone = tone_power(&samples, 440.0);
    let noise = (tone_power(&samples, 300.0) + tone_power(&samples, 600.0)) / 2.0;
    assert!(
        tone > noise * 8.0,
        "the 440 Hz test tone is not audible: tone {tone}, noise {noise}"
    );
}

/// A muted microphone silences the mic-test loop as well.
///
/// The loop is what the user hears while checking the microphone; leaving it
/// running made "mute does not work" a reasonable reading of the stage 2.3
/// behaviour (stage 2.3.1). Cues are off so the recording contains only the
/// loop.
#[test]
fn self_mute_silences_the_microphone_loop() {
    use rostalk_voice::SoundSettings;

    let dir = tempfile::tempdir().expect("tempdir");
    let output = dir.path().join("muted-loop.wav");
    let (events, _events_rx) = std::sync::mpsc::channel();
    let sink: Arc<dyn Fn(VoiceEvent) + Send + Sync> = Arc::new(move |event| {
        let _ = events.send(event);
    });
    let config = VoiceConfig {
        processing: tone_processing(),
        test: Some(TestAudioConfig {
            tone_hz: Some(440.0),
            input_wav: None,
            output_wav: Some(output.clone()),
            ..TestAudioConfig::default()
        }),
        sounds: SoundSettings {
            enabled: false,
            volume: 0.0,
            ..SoundSettings::default()
        },
        ..VoiceConfig::default()
    };
    let voice = rostalk_voice::start(config, sink).expect("voice engine");

    const STEP: Duration = Duration::from_millis(1200);
    voice.set_mic_test(true).expect("mic test");
    std::thread::sleep(STEP);
    voice.set_self_muted(true).expect("mute");
    std::thread::sleep(STEP);
    voice.set_self_muted(false).expect("unmute");
    std::thread::sleep(STEP);
    voice.shutdown();
    std::thread::sleep(Duration::from_millis(300));

    let samples = read_wav(&output);
    let before = rms_window(&samples, 0.3, 1.0);
    let muted = rms_window(&samples, 1.6, 2.2);
    let after = rms_window(&samples, 2.7, 3.4);
    eprintln!("loop rms: before {before:.4}, muted {muted:.4}, after {after:.4}");
    assert!(before > 0.01, "the loop was silent before mute");
    assert!(
        muted < 0.002,
        "the loop kept playing while muted: rms {muted:.4}"
    );
    assert!(after > 0.01, "the loop did not return after unmute");
}

/// A released push-to-talk button silences the mic-test loop as well.
///
/// The loop follows the button: hearing yourself while PTT is released reads as
/// "the microphone is always on" (stage 2.3.1 feedback). Cues are off so the
/// recording contains only the loop.
#[test]
fn push_to_talk_silences_the_microphone_loop() {
    use rostalk_voice::SoundSettings;

    let dir = tempfile::tempdir().expect("tempdir");
    let output = dir.path().join("ptt-loop.wav");
    let (events, _events_rx) = std::sync::mpsc::channel();
    let sink: Arc<dyn Fn(VoiceEvent) + Send + Sync> = Arc::new(move |event| {
        let _ = events.send(event);
    });
    let config = VoiceConfig {
        gate: GateMode::PushToTalk,
        processing: tone_processing(),
        test: Some(TestAudioConfig {
            tone_hz: Some(440.0),
            input_wav: None,
            output_wav: Some(output.clone()),
            ..TestAudioConfig::default()
        }),
        sounds: SoundSettings {
            enabled: false,
            volume: 0.0,
            ..SoundSettings::default()
        },
        ..VoiceConfig::default()
    };
    let voice = rostalk_voice::start(config, sink).expect("voice engine");

    const STEP: Duration = Duration::from_millis(1200);
    voice.set_mic_test(true).expect("mic test");
    std::thread::sleep(STEP);
    voice.set_push_to_talk(true).expect("push-to-talk down");
    std::thread::sleep(STEP);
    voice.set_push_to_talk(false).expect("push-to-talk up");
    std::thread::sleep(STEP);
    voice.shutdown();
    std::thread::sleep(Duration::from_millis(300));

    let samples = read_wav(&output);
    let released = rms_window(&samples, 0.3, 1.0);
    let pressed = rms_window(&samples, 1.6, 2.2);
    let after = rms_window(&samples, 2.7, 3.4);
    eprintln!("ptt loop rms: released {released:.4}, pressed {pressed:.4}, after {after:.4}");
    assert!(
        released < 0.002,
        "the loop played while push-to-talk was released: rms {released:.4}"
    );
    assert!(
        pressed > 0.01,
        "the loop was silent while push-to-talk was held"
    );
    assert!(
        after < 0.002,
        "the loop kept playing after push-to-talk was released: rms {after:.4}"
    );
}

/// A held push-to-talk key survives an audio rebuild, and mic test with it.
///
/// The rebuild opens a fresh `SharedAudio`; restoring the button and the
/// mic-test loop from the engine state keeps the tract open while the key is
/// still held (stage P25 rework). Releasing afterwards must close it again.
#[test]
fn a_held_push_to_talk_key_and_mic_test_survive_an_audio_rebuild() {
    use rostalk_voice::SoundSettings;

    let dir = tempfile::tempdir().expect("tempdir");
    let output = dir.path().join("ptt-rebuild.wav");
    let (events, _events_rx) = std::sync::mpsc::channel();
    let sink: Arc<dyn Fn(VoiceEvent) + Send + Sync> = Arc::new(move |event| {
        let _ = events.send(event);
    });
    let config = VoiceConfig {
        gate: GateMode::PushToTalk,
        processing: tone_processing(),
        test: Some(TestAudioConfig {
            tone_hz: Some(440.0),
            input_wav: None,
            output_wav: Some(output.clone()),
            ..TestAudioConfig::default()
        }),
        sounds: SoundSettings {
            enabled: false,
            volume: 0.0,
            ..SoundSettings::default()
        },
        ..VoiceConfig::default()
    };
    let voice = rostalk_voice::start(config, sink).expect("voice engine");

    voice.set_mic_test(true).expect("mic test");
    voice.set_push_to_talk(true).expect("push-to-talk down");
    std::thread::sleep(Duration::from_millis(800));
    // A device change rebuilds the tract while the key is still held.
    voice
        .set_input_device(Some("test-rebuild".to_owned()))
        .expect("device change");
    std::thread::sleep(Duration::from_millis(1500));
    voice.set_push_to_talk(false).expect("push-to-talk up");
    std::thread::sleep(Duration::from_millis(800));
    voice.shutdown();
    std::thread::sleep(Duration::from_millis(300));

    // The new runtime opens the same recording path with `create`, so the file
    // now starts at the rebuild; its own timeline is what this test measures.
    let samples = read_wav(&output);
    let rebuilt = rms_window(&samples, 0.3, 1.2);
    let released = rms_window(&samples, 1.8, 2.2);
    eprintln!(
        "ptt rebuild rms: held after rebuild {rebuilt:.4}, released {released:.4} \
         ({} samples)",
        samples.len()
    );
    assert!(
        rebuilt > 0.01,
        "the rebuilt tract lost the held push-to-talk key and mic test: rms {rebuilt:.4}"
    );
    assert!(
        released < 0.002,
        "the loop kept playing after the release: rms {released:.4}"
    );
}

/// The engine starts in the state saved in the profile after a restart.
///
/// `create_voice` passes the stored flags into `VoiceConfig`; this test proves
/// the audio runtime really starts muted and deafened, and that the mic-test
/// loop does not leak sound in that state (tech debt of stage 2.2).
#[test]
fn the_engine_starts_muted_and_deafened_from_the_profile() {
    use rostalk_voice::SoundSettings;

    let dir = tempfile::tempdir().expect("tempdir");
    let output = dir.path().join("restart.wav");
    let (events, _events_rx) = std::sync::mpsc::channel();
    let sink: Arc<dyn Fn(VoiceEvent) + Send + Sync> = Arc::new(move |event| {
        let _ = events.send(event);
    });
    let config = VoiceConfig {
        self_muted: true,
        deafened: true,
        processing: tone_processing(),
        sounds: SoundSettings {
            enabled: false,
            volume: 0.0,
            ..SoundSettings::default()
        },
        test: Some(TestAudioConfig {
            tone_hz: Some(440.0),
            input_wav: None,
            output_wav: Some(output.clone()),
            ..TestAudioConfig::default()
        }),
        ..VoiceConfig::default()
    };
    let voice = rostalk_voice::start(config, sink).expect("voice engine");
    let state = voice.state();
    assert!(state.self_muted);
    assert!(state.deafened);

    voice.set_mic_test(true).expect("mic test");
    std::thread::sleep(Duration::from_millis(1200));
    voice.shutdown();
    std::thread::sleep(Duration::from_millis(300));

    let samples = read_wav(&output);
    let rms = rms_window(&samples, 0.3, 1.0);
    assert!(
        rms < 0.002,
        "a muted engine played the microphone loop after a restart: rms {rms:.4}"
    );
}

/// Voice state reaches the UI and starts idle.
#[test]
fn state_events_are_emitted_without_a_server() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = dir.path().join("state.wav");
    let (events, events_rx) = std::sync::mpsc::channel();
    let sink: Arc<dyn Fn(VoiceEvent) + Send + Sync> = Arc::new(move |event| {
        let _ = events.send(event);
    });
    let voice = rostalk_voice::start(voice_config(&output), sink).expect("voice engine");
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut state = None;
    while Instant::now() < deadline && state.is_none() {
        if let Ok(VoiceEvent::State(value)) = events_rx.recv_timeout(Duration::from_millis(200)) {
            state = Some(value);
        }
    }
    let state: VoiceState = state.expect("initial voice state");
    assert_eq!(state.media, MediaPhase::Idle);
    assert!(!state.publishing);
    voice.shutdown();
}

// ---------------------------------------------------------------------------
// Live tests: a real server, the real LiveKit room and the rostalkctl bot.
// ---------------------------------------------------------------------------

struct Server {
    link: String,
    binary: Option<PathBuf>,
    data_dir: Option<tempfile::TempDir>,
    listen: Option<String>,
    host: Option<String>,
    child: Option<std::process::Child>,
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Server {
    fn from_env() -> Option<Self> {
        if let Ok(binary) = std::env::var("ROSTALK_SERVER_BIN") {
            if !binary.is_empty() {
                let data_dir = tempfile::tempdir().expect("tempdir");
                let listen = format!("127.0.0.1:{}", free_port());
                let child = std::process::Command::new(&binary)
                    .arg("run")
                    .arg(format!("--data={}", data_dir.path().display()))
                    .arg(format!("--listen={listen}"))
                    .arg(format!("--public-host={listen}"))
                    .env("ROSTALK_ADVERTISE_IP", "127.0.0.1")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .expect("start rostalk-server");
                wait_for_port(&listen);
                let link = invite_with(Path::new(&binary), data_dir.path(), &listen, &listen);
                return Some(Self {
                    link,
                    binary: Some(PathBuf::from(binary)),
                    data_dir: Some(data_dir),
                    listen: Some(listen.clone()),
                    host: Some(listen),
                    child: Some(child),
                });
            }
        }
        let link = std::env::var("ROSTALK_TEST_LINK").ok()?;
        Some(Self {
            link,
            binary: None,
            data_dir: None,
            listen: None,
            host: None,
            child: None,
        })
    }

    fn new_invite(&self) -> Option<String> {
        if let Some(binary) = self.binary.as_ref() {
            return Some(invite_with(
                binary,
                self.data_dir.as_ref()?.path(),
                self.listen.as_ref()?,
                self.host.as_ref()?,
            ));
        }
        // External dev server (Docker Desktop on Windows): the command prints
        // a fresh invite link, as in the stage 2.2 integration test.
        let command = std::env::var("ROSTALK_TEST_INVITE_CMD")
            .ok()
            .filter(|value| !value.is_empty())?;
        let output = if cfg!(windows) {
            std::process::Command::new("powershell")
                .arg("-NoProfile")
                .arg("-Command")
                .arg(command)
                .output()
                .ok()?
        } else {
            std::process::Command::new("sh")
                .arg("-c")
                .arg(command)
                .output()
                .ok()?
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout
            .lines()
            .find(|line| line.trim_start().starts_with("rostalk://"))
            .map(|line| line.trim().to_owned())
    }
}

fn invite_with(binary: &Path, data: &Path, listen: &str, host: &str) -> String {
    let output = std::process::Command::new(binary)
        .arg("invite")
        .arg(format!("--data={}", data.display()))
        .arg(format!("--listen={listen}"))
        .arg(format!("--public-host={host}"))
        .output()
        .expect("run rostalk-server invite");
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find(|line| line.trim_start().starts_with("rostalk://"))
        .map(|line| line.trim().to_owned())
        .unwrap_or_else(|| {
            panic!(
                "rostalk-server invite printed no link; stdout: {stdout}\nstderr: {}",
                String::from_utf8_lossy(&output.stderr)
            )
        })
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .expect("free port")
}

fn wait_for_port(listen: &str) {
    let port: u16 = listen
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("server on {listen} did not start in time");
}

/// Forwards core credentials into the voice engine.
fn wire(core: &CoreHandle, voice: &rostalk_voice::VoiceHandle) {
    let voice = voice.clone();
    core.set_media_sink(Arc::new(move |credentials| {
        let update = match credentials {
            Some(credentials) => MediaUpdate::Available(MediaCredentials {
                url: credentials.url,
                room: credentials.room,
                token: credentials.token,
                participant_identity: credentials.participant_identity,
                channel_id: credentials.channel_id,
                expires_in_seconds: credentials.expires_in_seconds,
                generation: credentials.generation,
                bitrate_bps: credentials.bitrate_bps,
                stereo: credentials.stereo,
                processing_enabled: credentials.processing_enabled,
                tls_fingerprint: credentials.tls_fingerprint,
            }),
            None => MediaUpdate::Unavailable { channel_id: 0 },
        };
        let _ = voice.apply_media(update);
    }));
}

/// Prints every voice state event while waiting for the engine to publish.
fn wait_for_publish(events: &std::sync::mpsc::Receiver<VoiceEvent>, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        while let Ok(event) = events.try_recv() {
            if let VoiceEvent::State(state) = event {
                eprintln!(
                    "voice state: media={:?} publishing={} allowed={} channel={} error={:?}",
                    state.media,
                    state.publishing,
                    state.publish_allowed,
                    state.channel_id,
                    state.error
                );
                if state.publishing {
                    return;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("timed out waiting for the client to publish");
}

struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, _metadata: &log::Metadata<'_>) -> bool {
        true
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("[{}] {}", record.level(), record.args());
        }
    }

    fn flush(&self) {}
}

fn init_logging() {
    static LOGGER: StderrLogger = StderrLogger;
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Warn);
}

/// The bot tone is heard in the client recording and the client tone reaches
/// the bot (two independent directions).
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN and ROSTALK_HCTL_BIN"]
async fn bot_tone_is_recorded_and_client_tone_reaches_the_bot() {
    init_logging();
    let Some(server) = Server::from_env() else {
        eprintln!("skipping: no server");
        return;
    };
    let hctl = std::env::var("ROSTALK_HCTL_BIN").expect("ROSTALK_HCTL_BIN");
    let invite = server.new_invite().expect("second invite");

    let (core, _dir) = make_core();
    let dir = tempfile::tempdir().expect("tempdir");
    let output = dir.path().join("client.wav");
    let (events, events_rx) = std::sync::mpsc::channel();
    let sink: Arc<dyn Fn(VoiceEvent) + Send + Sync> = Arc::new(move |event| {
        let _ = events.send(event);
    });
    let voice = rostalk_voice::start(voice_config(&output), sink).expect("voice engine");
    wire(&core, &voice);

    let state = core
        .connect(rostalk_core::ConnectRequest {
            target: rostalk_core::ConnectTarget::Link {
                link: server.link.clone(),
            },
            nickname: "alice".to_owned(),
            password: None,
            accept_new_certificate: false,
        })
        .await
        .expect("connect");
    let channel = state
        .channels
        .iter()
        .find(|channel| channel.kind == rostalk_core::ChannelKindView::Voice)
        .expect("voice channel")
        .clone();
    core.join_channel(channel.id, None).await.expect("join");

    wait_for_publish(&events_rx, Duration::from_secs(30));

    // Bot on its own identity and invite; 660 Hz is easy to separate from the
    // client's 440 Hz.
    let bot_identity = dir.path().join("bot.key");
    let bot = std::process::Command::new(&hctl)
        .arg("bot")
        .arg(&invite)
        .arg("--channel")
        .arg(&channel.name)
        .arg("--tone")
        .arg("--freq")
        .arg("660")
        .arg("--duration")
        .arg("14s")
        .arg("--identity")
        .arg(&bot_identity)
        .arg("--nick")
        .arg("rostalk-bot")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("start rostalkctl bot");
    let bot_output = bot.wait_with_output().expect("bot output");
    let output_text = String::from_utf8_lossy(&bot_output.stdout).to_string();
    let error_text = String::from_utf8_lossy(&bot_output.stderr).to_string();
    if !bot_output.status.success() {
        eprintln!("bot exited with {}: {error_text}", bot_output.status);
    }
    let received: u64 = output_text
        .split("received:")
        .filter_map(|chunk| chunk.split('=').nth(1))
        .filter_map(|value| value.split(' ').next())
        .filter_map(|value| value.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    assert!(
        received > 20,
        "the bot received no audio from the client; status {:?}\nstdout:\n{output_text}\nstderr:\n{error_text}",
        bot_output.status
    );

    wait_for_file(&output, 40_000);
    voice.shutdown();
    std::thread::sleep(Duration::from_millis(300));
    let samples = read_wav(&output);
    let bot_tone = tone_power(&samples, 660.0);
    let neighbours = (tone_power(&samples, 620.0) + tone_power(&samples, 700.0)) / 2.0;
    assert!(
        bot_tone > neighbours * 6.0,
        "the bot tone is not in the client recording: {bot_tone} vs {neighbours}"
    );
    core.disconnect().await.ok();
}

/// Switches channels and fails if the media session ever goes idle first.
async fn switch_channel_and_wait(
    core: &CoreHandle,
    events: &std::sync::mpsc::Receiver<VoiceEvent>,
    channel_id: u64,
) {
    // Drop events from the previous channel; only the switch matters here.
    while events.try_recv().is_ok() {}
    core.join_channel(channel_id, None)
        .await
        .expect("switch channel");

    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        for event in events.try_iter() {
            if let VoiceEvent::State(state) = event {
                eprintln!(
                    "switch state: media={:?} publishing={} channel={} error={:?}",
                    state.media, state.publishing, state.channel_id, state.error
                );
                assert_ne!(
                    state.media,
                    MediaPhase::Idle,
                    "the old room was closed before the new one connected"
                );
                assert_ne!(
                    state.channel_id, 0,
                    "media was cleared before the new room connected"
                );
                if state.channel_id == channel_id && state.publishing {
                    return;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("did not publish in channel {channel_id} after the switch");
}

/// A channel switch connects to the new room before closing the old one.
///
/// Joining another channel makes the server broadcast `UserMoved` before it
/// sends the new `MediaCredentials`. The core must keep the old room alive for
/// that window; otherwise the client goes idle, disconnects and only then
/// connects again (stage 2.3, requirement 8).
///
/// A bot sits in the new channel: the state assertions alone would not catch a
/// switch that leaves the client unable to receive audio. The short gap itself
/// is expected, because the server removes the old media participant as soon as
/// it issues the new credentials (ADR 0009).
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN or ROSTALK_TEST_LINK and ROSTALK_HCTL_BIN"]
async fn switching_channels_keeps_media_until_the_new_room_is_up() {
    init_logging();
    let Some(server) = Server::from_env() else {
        eprintln!("skipping: no server");
        return;
    };
    let hctl = std::env::var("ROSTALK_HCTL_BIN").expect("ROSTALK_HCTL_BIN");
    let invite = server.new_invite().expect("second invite");
    let (core, _dir) = make_core();
    let dir = tempfile::tempdir().expect("tempdir");
    let output = dir.path().join("switch.wav");
    let (events, events_rx) = std::sync::mpsc::channel();
    let sink: Arc<dyn Fn(VoiceEvent) + Send + Sync> = Arc::new(move |event| {
        let _ = events.send(event);
    });
    let voice = rostalk_voice::start(voice_config(&output), sink).expect("voice engine");
    wire(&core, &voice);

    let state = core
        .connect(rostalk_core::ConnectRequest {
            target: rostalk_core::ConnectTarget::Link {
                link: server.link.clone(),
            },
            nickname: "alice".to_owned(),
            password: None,
            accept_new_certificate: false,
        })
        .await
        .expect("connect");
    let channels: Vec<_> = state
        .channels
        .iter()
        .filter(|channel| channel.kind == rostalk_core::ChannelKindView::Voice)
        .take(2)
        .cloned()
        .collect();
    assert!(
        channels.len() >= 2,
        "the server needs two voice channels, got {}",
        channels.len()
    );
    let first = channels[0].id;
    let second = channels[1].id;

    core.join_channel(first, None).await.expect("join first");
    wait_for_publish(&events_rx, Duration::from_secs(30));

    // The bot waits in the target channel before the switch.
    let _bot = BotProcess::spawn(&hctl, &invite, &channels[1].name, 880, "25s");

    switch_channel_and_wait(&core, &events_rx, second).await;
    // Give the subscription in the new room time to arrive.
    std::thread::sleep(Duration::from_secs(6));

    voice.shutdown();
    std::thread::sleep(Duration::from_millis(300));
    let samples = read_wav(&output);
    let tail = &samples[samples.len().saturating_sub(4 * 48_000)..];
    let bot_tone = tone_power(tail, 880.0);
    let neighbours = (tone_power(tail, 820.0) + tone_power(tail, 940.0)) / 2.0;
    assert!(
        bot_tone > neighbours * 4.0,
        "the client receives no audio after the channel switch: {bot_tone} vs {neighbours}"
    );
    core.disconnect().await.ok();
}

/// Renewal through `RequestMediaCredentials` must not reconnect the room or
/// drop the published track.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN; runs for about a minute"]
async fn token_renewal_does_not_interrupt_publication() {
    init_logging();
    let Some(server) = Server::from_env() else {
        eprintln!("skipping: no server");
        return;
    };
    let (core, _dir) = make_core();
    let dir = tempfile::tempdir().expect("tempdir");
    let output = dir.path().join("renew.wav");
    let (events, events_rx) = std::sync::mpsc::channel();
    let sink: Arc<dyn Fn(VoiceEvent) + Send + Sync> = Arc::new(move |event| {
        let _ = events.send(event);
    });
    let voice = rostalk_voice::start(voice_config(&output), sink).expect("voice engine");
    wire(&core, &voice);

    let state = core
        .connect(rostalk_core::ConnectRequest {
            target: rostalk_core::ConnectTarget::Link {
                link: server.link.clone(),
            },
            nickname: "alice".to_owned(),
            password: None,
            accept_new_certificate: false,
        })
        .await
        .expect("connect");
    let channel = state
        .channels
        .iter()
        .find(|channel| channel.kind == rostalk_core::ChannelKindView::Voice)
        .expect("voice channel")
        .clone();
    core.join_channel(channel.id, None).await.expect("join");

    wait_for_publish(&events_rx, Duration::from_secs(30));

    // The token lives 60 s and is renewed 15 s before expiry; wait past that
    // point and make sure the engine never reported a reconnect.
    let mut reconnects = 0;
    let deadline = Instant::now() + Duration::from_secs(55);
    while Instant::now() < deadline {
        for event in events_rx.try_iter() {
            if let VoiceEvent::State(state) = event {
                if state.media == MediaPhase::Reconnecting {
                    reconnects += 1;
                }
                assert!(state.publishing, "publication stopped during renewal");
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(reconnects, 0, "the room reconnected during token renewal");
    assert!(core.voice_credentials().is_some());
    voice.shutdown();
    core.disconnect().await.ok();
}

// ---------------------------------------------------------------------------
// Stage 2.3.1: a muted microphone silences the loop, stops the RTP stream and
// resumes on unmute; the same holds for a released push-to-talk key.
// ---------------------------------------------------------------------------

/// A `rostalkctl bot` child whose per-second packet counters are read line by
/// line. The bot publishes its own tone and counts every RTP packet it receives
/// from the client, which is exactly what mute and PTT must stop.
struct BotProcess {
    child: std::process::Child,
    lines: Receiver<String>,
    last: Option<u64>,
    identity_dir: tempfile::TempDir,
}

impl BotProcess {
    fn spawn(hctl: &str, invite: &str, channel: &str, frequency: u32, duration: &str) -> Self {
        let identity_dir = tempfile::tempdir().expect("bot identity dir");
        let mut child = std::process::Command::new(hctl)
            .arg("bot")
            .arg(invite)
            .arg("--channel")
            .arg(channel)
            .arg("--tone")
            .arg("--freq")
            .arg(frequency.to_string())
            .arg("--duration")
            .arg(duration)
            .arg("--identity")
            .arg(identity_dir.path().join("bot.key"))
            .arg("--nick")
            .arg("rostalk-bot")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("start rostalkctl bot");
        let stdout = child.stdout.take().expect("bot stdout");
        let (sender, lines) = mpsc::channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if sender.send(line).is_err() {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        Self {
            child,
            lines,
            last: None,
            identity_dir,
        }
    }

    /// Drains the printed lines and returns the highest packet counter seen.
    fn poll(&mut self) -> Option<u64> {
        while let Ok(line) = self.lines.try_recv() {
            if let Some(value) = received_packets(&line) {
                self.last = Some(self.last.map_or(value, |old| old.max(value)));
            }
        }
        self.last
    }

    fn wait_for(&mut self, ready: impl Fn(u64) -> bool, timeout: Duration) -> u64 {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(value) = self.poll() {
                if ready(value) {
                    return value;
                }
            }
            if Instant::now() >= deadline {
                panic!(
                    "the bot did not reach the expected counter in {timeout:?}; last {:?}",
                    self.last
                );
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

impl Drop for BotProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Keeps the identity directory alive until the process is gone.
        let _ = &self.identity_dir;
    }
}

/// Highest `received: ...=N packets` value in one bot statistics line.
fn received_packets(line: &str) -> Option<u64> {
    let tail = line.split("received:").nth(1)?;
    tail.split(['=', ' '])
        .filter_map(|part| part.parse::<u64>().ok())
        .max()
}

async fn connect_and_publish(
    core: &CoreHandle,
    link: &str,
    events: &Receiver<VoiceEvent>,
) -> rostalk_core::ChannelView {
    let state = core
        .connect(rostalk_core::ConnectRequest {
            target: rostalk_core::ConnectTarget::Link {
                link: link.to_owned(),
            },
            nickname: "alice".to_owned(),
            password: None,
            accept_new_certificate: false,
        })
        .await
        .expect("connect");
    let channel = state
        .channels
        .iter()
        .find(|channel| channel.kind == rostalk_core::ChannelKindView::Voice)
        .expect("voice channel")
        .clone();
    core.join_channel(channel.id, None).await.expect("join");
    wait_for_publish(events, Duration::from_secs(30));
    channel
}

/// Mute stops the packets the bot receives; unmute resumes them.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN or ROSTALK_TEST_LINK and ROSTALK_HCTL_BIN"]
async fn self_mute_stops_the_microphone_and_unmute_resumes() {
    init_logging();
    let Some(server) = Server::from_env() else {
        eprintln!("skipping: no server");
        return;
    };
    let hctl = std::env::var("ROSTALK_HCTL_BIN").expect("ROSTALK_HCTL_BIN");
    let invite = server.new_invite().expect("second invite");
    let (core, _dir) = make_core();
    let dir = tempfile::tempdir().expect("tempdir");
    let output = dir.path().join("mute.wav");
    let (events, events_rx) = std::sync::mpsc::channel();
    let sink: Arc<dyn Fn(VoiceEvent) + Send + Sync> = Arc::new(move |event| {
        let _ = events.send(event);
    });
    let voice = rostalk_voice::start(voice_config(&output), sink).expect("voice engine");
    wire(&core, &voice);
    let channel = connect_and_publish(&core, &server.link, &events_rx).await;

    let mut bot = BotProcess::spawn(&hctl, &invite, &channel.name, 660, "40s");
    let before = bot.wait_for(|value| value >= 10, Duration::from_secs(25));
    eprintln!("bot received {before} packets before mute");

    voice.set_self_muted(true).expect("mute");
    // The native source buffers up to a second; give it time to drain.
    std::thread::sleep(Duration::from_secs(3));
    let frozen = bot.poll().unwrap_or(before);
    std::thread::sleep(Duration::from_secs(3));
    let after = bot.poll().unwrap_or(frozen);
    assert!(
        after <= frozen,
        "the bot still received audio while muted: {frozen} then {after}"
    );
    eprintln!("muted: the counter stayed at {after}");

    voice.set_self_muted(false).expect("unmute");
    let resumed = bot.wait_for(|value| value > after, Duration::from_secs(20));
    eprintln!("unmuted: the bot received {resumed} packets");
    assert!(resumed > after);

    voice.shutdown();
    std::thread::sleep(Duration::from_millis(300));
    core.disconnect().await.ok();
}

/// A released push-to-talk key closes the gate and stops the packets; pressing
/// it again resumes them.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN or ROSTALK_TEST_LINK and ROSTALK_HCTL_BIN"]
async fn released_push_to_talk_stops_the_packets() {
    init_logging();
    let Some(server) = Server::from_env() else {
        eprintln!("skipping: no server");
        return;
    };
    let hctl = std::env::var("ROSTALK_HCTL_BIN").expect("ROSTALK_HCTL_BIN");
    let invite = server.new_invite().expect("second invite");
    let (core, _dir) = make_core();
    let dir = tempfile::tempdir().expect("tempdir");
    let output = dir.path().join("ptt.wav");
    let (events, events_rx) = std::sync::mpsc::channel();
    let sink: Arc<dyn Fn(VoiceEvent) + Send + Sync> = Arc::new(move |event| {
        let _ = events.send(event);
    });
    let voice = rostalk_voice::start(voice_config(&output), sink).expect("voice engine");
    wire(&core, &voice);
    let channel = connect_and_publish(&core, &server.link, &events_rx).await;

    // The publisher stops as soon as the gate is push-to-talk and the key is up
    // (the hook reports the real state; here the state is injected directly).
    voice.set_gate(GateMode::PushToTalk).expect("push to talk");
    std::thread::sleep(Duration::from_millis(500));

    let mut bot = BotProcess::spawn(&hctl, &invite, &channel.name, 660, "40s");
    voice.set_push_to_talk(true).expect("key down");
    let pressed = bot.wait_for(|value| value >= 10, Duration::from_secs(25));
    eprintln!("bot received {pressed} packets while the key was down");

    voice.set_push_to_talk(false).expect("key up");
    std::thread::sleep(Duration::from_secs(3));
    let frozen = bot.poll().unwrap_or(pressed);
    std::thread::sleep(Duration::from_secs(3));
    let after = bot.poll().unwrap_or(frozen);
    assert!(
        after <= frozen,
        "the bot still received audio after the key was released: {frozen} then {after}"
    );
    eprintln!("released: the counter stayed at {after}");

    voice.set_push_to_talk(true).expect("key down again");
    let resumed = bot.wait_for(|value| value > after, Duration::from_secs(20));
    assert!(resumed > after);

    let state = voice.state();
    assert_eq!(state.gate, GateMode::PushToTalk);
    assert!(!state.self_muted);

    voice.shutdown();
    std::thread::sleep(Duration::from_millis(300));
    core.disconnect().await.ok();
}
// ---------------------------------------------------------------------------
// Stage 2.3.1: a WAV bot instead of a plain tone, one minute of RTP statistics.
// ---------------------------------------------------------------------------

/// Path to the generated bot fixture, independent of the working directory.
fn bot_fixture() -> PathBuf {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../tools/rostalkctl/testdata/quality.wav");
    assert!(
        path.is_file(),
        "missing bot fixture {}, run `go run testdata/generate.go` in tools/rostalkctl",
        path.display()
    );
    path
}

/// The WAV bot is heard for a minute, and the inbound stream stays inside the
/// LAN budget: under 1 % packet loss and under 30 ms mean jitter.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ROSTALK_SERVER_BIN or ROSTALK_TEST_LINK and ROSTALK_HCTL_BIN; runs for about a minute"]
async fn wav_bot_is_heard_with_lan_quality() {
    init_logging();
    let Some(server) = Server::from_env() else {
        eprintln!("skipping: no server");
        return;
    };
    let hctl = std::env::var("ROSTALK_HCTL_BIN").expect("ROSTALK_HCTL_BIN");
    let invite = server.new_invite().expect("second invite");
    let fixture = bot_fixture();

    let (core, _dir) = make_core();
    let dir = tempfile::tempdir().expect("tempdir");
    let output = dir.path().join("wav-bot.wav");
    let (events, events_rx) = std::sync::mpsc::channel();
    let sink: Arc<dyn Fn(VoiceEvent) + Send + Sync> = Arc::new(move |event| {
        let _ = events.send(event);
    });
    // The client publishes its own 1 kHz tone; the bot plays the fixture.
    let voice = rostalk_voice::start(voice_config(&output), sink).expect("voice engine");
    wire(&core, &voice);

    let state = core
        .connect(rostalk_core::ConnectRequest {
            target: rostalk_core::ConnectTarget::Link {
                link: server.link.clone(),
            },
            nickname: "alice".to_owned(),
            password: None,
            accept_new_certificate: false,
        })
        .await
        .expect("connect");
    let channel = state
        .channels
        .iter()
        .find(|channel| channel.kind == rostalk_core::ChannelKindView::Voice)
        .expect("voice channel")
        .clone();
    core.join_channel(channel.id, None).await.expect("join");
    wait_for_publish(&events_rx, Duration::from_secs(30));

    let bot_identity = dir.path().join("bot.key");
    let bot = std::process::Command::new(&hctl)
        .arg("bot")
        .arg(&invite)
        .arg("--channel")
        .arg(&channel.name)
        .arg("--play")
        .arg(&fixture)
        .arg("--loop")
        .arg("--duration")
        .arg("62s")
        .arg("--identity")
        .arg(&bot_identity)
        .arg("--nick")
        .arg("rostalk-bot")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("start rostalkctl bot");

    let mut snapshots = 0u32;
    let mut worst_loss: f32 = 0.0;
    let mut worst_jitter: f32 = 0.0;
    let mut pipeline = rostalk_voice::stats::AudioCounters::default();
    let deadline = Instant::now() + Duration::from_secs(61);
    while Instant::now() < deadline {
        while let Ok(event) = events_rx.try_recv() {
            if let VoiceEvent::Stats(stats) = event {
                snapshots += 1;
                worst_loss = worst_loss.max(stats.packet_loss_percent.unwrap_or(0.0));
                worst_jitter = worst_jitter.max(stats.jitter_ms.unwrap_or(0.0));
                pipeline = stats.audio;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let output_bytes = bot.wait_with_output().expect("bot output");
    let stdout = String::from_utf8_lossy(&output_bytes.stdout);
    if !output_bytes.status.success() {
        eprintln!(
            "bot exited with {}: {}",
            output_bytes.status,
            String::from_utf8_lossy(&output_bytes.stderr)
        );
    }
    eprintln!(
        "wav bot: {snapshots} stats snapshots, worst loss {worst_loss:.3} %, worst jitter {worst_jitter:.1} ms, pipeline {pipeline:?}"
    );
    assert!(
        snapshots >= 30,
        "only {snapshots} statistics snapshots in a minute"
    );
    assert!(
        worst_loss < 1.0,
        "packet loss reached {worst_loss:.2} % (budget 1 %)"
    );
    assert!(
        worst_jitter < 30.0,
        "jitter reached {worst_jitter:.1} ms (budget 30 ms)"
    );

    voice.shutdown();
    std::thread::sleep(Duration::from_millis(300));
    let samples = read_wav(&output);
    // The 660 Hz carrier of the fixture must be present in the recording; the
    // 220/1320 Hz harmonics make the check less sensitive to PCMU rounding.
    let carrier = tone_power(&samples, 660.0);
    let neighbours = (tone_power(&samples, 600.0) + tone_power(&samples, 720.0)) / 2.0;
    assert!(
        carrier > neighbours * 6.0,
        "the WAV bot is not in the recording: {carrier} vs {neighbours}\nbot stdout:\n{stdout}"
    );
    core.disconnect().await.ok();
}
