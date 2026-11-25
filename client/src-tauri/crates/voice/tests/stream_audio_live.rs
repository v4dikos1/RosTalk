//! Stage P15 live check (ADR 0027): the stream audio goes through the core,
//! reaches the viewer, follows the tile volume and never carries RosTalk's own
//! sound.
//!
//! Two real client cores and voice engines run in this process against a real
//! server and LiveKit room:
//!
//! - **streamer**: test tone as the microphone (no acoustic loop), the real
//!   speakers as output, and the **real WASAPI process loopback** as the
//!   stream-audio source. Its speakers play the viewer's voice (660 Hz),
//!   exactly the "friends hear themselves" situation of playtest-1;
//! - **viewer**: 660 Hz test tone as the microphone, output recorded to WAV;
//! - **another process** plays a 1 kHz "game" tone, started by hand before the
//!   test (for example a 1 kHz WAV in PowerShell's `SoundPlayer`). It must not
//!   be a child of the test: the EXCLUDE mode drops the whole process tree of
//!   RosTalk, children included (that is what keeps WebView2 out), and a first
//!   version of this test that spawned the player itself captured silence.
//!
//! The viewer's recording must contain the 1 kHz game tone only while it
//! watches, at 150 % when asked, and never its own 660 Hz voice: the
//! streamer's core excludes its own process tree from the capture.
//!
//! It plays sound on the default output device. Windows only; run by hand:
//!
//! ```text
//! ROSTALK_TEST_INVITE_CMD="docker exec <container> rostalk-server admin invite create --role member --data=/data" \
//!   cargo test -p rostalk-voice --features test-audio --test stream_audio_live -- --ignored --nocapture
//! ```

#![cfg(all(feature = "test-audio", windows))]

use std::path::Path;
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rostalk_core::CoreHandle;
use rostalk_platform::{IdentityVault, MemoryStore};
use rostalk_voice::{
    MediaCredentials, MediaUpdate, NoiseModel, ProcessingSettings, TestAudioConfig, VoiceConfig,
    VoiceEvent, VoiceHandle,
};

const VOICE_HZ: f32 = 660.0;
const STREAMER_MIC_HZ: f32 = 440.0;
const GAME_HZ: f32 = 1_000.0;

fn invite() -> Option<String> {
    let command = std::env::var("ROSTALK_TEST_INVITE_CMD")
        .ok()
        .filter(|value| !value.is_empty())?;
    let output = std::process::Command::new("powershell")
        .arg("-NoProfile")
        .arg("-Command")
        .arg(command)
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|line| line.trim_start().starts_with("rostalk://"))
        .map(|line| line.trim().to_owned())
}

fn make_core() -> (CoreHandle, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let vault = IdentityVault::new("test", MemoryStore::new());
    let core = CoreHandle::new(Arc::new(vault), dir.path(), Arc::new(|_| {})).expect("core");
    (core, dir)
}

fn processing() -> ProcessingSettings {
    // Steady tones: the WebRTC suppressor (RNNoise removes tones as noise),
    // and no AGC so the levels stay comparable.
    ProcessingSettings {
        noise_model: NoiseModel::WebRtc,
        gain_control: false,
        ..ProcessingSettings::default()
    }
}

fn start_engine(mic_hz: f32, output: Option<&Path>) -> (VoiceHandle, Receiver<VoiceEvent>) {
    let (events, events_rx) = std::sync::mpsc::channel();
    let sink: Arc<dyn Fn(VoiceEvent) + Send + Sync> = Arc::new(move |event| {
        let _ = events.send(event);
    });
    let config = VoiceConfig {
        processing: processing(),
        test: Some(TestAudioConfig {
            tone_hz: Some(mic_hz),
            output_wav: output.map(Path::to_path_buf),
            // No stream tone: the streamer uses the real process loopback.
            ..TestAudioConfig::default()
        }),
        ..VoiceConfig::default()
    };
    let voice = rostalk_voice::start(config, sink).expect("voice engine");
    (voice, events_rx)
}

fn wire(core: &CoreHandle, voice: &VoiceHandle) {
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

fn wait_for_publish(events: &Receiver<VoiceEvent>) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        while let Ok(event) = events.try_recv() {
            if let VoiceEvent::State(state) = event {
                if state.publishing {
                    return;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("timed out waiting for the microphone to publish");
}

async fn join(core: &CoreHandle, link: &str, nickname: &str) -> u64 {
    let state = core
        .connect(rostalk_core::ConnectRequest {
            target: rostalk_core::ConnectTarget::Link {
                link: link.to_owned(),
            },
            nickname: nickname.to_owned(),
            password: None,
            accept_new_certificate: false,
        })
        .await
        .expect("connect");
    let channel = state
        .channels
        .iter()
        .find(|channel| {
            channel.kind == rostalk_core::ChannelKindView::Voice && !channel.name.contains("AFK")
        })
        .expect("voice channel")
        .clone();
    core.join_channel(channel.id, None).await.expect("join");
    core.state().self_user_id
}

fn read_wav(path: &Path) -> Vec<f32> {
    let mut reader = hound::WavReader::open(path).expect("open recording");
    reader
        .samples::<i16>()
        .map(|sample| f32::from(sample.expect("sample")) / f32::from(i16::MAX))
        .collect()
}

/// Goertzel power of one frequency in a window given in seconds.
fn power(samples: &[f32], from: f32, to: f32, frequency: f32) -> f64 {
    let start = (from * 48_000.0) as usize;
    let end = ((to * 48_000.0) as usize).min(samples.len());
    assert!(
        start < end,
        "window {from}..{to} s is outside the recording"
    );
    let omega = std::f64::consts::TAU * f64::from(frequency) / 48_000.0;
    let (mut real, mut imag) = (0.0f64, 0.0f64);
    for (index, sample) in samples[start..end].iter().enumerate() {
        let phase = omega * index as f64;
        real += f64::from(*sample) * phase.cos();
        imag += f64::from(*sample) * phase.sin();
    }
    (real * real + imag * imag) / ((end - start) as f64).powi(2)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "plays sound and needs ROSTALK_TEST_INVITE_CMD; Windows only"]
async fn stream_audio_reaches_the_viewer_without_rostalk_sounds() {
    let (Some(link_a), Some(link_b)) = (invite(), invite()) else {
        eprintln!("skipping: ROSTALK_TEST_INVITE_CMD is not set");
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let recording = dir.path().join("viewer.wav");

    let (streamer_core, _a) = make_core();
    let (streamer, streamer_events) = start_engine(STREAMER_MIC_HZ, None);
    wire(&streamer_core, &streamer);
    let (viewer_core, _b) = make_core();
    let (viewer, viewer_events) = start_engine(VOICE_HZ, Some(&recording));
    let started = Instant::now();
    wire(&viewer_core, &viewer);

    let streamer_id = join(&streamer_core, &link_a, "streamer").await;
    wait_for_publish(&streamer_events);
    join(&viewer_core, &link_b, "viewer").await;
    wait_for_publish(&viewer_events);
    let support = streamer.stream_audio_support();
    assert!(
        support.supported,
        "process loopback unavailable: {:?}",
        support.error
    );

    streamer
        .start_stream_audio()
        .await
        .expect("start the stream audio");
    tokio::time::sleep(Duration::from_secs(2)).await;

    let at = |instant: Instant| instant.duration_since(started).as_secs_f32();
    // Not watching: nothing of the stream is played.
    let idle = (at(Instant::now()), at(Instant::now()) + 2.0);
    tokio::time::sleep(Duration::from_secs(2)).await;

    viewer.watch_stream_audio(streamer_id, true).expect("watch");
    tokio::time::sleep(Duration::from_secs(3)).await;
    let watched = (at(Instant::now()), at(Instant::now()) + 3.0);
    tokio::time::sleep(Duration::from_secs(3)).await;
    let state = viewer.stream_audio_state();
    eprintln!("viewer stream audio state: {state:?}");

    viewer
        .set_stream_audio_volume(streamer_id, 1.5, false)
        .expect("volume");
    tokio::time::sleep(Duration::from_secs(1)).await;
    let loud = (at(Instant::now()), at(Instant::now()) + 3.0);
    tokio::time::sleep(Duration::from_secs(3)).await;

    viewer
        .watch_stream_audio(streamer_id, false)
        .expect("unwatch");
    tokio::time::sleep(Duration::from_secs(1)).await;
    let after = (at(Instant::now()), at(Instant::now()) + 2.0);
    tokio::time::sleep(Duration::from_secs(2)).await;

    let streamer_state = streamer.stream_audio_state();
    // Proof that the streamer's speakers really played the viewer's voice
    // during the run (the levels of the remote participant it mixed).
    let mut heard_viewer = f32::MIN;
    while let Ok(event) = streamer_events.try_recv() {
        if let VoiceEvent::Levels(levels) = event {
            for participant in levels.participants {
                heard_viewer = heard_viewer.max(participant.level_db);
            }
        }
    }
    streamer.stop_stream_audio().expect("stop");
    let ended = at(Instant::now());
    viewer.shutdown();
    streamer.shutdown();
    tokio::time::sleep(Duration::from_millis(500)).await;
    streamer_core.disconnect().await.ok();
    viewer_core.disconnect().await.ok();

    let samples = read_wav(&recording);
    // The recorder starts after the engine and runs on its own 10 ms pacer, so
    // the WAV time axis lags the wall clock by a roughly constant offset;
    // shift the windows by it and keep a margin away from every transition.
    let lag = (ended - samples.len() as f32 / 48_000.0).max(0.0);
    eprintln!("recording lags the wall clock by {lag:.2} s");
    let report = |name: &str, window: (f32, f32)| {
        let window = (window.0 - lag + 0.5, window.1 - lag - 0.5);
        let game = power(&samples, window.0, window.1, GAME_HZ);
        let own = power(&samples, window.0, window.1, VOICE_HZ);
        let mic = power(&samples, window.0, window.1, STREAMER_MIC_HZ);
        eprintln!(
            "{name:>8} {:5.1}-{:5.1} s: game 1 kHz {game:.3e}, own voice 660 Hz {own:.3e}, streamer mic 440 Hz {mic:.3e}",
            window.0, window.1
        );
        (game, own, mic)
    };
    // One-second profile of the game tone, to see the transitions.
    let seconds = samples.len() / 48_000;
    let profile: Vec<String> = (0..seconds)
        .map(|second| {
            let from = second as f32;
            format!(
                "{second}:{:.1e}",
                power(&samples, from, from + 1.0, GAME_HZ)
            )
        })
        .collect();
    eprintln!("game tone per second: {}", profile.join(" "));
    let (idle_game, _, idle_mic) = report("idle", idle);
    let (watched_game, watched_own, _) = report("watched", watched);
    let (loud_game, loud_own, _) = report("150 %", loud);
    let (after_game, _, _) = report("unwatch", after);
    eprintln!("streamer state: {streamer_state:?}; loudest remote voice it played: {heard_viewer:.1} dBFS");
    assert!(
        heard_viewer > -40.0,
        "the streamer did not play the viewer's voice, the exclusion was not exercised"
    );

    assert!(
        idle_mic > 1e-6,
        "the streamer's voice did not reach the viewer"
    );
    assert!(
        watched_game > idle_game * 100.0 && watched_game > 1e-5,
        "the game sound did not reach the viewer: idle {idle_game:e}, watched {watched_game:e}"
    );
    assert!(
        after_game < watched_game / 100.0,
        "the stream audio kept playing after unwatch: {after_game:e}"
    );
    let ratio = loud_game / watched_game;
    assert!(
        (1.6..3.0).contains(&ratio),
        "150 % gave a power ratio of {ratio:.2}, expected about 2.25"
    );
    // The viewer's own voice, played by the streamer's speakers, must not come
    // back through the stream.
    assert!(
        watched_own < watched_game / 1_000.0 && loud_own < loud_game / 1_000.0,
        "the viewer hears itself in the stream: own {watched_own:e} vs game {watched_game:e}"
    );
}
