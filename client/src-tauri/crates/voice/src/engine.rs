//! Voice engine: the media plane on top of the audio pipeline.
//!
//! The engine connects to the LiveKit room named in `MediaCredentials` from the
//! core, publishes one microphone track, subscribes to remote microphone
//! tracks, and reports state, levels and statistics to the UI.
//!
//! Design constraints (stage 2.3):
//! - the participant identity comes from the server; the engine never invents
//!   one;
//! - tokens are renewed by the core with `RequestMediaCredentials`; a renewal
//!   does not reconnect the room;
//! - a new channel is connected before the old room is closed, and the switch
//!   time is logged;
//! - `SetCanPublish(false)` stops publishing and is reported; the engine never
//!   works around it;
//! - after the control connection drops, the core clears the credentials and
//!   re-joins on reconnect, so the engine joins the room anew and republishes.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use livekit::options::{AudioEncoding, TrackPublishOptions};
use livekit::prelude::{
    LocalAudioTrack, LocalTrack, LocalTrackPublication, Room, RoomEvent, RoomOptions, TrackSid,
    TrackSource,
};
use livekit::rtc_engine::SessionStats;
use livekit::track::RemoteTrack;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::prelude::{AudioSourceOptions, RtcAudioSource};
use livekit::DisconnectReason;
use ringbuf::traits::{Consumer, Observer};
use ringbuf::HeapCons;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::devices::{self, AudioFormats, DeviceList};
use crate::error::VoiceError;
use crate::frame::{FRAME_SAMPLES, SAMPLE_RATE};
use crate::gate::GateMode;
use crate::loopback::{self, CaptureSource, StreamAudioSupport, StreamCapture, STREAM_CHANNELS};
use crate::mixer::{Mixer, TrackLevel, TrackPublisher};
use crate::pipeline::{
    AudioConfig, AudioRuntime, MixerUpdate, SharedAudio, StallWatch, StreamSide, TestAudioConfig,
};
use crate::processing::ProcessingSettings;
use crate::signalling::SignallingProxy;
use crate::sounds::{EventSound, SoundSettings};
use crate::stats::{AudioCounters, StatsCollector, VoiceStats};
use crate::stream_audio::{
    mixer_key, stream_publisher_loop, user_id_of, StreamAudioState, StreamCaptureState,
    STREAM_AUDIO_BITRATE,
};

/// How often levels are reported to the UI (at most ten times a second).
const LEVEL_INTERVAL: Duration = Duration::from_millis(100);
/// How often the connection statistics are refreshed.
const STATS_INTERVAL: Duration = Duration::from_secs(1);
/// How often the engine checks stream errors and publish permissions.
const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(500);
/// Device polling interval; cpal 0.18 has no device-changed callback.
const DEVICE_INTERVAL: Duration = Duration::from_secs(2);
/// Delay before retrying a failed room connection.
const MEDIA_RETRY_DELAY: Duration = Duration::from_secs(2);
/// Delay before retrying a failed local publication. A transient
/// `publish_track` error must not look like a server-side ban.
const PUBLISH_RETRY_DELAY: Duration = Duration::from_secs(2);
/// Delay before retrying an audio pipeline that failed to rebuild (a device
/// that was just plugged in or is still held by another application).
const AUDIO_RETRY_DELAY: Duration = Duration::from_secs(2);
/// Minimum time between whole-tract rebuilds caused by stream errors. A stream
/// that keeps failing must not reconnect the media session twice a second
/// (stage 2.3.2a.1).
const STREAM_ERROR_RETRY_DELAY: Duration = Duration::from_secs(2);
/// Upper bound of the exponential stream-error backoff.
const STREAM_ERROR_MAX_DELAY: Duration = Duration::from_secs(30);
/// A tract that ran this long without a new stream error forgets the backoff.
const STREAM_ERROR_STABLE_AFTER: Duration = Duration::from_secs(20);
/// Publisher poll while no track is published. A 3 ms timer in an idle client
/// woke the runtime 300 times a second for nothing; without a room there is no
/// latency to protect, and the next `Source` command drains any backlog anyway.
const IDLE_PUBLISH_POLL: Duration = Duration::from_millis(200);
/// At most this many stream errors are handled per heartbeat; a backend that
/// reports an error on every callback must not starve the engine loop.
const STREAM_ERRORS_PER_TICK: usize = 8;
/// How often the publisher picks up the frames the microphone produced
/// (stage 2.3.2b). The capture thread forwards whole frames as the device
/// delivers them; a 3 ms poll adds no audible latency.
const PUBLISH_POLL: Duration = Duration::from_millis(3);
/// The publish ring may lag the microphone by at most 200 ms. A longer backlog
/// means the task stalled; catching up would add permanent latency, so the ring
/// is cut down to [`PUBLISH_KEEP_BACKLOG`] and the event is counted.
const PUBLISH_MAX_BACKLOG: usize = FRAME_SAMPLES * 20;
/// Backlog kept after an emergency trim: two frames, enough for the next poll.
const PUBLISH_KEEP_BACKLOG: usize = FRAME_SAMPLES * 2;

/// Media credentials handed over by the core.
///
/// Deliberately has no `Debug` or serde implementation: the token and URL must
/// never reach a log or the UI.
#[derive(Clone)]
pub struct MediaCredentials {
    /// Media gateway URL, for example `wss://host:7443/rtc`.
    pub url: String,
    /// Room name, `channel-<id>`.
    pub room: String,
    /// Short-lived JWT issued by the server.
    pub token: String,
    /// Identity the token was issued for; never generated locally.
    pub participant_identity: String,
    /// Control-plane channel id.
    pub channel_id: u64,
    /// Token lifetime in seconds.
    pub expires_in_seconds: u32,
    /// Credential generation. A new generation means a new media session even
    /// when the room name is unchanged (for example after a control reconnect).
    pub generation: u64,
    /// Opus bitrate of the channel's voice profile.
    pub bitrate_bps: u64,
    /// Publish stereo (music profile).
    pub stereo: bool,
    /// Apply APM (voice profiles) or publish untouched audio (music).
    pub processing_enabled: bool,
    /// SHA-256 of the server's TLS leaf certificate, lowercase hex. Used by the
    /// local signalling proxy (ADR 0006).
    pub tls_fingerprint: String,
}

/// A credentials change coming from the core.
pub enum MediaUpdate {
    /// Join or renew.
    Available(MediaCredentials),
    /// Leave the room; the control connection ended or the channel changed.
    Unavailable {
        /// Channel that is no longer active.
        channel_id: u64,
    },
}

/// Phase of the media connection, shown next to the connection indicator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum MediaPhase {
    /// Not in a voice channel.
    Idle,
    /// Connecting to the room or waiting for credentials.
    Connecting,
    /// In the room.
    Connected,
    /// The room connection dropped; the engine is retrying.
    Reconnecting,
    /// The last attempt failed; see `error`.
    Failed,
}

/// Whether the global push-to-talk input registration is running.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum PttHookState {
    /// The shell has not reported yet; the UI shows the binding without a
    /// warning.
    #[default]
    Unknown,
    /// Raw Input is registered and delivers key or mouse events.
    Active,
    /// Installation failed; `PttStatus::error` explains why.
    Unavailable,
    /// This build has no global input (the desktop client ships for Windows).
    Unsupported,
}

/// Push-to-talk binding and input status shown in the UI.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PttStatus {
    /// Whether the global input registration works.
    pub hook: PttHookState,
    /// Human-readable binding, for example `X1/X2`.
    pub binding: String,
    /// Token-free installation error, when `hook` is `Unavailable`.
    pub error: Option<String>,
}

/// Voice engine state reported to the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoiceState {
    /// Media connection phase.
    pub media: MediaPhase,
    /// Microphone track is published.
    pub publishing: bool,
    /// Server permission allows publishing (design 4.4).
    pub publish_allowed: bool,
    /// Control-plane channel id, 0 when not in a voice channel.
    pub channel_id: u64,
    /// Own microphone is muted locally.
    pub self_muted: bool,
    /// All playback is muted locally.
    pub deafened: bool,
    /// Microphone loopback is running.
    pub mic_test: bool,
    /// Transmission gate.
    pub gate: GateMode,
    /// Push-to-talk binding and input status.
    pub push_to_talk: PttStatus,
    /// Opened input device id.
    pub input_device: Option<String>,
    /// Opened output device id.
    pub output_device: Option<String>,
    /// Token-free error text.
    pub error: Option<String>,
}

impl Default for VoiceState {
    fn default() -> Self {
        Self {
            media: MediaPhase::Idle,
            publishing: false,
            publish_allowed: false,
            channel_id: 0,
            self_muted: false,
            deafened: false,
            mic_test: false,
            gate: GateMode::default(),
            push_to_talk: PttStatus::default(),
            input_device: None,
            output_device: None,
            error: None,
        }
    }
}

/// Level of one remote participant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantLevel {
    /// Media identity from the server.
    pub identity: String,
    /// Smoothed level in dBFS.
    pub level_db: f32,
    /// True while the participant is speaking.
    pub speaking: bool,
}

/// Level meter snapshot; emitted at most ten times a second.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoiceLevels {
    /// Own microphone level in dBFS.
    pub self_level_db: f32,
    /// True while the own gate transmits.
    pub self_speaking: bool,
    /// Remote participants in the room.
    pub participants: Vec<ParticipantLevel>,
}

/// Everything the voice engine sends to the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum VoiceEvent {
    /// Engine state changed.
    State(VoiceState),
    /// Level meter snapshot.
    Levels(VoiceLevels),
    /// Connection statistics.
    Stats(VoiceStats),
    /// Device list changed (plugged or unplugged hardware).
    Devices(DeviceList),
    /// Stream audio changed: own capture, remote streams with audio (stage
    /// P15, ADR 0027).
    StreamAudio(StreamAudioState),
}

/// Configuration of the voice engine.
#[derive(Debug, Clone)]
pub struct VoiceConfig {
    pub input_device: Option<String>,
    pub output_device: Option<String>,
    pub processing: ProcessingSettings,
    pub gate: GateMode,
    pub self_muted: bool,
    pub deafened: bool,
    pub sounds: SoundSettings,
    /// Master playback gain, 0..200 %.
    pub output_volume: f32,
    /// Level the loudness of incoming voices (stage P17).
    pub level_voices: bool,
    /// Test backends; honoured only with the `test-audio` feature.
    pub test: Option<TestAudioConfig>,
}

impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            input_device: None,
            output_device: None,
            processing: ProcessingSettings::default(),
            gate: GateMode::default(),
            self_muted: false,
            deafened: false,
            sounds: SoundSettings::default(),
            output_volume: 1.0,
            level_voices: false,
            test: None,
        }
    }
}

/// Commands sent to the engine task.
enum Command {
    Credentials(MediaUpdate),
    SetInput(Option<String>),
    SetOutput(Option<String>),
    SetGate(GateMode),
    SetProcessing(ProcessingSettings),
    SetSelfMuted(bool),
    SetDeafened(bool),
    SetVolume {
        identity: String,
        volume: f32,
    },
    SetOutputVolume(f32),
    SetLevelVoices(bool),
    SetParticipantMuted {
        identity: String,
        muted: bool,
    },
    SetPushToTalk(bool),
    SetMicTest(bool),
    SetSounds(SoundSettings),
    PlaySound {
        sound: EventSound,
        preview: bool,
    },
    SetPttStatus(PttStatus),
    StartStreamAudio(oneshot::Sender<Result<(), VoiceError>>),
    StopStreamAudio,
    WatchStreamAudio {
        user_id: u64,
        watching: bool,
    },
    SetStreamAudioVolume {
        user_id: u64,
        volume: f32,
        muted: bool,
    },
    Shutdown,
}

/// Commands for the long-lived publisher task.
enum PublisherCommand {
    /// Start or stop feeding a published track.
    Source(Option<PublishedAudio>),
    /// Replace the ring and the counters after an audio restart.
    Consumer {
        consumer: HeapCons<i16>,
        shared: Arc<SharedAudio>,
    },
}

struct PublishedAudio {
    source: NativeAudioSource,
    channels: u32,
}

/// Cheap handle used by the IPC layer.
#[derive(Clone)]
pub struct VoiceHandle {
    commands: mpsc::UnboundedSender<Command>,
    state: Arc<RwLock<VoiceState>>,
    devices: Arc<RwLock<DeviceList>>,
    formats: Arc<RwLock<AudioFormats>>,
    stream_audio: Arc<RwLock<StreamAudioState>>,
    capture_source: CaptureSource,
}

impl VoiceHandle {
    /// Last known state, for a window that opens after the event.
    #[must_use]
    pub fn state(&self) -> VoiceState {
        self.state
            .read()
            .map(|state| state.clone())
            .unwrap_or_default()
    }

    /// Last known device list.
    #[must_use]
    pub fn devices(&self) -> DeviceList {
        self.devices
            .read()
            .map(|list| list.clone())
            .unwrap_or_default()
    }

    /// Formats the audio streams are running with (stage P5 diagnostics).
    #[must_use]
    pub fn formats(&self) -> AudioFormats {
        self.formats
            .read()
            .map(|formats| formats.clone())
            .unwrap_or_default()
    }

    /// Applies credentials from the core.
    pub fn apply_media(&self, update: MediaUpdate) -> Result<(), VoiceError> {
        self.send(Command::Credentials(update))
    }

    /// Selects an input device; `None` means the system default.
    pub fn set_input_device(&self, id: Option<String>) -> Result<(), VoiceError> {
        self.send(Command::SetInput(id))
    }

    /// Selects an output device; `None` means the system default.
    pub fn set_output_device(&self, id: Option<String>) -> Result<(), VoiceError> {
        self.send(Command::SetOutput(id))
    }

    /// Replaces the transmission gate.
    pub fn set_gate(&self, mode: GateMode) -> Result<(), VoiceError> {
        self.send(Command::SetGate(mode))
    }

    /// Replaces the APM stages.
    pub fn set_processing(&self, settings: ProcessingSettings) -> Result<(), VoiceError> {
        self.send(Command::SetProcessing(settings))
    }

    /// Mutes or unmutes the own microphone.
    pub fn set_self_muted(&self, muted: bool) -> Result<(), VoiceError> {
        self.send(Command::SetSelfMuted(muted))
    }

    /// Deafens or undeafens the whole playback.
    pub fn set_deafened(&self, deafened: bool) -> Result<(), VoiceError> {
        self.send(Command::SetDeafened(deafened))
    }

    /// Per-participant volume, clamped to 0..200 %.
    pub fn set_participant_volume(&self, identity: String, volume: f32) -> Result<(), VoiceError> {
        self.send(Command::SetVolume { identity, volume })
    }

    /// Master playback volume, clamped to 0..200 %.
    pub fn set_output_volume(&self, volume: f32) -> Result<(), VoiceError> {
        self.send(Command::SetOutputVolume(volume))
    }

    /// Levels the loudness of incoming voices (stage P17), live.
    pub fn set_level_voices(&self, enabled: bool) -> Result<(), VoiceError> {
        self.send(Command::SetLevelVoices(enabled))
    }

    /// Local mute of one participant.
    pub fn set_participant_muted(&self, identity: String, muted: bool) -> Result<(), VoiceError> {
        self.send(Command::SetParticipantMuted { identity, muted })
    }

    /// Push-to-talk key or mouse button state from `rostalk-platform`.
    pub fn set_push_to_talk(&self, active: bool) -> Result<(), VoiceError> {
        self.send(Command::SetPushToTalk(active))
    }

    /// Starts or stops the microphone loopback (mic test).
    pub fn set_mic_test(&self, enabled: bool) -> Result<(), VoiceError> {
        self.send(Command::SetMicTest(enabled))
    }

    /// Replaces the event cue settings.
    pub fn set_sounds(&self, settings: SoundSettings) -> Result<(), VoiceError> {
        self.send(Command::SetSounds(settings))
    }

    /// Plays one event cue (used by UI-originated events such as streams).
    pub fn play_sound(&self, sound: EventSound) -> Result<(), VoiceError> {
        self.send(Command::PlaySound {
            sound,
            preview: false,
        })
    }

    /// Plays one cue for the settings window, ignoring the switches.
    pub fn preview_sound(&self, sound: EventSound) -> Result<(), VoiceError> {
        self.send(Command::PlaySound {
            sound,
            preview: true,
        })
    }

    /// Reports the push-to-talk binding and whether its input is running.
    pub fn set_ptt_status(&self, status: PttStatus) -> Result<(), VoiceError> {
        self.send(Command::SetPttStatus(status))
    }

    /// Last known stream-audio state.
    #[must_use]
    pub fn stream_audio_state(&self) -> StreamAudioState {
        self.stream_audio
            .read()
            .map(|state| state.clone())
            .unwrap_or_default()
    }

    /// Whether the computer audio can be captured without RosTalk's own sound
    /// (a process-loopback probe). Blocks for the activation; call it off the
    /// UI thread.
    #[must_use]
    pub fn stream_audio_support(&self) -> StreamAudioSupport {
        loopback::probe(self.capture_source)
    }

    /// Starts capturing the computer audio and publishes it as the
    /// `screen_share_audio` track of the voice participant. Fails when not in
    /// a voice channel, without the stream right or when the capture cannot
    /// start; the UI then falls back to the WebView capture.
    pub async fn start_stream_audio(&self) -> Result<(), VoiceError> {
        let (reply, result) = oneshot::channel();
        self.send(Command::StartStreamAudio(reply))?;
        result.await.map_err(|_| VoiceError::NotRunning)?
    }

    /// Stops the own stream-audio capture.
    pub fn stop_stream_audio(&self) -> Result<(), VoiceError> {
        self.send(Command::StopStreamAudio)
    }

    /// Plays or stops the stream audio of one user.
    pub fn watch_stream_audio(&self, user_id: u64, watching: bool) -> Result<(), VoiceError> {
        self.send(Command::WatchStreamAudio { user_id, watching })
    }

    /// Playback gain 0..2 (0..200 %) and local mute of one user's stream audio.
    pub fn set_stream_audio_volume(
        &self,
        user_id: u64,
        volume: f32,
        muted: bool,
    ) -> Result<(), VoiceError> {
        self.send(Command::SetStreamAudioVolume {
            user_id,
            volume,
            muted,
        })
    }

    /// Stops the engine and releases the audio devices.
    pub fn shutdown(&self) {
        let _ = self.commands.send(Command::Shutdown);
    }

    fn send(&self, command: Command) -> Result<(), VoiceError> {
        self.commands
            .send(command)
            .map_err(|_| VoiceError::NotRunning)
    }
}

/// Starts the voice engine on its own runtime thread.
///
/// The audio devices are opened before this returns; `sink` receives state,
/// levels, statistics and device changes.
pub fn start(
    config: VoiceConfig,
    sink: Arc<dyn Fn(VoiceEvent) + Send + Sync>,
) -> Result<VoiceHandle, VoiceError> {
    let audio_config = audio_config(&config, config.processing);
    let audio = AudioRuntime::start(&audio_config)?;
    let shared = audio.shared();
    let devices = devices::list_devices();
    let state = Arc::new(RwLock::new(VoiceState {
        self_muted: config.self_muted,
        deafened: config.deafened,
        gate: config.gate,
        input_device: audio.capture_device().map(str::to_owned),
        output_device: audio.playback_device().map(str::to_owned),
        ..VoiceState::default()
    }));
    let device_list = Arc::new(RwLock::new(devices.clone()));
    let formats = Arc::new(RwLock::new(audio_formats(&audio)));

    let (commands, command_rx) = mpsc::unbounded_channel();
    let (device_tx, device_rx) = mpsc::unbounded_channel();
    spawn_device_watcher(device_tx);
    let capture_source = capture_source(&config);
    let stream_audio = Arc::new(RwLock::new(StreamAudioState::default()));

    let handle = VoiceHandle {
        commands,
        state: state.clone(),
        devices: device_list.clone(),
        formats: formats.clone(),
        stream_audio: stream_audio.clone(),
        capture_source,
    };

    let engine = Engine {
        config,
        sink,
        audio: Some(audio),
        shared,
        devices,
        state,
        device_list,
        formats,
        commands: command_rx,
        device_events: device_rx,
        credentials: None,
        session: None,
        room_events: None,
        tracks: HashMap::new(),
        volumes: HashMap::new(),
        mutes: HashSet::new(),
        publisher: None,
        stats: StatsCollector::default(),
        last_counters: AudioCounters::default(),
        reconnect_at: None,
        publish_retry_at: None,
        audio_retry_at: None,
        stream_error_policy: StreamErrorPolicy::default(),
        last_error: None,
        capture_source,
        stream_audio,
        stream_wanted: None,
        stream_publication: None,
        stream_error: None,
        stream_watch: HashSet::new(),
        stream_gains: HashMap::new(),
        stream_tracks: HashMap::new(),
        connection_lost: false,
        last_ptt_down: false,
    };

    let spawned = std::thread::Builder::new()
        .name("rostalk-voice".to_owned())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    log::error!("could not start the voice runtime: {error}");
                    return;
                }
            };
            runtime.block_on(engine.run());
        })
        .map_err(|error| VoiceError::Internal(format!("start voice thread: {error}")))?;
    // The thread owns the engine; it stops when the command sender is dropped
    // or `shutdown` is called.
    drop(spawned);

    Ok(handle)
}

/// Where the stream audio comes from: the process loopback, or a tone in the
/// `test-audio` build when the test configuration asks for one.
fn capture_source(config: &VoiceConfig) -> CaptureSource {
    #[cfg(feature = "test-audio")]
    if let Some(frequency) = config.test.as_ref().and_then(|test| test.stream_tone_hz) {
        return CaptureSource::Tone(frequency);
    }
    let _ = config;
    CaptureSource::System
}

/// Formats the running streams were opened with, for the diagnostics export.
fn audio_formats(audio: &AudioRuntime) -> AudioFormats {
    AudioFormats {
        input: audio.capture_format().cloned(),
        output: audio.playback_format().cloned(),
    }
}

fn audio_config(config: &VoiceConfig, processing: ProcessingSettings) -> AudioConfig {
    AudioConfig {
        input_device: config.input_device.clone(),
        output_device: config.output_device.clone(),
        processing,
        gate: config.gate,
        self_muted: config.self_muted,
        deafened: config.deafened,
        mic_test: false,
        sounds: config.sounds,
        output_volume: config.output_volume,
        level_voices: config.level_voices,
        test: config.test.clone(),
    }
}

fn spawn_device_watcher(sender: mpsc::UnboundedSender<DeviceList>) {
    let _ = std::thread::Builder::new()
        .name("rostalk-device-watch".to_owned())
        .spawn(move || {
            let mut previous = devices::list_devices();
            loop {
                std::thread::sleep(DEVICE_INTERVAL);
                let current = devices::list_devices();
                if current != previous {
                    previous = current.clone();
                    if sender.send(current).is_err() {
                        return;
                    }
                }
            }
        });
}

struct Session {
    room: Arc<Room>,
    /// Loopback signalling proxy with certificate pinning (ADR 0006).
    _proxy: SignallingProxy,
    generation: u64,
    channel_id: u64,
    identity: String,
    publication: Option<TrackSid>,
    /// The publication itself, so mute and push-to-talk can stop the sender.
    track: Option<LocalTrackPublication>,
    stereo: bool,
    bitrate_bps: u64,
    processing_enabled: bool,
}

struct TrackEntry {
    level: Arc<TrackLevel>,
    task: JoinHandle<()>,
}

/// The own stream audio while it is published (stage P15).
struct StreamPublication {
    capture: StreamCapture,
    task: JoinHandle<()>,
    sid: TrackSid,
}

/// A subscribed remote stream-audio track.
struct StreamTrack {
    user_id: u64,
    task: JoinHandle<()>,
}

struct Engine {
    config: VoiceConfig,
    sink: Arc<dyn Fn(VoiceEvent) + Send + Sync>,
    audio: Option<AudioRuntime>,
    shared: Arc<SharedAudio>,
    devices: DeviceList,
    state: Arc<RwLock<VoiceState>>,
    device_list: Arc<RwLock<DeviceList>>,
    formats: Arc<RwLock<AudioFormats>>,
    commands: mpsc::UnboundedReceiver<Command>,
    device_events: mpsc::UnboundedReceiver<DeviceList>,
    credentials: Option<MediaCredentials>,
    session: Option<Session>,
    room_events: Option<mpsc::UnboundedReceiver<RoomEvent>>,
    tracks: HashMap<String, TrackEntry>,
    volumes: HashMap<String, f32>,
    mutes: HashSet<String>,
    publisher: Option<mpsc::UnboundedSender<PublisherCommand>>,
    stats: StatsCollector,
    /// Last counters reported, for logging only changes.
    last_counters: AudioCounters,
    reconnect_at: Option<Instant>,
    /// Earliest retry of a failed local publication.
    publish_retry_at: Option<Instant>,
    /// Earliest retry of a failed audio-pipeline rebuild.
    audio_retry_at: Option<Instant>,
    /// Rate limit and backoff for rebuilds caused by cpal stream errors.
    stream_error_policy: StreamErrorPolicy,
    last_error: Option<String>,
    /// Source of the own stream audio.
    capture_source: CaptureSource,
    /// Last stream-audio state, read by the IPC getter.
    stream_audio: Arc<RwLock<StreamAudioState>>,
    /// Channel the UI asked to capture the stream audio in. It survives a
    /// reconnect of the same room and is cleared by a channel change.
    stream_wanted: Option<u64>,
    stream_publication: Option<StreamPublication>,
    stream_error: Option<String>,
    /// Users whose stream audio the UI watches.
    stream_watch: HashSet<u64>,
    /// Per-user stream gain 0..2 and local mute.
    stream_gains: HashMap<u64, (f32, bool)>,
    /// Subscribed remote stream-audio tracks by publisher identity.
    stream_tracks: HashMap<String, StreamTrack>,
    /// The media connection dropped and has not been restored yet.
    connection_lost: bool,
    /// Last push-to-talk state, to sound the edge once (Raw Input repeats).
    last_ptt_down: bool,
}

impl Engine {
    async fn run(mut self) {
        self.start_publisher();
        self.apply_volumes();
        self.emit_state();
        self.sink(VoiceEvent::Devices(self.devices.clone()));
        self.sink(VoiceEvent::Stats(self.stats.last()));

        let mut levels = tokio::time::interval(LEVEL_INTERVAL);
        levels.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut stats = tokio::time::interval(STATS_INTERVAL);
        stats.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                command = self.commands.recv() => {
                    match command {
                        None => break,
                        Some(Command::Shutdown) => break,
                        Some(command) => self.handle_command(command).await,
                    }
                }
                event = next_room_event(&mut self.room_events) => {
                    match event {
                        Some(event) => self.handle_room_event(event).await,
                        None => {
                            if self.room_events.is_some() {
                                self.handle_room_lost().await;
                            }
                        }
                    }
                }
                Some(list) = self.device_events.recv() => self.handle_devices(list).await,
                _ = levels.tick() => self.emit_levels(),
                _ = stats.tick() => self.emit_stats().await,
                _ = heartbeat.tick() => self.heartbeat().await,
            }
        }

        self.stream_wanted = None;
        self.close_session(DisconnectReason::ClientInitiated).await;
        if let Some(sender) = &self.publisher {
            let _ = sender.send(PublisherCommand::Source(None));
        }
        self.publisher = None;
        if let Some(audio) = self.audio.take() {
            audio.stop();
        }
    }

    fn emit_state(&self) {
        let state = self.state();
        if let Ok(mut guard) = self.state.write() {
            *guard = state.clone();
        }
        self.sink(VoiceEvent::State(state));
    }

    fn state(&self) -> VoiceState {
        let audio = self.audio.as_ref();
        VoiceState {
            media: self
                .state
                .read()
                .map(|s| s.media)
                .unwrap_or(MediaPhase::Idle),
            publishing: self.state.read().map(|s| s.publishing).unwrap_or(false),
            publish_allowed: self
                .state
                .read()
                .map(|s| s.publish_allowed)
                .unwrap_or(false),
            channel_id: self.session.as_ref().map_or(0, |s| s.channel_id),
            self_muted: self.shared.self_muted(),
            deafened: self.shared.deafened(),
            mic_test: self.shared.mic_test(),
            gate: self.state.read().map(|s| s.gate).unwrap_or_default(),
            push_to_talk: self
                .state
                .read()
                .map(|s| s.push_to_talk.clone())
                .unwrap_or_default(),
            input_device: audio
                .and_then(|a| a.capture_device().map(str::to_owned))
                .or_else(|| self.config.input_device.clone()),
            output_device: audio
                .and_then(|a| a.playback_device().map(str::to_owned))
                .or_else(|| self.config.output_device.clone()),
            error: self.last_error.clone(),
        }
    }

    fn mutate_state(&mut self, update: impl FnOnce(&mut VoiceState)) {
        if let Ok(mut guard) = self.state.write() {
            update(&mut guard);
            guard.error = self.last_error.clone();
        }
        self.emit_state();
    }

    fn start_publisher(&mut self) {
        let Some(audio) = self.audio.as_mut() else {
            return;
        };
        let Some(consumer) = audio.take_publish_consumer() else {
            return;
        };
        if let Some(sender) = &self.publisher {
            // The publisher task survives an audio restart; only the ring and
            // the shared counters are replaced.
            let _ = sender.send(PublisherCommand::Consumer {
                consumer,
                shared: self.shared.clone(),
            });
            return;
        }
        let (sender, receiver) = mpsc::unbounded_channel();
        tokio::spawn(publisher_loop(receiver, consumer, self.shared.clone()));
        self.publisher = Some(sender);
    }

    fn apply_volumes(&self) {
        if let Some(audio) = &self.audio {
            for (identity, volume) in &self.volumes {
                audio.update(MixerUpdate::Volume {
                    identity: identity.clone(),
                    volume: *volume,
                });
            }
            for identity in &self.mutes {
                audio.update(MixerUpdate::Muted {
                    identity: identity.clone(),
                    muted: true,
                });
            }
        }
    }

    /// Re-applies the stored volume and local mute to a freshly subscribed
    /// track. `Mixer::insert_track` starts every track at 100 % / unmuted, and
    /// a channel switch or reconnect subscribes the same participants again.
    fn apply_track_settings(&self, identity: &str) {
        let (volume, muted) = replay_settings(&self.volumes, &self.mutes, identity);
        if let Some(volume) = volume {
            self.update_audio(MixerUpdate::Volume {
                identity: identity.to_owned(),
                volume,
            });
        }
        if muted {
            self.update_audio(MixerUpdate::Muted {
                identity: identity.to_owned(),
                muted: true,
            });
        }
    }

    async fn handle_command(&mut self, command: Command) {
        match command {
            Command::Shutdown => {}
            Command::Credentials(update) => self.apply_credentials(update).await,
            Command::SetInput(id) => {
                if self.config.input_device != id {
                    self.config.input_device = id;
                    self.restart_audio().await;
                }
            }
            Command::SetOutput(id) => {
                if self.config.output_device != id {
                    self.config.output_device = id;
                    self.restart_audio().await;
                }
            }
            Command::SetGate(mode) => {
                self.config.gate = mode;
                self.shared.set_gate_mode(mode);
                self.apply_publish_mute();
                self.mutate_state(|state| state.gate = mode);
            }
            Command::SetProcessing(settings) => {
                self.config.processing = settings;
                if let Some(audio) = &self.audio {
                    audio.set_processing(self.effective_processing());
                }
            }
            Command::SetSelfMuted(muted) => {
                let changed = self.shared.self_muted() != muted;
                self.shared.set_self_muted(muted);
                self.apply_publish_mute();
                if changed {
                    self.play_sound(if muted {
                        EventSound::MicOff
                    } else {
                        EventSound::MicOn
                    });
                }
                self.mutate_state(|state| state.self_muted = muted);
            }
            Command::SetDeafened(deafened) => {
                let changed = self.shared.deafened() != deafened;
                self.shared.set_deafened(deafened);
                if changed {
                    self.play_sound(if deafened {
                        EventSound::SoundOff
                    } else {
                        EventSound::SoundOn
                    });
                }
                self.mutate_state(|state| state.deafened = deafened);
            }
            Command::SetVolume { identity, volume } => {
                let volume = volume.clamp(0.0, 2.0);
                self.volumes.insert(identity.clone(), volume);
                self.update_audio(MixerUpdate::Volume { identity, volume });
            }
            Command::SetOutputVolume(volume) => {
                let volume = volume.clamp(0.0, 2.0);
                self.config.output_volume = volume;
                self.update_audio(MixerUpdate::MasterVolume(volume));
            }
            Command::SetLevelVoices(enabled) => {
                self.config.level_voices = enabled;
                self.update_audio(MixerUpdate::Leveling(enabled));
            }
            Command::SetParticipantMuted { identity, muted } => {
                if muted {
                    self.mutes.insert(identity.clone());
                } else {
                    self.mutes.remove(&identity);
                }
                self.update_audio(MixerUpdate::Muted { identity, muted });
            }
            Command::SetPushToTalk(active) => {
                let changed = self.last_ptt_down != active;
                self.last_ptt_down = active;
                self.shared.set_push_to_talk(active);
                self.apply_publish_mute();
                if changed && self.config.gate == GateMode::PushToTalk {
                    self.play_sound(if active {
                        EventSound::PttDown
                    } else {
                        EventSound::PttUp
                    });
                }
            }
            Command::SetMicTest(enabled) => {
                self.shared.set_mic_test(enabled);
                self.mutate_state(|state| state.mic_test = enabled);
            }
            Command::SetSounds(settings) => {
                self.config.sounds = settings;
                self.update_audio(MixerUpdate::Sounds(settings));
            }
            Command::PlaySound { sound, preview } => {
                self.update_audio(MixerUpdate::Sound { sound, preview });
            }
            Command::SetPttStatus(status) => {
                self.mutate_state(|state| state.push_to_talk = status);
            }
            Command::StartStreamAudio(reply) => {
                let result = self.start_stream_audio().await;
                let _ = reply.send(result);
            }
            Command::StopStreamAudio => self.stop_stream_audio().await,
            Command::WatchStreamAudio { user_id, watching } => {
                if watching {
                    self.stream_watch.insert(user_id);
                } else {
                    self.stream_watch.remove(&user_id);
                }
                self.sync_stream_subscriptions();
                self.emit_stream_audio();
            }
            Command::SetStreamAudioVolume {
                user_id,
                volume,
                muted,
            } => {
                self.stream_gains
                    .insert(user_id, (volume.clamp(0.0, 2.0), muted));
                let identities: Vec<String> = self
                    .stream_tracks
                    .iter()
                    .filter(|(_, track)| track.user_id == user_id)
                    .map(|(identity, _)| identity.clone())
                    .collect();
                for identity in identities {
                    self.apply_stream_gain(&identity, user_id);
                }
            }
        }
    }

    fn update_audio(&self, update: MixerUpdate) {
        if let Some(audio) = &self.audio {
            audio.update(update);
        }
    }

    fn play_sound(&self, sound: EventSound) {
        self.update_audio(MixerUpdate::Sound {
            sound,
            preview: false,
        });
    }

    fn effective_processing(&self) -> ProcessingSettings {
        match &self.session {
            Some(session) if !session.processing_enabled => ProcessingSettings::disabled(),
            _ => self.config.processing,
        }
    }

    async fn apply_credentials(&mut self, update: MediaUpdate) {
        match update {
            MediaUpdate::Available(credentials) => {
                if let Some(session) = &self.session {
                    if session.generation == credentials.generation
                        && session.channel_id == credentials.channel_id
                    {
                        // Token renewal: keep the room and the publication. The
                        // new token is only needed for a future join.
                        log::debug!("voice credentials renewed");
                        self.credentials = Some(credentials);
                        return;
                    }
                }
                self.credentials = Some(credentials.clone());
                self.connect_media(credentials).await;
            }
            MediaUpdate::Unavailable { channel_id } => {
                self.credentials = None;
                // A stream belongs to the channel it was started in.
                self.stream_wanted = None;
                self.stream_error = None;
                let matches = self
                    .session
                    .as_ref()
                    .is_some_and(|session| channel_id == 0 || session.channel_id == channel_id);
                if matches {
                    self.close_session(DisconnectReason::ClientInitiated).await;
                    self.reconnect_at = None;
                    self.last_error = None;
                    self.connection_lost = false;
                    self.play_sound(EventSound::SelfLeave);
                    self.mutate_state(|state| {
                        state.media = MediaPhase::Idle;
                        state.channel_id = 0;
                        state.publishing = false;
                        state.publish_allowed = false;
                    });
                }
            }
        }
    }

    /// Reports a failed room connection and schedules a retry.
    ///
    /// When an old room is still open (a channel switch), it stays connected:
    /// the failure only affects the new room, which the heartbeat retries.
    fn media_failed(&mut self, message: String) {
        log::warn!("{message}");
        self.last_error = Some(message);
        let phase = if self.session.is_some() {
            MediaPhase::Reconnecting
        } else {
            MediaPhase::Failed
        };
        self.mutate_state(|state| state.media = phase);
        self.reconnect_at = Some(Instant::now() + MEDIA_RETRY_DELAY);
        // The new channel may use a different processing profile; restore the
        // one of the room that is still open.
        if let Some(audio) = &self.audio {
            audio.set_processing(self.effective_processing());
        }
    }

    async fn connect_media(&mut self, credentials: MediaCredentials) {
        self.reconnect_at = None;
        self.publish_retry_at = None;
        self.last_error = None;
        // Apply the channel's processing profile before the first frame.
        if let Some(audio) = &self.audio {
            let processing = if credentials.processing_enabled {
                self.config.processing
            } else {
                ProcessingSettings::disabled()
            };
            audio.set_processing(processing);
        }
        self.mutate_state(|state| {
            state.media = MediaPhase::Connecting;
            state.error = None;
        });

        let started = Instant::now();
        let proxy =
            match SignallingProxy::start(&credentials.url, &credentials.tls_fingerprint).await {
                Ok(proxy) => proxy,
                Err(error) => {
                    self.media_failed(format!("voice connection failed: {error}"));
                    return;
                }
            };
        let mut options = RoomOptions::default();
        // Only microphone tracks are relevant in stage 2.3; they are subscribed
        // explicitly on `TrackPublished`, so screen-share audio is never pulled.
        options.auto_subscribe = false;
        let (room, events) =
            match Room::connect(proxy.local_url(), &credentials.token, options).await {
                Ok(value) => value,
                Err(error) => {
                    // The error text is safe: it contains neither the token nor the
                    // URL (the SDK reports the reason, not the credentials).
                    self.media_failed(format!("voice connection failed: {error}"));
                    return;
                }
            };
        let room = Arc::new(room);
        log::info!(
            "joined media room {} in {} ms",
            credentials.room,
            started.elapsed().as_millis()
        );

        let allowed = microphone_allowed(
            PublishGrant::of(
                room.local_participant()
                    .permission()
                    .map(|p| (p.can_publish, p.can_publish_sources)),
            )
            .as_ref(),
        );

        let new_session = Session {
            room: room.clone(),
            _proxy: proxy,
            generation: credentials.generation,
            channel_id: credentials.channel_id,
            identity: credentials.participant_identity.clone(),
            publication: None,
            track: None,
            stereo: credentials.stereo,
            bitrate_bps: credentials.bitrate_bps,
            processing_enabled: credentials.processing_enabled,
        };

        // Requirement 8: connect to the new room first, then leave the old one.
        // The own stream audio was published in the old room; it is published
        // again below if the room is the same channel.
        self.release_stream_publication(false).await;
        let previous = self.session.replace(new_session);
        self.room_events = Some(events);
        self.clear_tracks();
        if let Some(previous) = previous {
            self.close_room(previous).await;
        }

        let cue = if self.connection_lost {
            self.connection_lost = false;
            EventSound::ConnectionRestored
        } else {
            EventSound::SelfJoin
        };
        self.play_sound(cue);
        self.mutate_state(|state| {
            state.media = MediaPhase::Connected;
            state.channel_id = credentials.channel_id;
            state.publish_allowed = allowed;
            state.publishing = false;
        });
        if allowed {
            self.start_publish().await;
        }
        self.resume_stream_audio(credentials.channel_id).await;
        self.sync_stream_subscriptions();
        self.emit_stream_audio();
    }

    async fn start_publish(&mut self) {
        let Some(session) = &self.session else {
            return;
        };
        if session.publication.is_some() {
            return;
        }
        let channels = if session.stereo { 2 } else { 1 };
        // `queue_size_ms = 0` disables the native source's own buffering and
        // its timer: the frame goes straight to the WebRTC sinks, so the
        // microphone remains the only clock on the transmit side (stage
        // 2.3.2b). The crate (`libwebrtc-0.4.2/src/native/audio_source.rs`)
        // requires exactly 10 ms per channel in this mode — `FRAME_SAMPLES` at
        // 48 kHz is exactly that.
        let source = NativeAudioSource::new(source_options(), SAMPLE_RATE, channels, 0);
        let track = LocalAudioTrack::create_audio_track(
            "microphone",
            RtcAudioSource::Native(source.clone()),
        );
        let options = voice_publish_options(session.bitrate_bps, session.stereo);
        let room = session.room.clone();
        match room
            .local_participant()
            .publish_track(LocalTrack::Audio(track), options)
            .await
        {
            Ok(publication) => {
                let sid = publication.sid();
                if let Some(session) = self.session.as_mut() {
                    session.publication = Some(sid);
                    session.track = Some(publication);
                }
                if let Some(sender) = &self.publisher {
                    let _ = sender.send(PublisherCommand::Source(Some(PublishedAudio {
                        source,
                        channels,
                    })));
                }
                self.publish_retry_at = None;
                self.last_error = None;
                self.mutate_state(|state| {
                    state.publishing = true;
                    state.publish_allowed = true;
                });
                // A track published while muted must not start sending on its
                // own (the state survives a channel switch).
                self.apply_publish_mute();
            }
            Err(error) => {
                // A local failure is not a server ban: keep the permission we
                // were granted and retry from the heartbeat (the server still
                // controls `publish_allowed` through its permission update).
                log::warn!("publishing the microphone track failed: {error}");
                self.last_error = Some(format!("could not publish audio: {error}"));
                self.publish_retry_at = Some(Instant::now() + PUBLISH_RETRY_DELAY);
                self.mutate_state(|state| state.publishing = false);
            }
        }
    }

    async fn stop_publish(&mut self) {
        if let Some(sender) = &self.publisher {
            let _ = sender.send(PublisherCommand::Source(None));
        }
        let Some(session) = self.session.as_mut() else {
            return;
        };
        session.track = None;
        let Some(sid) = session.publication.take() else {
            return;
        };
        if let Err(error) = session.room.local_participant().unpublish_track(&sid).await {
            log::debug!("unpublishing the microphone track failed: {error}");
        }
        self.mutate_state(|state| state.publishing = false);
    }

    /// Mutes or unmutes the published track after a mute, a gate change or a
    /// push-to-talk key press.
    ///
    /// The publisher already stops feeding frames, but an idle native source
    /// still emits the occasional Opus DTX packet. Muting the publication
    /// disables the sender, so the other side sees the packet counter freeze
    /// (stage 2.3.1). A publication that does not exist yet is handled by
    /// `start_publish`, which applies the current state after publishing.
    fn apply_publish_mute(&self) {
        let Some(session) = &self.session else {
            return;
        };
        let Some(track) = &session.track else {
            return;
        };
        if self.shared.feeds_publisher() {
            track.unmute();
        } else {
            track.mute();
        }
    }

    async fn handle_room_event(&mut self, event: RoomEvent) {
        match event {
            RoomEvent::Connected {
                participants_with_tracks,
            } => {
                // Participants that were already in the room when we joined do
                // not necessarily produce TrackPublished after connect: their
                // publications arrive here. Subscribe to microphones only.
                for (_participant, publications) in participants_with_tracks {
                    for publication in publications {
                        if publication.source() == TrackSource::Microphone {
                            publication.set_subscribed(true);
                        }
                    }
                }
                // Stream audio only for the streams the UI watches.
                self.sync_stream_subscriptions();
                self.emit_stream_audio();
            }
            RoomEvent::TrackPublished {
                publication,
                participant: _,
            } => {
                if publication.source() == TrackSource::Microphone {
                    publication.set_subscribed(true);
                } else if publication.source() == TrackSource::ScreenshareAudio {
                    self.sync_stream_subscriptions();
                    self.emit_stream_audio();
                }
            }
            RoomEvent::TrackUnpublished {
                publication,
                participant,
            } => {
                if publication.source() == TrackSource::ScreenshareAudio {
                    self.remove_stream_track(&participant.identity().to_string());
                    self.emit_stream_audio();
                }
            }
            RoomEvent::TrackSubscribed {
                track,
                publication,
                participant,
            } => {
                if publication.source() == TrackSource::ScreenshareAudio {
                    if let RemoteTrack::Audio(audio) = track {
                        self.add_stream_track(participant.identity().to_string(), audio);
                    }
                    return;
                }
                if publication.source() != TrackSource::Microphone {
                    return;
                }
                let RemoteTrack::Audio(audio) = track else {
                    return;
                };
                let identity = participant.identity().to_string();
                self.remove_track(&identity);
                let (publisher, level, consumer) = Mixer::create_track(&identity);
                self.update_audio(MixerUpdate::Add {
                    identity: identity.clone(),
                    consumer,
                    level: level.clone(),
                });
                let mut publisher: TrackPublisher = publisher;
                // One WAV per subscribed track, before the mixer (stage 2.3.2a).
                let mut rx_dump = self.audio.as_mut().and_then(AudioRuntime::dump_receiver);
                let task = tokio::spawn(async move {
                    let mut stream =
                        NativeAudioStream::new(audio.rtc_track(), SAMPLE_RATE as i32, 1);
                    while let Some(frame) = stream.next().await {
                        if let Some(tap) = rx_dump.as_mut() {
                            tap.push(frame.data.as_ref());
                        }
                        publisher.push(frame.data.as_ref());
                    }
                });
                self.apply_track_settings(&identity);
                self.tracks.insert(identity, TrackEntry { level, task });
            }
            RoomEvent::TrackUnsubscribed {
                publication,
                participant,
                ..
            } => {
                if publication.source() == TrackSource::Microphone {
                    let identity = participant.identity().to_string();
                    self.remove_track(&identity);
                } else if publication.source() == TrackSource::ScreenshareAudio {
                    self.remove_stream_track(&participant.identity().to_string());
                    self.emit_stream_audio();
                }
            }
            RoomEvent::ParticipantConnected(participant) => {
                log::debug!("media participant joined");
                let _ = participant;
                self.play_sound(EventSound::UserJoin);
            }
            RoomEvent::ParticipantDisconnected(participant) => {
                let identity = participant.identity().to_string();
                self.remove_track(&identity);
                self.remove_stream_track(&identity);
                self.emit_stream_audio();
                self.play_sound(EventSound::UserLeave);
            }
            RoomEvent::ParticipantPermissionChanged {
                participant,
                permission,
            } => {
                let is_self = self
                    .session
                    .as_ref()
                    .is_some_and(|session| session.identity == participant.identity().to_string());
                if !is_self {
                    return;
                }
                let grant = PublishGrant::of(
                    permission.map(|value| (value.can_publish, value.can_publish_sources)),
                );
                let stream_allowed = grant.as_ref().is_some_and(stream_audio_allowed);
                if !stream_allowed && self.stream_wanted.is_some() {
                    // The stream right was revoked or a moderator stopped the
                    // stream; the SFU already removed the track.
                    log::info!("the server withdrew the stream audio");
                    self.release_stream_publication(false).await;
                    self.stream_wanted = None;
                    self.stream_error =
                        Some("the server does not allow streaming audio".to_owned());
                    self.emit_stream_audio();
                }
                let allowed = grant.is_some() && microphone_allowed(grant.as_ref());
                if allowed {
                    self.mutate_state(|state| state.publish_allowed = true);
                    self.start_publish().await;
                } else {
                    // The server revoked publishing (mute or a role change):
                    // stop and show it, never work around it.
                    log::info!("the server revoked audio publishing");
                    self.publish_retry_at = None;
                    self.stop_publish().await;
                    self.last_error = Some("the server does not allow publishing audio".to_owned());
                    self.mutate_state(|state| state.publish_allowed = false);
                }
            }
            RoomEvent::Reconnecting => {
                self.mutate_state(|state| state.media = MediaPhase::Reconnecting);
            }
            RoomEvent::Reconnected => {
                self.mutate_state(|state| state.media = MediaPhase::Connected);
                self.sync_stream_subscriptions();
            }
            RoomEvent::Disconnected { reason } => {
                if reason != DisconnectReason::ClientInitiated {
                    log::warn!("media room disconnected");
                    self.handle_room_lost().await;
                }
            }
            RoomEvent::TrackSubscriptionFailed { error, .. } => {
                log::warn!("audio subscription failed: {error}");
            }
            RoomEvent::LocalTrackPublished { .. } | RoomEvent::LocalTrackUnpublished { .. } => {}
            _ => {}
        }
    }

    async fn handle_room_lost(&mut self) {
        self.release_stream_publication(false).await;
        self.clear_tracks();
        self.room_events = None;
        self.publish_retry_at = None;
        if let Some(session) = self.session.take() {
            // The room is already gone; just drop it.
            drop(session);
        }
        self.play_sound(EventSound::ConnectionLost);
        self.connection_lost = true;
        if self.credentials.is_some() {
            self.mutate_state(|state| {
                state.media = MediaPhase::Reconnecting;
                state.publishing = false;
            });
            self.reconnect_at = Some(Instant::now() + Duration::from_secs(1));
        } else {
            self.mutate_state(|state| {
                state.media = MediaPhase::Idle;
                state.publishing = false;
                state.publish_allowed = false;
            });
        }
    }

    async fn heartbeat(&mut self) {
        let now = Instant::now();
        // cpal stream errors are classified before acting: an `Xrun` is a
        // glitch the stream survives, not a reason to rebuild the tract and
        // reconnect the media session (stage 2.3.2a.1).
        if self.handle_stream_errors(now).await {
            return;
        }
        // A rebuild that was deferred by the backoff still has to happen even
        // if the stream stopped reporting new errors.
        if self.stream_error_policy.pending_due(now) {
            self.rebuild_after_stream_error().await;
            return;
        }
        self.stream_error_policy.settle(now);

        // A capture whose client died (device lost, audio service restart)
        // ends the stream audio; the UI shows it and the user restarts.
        if self
            .stream_publication
            .as_ref()
            .is_some_and(|publication| publication.capture.failed())
        {
            log::warn!("the stream audio capture stopped");
            self.release_stream_publication(true).await;
            self.stream_wanted = None;
            self.stream_error = Some("the computer audio capture stopped".to_owned());
            self.emit_stream_audio();
        }

        // A failed rebuild of the audio tract is retried on its own timer; the
        // device watcher may not fire again until the hardware changes.
        if audio_retry_due(self.audio.is_none(), self.audio_retry_at, now) {
            log::info!("retrying the audio pipeline");
            self.restart_audio().await;
            return;
        }

        // Retry a failed new room even while the old room is still open: the
        // switch must connect to the new room before closing the old one, and
        // a transient failure there must not leave the user in the old channel.
        if let (Some(credentials), Some(at)) = (&self.credentials, self.reconnect_at) {
            if now >= at {
                let credentials = credentials.clone();
                self.connect_media(credentials).await;
                return;
            }
        }

        let publish_due = publish_retry_due(self.publish_retry_at, now);
        if publish_due
            && self
                .state
                .read()
                .map(|state| state.publish_allowed && !state.publishing)
                .unwrap_or(false)
            && self
                .session
                .as_ref()
                .is_some_and(|session| session.publication.is_none())
        {
            self.start_publish().await;
        }
    }

    async fn handle_devices(&mut self, list: DeviceList) {
        self.devices = list.clone();
        if let Ok(mut guard) = self.device_list.write() {
            *guard = list.clone();
        }
        self.sink(VoiceEvent::Devices(list.clone()));

        let opened_input = self
            .audio
            .as_ref()
            .and_then(|audio| audio.capture_device())
            .map(str::to_owned);
        let opened_output = self
            .audio
            .as_ref()
            .and_then(|audio| audio.playback_device())
            .map(str::to_owned);
        let plan = reconcile_devices(
            self.config.input_device.as_deref(),
            self.config.output_device.as_deref(),
            opened_input.as_deref(),
            opened_output.as_deref(),
            &list,
        );

        if plan.input != self.config.input_device {
            if plan.input.is_none() && self.config.input_device.is_some() {
                log::info!("the selected input device disappeared, using the default");
            }
            self.config.input_device = plan.input;
        }
        if plan.output != self.config.output_device {
            if plan.output.is_none() && self.config.output_device.is_some() {
                log::info!("the selected output device disappeared, using the default");
            }
            self.config.output_device = plan.output;
        }
        if plan.restart {
            self.restart_audio().await;
        }
    }

    /// Handles every pending cpal stream error.
    ///
    /// Returns true when the tract was rebuilt. Only fatal kinds rebuild, and
    /// the rebuild is rate limited; `Xrun`/`DeviceChanged`/`RealtimeDenied`
    /// leave the running streams alone.
    async fn handle_stream_errors(&mut self, now: Instant) -> bool {
        for _ in 0..STREAM_ERRORS_PER_TICK {
            let Some(event) = self.shared.take_stream_error() else {
                return false;
            };
            let side = event.side.name();
            let device = match event.side {
                StreamSide::Capture => self.audio.as_ref().and_then(|audio| audio.capture_device()),
                StreamSide::Playback => self
                    .audio
                    .as_ref()
                    .and_then(|audio| audio.playback_device()),
            }
            .map_or_else(|| "default".to_owned(), str::to_owned);
            let error = event.error;
            let message = error
                .message
                .as_deref()
                .map_or_else(String::new, |text| format!(", message={text:?}"));

            if !error.kind.is_fatal() {
                // One line per stream that reports a benign event; a storm of
                // Xruns stays at debug.
                if error.first {
                    log::info!(
                        "audio {side} stream reported {} (count={}, device={device}{message}); the stream keeps running",
                        error.kind.name(),
                        error.count
                    );
                } else {
                    log::debug!(
                        "audio {side} stream reported {} (count={}, device={device}{message})",
                        error.kind.name(),
                        error.count
                    );
                }
                continue;
            }

            if error.first {
                log::warn!(
                    "audio {side} stream failed: kind={}, count={}, device={device}{message}",
                    error.kind.name(),
                    error.count
                );
            } else {
                log::debug!(
                    "audio {side} stream still failing: kind={}, count={}, device={device}{message}",
                    error.kind.name(),
                    error.count
                );
            }

            match self.stream_error_policy.observe(event.side, now) {
                StreamErrorDecision::Rebuild => {
                    self.rebuild_after_stream_error().await;
                    return true;
                }
                StreamErrorDecision::Deferred => {
                    log::debug!(
                        "audio {side} stream error: the tract rebuild is held back by the backoff"
                    );
                }
            }
        }
        false
    }

    async fn rebuild_after_stream_error(&mut self) {
        let side = self
            .stream_error_policy
            .last_side
            .unwrap_or(StreamSide::Capture)
            .name();
        // Capture and playback share the runtime threads and the media session,
        // and a cpal stream cannot be reopened in place. The classification in
        // `StreamErrorKind::is_fatal` keeps a benign one-sided event (the
        // startup Xrun) from tearing the tract down; a truly fatal stream error
        // is handled by rebuilding the shared tract as a unit.
        log::warn!("rebuilding the audio tract after a {side}-side stream error");
        self.restart_audio().await;
    }

    async fn restart_audio(&mut self) {
        let credentials = self.credentials.clone();
        self.close_session(DisconnectReason::ClientInitiated).await;
        if let Some(audio) = self.audio.take() {
            audio.stop();
        }
        let processing = self.effective_processing();
        let config = audio_config(&self.config, processing);
        match AudioRuntime::start(&config) {
            Ok(audio) => {
                self.audio_retry_at = None;
                // A rebuilt tract may have opened another device or another
                // format; the diagnostics export reads this snapshot.
                if let Ok(mut guard) = self.formats.write() {
                    *guard = audio_formats(&audio);
                }
                // Any successful start ends the stream-error episode: the next
                // fatal error gets a fresh (rate-limited) rebuild.
                self.stream_error_policy.rebuilt(Instant::now());
                self.shared = audio.shared();
                self.shared.set_gate_mode(self.config.gate);
                self.shared.set_self_muted(
                    self.state
                        .read()
                        .map(|state| state.self_muted)
                        .unwrap_or(false),
                );
                self.shared.set_deafened(
                    self.state
                        .read()
                        .map(|state| state.deafened)
                        .unwrap_or(false),
                );
                self.shared.set_mic_test(
                    self.state
                        .read()
                        .map(|state| state.mic_test)
                        .unwrap_or(false),
                );
                self.audio = Some(audio);
                self.start_publisher();
                // Re-add the per-user settings; the tracks themselves come back
                // with the new room subscription.
                self.apply_volumes();
                if let Some(credentials) = credentials {
                    self.connect_media(credentials).await;
                } else {
                    self.mutate_state(|state| {
                        state.media = MediaPhase::Idle;
                        state.publishing = false;
                    });
                }
            }
            Err(error) => {
                log::error!("could not rebuild the audio pipeline: {error}");
                self.last_error = Some(error.user_message());
                // The heartbeat retries: a device that is still held by another
                // application or a plug/unplug race must not end in a dead
                // tract until the next device-list change (stage 2.3.1).
                self.audio_retry_at = Some(Instant::now() + AUDIO_RETRY_DELAY);
                self.mutate_state(|state| state.media = MediaPhase::Failed);
            }
        }
    }

    async fn close_session(&mut self, reason: DisconnectReason) {
        if let Some(sender) = &self.publisher {
            let _ = sender.send(PublisherCommand::Source(None));
        }
        self.release_stream_publication(false).await;
        self.clear_tracks();
        self.room_events = None;
        self.publish_retry_at = None;
        if let Some(session) = self.session.take() {
            self.close_room_with(session, reason).await;
        }
        self.mutate_state(|state| {
            state.publishing = false;
            state.channel_id = 0;
        });
    }

    async fn close_room(&mut self, session: Session) {
        self.close_room_with(session, DisconnectReason::ClientInitiated)
            .await;
    }

    async fn close_room_with(&mut self, session: Session, reason: DisconnectReason) {
        if let Err(error) = session.room.close_with_reason(reason).await {
            log::debug!("closing the media room failed: {error}");
        }
    }

    fn clear_tracks(&mut self) {
        let identities: Vec<String> = self.tracks.keys().cloned().collect();
        for identity in identities {
            self.remove_track(&identity);
        }
        let streams: Vec<String> = self.stream_tracks.keys().cloned().collect();
        for identity in streams {
            self.remove_stream_track(&identity);
        }
    }

    // ---------------------------------------------------------------------
    // Stream audio (stage P15, ADR 0027)
    // ---------------------------------------------------------------------

    async fn start_stream_audio(&mut self) -> Result<(), VoiceError> {
        let Some(session) = &self.session else {
            return Err(VoiceError::Media(
                "join a voice channel before sharing the computer audio".to_owned(),
            ));
        };
        let permission = PublishGrant::of(
            session
                .room
                .local_participant()
                .permission()
                .map(|value| (value.can_publish, value.can_publish_sources)),
        );
        // `None` only before the first participant update: worth a try, the
        // SFU still enforces the grant.
        if permission
            .as_ref()
            .is_some_and(|value| !stream_audio_allowed(value))
        {
            return Err(VoiceError::PublishNotAllowed);
        }
        let channel_id = session.channel_id;
        self.stream_wanted = Some(channel_id);
        match self.publish_stream_audio().await {
            Ok(()) => {
                self.stream_error = None;
                self.emit_stream_audio();
                Ok(())
            }
            Err(error) => {
                log::warn!("the stream audio could not start: {error}");
                self.stream_wanted = None;
                self.stream_error = Some(error.user_message());
                self.emit_stream_audio();
                Err(error)
            }
        }
    }

    async fn stop_stream_audio(&mut self) {
        self.stream_wanted = None;
        self.stream_error = None;
        self.release_stream_publication(true).await;
        self.emit_stream_audio();
    }

    /// Republishes the stream audio after the room of the same channel came
    /// back (a new generation, an audio rebuild, a reconnect). A new channel
    /// ends it: a stream belongs to the channel it was started in.
    async fn resume_stream_audio(&mut self, channel_id: u64) {
        let Some(wanted) = self.stream_wanted else {
            return;
        };
        if wanted != channel_id {
            self.stream_wanted = None;
            self.stream_error = None;
            return;
        }
        if let Err(error) = self.publish_stream_audio().await {
            log::warn!("the stream audio could not be published again: {error}");
            self.stream_wanted = None;
            self.stream_error = Some(error.user_message());
        }
    }

    async fn publish_stream_audio(&mut self) -> Result<(), VoiceError> {
        if self.stream_publication.is_some() {
            return Ok(());
        }
        let Some(session) = &self.session else {
            return Err(VoiceError::Media("not in a voice channel".to_owned()));
        };
        let room = session.room.clone();
        let source = self.capture_source;
        let (capture, consumer) = tokio::task::spawn_blocking(move || StreamCapture::start(source))
            .await
            .map_err(|error| VoiceError::Internal(format!("stream audio start: {error}")))??;
        // Stereo, 10 ms frames, no own queue (ADR 0013); no APM: the game
        // audio is published untouched (ADR 0027).
        let native =
            NativeAudioSource::new(source_options(), SAMPLE_RATE, STREAM_CHANNELS as u32, 0);
        let track = LocalAudioTrack::create_audio_track(
            "screen-audio",
            RtcAudioSource::Native(native.clone()),
        );
        let options = TrackPublishOptions {
            audio_encoding: Some(AudioEncoding {
                max_bitrate: STREAM_AUDIO_BITRATE,
            }),
            // A quiet moment in a game is not a reason to cut the stream.
            dtx: false,
            red: true,
            source: TrackSource::ScreenshareAudio,
            ..Default::default()
        };
        match room
            .local_participant()
            .publish_track(LocalTrack::Audio(track), options)
            .await
        {
            Ok(publication) => {
                let task = tokio::spawn(stream_publisher_loop(consumer, native));
                self.stream_publication = Some(StreamPublication {
                    capture,
                    task,
                    sid: publication.sid(),
                });
                log::info!("stream audio published");
                Ok(())
            }
            Err(error) => {
                let _ = tokio::task::spawn_blocking(move || capture.stop()).await;
                Err(VoiceError::Media(format!(
                    "could not publish the stream audio: {error}"
                )))
            }
        }
    }

    /// Stops the capture and the publisher. `unpublish` also removes the track
    /// from a room that stays open; a room that is closing or already gone
    /// drops it anyway.
    async fn release_stream_publication(&mut self, unpublish: bool) {
        let Some(publication) = self.stream_publication.take() else {
            return;
        };
        publication.task.abort();
        if unpublish {
            if let Some(session) = &self.session {
                if let Err(error) = session
                    .room
                    .local_participant()
                    .unpublish_track(&publication.sid)
                    .await
                {
                    log::debug!("unpublishing the stream audio failed: {error}");
                }
            }
        }
        let dropped = publication.capture.dropped();
        if dropped > 0 {
            log::debug!("stream audio capture dropped {dropped} samples");
        }
        let capture = publication.capture;
        let _ = tokio::task::spawn_blocking(move || capture.stop()).await;
        log::info!("stream audio stopped");
    }

    /// Subscribes to the `screen_share_audio` publications of watched users
    /// and unsubscribes from the rest. Any participant of a user counts: the
    /// track type comes from the source (design 4.7).
    fn sync_stream_subscriptions(&mut self) {
        if let Some(session) = &self.session {
            for (identity, participant) in session.room.remote_participants() {
                let Some(user_id) = user_id_of(&identity.to_string()) else {
                    continue;
                };
                let wanted = self.stream_watch.contains(&user_id);
                for publication in participant.track_publications().into_values() {
                    if publication.source() == TrackSource::ScreenshareAudio
                        && publication.is_subscribed() != wanted
                    {
                        publication.set_subscribed(wanted);
                    }
                }
            }
        }
        let stale: Vec<String> = self
            .stream_tracks
            .iter()
            .filter(|(_, track)| !self.stream_watch.contains(&track.user_id))
            .map(|(identity, _)| identity.clone())
            .collect();
        for identity in stale {
            self.remove_stream_track(&identity);
        }
    }

    fn add_stream_track(&mut self, identity: String, audio: livekit::track::RemoteAudioTrack) {
        let Some(user_id) = user_id_of(&identity) else {
            return;
        };
        if !self.stream_watch.contains(&user_id) {
            // A subscription that raced an unwatch.
            self.sync_stream_subscriptions();
            return;
        }
        self.remove_stream_track(&identity);
        let key = mixer_key(&identity);
        let (mut publisher, level, consumer) = Mixer::create_track(&key);
        self.update_audio(MixerUpdate::Add {
            identity: key,
            consumer,
            level,
        });
        // The core mixer is mono (ADR 0007): libwebrtc downmixes the stereo
        // stream here. Volume, mute, deafen and the AEC reference then treat it
        // like any voice.
        let task = tokio::spawn(async move {
            let mut stream = NativeAudioStream::new(audio.rtc_track(), SAMPLE_RATE as i32, 1);
            while let Some(frame) = stream.next().await {
                publisher.push(frame.data.as_ref());
            }
        });
        self.stream_tracks
            .insert(identity.clone(), StreamTrack { user_id, task });
        self.apply_stream_gain(&identity, user_id);
        self.emit_stream_audio();
    }

    fn remove_stream_track(&mut self, identity: &str) {
        if let Some(track) = self.stream_tracks.remove(identity) {
            track.task.abort();
            self.update_audio(MixerUpdate::Remove(mixer_key(identity)));
        }
    }

    fn apply_stream_gain(&self, identity: &str, user_id: u64) {
        let (volume, muted) = self
            .stream_gains
            .get(&user_id)
            .copied()
            .unwrap_or((1.0, false));
        let key = mixer_key(identity);
        self.update_audio(MixerUpdate::Volume {
            identity: key.clone(),
            volume,
        });
        self.update_audio(MixerUpdate::Muted {
            identity: key,
            muted,
        });
    }

    fn stream_audio_snapshot(&self) -> StreamAudioState {
        let mut available = Vec::new();
        if let Some(session) = &self.session {
            for (identity, participant) in session.room.remote_participants() {
                let Some(user_id) = user_id_of(&identity.to_string()) else {
                    continue;
                };
                if participant
                    .track_publications()
                    .values()
                    .any(|publication| publication.source() == TrackSource::ScreenshareAudio)
                {
                    available.push(user_id);
                }
            }
        }
        available.sort_unstable();
        available.dedup();
        let mut playing: Vec<u64> = self
            .stream_tracks
            .values()
            .map(|track| track.user_id)
            .collect();
        playing.sort_unstable();
        playing.dedup();
        let capture = if self.stream_publication.is_some() {
            StreamCaptureState::Live
        } else if self.stream_error.is_some() {
            StreamCaptureState::Failed
        } else {
            StreamCaptureState::Off
        };
        StreamAudioState {
            capture,
            error: self.stream_error.clone(),
            available,
            playing,
        }
    }

    /// Reports the stream-audio state when it changed.
    fn emit_stream_audio(&self) {
        let next = self.stream_audio_snapshot();
        let changed = match self.stream_audio.write() {
            Ok(mut current) => {
                if *current == next {
                    false
                } else {
                    *current = next.clone();
                    true
                }
            }
            Err(_) => true,
        };
        if changed {
            self.sink(VoiceEvent::StreamAudio(next));
        }
    }

    fn remove_track(&mut self, identity: &str) {
        if let Some(entry) = self.tracks.remove(identity) {
            entry.task.abort();
        }
        self.update_audio(MixerUpdate::Remove(identity.to_owned()));
    }

    fn emit_levels(&self) {
        let participants = self
            .tracks
            .iter()
            .map(|(identity, entry)| ParticipantLevel {
                identity: identity.clone(),
                level_db: entry.level.level_db(),
                speaking: entry.level.is_speaking(),
            })
            .collect();
        self.sink(VoiceEvent::Levels(VoiceLevels {
            self_level_db: self.shared.meter_level_db(),
            self_speaking: self.shared.own_speaking(),
            participants,
        }));
    }

    async fn emit_stats(&mut self) {
        let counters = self.shared.counters();
        let empty = || SessionStats {
            publisher_stats: Vec::new(),
            subscriber_stats: Vec::new(),
        };
        let snapshot = match &self.session {
            Some(session) => match session.room.get_stats().await {
                Ok(stats) => self.stats.update(&stats, counters),
                Err(error) => {
                    log::debug!("could not read media statistics: {error}");
                    self.stats.update(&empty(), counters)
                }
            },
            None => self.stats.update(&empty(), counters),
        };
        // Counters are diagnostics, not an error: log them once per second at
        // debug level and only when something moved, so a healthy session does
        // not fill the log.
        if snapshot.audio != self.last_counters && snapshot.audio.any() {
            log::debug!("audio pipeline counters: {}", snapshot.audio.summary());
        }
        self.last_counters = snapshot.audio;
        self.sink(VoiceEvent::Stats(snapshot));
    }

    fn sink(&self, event: VoiceEvent) {
        (self.sink)(event);
    }
}

/// Options for the published source.
///
/// APM runs in our own capture thread; WebRTC's built-in processing would
/// process the audio a second time and undo the tuning (stage 2.3.1).
fn source_options() -> AudioSourceOptions {
    AudioSourceOptions {
        echo_cancellation: false,
        noise_suppression: false,
        auto_gain_control: false,
    }
}

/// Publish options of the microphone track (ADR 0002, stage P17).
///
/// What the SDK lets us tune for voice, and what it does not: the Opus bitrate
/// ceiling (`audio_encoding`), DTX and RED are set here; inband FEC and the
/// frame length are libwebrtc's own policy and have no API in `livekit` 0.12.
/// RED is requested for voice and allowed by the server, which lists
/// `audio/red` in its default enabled codecs. DTX is off for music (stereo):
/// discontinuous transmission would cut quiet passages.
fn voice_publish_options(bitrate_bps: u64, stereo: bool) -> TrackPublishOptions {
    TrackPublishOptions {
        audio_encoding: Some(AudioEncoding {
            max_bitrate: bitrate_bps,
        }),
        dtx: !stereo,
        red: true,
        source: TrackSource::Microphone,
        ..Default::default()
    }
}

/// `TrackSource` numbers of the LiveKit protocol (`livekit-protocol` 0.9.0,
/// `livekit.rs`: `Microphone = 2`, `ScreenShareAudio = 4`). `livekit::proto`
/// does not re-export the protocol types, so the permission's source list is
/// read as the raw numbers the server sent.
const PROTO_MICROPHONE: i32 = 2;
const PROTO_SCREEN_SHARE_AUDIO: i32 = 4;

/// The publish part of a `ParticipantPermission`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PublishGrant {
    can_publish: bool,
    sources: Vec<i32>,
}

impl PublishGrant {
    fn of(permission: Option<(bool, Vec<i32>)>) -> Option<Self> {
        permission.map(|(can_publish, sources)| Self {
            can_publish,
            sources,
        })
    }

    /// An empty source list with `can_publish` means "any source" (LiveKit).
    fn allows(&self, source: i32) -> bool {
        self.can_publish && (self.sources.is_empty() || self.sources.contains(&source))
    }
}

/// Whether the local participant may publish a microphone track.
///
/// The server is authoritative (a server mute and the initial token claims
/// both surface in the participant permission); since ADR 0027 the voice token
/// may carry `screen_share_audio` without the microphone, so the source list
/// is checked, not just `can_publish`. `None` only happens before the first
/// participant update, when publishing is worth a try.
fn microphone_allowed(grant: Option<&PublishGrant>) -> bool {
    grant.is_none_or(|value| value.allows(PROTO_MICROPHONE))
}

/// Whether the voice participant may publish the stream audio (ADR 0027).
fn stream_audio_allowed(grant: &PublishGrant) -> bool {
    grant.allows(PROTO_SCREEN_SHARE_AUDIO)
}

/// What the device watcher wants the engine to do after a list change.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct DevicePlan {
    input: Option<String>,
    output: Option<String>,
    restart: bool,
}

/// Applies the device rules to a fresh device list.
///
/// An explicit selection wins while the device exists. When it disappears the
/// engine falls back to the system default (`None`). Without an explicit
/// selection the opened default is compared with the new default, so plugging
/// a headset or changing the default in the OS rebuilds the tract.
fn reconcile_devices(
    selected_input: Option<&str>,
    selected_output: Option<&str>,
    opened_input: Option<&str>,
    opened_output: Option<&str>,
    list: &DeviceList,
) -> DevicePlan {
    let mut restart = false;
    let input = match selected_input {
        Some(id) if list.has_input(id) => Some(id.to_owned()),
        Some(_) => {
            restart = true;
            None
        }
        None => {
            restart |= follows_new_default(opened_input, list.default_input.as_deref());
            None
        }
    };
    let output = match selected_output {
        Some(id) if list.has_output(id) => Some(id.to_owned()),
        Some(_) => {
            restart = true;
            None
        }
        None => {
            restart |= follows_new_default(opened_output, list.default_output.as_deref());
            None
        }
    };
    DevicePlan {
        input,
        output,
        restart,
    }
}

/// True when the opened default is no longer the current system default.
///
/// "No device at all" on both sides is not a change and must not restart the
/// tract in a loop on a machine without audio hardware.
fn follows_new_default(opened: Option<&str>, current: Option<&str>) -> bool {
    opened != current && (opened.is_some() || current.is_some())
}

/// What the heartbeat does with a fatal stream error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamErrorDecision {
    /// The tract is rebuilt now.
    Rebuild,
    /// A rebuild is pending but the backoff has not expired.
    Deferred,
}

/// Rate limit and exponential backoff for whole-tract rebuilds caused by cpal
/// stream errors.
///
/// The tract is a unit: capture and playback share the runtime and the media
/// session, so rebuilding it is expensive (it also reconnects the room). A
/// stream that reports a fatal error every callback must therefore cause at
/// most one rebuild per backoff window, not one per heartbeat.
#[derive(Debug, Default)]
struct StreamErrorPolicy {
    /// Rebuilds since the tract last stayed healthy long enough.
    rebuilds: u32,
    /// A fatal error was seen but its rebuild was deferred.
    pending: bool,
    /// Earliest time the next rebuild may happen.
    retry_at: Option<Instant>,
    /// When the current tract was (re)started, for the stable-period reset.
    stable_since: Option<Instant>,
    /// Side of the last fatal error, used for the log line.
    last_side: Option<StreamSide>,
}

impl StreamErrorPolicy {
    /// Records a fatal stream error and decides whether to rebuild now.
    fn observe(&mut self, side: StreamSide, now: Instant) -> StreamErrorDecision {
        self.pending = true;
        self.last_side = Some(side);
        self.stable_since = None;
        if self.rebuild_due(now) {
            StreamErrorDecision::Rebuild
        } else {
            StreamErrorDecision::Deferred
        }
    }

    /// A deferred rebuild still has to happen after the backoff expires, even
    /// when the stream stopped reporting new errors.
    fn pending_due(&mut self, now: Instant) -> bool {
        self.pending && self.rebuild_due(now)
    }

    fn rebuild_due(&mut self, now: Instant) -> bool {
        if self.retry_at.is_some_and(|at| now < at) {
            return false;
        }
        self.pending = false;
        self.rebuilds = self.rebuilds.saturating_add(1);
        self.retry_at = Some(now + stream_error_delay(self.rebuilds));
        true
    }

    /// Called after the tract was rebuilt successfully.
    fn rebuilt(&mut self, now: Instant) {
        self.pending = false;
        self.stable_since = Some(now);
    }

    /// Clears the backoff once the tract has been healthy long enough, so a
    /// later unplug is handled immediately instead of waiting out an old window.
    fn settle(&mut self, now: Instant) {
        if self.pending {
            return;
        }
        if self
            .stable_since
            .is_some_and(|since| now.saturating_duration_since(since) >= STREAM_ERROR_STABLE_AFTER)
        {
            self.rebuilds = 0;
            self.retry_at = None;
            self.stable_since = None;
        }
    }
}

/// Exponential delay after the n-th consecutive stream-error rebuild: 2 s, 4 s,
/// 8 s, 16 s, then the 30 s cap.
fn stream_error_delay(rebuilds: u32) -> Duration {
    let factor = 1u32 << rebuilds.saturating_sub(1).min(4);
    (STREAM_ERROR_RETRY_DELAY * factor).min(STREAM_ERROR_MAX_DELAY)
}

/// Whether the heartbeat should rebuild the audio pipeline again.
///
/// Only a missing tract with an expired deadline is retried; a running tract is
/// never rebuilt from the heartbeat, and a failure without a deadline (startup)
/// is handled by the caller that reported it.
fn audio_retry_due(missing: bool, retry_at: Option<Instant>, now: Instant) -> bool {
    missing && retry_at.is_some_and(|at| now >= at)
}

/// Whether a failed local publication may be retried now.
///
/// `None` means "no failure pending", so the heartbeat may try to publish a
/// track that is allowed but missing.
fn publish_retry_due(retry_at: Option<Instant>, now: Instant) -> bool {
    retry_at.is_none_or(|at| now >= at)
}

/// Stored per-participant settings to re-apply to a new track.
fn replay_settings(
    volumes: &HashMap<String, f32>,
    mutes: &HashSet<String>,
    identity: &str,
) -> (Option<f32>, bool) {
    (volumes.get(identity).copied(), mutes.contains(identity))
}

async fn next_room_event(
    receiver: &mut Option<mpsc::UnboundedReceiver<RoomEvent>>,
) -> Option<RoomEvent> {
    match receiver {
        Some(receiver) => receiver.recv().await,
        None => std::future::pending::<Option<RoomEvent>>().await,
    }
}

async fn publisher_loop(
    mut commands: mpsc::UnboundedReceiver<PublisherCommand>,
    mut consumer: HeapCons<i16>,
    mut shared: Arc<SharedAudio>,
) {
    let mut current: Option<PublishedAudio> = None;
    let mut mono = [0i16; FRAME_SAMPLES];
    let mut stereo = [0i16; FRAME_SAMPLES * 2];
    let mut feeding = false;
    let mut watch = StallWatch::new();
    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    None => break,
                    Some(PublisherCommand::Consumer { consumer: next, shared: current_shared }) => {
                        consumer = next;
                        shared = current_shared;
                        drain(&mut consumer);
                        watch.frame();
                    }
                    Some(PublisherCommand::Source(next)) => {
                        // Start from the freshest audio, not a stale backlog.
                        drain(&mut consumer);
                        current = next;
                        feeding = false;
                        watch.frame();
                    }
                }
            }
            _ = tokio::time::sleep(if current.is_none() { IDLE_PUBLISH_POLL } else { PUBLISH_POLL }) => {
                let Some(audio) = current.as_ref() else {
                    drain(&mut consumer);
                    continue;
                };
                // A muted microphone or a released push-to-talk key stops the
                // RTP stream instead of streaming silence: the other side must
                // see the packet counter freeze (stage 2.3.1). The native
                // source has no queue at all (stage 2.3.2b), so clearing it is
                // a no-op kept for the buffered mode: with
                // `queue_size_ms = 0` `clear_buffer()` only clears an empty
                // vector under its mutex (webrtc-sys `audio_track.cpp`) and
                // cannot panic.
                if !shared.feeds_publisher() {
                    if feeding {
                        audio.source.clear_buffer();
                        feeding = false;
                    }
                    drain(&mut consumer);
                    continue;
                }
                feeding = true;
                // Bound the backlog: a stalled runtime must not add permanent
                // latency. Dropping audio is audible, so it is counted and
                // logged, never silent.
                let dropped = trim_backlog(&mut consumer);
                if dropped > 0 {
                    shared.note_publish_overflow();
                    log::debug!("publisher backlog dropped {dropped} samples");
                }
                // Send every whole frame the microphone has produced: the
                // capture thread sets the pace, and the frames must not wait
                // for a timer here (stage 2.3.2b).
                let mut sent = 0usize;
                while consumer.occupied_len() >= FRAME_SAMPLES {
                    let filled = consumer.pop_slice(&mut mono);
                    debug_assert_eq!(filled, FRAME_SAMPLES, "a whole frame was checked first");
                    // Music publishes dual mono, not true stereo: capture, APM
                    // and the publish ring are mono, so the same sample goes to
                    // both channels here. See ADR 0007.
                    let frame = if audio.channels == 2 {
                        for (index, sample) in mono.iter().enumerate() {
                            stereo[index * 2] = *sample;
                            stereo[index * 2 + 1] = *sample;
                        }
                        AudioFrame {
                            data: Cow::Borrowed(&stereo[..]),
                            sample_rate: SAMPLE_RATE,
                            num_channels: 2,
                            samples_per_channel: FRAME_SAMPLES as u32,
                        }
                    } else {
                        AudioFrame {
                            data: Cow::Borrowed(&mono[..]),
                            sample_rate: SAMPLE_RATE,
                            num_channels: 1,
                            samples_per_channel: FRAME_SAMPLES as u32,
                        }
                    };
                    if let Err(error) = audio.source.capture_frame(&frame).await {
                        log::debug!("capture_frame failed: {error}");
                    }
                    sent += 1;
                }
                if sent > 0 {
                    watch.frame();
                } else if watch.stalled() {
                    shared.note_publish_underrun();
                }
            }
        }
    }
}

/// Bounds the publish ring: more than [`PUBLISH_MAX_BACKLOG`] samples are cut
/// down to [`PUBLISH_KEEP_BACKLOG`]. Returns how many samples were dropped
/// (stage 2.3.2b).
fn trim_backlog(consumer: &mut HeapCons<i16>) -> usize {
    if consumer.occupied_len() <= PUBLISH_MAX_BACKLOG {
        return 0;
    }
    let mut dropped = 0usize;
    while consumer.occupied_len() > PUBLISH_KEEP_BACKLOG {
        if consumer.try_pop().is_none() {
            break;
        }
        dropped += 1;
    }
    dropped
}

fn drain(consumer: &mut HeapCons<i16>) {
    while consumer.try_pop().is_some() {}
}

/// Statistics helper used by integration tests.
#[cfg(feature = "test-hooks")]
#[must_use]
pub fn session_stats_snapshot(stats: &SessionStats) -> VoiceStats {
    StatsCollector::default().update(stats, AudioCounters::default())
}

#[cfg(test)]
mod tests {
    #[test]
    fn voice_publishes_with_red_and_dtx_as_adr_0002_says() {
        let options = voice_publish_options(64_000, false);
        assert!(
            options.red,
            "RED protects voice against single lost packets"
        );
        assert!(options.dtx, "DTX saves bandwidth in the pauses of speech");
        assert_eq!(
            options.audio_encoding.map(|encoding| encoding.max_bitrate),
            Some(64_000)
        );
        assert_eq!(options.source, TrackSource::Microphone);
    }

    #[test]
    fn music_keeps_red_but_never_uses_dtx() {
        let options = voice_publish_options(128_000, true);
        assert!(options.red);
        assert!(!options.dtx, "DTX would cut quiet music passages");
    }

    use super::*;

    #[test]
    fn default_state_is_idle() {
        let state = VoiceState::default();
        assert_eq!(state.media, MediaPhase::Idle);
        assert!(!state.publishing);
        assert_eq!(state.channel_id, 0);
    }

    #[test]
    fn the_published_source_does_not_process_the_audio_again() {
        // APM already ran in the capture thread; WebRTC's own echo/noise/AGC
        // would apply a second, untuned pass (stage 2.3.1).
        let options = source_options();
        assert!(!options.echo_cancellation);
        assert!(!options.noise_suppression);
        assert!(!options.auto_gain_control);
    }

    #[test]
    fn publish_permission_is_respected() {
        // `SetCanPublish(false)` and a token without the speak grant both
        // surface here; the engine must not publish and never work around it.
        let permission = |can_publish: bool, sources: &[i32]| PublishGrant {
            can_publish,
            sources: sources.to_vec(),
        };
        const MIC: i32 = PROTO_MICROPHONE;
        const AUDIO: i32 = PROTO_SCREEN_SHARE_AUDIO;
        assert!(!microphone_allowed(Some(&permission(false, &[]))));
        assert!(microphone_allowed(Some(&permission(true, &[]))));
        assert!(microphone_allowed(None));
        // ADR 0027: a voice token with only the stream audio must not make the
        // engine publish (and fail on) a microphone track, and vice versa.
        let stream_only = permission(true, &[AUDIO]);
        assert!(!microphone_allowed(Some(&stream_only)));
        assert!(stream_audio_allowed(&stream_only));
        let mic_only = permission(true, &[MIC]);
        assert!(microphone_allowed(Some(&mic_only)));
        assert!(!stream_audio_allowed(&mic_only));
        let both = permission(true, &[MIC, AUDIO]);
        assert!(microphone_allowed(Some(&both)) && stream_audio_allowed(&both));
        assert!(!stream_audio_allowed(&permission(false, &[AUDIO])));
    }

    #[test]
    fn a_publish_backlog_of_more_than_200_ms_is_cut_to_20_ms() {
        use ringbuf::traits::{Producer, Split};

        // Below the emergency bound nothing is touched.
        let (mut producer, mut consumer) = ringbuf::HeapRb::<i16>::new(PUBLISH_MAX_BACKLOG).split();
        producer.push_slice(&[7i16; PUBLISH_MAX_BACKLOG]);
        assert_eq!(trim_backlog(&mut consumer), 0);
        assert_eq!(consumer.occupied_len(), PUBLISH_MAX_BACKLOG);

        // Above it the ring keeps two frames and reports the dropped samples.
        const CAPACITY: usize = PUBLISH_MAX_BACKLOG + FRAME_SAMPLES;
        let (mut producer, mut consumer) = ringbuf::HeapRb::<i16>::new(CAPACITY).split();
        producer.push_slice(&[7i16; CAPACITY]);
        assert_eq!(trim_backlog(&mut consumer), CAPACITY - PUBLISH_KEEP_BACKLOG);
        assert_eq!(consumer.occupied_len(), PUBLISH_KEEP_BACKLOG);
        assert_eq!(trim_backlog(&mut consumer), 0);
    }

    #[test]
    fn a_push_to_talk_pre_roll_burst_leaves_no_backlog() {
        use ringbuf::traits::{Producer, Split};

        // The push-to-talk front sends two pre-roll frames and the fresh one
        // (30 ms) into the ring at once. That is well below the 200 ms bound,
        // so no trim; the publisher's drain loop sends the whole burst in one
        // poll and the ring returns to empty. A one-off burst therefore does
        // not leave latency behind and cannot cause a publish underrun: the
        // poll that sent frames resets the stall watch.
        let (mut producer, mut consumer) =
            ringbuf::HeapRb::<i16>::new(PUBLISH_MAX_BACKLOG * 2).split();
        for value in 1..=3i16 {
            producer.push_slice(&[value * 100; FRAME_SAMPLES]);
        }
        assert_eq!(trim_backlog(&mut consumer), 0, "30 ms is not a backlog");

        let mut mono = [0i16; FRAME_SAMPLES];
        let mut sent = 0usize;
        while consumer.occupied_len() >= FRAME_SAMPLES {
            assert_eq!(consumer.pop_slice(&mut mono), FRAME_SAMPLES);
            sent += 1;
        }
        assert_eq!(sent, 3, "the publisher sends the whole press in one poll");
        assert_eq!(consumer.occupied_len(), 0, "the queue returns to normal");
    }

    fn device(id: &str) -> crate::devices::DeviceInfo {
        crate::devices::DeviceInfo {
            id: id.to_owned(),
            name: id.to_owned(),
            is_default: false,
            channels: 1,
            sample_rate: 48_000,
            sample_format: "F32".to_owned(),
        }
    }

    fn device_list(default_input: &str, default_output: &str) -> DeviceList {
        DeviceList {
            inputs: vec![device("mic-a"), device("mic-b")],
            outputs: vec![device("spk-a"), device("spk-b")],
            default_input: Some(default_input.to_owned()),
            default_output: Some(default_output.to_owned()),
        }
    }

    #[test]
    fn following_the_default_rebuilds_on_a_default_change() {
        let list = device_list("mic-b", "spk-a");
        let plan = reconcile_devices(None, None, Some("mic-a"), Some("spk-a"), &list);
        assert!(plan.restart);
        assert_eq!(plan.input, None);
        assert_eq!(plan.output, None);
    }

    #[test]
    fn an_explicit_selection_wins_over_a_new_default() {
        let list = device_list("mic-b", "spk-b");
        let plan = reconcile_devices(
            Some("mic-a"),
            Some("spk-a"),
            Some("mic-a"),
            Some("spk-a"),
            &list,
        );
        assert!(!plan.restart);
        assert_eq!(plan.input.as_deref(), Some("mic-a"));
        assert_eq!(plan.output.as_deref(), Some("spk-a"));
    }

    #[test]
    fn a_selected_device_is_kept_when_another_device_arrives() {
        let list = device_list("mic-a", "spk-a");
        let plan = reconcile_devices(
            Some("mic-b"),
            Some("spk-b"),
            Some("mic-b"),
            Some("spk-b"),
            &list,
        );
        assert!(!plan.restart);
        assert_eq!(plan.input.as_deref(), Some("mic-b"));
        assert_eq!(plan.output.as_deref(), Some("spk-b"));
    }

    #[test]
    fn a_missing_selected_device_falls_back_to_the_default() {
        let list = device_list("mic-a", "spk-a");
        let plan = reconcile_devices(
            Some("mic-old"),
            Some("spk-old"),
            Some("mic-old"),
            Some("spk-old"),
            &list,
        );
        assert!(plan.restart);
        assert_eq!(plan.input, None);
        assert_eq!(plan.output, None);
    }

    #[test]
    fn an_empty_device_list_does_not_restart_forever() {
        let list = DeviceList::default();
        let plan = reconcile_devices(None, None, None, None, &list);
        assert!(!plan.restart);
    }

    #[test]
    fn stored_volume_and_mute_are_replayed_to_a_new_track() {
        let mut volumes = HashMap::new();
        volumes.insert("alice".to_owned(), 0.5);
        let mut mutes = HashSet::new();
        mutes.insert("bob".to_owned());
        assert_eq!(
            replay_settings(&volumes, &mutes, "alice"),
            (Some(0.5), false)
        );
        assert_eq!(replay_settings(&volumes, &mutes, "bob"), (None, true));
        assert_eq!(replay_settings(&volumes, &mutes, "carol"), (None, false));
    }

    /// Regression: channel switch and reconnect create a fresh mixer track at
    /// 100 % / unmuted; the stored per-user settings must be re-applied to it.
    #[test]
    fn a_resubscribed_track_gets_the_stored_volume_and_mute_back() {
        use crate::mixer::Mixer;

        let mut volumes = HashMap::new();
        volumes.insert("alice".to_owned(), 0.5);
        let mut mutes = HashSet::new();
        mutes.insert("bob".to_owned());

        let mut mixer = Mixer::new();
        let (mut alice, _) = mixer.add_track("alice");
        let (mut bob, _) = mixer.add_track("bob");
        for (identity, track) in [("alice", &mut alice), ("bob", &mut bob)] {
            let (volume, muted) = replay_settings(&volumes, &mutes, identity);
            if let Some(volume) = volume {
                mixer.set_volume(identity, volume);
            }
            if muted {
                mixer.set_muted(identity, true);
            }
            // Three frames: the receive ring reserves 30 ms before it plays.
            for _ in 0..3 {
                track.push(&[10_000; FRAME_SAMPLES]);
            }
        }
        let mut out = [0i16; FRAME_SAMPLES];
        mixer.mix(&mut out);
        assert!(
            out.iter().all(|sample| *sample == 5_000),
            "volume was not applied"
        );

        // Unsubscribe both participants, then subscribe them again: this is the
        // path a channel switch and a reconnect take.
        mixer.remove_track("alice");
        mixer.remove_track("bob");
        let (mut alice, _) = mixer.add_track("alice");
        let (mut bob, _) = mixer.add_track("bob");
        for (identity, track) in [("alice", &mut alice), ("bob", &mut bob)] {
            let (volume, muted) = replay_settings(&volumes, &mutes, identity);
            if let Some(volume) = volume {
                mixer.set_volume(identity, volume);
            }
            if muted {
                mixer.set_muted(identity, true);
            }
            for _ in 0..3 {
                track.push(&[10_000; FRAME_SAMPLES]);
            }
        }
        let mut out = [0i16; FRAME_SAMPLES];
        mixer.mix(&mut out);
        assert!(
            out.iter().all(|sample| *sample == 5_000),
            "the fresh track lost the stored volume or mute"
        );
    }

    #[test]
    fn a_failed_audio_rebuild_is_retried_on_its_deadline() {
        let now = Instant::now();
        assert!(!audio_retry_due(false, Some(now), now));
        assert!(!audio_retry_due(true, None, now));
        assert!(!audio_retry_due(
            true,
            Some(now + Duration::from_secs(1)),
            now
        ));
        assert!(audio_retry_due(true, Some(now), now));
        assert!(audio_retry_due(
            true,
            Some(now - Duration::from_secs(1)),
            now
        ));
    }

    #[test]
    fn a_stream_error_rebuild_is_rate_limited_and_backs_off() {
        let now = Instant::now();
        let mut policy = StreamErrorPolicy::default();
        assert_eq!(
            policy.observe(StreamSide::Capture, now),
            StreamErrorDecision::Rebuild
        );
        // The next error arrives on the following heartbeat: it must not
        // rebuild (and therefore reconnect the media session) again.
        assert_eq!(
            policy.observe(StreamSide::Capture, now + Duration::from_millis(500)),
            StreamErrorDecision::Deferred
        );
        assert!(!policy.pending_due(now + Duration::from_millis(1_500)));
        // The deferred rebuild happens when the first window expires.
        assert!(policy.pending_due(now + Duration::from_secs(2)));
        // A different side shares the same tract-wide backoff.
        assert_eq!(
            policy.observe(StreamSide::Playback, now + Duration::from_millis(2_100)),
            StreamErrorDecision::Deferred
        );
        assert!(!policy.pending_due(now + Duration::from_secs(5)));
        // Second window: twice as long.
        assert!(policy.pending_due(now + Duration::from_secs(6)));
        // A stream that keeps failing produces a new error per heartbeat.
        assert_eq!(
            policy.observe(StreamSide::Capture, now + Duration::from_secs(13)),
            StreamErrorDecision::Deferred
        );
        assert!(policy.pending_due(now + Duration::from_secs(14)));
        // The delay is capped, so a long-failing device is retried every 30 s.
        assert_eq!(
            policy.observe(StreamSide::Capture, now + Duration::from_secs(29)),
            StreamErrorDecision::Deferred
        );
        assert!(policy.pending_due(now + Duration::from_secs(30)));
        assert_eq!(
            policy.observe(StreamSide::Capture, now + Duration::from_secs(59)),
            StreamErrorDecision::Deferred
        );
        assert!(policy.pending_due(now + Duration::from_secs(60)));
    }

    #[test]
    fn a_stable_tract_forgets_the_stream_error_backoff() {
        let now = Instant::now();
        let mut policy = StreamErrorPolicy::default();
        assert_eq!(
            policy.observe(StreamSide::Capture, now),
            StreamErrorDecision::Rebuild
        );
        policy.rebuilt(now);
        policy.settle(now + Duration::from_secs(19));
        // Less than twenty healthy seconds: the error counter is kept, so the
        // next rebuild still opens a 4 s window instead of the initial 2 s.
        assert_eq!(
            policy.observe(StreamSide::Capture, now + Duration::from_secs(19)),
            StreamErrorDecision::Rebuild
        );
        policy.rebuilt(now + Duration::from_secs(19));
        assert_eq!(
            policy.observe(StreamSide::Playback, now + Duration::from_secs(21)),
            StreamErrorDecision::Deferred
        );

        // Twenty healthy seconds reset the counter: the next unplug rebuilds
        // at once and starts from the shortest window again.
        let mut policy = StreamErrorPolicy::default();
        assert_eq!(
            policy.observe(StreamSide::Capture, now),
            StreamErrorDecision::Rebuild
        );
        policy.rebuilt(now);
        policy.settle(now + STREAM_ERROR_STABLE_AFTER);
        assert_eq!(policy.rebuilds, 0);
        assert_eq!(
            policy.observe(StreamSide::Playback, now + STREAM_ERROR_STABLE_AFTER),
            StreamErrorDecision::Rebuild
        );
    }

    #[test]
    fn the_stream_error_backoff_never_exceeds_its_cap() {
        assert_eq!(stream_error_delay(1), Duration::from_secs(2));
        assert_eq!(stream_error_delay(2), Duration::from_secs(4));
        assert_eq!(stream_error_delay(3), Duration::from_secs(8));
        assert_eq!(stream_error_delay(4), Duration::from_secs(16));
        assert_eq!(stream_error_delay(5), Duration::from_secs(30));
        assert_eq!(
            stream_error_delay(u32::MAX),
            Duration::from_secs(30),
            "a saturated counter must not overflow the shift"
        );
    }

    #[test]
    fn a_local_publish_error_is_retried_after_its_delay() {
        let now = Instant::now();
        assert!(publish_retry_due(None, now));
        assert!(!publish_retry_due(Some(now + Duration::from_secs(1)), now));
        assert!(publish_retry_due(Some(now), now));
    }
}
