//! The real-time audio runtime: capture thread, APM, gate, and the playback
//! mixer thread.
//!
//! Threading rules (CONTRIBUTING.md, ADR 0002):
//! - cpal callbacks only convert samples and move them through lock-free rings;
//!   they never lock, allocate or log;
//! - APM, the gate and publishing run on a dedicated capture thread, not in a
//!   `tokio` task behind a mutex;
//! - the playback mixer runs on its own thread and feeds the output callback
//!   and the AEC reference ring through rings.
//!
//! The engine controls the threads through atomics (gate, mute, deafen) and a
//! small command channel that the playback thread drains; none of that touches
//! the cpal callbacks.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

use crate::devices::{self, CaptureStream, PlaybackStream, StreamError, StreamFormatInfo};
use crate::dump::{AudioDump, DumpKind, DumpTap};
use crate::error::VoiceError;
use crate::frame::{FRAME_SAMPLES, SAMPLE_RATE, SILENCE_DB};
use crate::gate::{Gate, GateMode, VAD_THRESHOLD};
use crate::level::LevelSmoother;
use crate::mixer::{FrameReader, Mixer, TrackLevel};
use crate::processing::{ApmProcessor, ProcessingSettings};
use crate::scheduler::{self, AudioScheduler};
use crate::sounds::{EventSound, SoundPlayer, SoundSettings};
use crate::stats::AudioCounters;

/// One second of input audio at the highest common device rate.
const INPUT_RING: usize = 96_000;
/// Half a second of frames waiting for the publisher task.
const PUBLISH_RING: usize = 24_000;
/// 250 ms of playback reference for AEC.
const REFERENCE_RING: usize = 12_000;
/// 250 ms of microphone loopback.
const LOCAL_RING: usize = 12_000;
/// One second of playback at the highest common device rate.
const OUTPUT_RING: usize = 96_000;
/// Three frames primed into the output ring: 30 ms in device samples
/// (stage 2.3.2c). The speakers clock the receive path, so the loop mixes a
/// frame only after the device has taken one; this reserve covers the device
/// callback that arrives between two polls.
const OUTPUT_TARGET_FRAMES: usize = 3;
/// How often the playback thread checks the output ring when the speakers
/// drive the receive path (stage 2.3.2c). The device consumes one 10 ms frame
/// per 10 ms, so a 2 ms poll keeps the ring at its target without a timer of
/// its own.
const PLAYBACK_POLL: Duration = Duration::from_millis(2);
/// Three frames primed into the microphone-loop ring when monitoring starts,
/// for the same reason as the publish ring: two independent 10 ms pacers must
/// not read with zero slack. Only the last of them is the current frame; the
/// first [`LOCAL_PRIME_FRAMES`]−1 are silence, because replaying the same frame
/// three times was audible as a stutter at the start of every push-to-talk
/// press (stage 2.3.4).
const LOCAL_PRIME_FRAMES: usize = 3;
/// Voice activation decides on the freshest frame but publishes one that is
/// [`PREROLL_FRAMES`] old, so the 30 ms before the threshold crossing — the
/// start of a quiet word — is not lost (stage 2.3.2d). Push-to-talk and
/// continuous mode have no such line: their extra 30 ms would buy nothing.
const PREROLL_FRAMES: usize = 3;
/// Push-to-talk keeps the two frames before the press (20 ms) so a word that
/// began just before the key went down still reaches the room (stage 2.3.4).
/// They are sent only when they look like speech: on a press after silence or
/// noise nothing is replayed and the latency does not grow.
const PTT_PREROLL_FRAMES: usize = 2;
/// AEC reference ring: above 100 ms it is behind the capture path and is cut
/// back to 30 ms; the capture thread only ever reads whole frames from it
/// (stage 2.3.2c).
const REFERENCE_MAX: usize = 4_800;
/// The reserve the reference ring is trimmed back to: 30 ms.
const REFERENCE_PRIME: usize = 3 * FRAME_SAMPLES;
/// How often the capture thread polls the input ring when the microphone
/// drives the transfer (stage 2.3.2b). A device delivers one 10 ms frame per
/// 10 ms; polling every 2 ms keeps the frame in the pipeline instead of in the
/// ring, while the 1 ms system timer makes the sleep accurate.
const CAPTURE_POLL: Duration = Duration::from_millis(2);
/// No whole frame for this long means the stream stopped, not that one poll
/// came up short: a healthy device leaves most polls empty (stage 2.3.2b).
pub(crate) const STREAM_STALL: Duration = Duration::from_millis(100);

/// Test-only audio backends (stage 2.3 integration tests).
#[derive(Debug, Clone, Default)]
pub struct TestAudioConfig {
    /// Replace the microphone with a sine tone at this frequency.
    pub tone_hz: Option<f32>,
    /// Replace the microphone with a 48 kHz mono 16-bit WAV file.
    pub input_wav: Option<PathBuf>,
    /// Write the playback mix to this 48 kHz mono 16-bit WAV file instead of
    /// the speakers.
    pub output_wav: Option<PathBuf>,
    /// Simulated input device clock (stage 2.3.2a). The signal comes from
    /// `tone_hz`/`input_wav`; only the timing differs from a real device.
    #[cfg(feature = "test-audio")]
    pub fake_input: Option<crate::testaudio::FakeClock>,
    /// Simulated output device clock (stage 2.3.2a); the played mix goes to
    /// `output_wav` when it is set.
    #[cfg(feature = "test-audio")]
    pub fake_output: Option<crate::testaudio::FakeClock>,
    /// Replace the stream-audio process loopback with a stereo tone at this
    /// frequency (stage P15), so the media tests need no sound card.
    #[cfg(feature = "test-audio")]
    pub stream_tone_hz: Option<f32>,
}

/// Everything the audio runtime needs to build its threads.
#[derive(Debug, Clone)]
pub struct AudioConfig {
    /// Selected input device id; `None` means the system default.
    pub input_device: Option<String>,
    /// Selected output device id; `None` means the system default.
    pub output_device: Option<String>,
    /// APM stages.
    pub processing: ProcessingSettings,
    /// Transmission gate.
    pub gate: GateMode,
    /// Start muted.
    pub self_muted: bool,
    /// Start deafened.
    pub deafened: bool,
    /// Start with the microphone loopback.
    pub mic_test: bool,
    /// Event cue settings.
    pub sounds: SoundSettings,
    /// Master playback gain, 0..200 %.
    pub output_volume: f32,
    /// Level the loudness of incoming voices (stage P17).
    pub level_voices: bool,
    /// Test backends; only honoured with the `test-audio` feature.
    pub test: Option<TestAudioConfig>,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            input_device: None,
            output_device: None,
            processing: ProcessingSettings::default(),
            gate: GateMode::default(),
            self_muted: false,
            deafened: false,
            mic_test: false,
            sounds: SoundSettings::default(),
            output_volume: 1.0,
            level_voices: false,
            test: None,
        }
    }
}

const GATE_CONTINUOUS: u8 = 0;
const GATE_PUSH_TO_TALK: u8 = 1;
const GATE_VOICE_ACTIVATION: u8 = 2;

/// Which half of the tract reported a cpal stream error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamSide {
    /// Microphone.
    Capture,
    /// Speakers or headphones.
    Playback,
}

impl StreamSide {
    /// Name used in logs.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::Playback => "playback",
        }
    }
}

/// A stream error and the half of the tract it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamErrorEvent {
    /// Capturing or playing side.
    pub side: StreamSide,
    /// Kind and text captured in the cpal callback.
    pub error: StreamError,
}

/// State shared between the engine, the audio threads and the reporter.
#[derive(Debug)]
pub struct SharedAudio {
    /// Smoothed level of the processed microphone signal, dBFS.
    own_level_bits: AtomicU32,
    /// True while the gate transmits.
    own_speaking: AtomicBool,
    /// True while the gate is open (independent of the speaking threshold).
    gate_open: AtomicBool,
    /// Capture stalls: 100 ms without a single whole frame from the device.
    /// An empty poll between two 10 ms frames is normal and is not counted
    /// (stage 2.3.2b).
    capture_underruns: AtomicU64,
    /// Frames the capture path filled only partially (`0 < written < 480`).
    /// The device and fake-device paths forward whole frames only, so they
    /// never increment this; it stays for the file and silent sources.
    partial_capture_frames: AtomicU64,
    /// Samples the capture callback could not push because the input ring was
    /// full.
    input_overflows: Arc<AtomicU64>,
    /// Samples the resampler dropped because its buffer was full.
    resampler_overflows: AtomicU64,
    /// Frames the capture thread could not push into the publish ring, plus
    /// frames the publisher drained to bound the latency.
    publish_overflows: AtomicU64,
    /// Publisher stalls: 100 ms without a whole frame to send. An empty poll
    /// between two 10 ms frames is normal and is not counted (stage 2.3.2b).
    publish_underruns: AtomicU64,
    /// Remote tracks that had no audio for a mixer frame.
    mixer_underruns: AtomicU64,
    /// Bounded trims of receive rings that ran ahead of the output clock
    /// (stage 2.3.2c).
    track_trims: AtomicU64,
    /// AEC reference ring trims: it fell behind the capture path by more than
    /// 100 ms (stage 2.3.2c).
    reference_trims: AtomicU64,
    /// Frames rejected by `AudioProcessingModule`.
    apm_errors: Arc<AtomicU64>,
    capture_error: Arc<crate::devices::StreamErrorState>,
    playback_error: Arc<crate::devices::StreamErrorState>,
    playback_drops: Arc<AtomicU64>,
    self_muted: AtomicBool,
    deafened: AtomicBool,
    mic_test: AtomicBool,
    push_to_talk: AtomicBool,
    gate_kind: AtomicU8,
    gate_threshold_bits: AtomicU32,
    gate_hold_ms: AtomicU32,
    /// Test-only: frames with an RNNoise probability and how many of them had
    /// `vad >= VAD_THRESHOLD` (stage 2.3.2e end-to-end test).
    #[cfg(feature = "test-audio")]
    vad_frames: AtomicU64,
    #[cfg(feature = "test-audio")]
    vad_speech_frames: AtomicU64,
}

impl SharedAudio {
    fn new(config: &AudioConfig) -> Self {
        let shared = Self {
            own_level_bits: AtomicU32::new(f32::to_bits(SILENCE_DB)),
            own_speaking: AtomicBool::new(false),
            gate_open: AtomicBool::new(false),
            capture_underruns: AtomicU64::new(0),
            partial_capture_frames: AtomicU64::new(0),
            input_overflows: Arc::new(AtomicU64::new(0)),
            resampler_overflows: AtomicU64::new(0),
            publish_overflows: AtomicU64::new(0),
            publish_underruns: AtomicU64::new(0),
            mixer_underruns: AtomicU64::new(0),
            track_trims: AtomicU64::new(0),
            reference_trims: AtomicU64::new(0),
            apm_errors: Arc::new(AtomicU64::new(0)),
            capture_error: Arc::new(crate::devices::StreamErrorState::new()),
            playback_error: Arc::new(crate::devices::StreamErrorState::new()),
            playback_drops: Arc::new(AtomicU64::new(0)),
            self_muted: AtomicBool::new(config.self_muted),
            deafened: AtomicBool::new(config.deafened),
            mic_test: AtomicBool::new(config.mic_test),
            push_to_talk: AtomicBool::new(false),
            gate_kind: AtomicU8::new(GATE_CONTINUOUS),
            gate_threshold_bits: AtomicU32::new(f32::to_bits(-45.0)),
            gate_hold_ms: AtomicU32::new(300),
            #[cfg(feature = "test-audio")]
            vad_frames: AtomicU64::new(0),
            #[cfg(feature = "test-audio")]
            vad_speech_frames: AtomicU64::new(0),
        };
        shared.set_gate_mode(config.gate);
        shared
    }

    /// Own microphone level in dBFS.
    #[must_use]
    pub fn own_level_db(&self) -> f32 {
        f32::from_bits(self.own_level_bits.load(Ordering::Relaxed))
    }

    /// Level for the control-bar meter.
    ///
    /// In push-to-talk the meter stays at silence until the button is held:
    /// otherwise it moves while the user is not transmitting and reads as
    /// "the microphone is always on" (stage 2.3.1 feedback).
    #[must_use]
    pub fn meter_level_db(&self) -> f32 {
        if self.gate_mode() == GateMode::PushToTalk && !self.push_to_talk.load(Ordering::Relaxed) {
            SILENCE_DB
        } else {
            self.own_level_db()
        }
    }

    /// True while the own microphone is transmitting.
    #[must_use]
    pub fn own_speaking(&self) -> bool {
        self.own_speaking.load(Ordering::Relaxed)
    }

    /// True while the transmission gate is open.
    #[must_use]
    pub fn gate_open(&self) -> bool {
        self.gate_open.load(Ordering::Relaxed)
    }

    /// Whether the publisher should feed frames to the room.
    ///
    /// An explicit mute or a released push-to-talk key must stop the RTP
    /// stream, not merely turn the samples into silence: the other side then
    /// sees no packets at all (stage 2.3.1). Voice activation keeps feeding
    /// silence, so its DTX and the receiver's jitter buffer behave as before.
    #[must_use]
    pub fn feeds_publisher(&self) -> bool {
        if self.self_muted() {
            return false;
        }
        match self.gate_mode() {
            GateMode::PushToTalk => self.push_to_talk.load(Ordering::Relaxed),
            _ => true,
        }
    }

    /// Capture underruns since start.
    #[must_use]
    pub fn capture_underruns(&self) -> u64 {
        self.capture_underruns.load(Ordering::Relaxed)
    }

    /// Increments the capture-underrun counter (the device produced no whole
    /// frame for 100 ms: it is gone, not merely late).
    pub fn note_capture_underrun(&self) {
        self.capture_underruns.fetch_add(1, Ordering::Relaxed);
    }

    /// Records a capture frame that the source filled only partially.
    ///
    /// The device path never does this after 2.3.2b: it waits for a whole
    /// frame instead of padding with silence. The file source can still be
    /// short on its first frame, which waits for the resampler's lookahead.
    pub fn note_partial_capture_frame(&self) {
        self.partial_capture_frames.fetch_add(1, Ordering::Relaxed);
    }

    /// Input-ring overflow counter shared with the cpal callback.
    #[must_use]
    pub fn input_overflow_counter(&self) -> Arc<AtomicU64> {
        self.input_overflows.clone()
    }

    /// APM error counter shared with the processor.
    #[must_use]
    pub fn apm_error_counter(&self) -> Arc<AtomicU64> {
        self.apm_errors.clone()
    }

    /// Records samples dropped by the resampler.
    pub fn note_resampler_overflow(&self, samples: u64) {
        if samples > 0 {
            self.resampler_overflows
                .fetch_add(samples, Ordering::Relaxed);
        }
    }

    /// Records a publish-ring overflow (one 10 ms frame).
    pub fn note_publish_overflow(&self) {
        self.publish_overflows.fetch_add(1, Ordering::Relaxed);
    }

    /// Records a publisher stall (no whole frame to send for 100 ms).
    pub fn note_publish_underrun(&self) {
        self.publish_underruns.fetch_add(1, Ordering::Relaxed);
    }

    /// Records remote tracks that starved the mixer.
    pub fn note_mixer_underrun(&self, tracks: u64) {
        if tracks > 0 {
            self.mixer_underruns.fetch_add(tracks, Ordering::Relaxed);
        }
    }

    /// Records bounded trims of receive rings (stage 2.3.2c).
    pub fn note_track_trims(&self, trims: u64) {
        if trims > 0 {
            self.track_trims.fetch_add(trims, Ordering::Relaxed);
        }
    }

    /// Records a trim of the AEC reference ring (stage 2.3.2c).
    pub fn note_reference_trim(&self) {
        self.reference_trims.fetch_add(1, Ordering::Relaxed);
    }

    /// Snapshot of every pipeline counter.
    #[must_use]
    pub fn counters(&self) -> AudioCounters {
        AudioCounters {
            capture_underruns: self.capture_underruns.load(Ordering::Relaxed),
            partial_capture_frames: self.partial_capture_frames.load(Ordering::Relaxed),
            input_overflows: self.input_overflows.load(Ordering::Relaxed),
            resampler_overflows: self.resampler_overflows.load(Ordering::Relaxed),
            publish_overflows: self.publish_overflows.load(Ordering::Relaxed),
            publish_underruns: self.publish_underruns.load(Ordering::Relaxed),
            playback_underruns: self.playback_drops.load(Ordering::Relaxed),
            mixer_underruns: self.mixer_underruns.load(Ordering::Relaxed),
            track_trims: self.track_trims.load(Ordering::Relaxed),
            reference_trims: self.reference_trims.load(Ordering::Relaxed),
            apm_errors: self.apm_errors.load(Ordering::Relaxed),
        }
    }

    /// Test-only VAD counters, fed by the capture thread when RNNoise runs.
    ///
    /// Returns `(speech frames, frames with a probability)`: a frame counts as
    /// speech when `vad >= VAD_THRESHOLD`. Used by the 2.3.2e end-to-end test
    /// to prove that quiet speech passes the VAD gate; production builds do
    /// not compile this counter at all.
    #[cfg(feature = "test-audio")]
    #[must_use]
    pub fn vad_frame_counts(&self) -> (u64, u64) {
        (
            self.vad_speech_frames.load(Ordering::Relaxed),
            self.vad_frames.load(Ordering::Relaxed),
        )
    }

    #[cfg(feature = "test-audio")]
    pub(crate) fn note_vad_frame(&self, vad: Option<f32>) {
        let Some(probability) = vad else {
            return;
        };
        self.vad_frames.fetch_add(1, Ordering::Relaxed);
        if probability >= VAD_THRESHOLD {
            self.vad_speech_frames.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Takes the next stream error, capture before playback.
    ///
    /// The engine classifies it and decides whether the tract needs a rebuild;
    /// taking it here also clears the slot so the same error is not handled on
    /// every heartbeat.
    pub fn take_stream_error(&self) -> Option<StreamErrorEvent> {
        if let Some(error) = self.capture_error.take() {
            return Some(StreamErrorEvent {
                side: StreamSide::Capture,
                error,
            });
        }
        self.playback_error.take().map(|error| StreamErrorEvent {
            side: StreamSide::Playback,
            error,
        })
    }

    /// Playback frames that had no audio; updated by the output callback.
    #[must_use]
    pub fn buffer_drops(&self) -> u64 {
        self.playback_drops.load(Ordering::Relaxed)
    }

    /// Enables or disables the own microphone.
    pub fn set_self_muted(&self, muted: bool) {
        self.self_muted.store(muted, Ordering::Relaxed);
    }

    /// Own mute flag.
    #[must_use]
    pub fn self_muted(&self) -> bool {
        self.self_muted.load(Ordering::Relaxed)
    }

    /// Enables or disables all playback.
    pub fn set_deafened(&self, deafened: bool) {
        self.deafened.store(deafened, Ordering::Relaxed);
    }

    /// Deafen flag.
    #[must_use]
    pub fn deafened(&self) -> bool {
        self.deafened.load(Ordering::Relaxed)
    }

    /// Enables or disables the microphone loopback.
    pub fn set_mic_test(&self, enabled: bool) {
        self.mic_test.store(enabled, Ordering::Relaxed);
    }

    /// Microphone loopback flag.
    #[must_use]
    pub fn mic_test(&self) -> bool {
        self.mic_test.load(Ordering::Relaxed)
    }

    /// Push-to-talk key state.
    pub fn set_push_to_talk(&self, active: bool) {
        self.push_to_talk.store(active, Ordering::Relaxed);
    }

    /// Replaces the gate mode.
    pub fn set_gate_mode(&self, mode: GateMode) {
        match mode {
            GateMode::Continuous => self.gate_kind.store(GATE_CONTINUOUS, Ordering::Relaxed),
            GateMode::PushToTalk => self.gate_kind.store(GATE_PUSH_TO_TALK, Ordering::Relaxed),
            GateMode::VoiceActivation {
                threshold_db,
                hold_ms,
            } => {
                self.gate_threshold_bits
                    .store(f32::to_bits(threshold_db), Ordering::Relaxed);
                self.gate_hold_ms.store(hold_ms, Ordering::Relaxed);
                self.gate_kind
                    .store(GATE_VOICE_ACTIVATION, Ordering::Relaxed);
            }
        }
    }

    fn gate_mode(&self) -> GateMode {
        match self.gate_kind.load(Ordering::Relaxed) {
            GATE_PUSH_TO_TALK => GateMode::PushToTalk,
            GATE_VOICE_ACTIVATION => GateMode::VoiceActivation {
                threshold_db: f32::from_bits(self.gate_threshold_bits.load(Ordering::Relaxed)),
                hold_ms: self.gate_hold_ms.load(Ordering::Relaxed),
            },
            _ => GateMode::Continuous,
        }
    }
}

/// Control messages for the playback thread; sent from the engine, never from
/// an audio callback.
pub enum MixerUpdate {
    /// A remote track was subscribed.
    Add {
        identity: String,
        consumer: HeapCons<i16>,
        level: Arc<TrackLevel>,
    },
    /// A remote track was unsubscribed.
    Remove(String),
    /// Per-user volume, 0..200 %.
    Volume { identity: String, volume: f32 },
    /// Local mute of a user.
    Muted { identity: String, muted: bool },
    /// Master playback volume, 0..200 %.
    MasterVolume(f32),
    /// Level the loudness of incoming voices (stage P17).
    Leveling(bool),
    /// Play an event cue; `preview` ignores the switches (settings window).
    Sound { sound: EventSound, preview: bool },
    /// Replace the cue settings.
    Sounds(SoundSettings),
}

/// A running capture and playback pipeline.
pub struct AudioRuntime {
    shared: Arc<SharedAudio>,
    mixer: Sender<MixerUpdate>,
    apm: Sender<ApmProcessor>,
    publish: Option<HeapCons<i16>>,
    shutdown: Arc<AtomicBool>,
    capture_thread: Option<std::thread::JoinHandle<()>>,
    playback_thread: Option<std::thread::JoinHandle<()>>,
    capture_device: Option<String>,
    playback_device: Option<String>,
    capture_rate: u32,
    playback_rate: u32,
    /// Formats the streams were opened with (stage P5, diagnostics).
    capture_format: Option<StreamFormatInfo>,
    playback_format: Option<StreamFormatInfo>,
    /// WAV dumps, present only with `ROSTALK_AUDIO_DUMP` in a debug build.
    dump: Option<AudioDump>,
}

impl AudioRuntime {
    /// Builds the streams and starts both threads.
    ///
    /// A missing input or output device does not fail the whole engine: the
    /// corresponding side runs on silence and the engine reports it to the UI.
    pub fn start(config: &AudioConfig) -> Result<Self, VoiceError> {
        let shared = Arc::new(SharedAudio::new(config));
        let shutdown = Arc::new(AtomicBool::new(false));
        let scheduler = Arc::new(AudioScheduler::new());

        // Capture rings.
        let input_ring = HeapRb::<f32>::new(INPUT_RING);
        let (input_producer, input_consumer) = input_ring.split();
        let publish_ring = HeapRb::<i16>::new(PUBLISH_RING);
        let (publish_producer, publish_consumer) = publish_ring.split();
        let reference_ring = HeapRb::<i16>::new(REFERENCE_RING);
        let (reference_producer, reference_consumer) = reference_ring.split();
        let local_ring = HeapRb::<i16>::new(LOCAL_RING);
        let (local_producer, local_consumer) = local_ring.split();
        let output_ring = HeapRb::<f32>::new(OUTPUT_RING);
        let (mut output_producer, output_consumer) = output_ring.split();
        // The device starts consuming as soon as the stream is open, which is
        // before the playback thread has run once. Prime the ring with the
        // same 30 ms of silence the thread keeps there (stage 2.3.2c): without
        // it the first callbacks are counted as output underruns.
        let silence = [0.0f32; OUTPUT_TARGET_FRAMES * FRAME_SAMPLES];
        let _ = output_producer.push_slice(&silence);

        // Capture side.
        let capture = open_capture(config, input_producer, input_consumer, &shared)?;

        // Playback side.
        let playback = open_playback(config, output_producer, output_consumer, &shared)?;

        let (mixer_sender, mixer_receiver) = mpsc::channel();
        let (apm_sender, apm_receiver) = mpsc::channel();

        // Debug dumps: the taps move to the audio threads, the dump itself
        // stays with the runtime so it can stop the writers.
        let mut dump = AudioDump::from_env();
        let capture_dump = CaptureDump {
            raw: dump.as_mut().and_then(|dump| dump.tap(DumpKind::Raw)),
            apm: dump.as_mut().and_then(|dump| dump.tap(DumpKind::Apm)),
            sent: dump.as_mut().and_then(|dump| dump.tap(DumpKind::Sent)),
        };
        let output_dump = dump.as_mut().and_then(|dump| dump.tap(DumpKind::Out));

        let capture_ctx = CaptureContext {
            shared: shared.clone(),
            shutdown: shutdown.clone(),
            scheduler: scheduler.clone(),
            source: capture.source,
            apm: ApmProcessor::new(config.processing, shared.apm_error_counter()),
            apm_updates: apm_receiver,
            gate: Gate::new(),
            preroll: Preroll::default(),
            preroll_active: false,
            ptt_history: PttHistory::default(),
            ptt_active: false,
            ptt_previous: false,
            mic_test_primed: false,
            smoother: LevelSmoother::default(),
            publish: publish_producer,
            reference: reference_consumer,
            local: local_producer,
            dump: capture_dump,
        };
        let capture_thread = std::thread::Builder::new()
            .name("rostalk-capture".to_owned())
            .spawn(move || capture_loop(capture_ctx))
            .map_err(|error| VoiceError::Internal(format!("start capture thread: {error}")))?;

        let output_target = playback_target(&playback.sink, playback.rate);
        let playback_ctx = PlaybackContext {
            shared: shared.clone(),
            shutdown: shutdown.clone(),
            scheduler: scheduler.clone(),
            mixer: {
                let mut mixer = Mixer::new();
                mixer.set_master_volume(config.output_volume);
                mixer.set_leveling(config.level_voices);
                mixer
            },
            updates: mixer_receiver,
            reference: reference_producer,
            local: FrameReader::looped(local_consumer),
            sounds: SoundPlayer::new(config.sounds),
            sink: playback.sink,
            target: output_target,
            dump: output_dump,
        };
        let playback_thread = std::thread::Builder::new()
            .name("rostalk-playback".to_owned())
            .spawn(move || playback_loop(playback_ctx))
            .map_err(|error| VoiceError::Internal(format!("start playback thread: {error}")))?;

        Ok(Self {
            shared,
            mixer: mixer_sender,
            apm: apm_sender,
            publish: Some(publish_consumer),
            shutdown,
            capture_thread: Some(capture_thread),
            playback_thread: Some(playback_thread),
            capture_device: capture.device,
            playback_device: playback.device,
            capture_rate: capture.rate,
            playback_rate: playback.rate,
            capture_format: capture.format,
            playback_format: playback.format,
            dump,
        })
    }

    /// Shared live state.
    #[must_use]
    pub fn shared(&self) -> Arc<SharedAudio> {
        self.shared.clone()
    }

    /// Takes the consumer of published frames. Only one publisher exists.
    pub fn take_publish_consumer(&mut self) -> Option<HeapCons<i16>> {
        self.publish.take()
    }

    /// Sends a control message to the playback thread.
    pub fn update(&self, update: MixerUpdate) {
        let _ = self.mixer.send(update);
    }

    /// Swaps the APM configuration on the capture thread without restarting
    /// the streams or the room.
    pub fn set_processing(&self, settings: ProcessingSettings) {
        let _ = self
            .apm
            .send(ApmProcessor::new(settings, self.shared.apm_error_counter()));
    }

    /// Id of the opened input device, if it is a real device.
    #[must_use]
    pub fn capture_device(&self) -> Option<&str> {
        self.capture_device.as_deref()
    }

    /// Creates a dump point for one remote track, if dumping is on.
    ///
    /// Called from the engine thread when a track is subscribed; not an audio
    /// callback.
    pub(crate) fn dump_receiver(&mut self) -> Option<DumpTap> {
        self.dump.as_mut().and_then(|dump| dump.receiver())
    }

    /// Id of the opened output device, if it is a real device.
    #[must_use]
    pub fn playback_device(&self) -> Option<&str> {
        self.playback_device.as_deref()
    }

    /// Format the input stream was opened with, for the diagnostics export.
    #[must_use]
    pub fn capture_format(&self) -> Option<&StreamFormatInfo> {
        self.capture_format.as_ref()
    }

    /// Format the output stream was opened with, for the diagnostics export.
    #[must_use]
    pub fn playback_format(&self) -> Option<&StreamFormatInfo> {
        self.playback_format.as_ref()
    }

    /// Native capture rate before the resampler.
    #[must_use]
    pub fn capture_rate(&self) -> u32 {
        self.capture_rate
    }

    /// Native playback rate before the resampler.
    #[must_use]
    pub fn playback_rate(&self) -> u32 {
        self.playback_rate
    }

    /// Stops both threads and releases the devices.
    pub fn stop(mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        // Wake a sleeping thread: both loops sleep at most 10 ms.
        if let Some(handle) = self.capture_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.playback_thread.take() {
            let _ = handle.join();
        }
        // The taps are gone with the threads; flush the dumps and patch their
        // WAV headers.
        if let Some(dump) = self.dump.take() {
            dump.finish();
        }
    }
}

// The error and drop counters are shared with the cpal callbacks; the helpers
// below keep their construction in one place.

enum CaptureSource {
    Device(Box<DeviceCapture>),
    #[cfg(feature = "test-audio")]
    Test(crate::testaudio::TestSource),
    /// Simulated device with its own clock (stage 2.3.2a).
    #[cfg(feature = "test-audio")]
    Fake(Box<FakeCapture>),
    Null,
}

struct DeviceCapture {
    #[allow(dead_code)]
    stream: CaptureStream,
    consumer: HeapCons<f32>,
    resampler: crate::resample::Resampler,
    /// Resampler drops already copied into the shared counter.
    reported_dropped: u64,
}

impl CaptureSource {
    /// True when the source has its own hardware clock and therefore drives
    /// the frame rate (stage 2.3.2b).
    ///
    /// The file source and the silent fallback have no device behind them and
    /// keep the old 10 ms tempo.
    fn is_clocked(&self) -> bool {
        match self {
            Self::Device(_) => true,
            #[cfg(feature = "test-audio")]
            Self::Fake(_) => true,
            _ => false,
        }
    }
}

/// A fake device behaves exactly like [`DeviceCapture`]; only its clock and
/// the transport differ.
#[cfg(feature = "test-audio")]
struct FakeCapture {
    #[allow(dead_code)]
    device: crate::testaudio::FakeDevice,
    consumer: HeapCons<f32>,
    resampler: crate::resample::Resampler,
    reported_dropped: u64,
}

/// A capture side that was opened: the source, the device id and the formats.
struct OpenedCapture {
    source: CaptureSource,
    device: Option<String>,
    rate: u32,
    format: Option<StreamFormatInfo>,
}

/// A playback side that was opened: the sink, the device id and the formats.
struct OpenedPlayback {
    sink: PlaybackSink,
    device: Option<String>,
    rate: u32,
    format: Option<StreamFormatInfo>,
}

/// Opens a simulated input device, a file source or the real microphone, in
/// that order (stage 2.3.2a).
fn open_capture(
    config: &AudioConfig,
    producer: HeapProd<f32>,
    consumer: HeapCons<f32>,
    shared: &SharedAudio,
) -> Result<OpenedCapture, VoiceError> {
    #[cfg(feature = "test-audio")]
    if let Some(clock) = config.test.as_ref().and_then(|test| test.fake_input) {
        let source = match build_test_source(config) {
            Some(Ok(source)) => source,
            Some(Err(error)) => return Err(error),
            None => {
                return Err(VoiceError::TestAudio(
                    "fake_input needs tone_hz or input_wav as its signal".to_owned(),
                ))
            }
        };
        let device = crate::testaudio::FakeDevice::start(
            clock,
            source,
            producer,
            shared.capture_error.clone(),
            shared.input_overflow_counter(),
        )?;
        let source = CaptureSource::Fake(Box::new(FakeCapture {
            device,
            consumer,
            resampler: crate::resample::Resampler::new(SAMPLE_RATE),
            reported_dropped: 0,
        }));
        return Ok(OpenedCapture {
            source,
            device: None,
            rate: SAMPLE_RATE,
            format: None,
        });
    }
    #[cfg(feature = "test-audio")]
    if let Some(source) = build_test_source(config) {
        return Ok(OpenedCapture {
            source: CaptureSource::Test(source?),
            device: None,
            rate: SAMPLE_RATE,
            format: None,
        });
    }
    match devices::open_capture(
        config.input_device.as_deref(),
        producer,
        shared.capture_error.clone(),
        shared.input_overflow_counter(),
    ) {
        Ok(stream) => {
            let device = Some(stream.device_id().to_owned());
            let rate = stream.sample_rate();
            let format = Some(stream.format().clone());
            Ok(OpenedCapture {
                source: CaptureSource::Device(Box::new(DeviceCapture {
                    stream,
                    consumer,
                    resampler: crate::resample::Resampler::new(rate),
                    reported_dropped: 0,
                })),
                device,
                rate,
                format,
            })
        }
        Err(error) => {
            log::warn!("no microphone, capturing silence: {error}");
            Ok(OpenedCapture {
                source: CaptureSource::Null,
                device: None,
                rate: SAMPLE_RATE,
                format: None,
            })
        }
    }
}

/// Opens a simulated output device, a WAV recorder or the real speakers, in
/// that order (stage 2.3.2a).
fn open_playback(
    config: &AudioConfig,
    producer: HeapProd<f32>,
    consumer: HeapCons<f32>,
    shared: &SharedAudio,
) -> Result<OpenedPlayback, VoiceError> {
    #[cfg(feature = "test-audio")]
    if let Some(clock) = config.test.as_ref().and_then(|test| test.fake_output) {
        let path = config
            .test
            .as_ref()
            .and_then(|test| test.output_wav.clone());
        let output = crate::testaudio::FakeOutput::start(
            clock,
            consumer,
            path.as_deref(),
            shared.playback_drops.clone(),
        )?;
        let sink = PlaybackSink::Fake(Box::new(FakePlayback { output, producer }));
        return Ok(OpenedPlayback {
            sink,
            device: None,
            rate: SAMPLE_RATE,
            format: None,
        });
    }
    #[cfg(feature = "test-audio")]
    if let Some(sink) = build_test_sink(config) {
        return Ok(OpenedPlayback {
            sink: PlaybackSink::Test(sink?),
            device: None,
            rate: SAMPLE_RATE,
            format: None,
        });
    }
    match devices::open_playback(
        config.output_device.as_deref(),
        consumer,
        shared.playback_error.clone(),
        shared.playback_drops.clone(),
    ) {
        Ok(stream) => {
            let device = Some(stream.device_id().to_owned());
            let rate = stream.sample_rate();
            let format = Some(stream.format().clone());
            Ok(OpenedPlayback {
                sink: PlaybackSink::Device(Box::new(DevicePlayback {
                    stream,
                    producer,
                    resampler: crate::resample::Resampler::new_with_rates(SAMPLE_RATE, rate),
                })),
                device,
                rate,
                format,
            })
        }
        Err(error) => {
            log::warn!("no playback device, audio is discarded: {error}");
            Ok(OpenedPlayback {
                sink: PlaybackSink::Null,
                device: None,
                rate: SAMPLE_RATE,
                format: None,
            })
        }
    }
}

struct CaptureContext {
    shared: Arc<SharedAudio>,
    shutdown: Arc<AtomicBool>,
    scheduler: Arc<AudioScheduler>,
    source: CaptureSource,
    apm: ApmProcessor,
    apm_updates: Receiver<ApmProcessor>,
    gate: Gate,
    /// Look-ahead for voice activation. Allocated once, before the loop.
    preroll: Preroll,
    /// Whether the delay line currently belongs to voice activation.
    preroll_active: bool,
    /// The frames just before a push-to-talk press, with their speech verdict.
    ptt_history: PttHistory,
    /// Whether the history currently belongs to push-to-talk.
    ptt_active: bool,
    /// Push-to-talk state on the previous frame, for front-edge detection.
    ptt_previous: bool,
    /// Whether the microphone loop has its priming reserve.
    mic_test_primed: bool,
    smoother: LevelSmoother,
    publish: HeapProd<i16>,
    reference: HeapCons<i16>,
    local: HeapProd<i16>,
    dump: CaptureDump,
}

/// The three capture-side dump points. `None` fields cost one branch per
/// frame when dumping is off.
#[derive(Default)]
struct CaptureDump {
    raw: Option<DumpTap>,
    apm: Option<DumpTap>,
    sent: Option<DumpTap>,
}

impl CaptureDump {
    fn push_raw(&mut self, frame: &[i16]) {
        if let Some(tap) = self.raw.as_mut() {
            tap.push(frame);
        }
    }

    fn push_apm(&mut self, frame: &[i16]) {
        if let Some(tap) = self.apm.as_mut() {
            tap.push(frame);
        }
    }

    fn push_sent(&mut self, frame: &[i16]) {
        if let Some(tap) = self.sent.as_mut() {
            tap.push(frame);
        }
    }
}

/// A fixed three-frame delay line for voice activation (stage 2.3.2d).
///
/// The gate decides on the freshest frame, but the frame sent is the one from
/// [`PREROLL_FRAMES`] frames ago: while the level is still below the threshold
/// the word is already in the line, so opening the gate does not clip its
/// beginning. The buffer is allocated with the context, before the loop.
#[derive(Debug)]
struct Preroll {
    frames: [[i16; FRAME_SAMPLES]; PREROLL_FRAMES],
    index: usize,
}

impl Default for Preroll {
    fn default() -> Self {
        Self {
            frames: [[0i16; FRAME_SAMPLES]; PREROLL_FRAMES],
            index: 0,
        }
    }
}

impl Preroll {
    /// Stores `frame` and returns the one written [`PREROLL_FRAMES`] frames
    /// earlier (silence for the first frames after a reset).
    fn push(&mut self, frame: &[i16; FRAME_SAMPLES]) -> [i16; FRAME_SAMPLES] {
        let delayed = self.frames[self.index];
        self.frames[self.index] = *frame;
        self.index = (self.index + 1) % PREROLL_FRAMES;
        delayed
    }

    /// Drops the history when the gate mode changes.
    fn clear(&mut self) {
        for frame in &mut self.frames {
            frame.fill(0);
        }
        self.index = 0;
    }
}

/// The two frames before a push-to-talk press, with the speech verdict of each.
///
/// PTT publishes the fresh frame, so on a late press the attack is already
/// gone. Keeping the preceding 20 ms lets the front edge replay the start of a
/// word without adding a delay to every frame: after silence or noise the
/// frames are not speech and nothing is replayed (stage 2.3.4). The buffer is
/// fixed and lives with the capture context; the loop only copies into it.
#[derive(Debug)]
struct PttHistory {
    frames: [[i16; FRAME_SAMPLES]; PTT_PREROLL_FRAMES],
    speech: [bool; PTT_PREROLL_FRAMES],
    index: usize,
}

impl Default for PttHistory {
    fn default() -> Self {
        Self {
            frames: [[0i16; FRAME_SAMPLES]; PTT_PREROLL_FRAMES],
            speech: [false; PTT_PREROLL_FRAMES],
            index: 0,
        }
    }
}

impl PttHistory {
    /// Stores one pre-press frame and whether it looked like speech.
    fn push(&mut self, frame: &[i16; FRAME_SAMPLES], speech: bool) {
        self.frames[self.index] = *frame;
        self.speech[self.index] = speech;
        self.index = (self.index + 1) % PTT_PREROLL_FRAMES;
    }

    /// Drops the history after a press or a mode change.
    fn clear(&mut self) {
        for frame in &mut self.frames {
            frame.fill(0);
        }
        self.speech = [false; PTT_PREROLL_FRAMES];
        self.index = 0;
    }

    /// Copies the frames to replay into `out` and returns their count, oldest
    /// first.
    ///
    /// Only the run of speech frames ending at the press is returned: a word
    /// that started one frame before the key is replayed, a press in a pause
    /// or on a keyboard click is not. A cleared line has no speech flags, so a
    /// fresh press after a mode switch never replays stale audio.
    fn attack_into(&self, out: &mut [[i16; FRAME_SAMPLES]; PTT_PREROLL_FRAMES]) -> usize {
        let newest = (self.index + PTT_PREROLL_FRAMES - 1) % PTT_PREROLL_FRAMES;
        if !self.speech[newest] {
            return 0;
        }
        let mut count = 1;
        if self.speech[(newest + PTT_PREROLL_FRAMES - 1) % PTT_PREROLL_FRAMES] {
            count = PTT_PREROLL_FRAMES;
        }
        for (offset, slot) in out[..count].iter_mut().enumerate() {
            let age = count - 1 - offset;
            let index = (newest + PTT_PREROLL_FRAMES - age) % PTT_PREROLL_FRAMES;
            *slot = self.frames[index];
        }
        count
    }
}

fn capture_loop(mut ctx: CaptureContext) {
    let _audio_thread = ctx.scheduler.enter_audio_thread();
    let mut frame = [0i16; FRAME_SAMPLES];
    let mut resampled = [0.0f32; FRAME_SAMPLES];
    let mut watch = StallWatch::new();
    let mut next = Instant::now();
    while !ctx.shutdown.load(Ordering::Relaxed) {
        if let Ok(apm) = ctx.apm_updates.try_recv() {
            ctx.apm = apm;
        }
        if ctx.source.is_clocked() {
            // The microphone drives the transfer (stage 2.3.2b): poll its ring
            // often and handle every whole frame it has produced. A short
            // remainder waits inside the resampler; it is never padded with
            // silence, because a zero-filled tail in the middle of a word is
            // exactly the gap this stage removes.
            std::thread::sleep(CAPTURE_POLL);
            if ctx.shutdown.load(Ordering::Relaxed) {
                break;
            }
            let mut produced = false;
            while pull_device_frame(&ctx.shared, &mut ctx.source, &mut resampled) {
                resampled_to_frame(&resampled, &mut frame);
                ctx.dump.push_raw(&frame);
                process_frame(&mut ctx, &frame);
                produced = true;
            }
            if produced {
                watch.frame();
            } else if watch.stalled() {
                ctx.shared.note_capture_underrun();
            }
            continue;
        }

        // The file source and the silent fallback have no clock of their own:
        // keep the old 10 ms tempo and the old underrun accounting.
        scheduler::pace(&mut next);
        if ctx.shutdown.load(Ordering::Relaxed) {
            break;
        }
        let written = match &mut ctx.source {
            #[cfg(feature = "test-audio")]
            CaptureSource::Test(source) => {
                if source.next_frame(&mut frame) {
                    FRAME_SAMPLES
                } else {
                    0
                }
            }
            _ => {
                frame.fill(0);
                0
            }
        };
        if written == 0 {
            ctx.shared.note_capture_underrun();
        } else if written < FRAME_SAMPLES {
            ctx.shared.note_partial_capture_frame();
        }
        ctx.dump.push_raw(&frame);
        process_frame(&mut ctx, &frame);
    }
}

/// One processed 10 ms frame: AEC reference, APM, level and gate, publish and
/// the microphone loop (steps 2–6 of the capture cycle).
fn process_frame(ctx: &mut CaptureContext, frame: &[i16; FRAME_SAMPLES]) {
    // 2. AEC reference from the playback mixer (silence while it has none).
    let mut reference = [0i16; FRAME_SAMPLES];
    take_reference(&mut ctx.reference, &ctx.shared, &mut reference);
    ctx.apm.process_reverse(&mut reference);

    // 3. APM on the forward stream.
    let mut processed = *frame;
    ctx.apm.process_capture(&mut processed);
    ctx.dump.push_apm(&processed);

    // 4. Level, speaking and the gate.
    let level = ctx.smoother.update_frame(&processed);
    ctx.shared
        .own_level_bits
        .store(f32::to_bits(level), Ordering::Relaxed);
    let muted = ctx.shared.self_muted();
    let push_to_talk = ctx.shared.push_to_talk.load(Ordering::Relaxed);
    let gate_mode = ctx.shared.gate_mode();
    let vad = ctx.apm.vad();
    #[cfg(feature = "test-audio")]
    ctx.shared.note_vad_frame(vad);
    let open = if muted {
        ctx.gate.reset();
        false
    } else {
        // RNNoise also says whether the frame is speech: voice activation
        // needs both the level and the probability, so a keyboard click does
        // not open the microphone (stage 2.3.2e). Without RNNoise the gate
        // falls back to the level alone.
        ctx.gate
            .update_with_vad(gate_mode, push_to_talk, level, vad)
    };
    ctx.shared.gate_open.store(open, Ordering::Relaxed);
    ctx.shared.own_speaking.store(
        open && level >= speaking_threshold(gate_mode),
        Ordering::Relaxed,
    );

    // 5. Publish. Voice activation sends the frame from 30 ms ago, because the
    // decision above was made on a fresh frame that may already contain the
    // start of a word. Push-to-talk sends the fresh frame, preceded — only on
    // the press and only when the frames just before it were speech — by the
    // 20 ms of history the attack lives in (stage 2.3.4). The gate then applies
    // its 5 ms fade to whatever is sent, in order, so opening, closing, mute
    // and a released key never cut the waveform.
    let mut outgoing = processed;
    let mut attack = [[0i16; FRAME_SAMPLES]; PTT_PREROLL_FRAMES];
    let mut attack_frames = 0usize;
    match gate_mode {
        GateMode::VoiceActivation { .. } => {
            if !ctx.preroll_active {
                ctx.preroll.clear();
                ctx.preroll_active = true;
            }
            if ctx.ptt_active {
                ctx.ptt_history.clear();
                ctx.ptt_active = false;
            }
            ctx.ptt_previous = false;
            outgoing = ctx.preroll.push(&processed);
        }
        GateMode::PushToTalk => {
            if ctx.preroll_active {
                // Another mode owned the line before; its history is unrelated.
                ctx.preroll.clear();
                ctx.preroll_active = false;
            }
            if !ctx.ptt_active {
                ctx.ptt_history.clear();
                ctx.ptt_active = true;
            }
            let pressed = push_to_talk && !ctx.ptt_previous;
            let released = !push_to_talk && ctx.ptt_previous;
            ctx.ptt_previous = push_to_talk;
            if pressed {
                attack_frames = ctx.ptt_history.attack_into(&mut attack);
                ctx.ptt_history.clear();
            } else if !push_to_talk {
                if released {
                    // A quick re-press must not replay the end of the previous
                    // transmission: the window starts at the release.
                    ctx.ptt_history.clear();
                }
                // The button is up: keep filling the window a press will read.
                ctx.ptt_history
                    .push(&processed, frame_is_speech(level, vad));
            }
        }
        GateMode::Continuous => {
            if ctx.preroll_active {
                ctx.preroll.clear();
                ctx.preroll_active = false;
            }
            if ctx.ptt_active {
                ctx.ptt_history.clear();
                ctx.ptt_active = false;
            }
            ctx.ptt_previous = false;
        }
    }

    // 6. Every outgoing frame goes through the gate in order and reaches the
    // publisher and the microphone loop. The loop carries exactly what the
    // room receives, not the pre-gate signal: a keyboard or a fan that the
    // gate keeps out of the room must stay out of the microphone test too
    // (stage 2.3.4). A muted microphone silences the loop as well, otherwise
    // the user hears themselves while muted and reads it as "mute does not
    // work" (stage 2.3.1). In push-to-talk the loop follows the button.
    let loop_open =
        ctx.shared.mic_test() && !muted && (gate_mode != GateMode::PushToTalk || push_to_talk);
    for frame in &mut attack[..attack_frames] {
        publish_outgoing(ctx, frame, loop_open);
    }
    publish_outgoing(ctx, &mut outgoing, loop_open);
}

/// Applies the gate to one frame, then hands it to the publisher and the
/// microphone loop.
///
/// The gate is stateful, so frames must be passed in chronological order: the
/// push-to-talk pre-roll hums its 5 ms fade-in on the first replayed frame
/// instead of stepping.
fn publish_outgoing(ctx: &mut CaptureContext, frame: &mut [i16; FRAME_SAMPLES], loop_open: bool) {
    ctx.gate.apply(frame);
    ctx.dump.push_sent(frame);
    // Silence keeps the track and its DTX stream alive.
    publish_frame(&mut ctx.publish, frame, &ctx.shared);
    push_local_monitor(&mut ctx.local, &mut ctx.mic_test_primed, loop_open, frame);
}

/// Routes one outgoing frame to the microphone-loop ring.
///
/// Starting the monitor primes [`LOCAL_PRIME_FRAMES`]−1 silent frames before
/// the first real one: the playback thread paces its own 10 ms ticks, and
/// reading with zero slack turns a lost race into a 10 ms hole in the loop.
/// The reserve used to be three copies of the same frame, which the user heard
/// as a stutter at every push-to-talk press; silence gives the same slack
/// without repeating audio (stage 2.3.4).
fn push_local_monitor(
    local: &mut HeapProd<i16>,
    primed: &mut bool,
    open: bool,
    frame: &[i16; FRAME_SAMPLES],
) {
    if !open {
        *primed = false;
        return;
    }
    if !*primed {
        let silence = [0i16; FRAME_SAMPLES];
        for _ in 1..LOCAL_PRIME_FRAMES {
            let _ = local.push_slice(&silence);
        }
        *primed = true;
    }
    let _ = local.push_slice(frame);
}

/// Whether a push-to-talk pre-roll frame counts as speech.
///
/// RNNoise's probability is the precise signal, with the same threshold the
/// voice-activation gate uses: it separates a word from a keyboard click or a
/// fan. Without RNNoise the level rule the speaking indicator already uses for
/// push-to-talk is all that is left.
fn frame_is_speech(level_db: f32, vad: Option<f32>) -> bool {
    match vad {
        Some(probability) => probability >= VAD_THRESHOLD,
        None => level_db >= speaking_threshold(GateMode::PushToTalk),
    }
}

/// Takes one whole AEC reference frame from the playback ring.
///
/// The capture thread is clocked by the microphone and the playback thread by
/// the speakers, so the reference ring drifts in both directions. A backlog
/// past 100 ms is cut back to 30 ms (stage 2.3.2c); a ring with less than a
/// frame yields silence for the tail, exactly like before.
fn take_reference(
    reference: &mut HeapCons<i16>,
    shared: &SharedAudio,
    out: &mut [i16; FRAME_SAMPLES],
) {
    if reference.occupied_len() > REFERENCE_MAX {
        while reference.occupied_len() > REFERENCE_PRIME {
            if reference.skip(FRAME_SAMPLES) < FRAME_SAMPLES {
                break;
            }
        }
        shared.note_reference_trim();
    }
    let filled = reference.pop_slice(out);
    for sample in &mut out[filled..] {
        *sample = 0;
    }
}

/// Drains the device ring into its resampler and, if a whole 10 ms frame is
/// ready, converts it into `resampled`.
///
/// Returns false when the device has not produced enough input yet. The
/// remainder stays in the resampler, so no frame is ever completed with
/// silence (stage 2.3.2b).
fn pull_device_frame(
    shared: &SharedAudio,
    source: &mut CaptureSource,
    resampled: &mut [f32; FRAME_SAMPLES],
) -> bool {
    match source {
        CaptureSource::Device(device) => drain_device(
            shared,
            &mut device.consumer,
            &mut device.resampler,
            &mut device.reported_dropped,
            resampled,
        ),
        #[cfg(feature = "test-audio")]
        CaptureSource::Fake(device) => drain_device(
            shared,
            &mut device.consumer,
            &mut device.resampler,
            &mut device.reported_dropped,
            resampled,
        ),
        _ => false,
    }
}

fn drain_device(
    shared: &SharedAudio,
    consumer: &mut HeapCons<f32>,
    resampler: &mut crate::resample::Resampler,
    reported_dropped: &mut u64,
    resampled: &mut [f32; FRAME_SAMPLES],
) -> bool {
    while let Some(sample) = consumer.try_pop() {
        resampler.push(sample);
    }
    let dropped = resampler.dropped();
    if dropped > *reported_dropped {
        shared.note_resampler_overflow(dropped - *reported_dropped);
        *reported_dropped = dropped;
    }
    if resampler.available() < FRAME_SAMPLES {
        return false;
    }
    let written = resampler.produce(resampled);
    debug_assert_eq!(written, FRAME_SAMPLES, "available() over-reported");
    written == FRAME_SAMPLES
}

fn resampled_to_frame(resampled: &[f32; FRAME_SAMPLES], frame: &mut [i16; FRAME_SAMPLES]) {
    for (out, sample) in frame.iter_mut().zip(resampled) {
        *out = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
    }
}

/// Tells a stream that stopped from a poll that landed between two frames
/// (stage 2.3.2b).
///
/// Both the capture thread and the publisher poll every few milliseconds while
/// a healthy device delivers one 10 ms frame per 10 ms, so an empty poll is the
/// normal case. Only [`STREAM_STALL`] without a frame means the stream is gone;
/// the watch then reports one stall and restarts, so a dead device adds one
/// underrun per 100 ms instead of one per poll.
pub(crate) struct StallWatch {
    last: Instant,
}

impl StallWatch {
    /// Starts the watch now.
    pub(crate) fn new() -> Self {
        Self {
            last: Instant::now(),
        }
    }

    /// Records that a whole frame just arrived or was sent.
    pub(crate) fn frame(&mut self) {
        self.last = Instant::now();
    }

    /// True at most once per stall window: no frame for [`STREAM_STALL`].
    pub(crate) fn stalled(&mut self) -> bool {
        self.stalled_at(Instant::now())
    }

    fn stalled_at(&mut self, now: Instant) -> bool {
        if now.saturating_duration_since(self.last) >= STREAM_STALL {
            self.last = now;
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    fn frame_at(&mut self, now: Instant) {
        self.last = now;
    }
}

/// The speaking flag should follow the gate: for voice activation the gate
/// already contains the hold window; for push-to-talk any input counts.
fn speaking_threshold(mode: GateMode) -> f32 {
    match mode {
        GateMode::VoiceActivation { threshold_db, .. } => threshold_db - 10.0,
        _ => -60.0,
    }
}

/// Publishes one frame, counting a short push (the ring was full).
fn publish_frame(publish: &mut HeapProd<i16>, frame: &[i16; FRAME_SAMPLES], shared: &SharedAudio) {
    if publish.push_slice(frame) < FRAME_SAMPLES {
        shared.note_publish_overflow();
    }
}

enum PlaybackSink {
    Device(Box<DevicePlayback>),
    #[cfg(feature = "test-audio")]
    Test(crate::testaudio::TestSink),
    /// Simulated device with its own clock (stage 2.3.2a).
    #[cfg(feature = "test-audio")]
    Fake(Box<FakePlayback>),
    Null,
}

impl PlaybackSink {
    /// True when the sink has its own hardware clock and therefore drives the
    /// receive frame rate (stage 2.3.2c).
    ///
    /// A WAV recorder and the silent fallback have no device behind them and
    /// keep the old 10 ms tempo.
    fn is_clocked(&self) -> bool {
        match self {
            Self::Device(_) => true,
            #[cfg(feature = "test-audio")]
            Self::Fake(_) => true,
            _ => false,
        }
    }
}

struct DevicePlayback {
    #[allow(dead_code)]
    stream: PlaybackStream,
    producer: HeapProd<f32>,
    resampler: crate::resample::Resampler,
}

/// The fake output runs at the pipeline rate; only its own clock differs.
#[cfg(feature = "test-audio")]
struct FakePlayback {
    #[allow(dead_code)]
    output: crate::testaudio::FakeOutput,
    producer: HeapProd<f32>,
}

struct PlaybackContext {
    shared: Arc<SharedAudio>,
    shutdown: Arc<AtomicBool>,
    scheduler: Arc<AudioScheduler>,
    mixer: Mixer,
    updates: Receiver<MixerUpdate>,
    reference: HeapProd<i16>,
    local: FrameReader,
    sounds: SoundPlayer,
    sink: PlaybackSink,
    /// Output-ring level the loop keeps filled, in device samples (0 for sinks
    /// without a clock).
    target: usize,
    dump: Option<DumpTap>,
}

/// Buffers of the playback thread, allocated once before the loop.
struct PlaybackFrame {
    mix: [i16; FRAME_SAMPLES],
    local: [i16; FRAME_SAMPLES],
    reference: [i16; FRAME_SAMPLES],
    scratch: Vec<f32>,
}

/// 30 ms of output in the rate of the device (stage 2.3.2c).
///
/// Sinks without a clock (`Test`, `Null`) keep the old 10 ms tempo; for them
/// the target is zero and the loop never looks at the ring.
fn playback_target(sink: &PlaybackSink, device_rate: u32) -> usize {
    if !sink.is_clocked() {
        return 0;
    }
    (OUTPUT_TARGET_FRAMES * FRAME_SAMPLES * device_rate as usize) / SAMPLE_RATE as usize
}

fn playback_loop(mut ctx: PlaybackContext) {
    let _audio_thread = ctx.scheduler.enter_audio_thread();
    let mut buffers = PlaybackFrame {
        mix: [0i16; FRAME_SAMPLES],
        local: [0i16; FRAME_SAMPLES],
        reference: [0i16; FRAME_SAMPLES],
        // The resampler may emit more samples than it consumed.
        scratch: vec![0.0f32; 8 * FRAME_SAMPLES],
    };
    let mut next = Instant::now();
    // A sink without its own clock (the WAV recorder or no device at all) keeps
    // the fixed 10 ms tempo: it has no drift the speakers could clock.
    if ctx.target == 0 {
        while !ctx.shutdown.load(Ordering::Relaxed) {
            scheduler::pace(&mut next);
            if ctx.shutdown.load(Ordering::Relaxed) {
                break;
            }
            drain_updates(&mut ctx);
            render_frame(&mut ctx, &mut buffers);
        }
    } else {
        while !ctx.shutdown.load(Ordering::Relaxed) {
            std::thread::sleep(PLAYBACK_POLL);
            if ctx.shutdown.load(Ordering::Relaxed) {
                break;
            }
            drain_updates(&mut ctx);
            // The speakers took samples since the last poll; mix exactly the
            // frames that bring the ring back to the target, so the mixer is
            // called as often as the device consumed and the drift between the
            // timer and the crystal disappears (stage 2.3.2c).
            while ctx.output_occupied() < ctx.target {
                render_frame(&mut ctx, &mut buffers);
            }
        }
    }

    // Flush a recording sink before the thread exits.
    #[cfg(feature = "test-audio")]
    if let PlaybackSink::Test(sink) = ctx.sink {
        sink.finish();
    }
}

impl PlaybackContext {
    /// Samples waiting in the output ring of a clocked sink.
    fn output_occupied(&self) -> usize {
        match &self.sink {
            PlaybackSink::Device(device) => device.producer.occupied_len(),
            #[cfg(feature = "test-audio")]
            PlaybackSink::Fake(sink) => sink.producer.occupied_len(),
            _ => 0,
        }
    }
}

/// Mixes one 10 ms frame and hands it to the output.
fn render_frame(ctx: &mut PlaybackContext, buffers: &mut PlaybackFrame) {
    // Microphone loopback is mixed with the participants. It follows the track
    // rules: only whole frames, a 30 ms reserve and bounded trims.
    let local_playing = ctx.local.read(&mut buffers.local);

    let starved = ctx.mixer.mix(&mut buffers.mix);
    ctx.shared.note_mixer_underrun(u64::from(starved));
    let trims = ctx.mixer.take_track_trims() + ctx.local.take_trims();
    ctx.shared.note_track_trims(u64::from(trims));
    if local_playing && ctx.shared.mic_test() {
        for (out, sample) in buffers.mix.iter_mut().zip(buffers.local.iter()) {
            let sum = i32::from(*out) + i32::from(*sample);
            *out = sum.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16;
        }
    }

    let deafened = ctx.shared.deafened();
    if deafened {
        // Deafened means silence, but the "sound off" confirmation cue must
        // still be heard once (P10).
        buffers.mix.fill(0);
    }
    // Cues are audible even when every participant is muted.
    ctx.sounds.mix_into(&mut buffers.mix);

    // The AEC reference is what the user would hear; deafened means silence,
    // so nothing must be cancelled.
    buffers.reference.copy_from_slice(&buffers.mix);
    if deafened && !ctx.sounds.is_deafening_cue() {
        buffers.reference.fill(0);
        buffers.mix.fill(0);
    }
    let _ = ctx.reference.push_slice(&buffers.reference);

    if let Some(tap) = ctx.dump.as_mut() {
        tap.push(&buffers.mix);
    }

    match &mut ctx.sink {
        PlaybackSink::Device(device) => {
            feed_device_mix(
                &mut device.producer,
                &mut device.resampler,
                &mut buffers.scratch,
                &buffers.mix,
            );
        }
        #[cfg(feature = "test-audio")]
        PlaybackSink::Fake(sink) => {
            // The fake device runs at the pipeline rate: no resampler, only
            // its own clock pulls the samples.
            for sample in &buffers.mix {
                let _ = sink
                    .producer
                    .try_push(f32::from(*sample) / f32::from(i16::MAX));
            }
        }
        #[cfg(feature = "test-audio")]
        PlaybackSink::Test(sink) => sink.write(&buffers.mix),
        PlaybackSink::Null => {}
    }
}

/// Resamples one mixed frame to the device rate and pushes it to the output
/// ring. `scratch` is larger than a frame because the resampler may emit more
/// samples than it consumed.
fn feed_device_mix(
    producer: &mut HeapProd<f32>,
    resampler: &mut crate::resample::Resampler,
    scratch: &mut [f32],
    mix: &[i16; FRAME_SAMPLES],
) {
    for sample in mix {
        resampler.push(f32::from(*sample) / f32::from(i16::MAX));
    }
    let written = resampler.produce(scratch);
    let _ = producer.push_slice(&scratch[..written]);
}

fn drain_updates(ctx: &mut PlaybackContext) {
    loop {
        match ctx.updates.try_recv() {
            Ok(MixerUpdate::Add {
                identity,
                consumer,
                level,
            }) => ctx.mixer.insert_track(&identity, consumer, level),
            Ok(MixerUpdate::Remove(identity)) => ctx.mixer.remove_track(&identity),
            Ok(MixerUpdate::Volume { identity, volume }) => {
                ctx.mixer.set_volume(&identity, volume);
            }
            Ok(MixerUpdate::Muted { identity, muted }) => ctx.mixer.set_muted(&identity, muted),
            Ok(MixerUpdate::MasterVolume(volume)) => ctx.mixer.set_master_volume(volume),
            Ok(MixerUpdate::Leveling(enabled)) => ctx.mixer.set_leveling(enabled),
            Ok(MixerUpdate::Sound { sound, preview }) => {
                if preview {
                    ctx.sounds.preview(sound);
                } else {
                    ctx.sounds.play(sound);
                }
            }
            Ok(MixerUpdate::Sounds(settings)) => ctx.sounds.set_settings(settings),
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => break,
        }
    }
}

#[cfg(feature = "test-audio")]
fn build_test_source(
    config: &AudioConfig,
) -> Option<Result<crate::testaudio::TestSource, VoiceError>> {
    let test = config.test.as_ref()?;
    if test.input_wav.is_none() && test.tone_hz.is_none() {
        return None;
    }
    Some(crate::testaudio::TestSource::open(
        test.tone_hz,
        test.input_wav.as_deref(),
    ))
}

#[cfg(feature = "test-audio")]
fn build_test_sink(config: &AudioConfig) -> Option<Result<crate::testaudio::TestSink, VoiceError>> {
    let test = config.test.as_ref()?;
    let path = test.output_wav.as_ref()?;
    Some(crate::testaudio::TestSink::create(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A playback context without a device: the mix goes nowhere, but the
    /// AEC reference ring is real and can be read back.
    fn playback_context(deafened: bool) -> (PlaybackContext, Sender<MixerUpdate>, HeapCons<i16>) {
        let config = AudioConfig {
            deafened,
            sounds: SoundSettings {
                enabled: false,
                ..SoundSettings::default()
            },
            ..AudioConfig::default()
        };
        let (updates_tx, updates) = mpsc::channel();
        let (reference, reference_rx) = HeapRb::<i16>::new(REFERENCE_RING).split();
        let (_local_tx, local_rx) = HeapRb::<i16>::new(LOCAL_RING).split();
        let ctx = PlaybackContext {
            shared: Arc::new(SharedAudio::new(&config)),
            shutdown: Arc::new(AtomicBool::new(false)),
            scheduler: Arc::new(AudioScheduler::new()),
            mixer: Mixer::new(),
            updates,
            reference,
            local: FrameReader::looped(local_rx),
            sounds: SoundPlayer::new(config.sounds),
            sink: PlaybackSink::Null,
            target: 0,
            dump: None,
        };
        (ctx, updates_tx, reference_rx)
    }

    /// Stage P15 (ADR 0027): the viewer's core mixes the stream audio into the
    /// same frame that feeds the AEC reference, at the tile volume (150 %), so
    /// a stream played on speakers is cancelled like a voice; the local mute
    /// and deafen silence it in both.
    #[test]
    fn stream_audio_reaches_the_aec_reference_at_its_volume() {
        let (mut ctx, updates, mut reference) = playback_context(false);
        let key = "7:voice#screen_share_audio".to_owned();
        let (mut publisher, level, consumer) = Mixer::create_track(&key);
        updates
            .send(MixerUpdate::Add {
                identity: key.clone(),
                consumer,
                level,
            })
            .expect("send");
        updates
            .send(MixerUpdate::Volume {
                identity: key.clone(),
                volume: 1.5,
            })
            .expect("send");
        for _ in 0..4 {
            publisher.push(&[1_000i16; FRAME_SAMPLES]);
        }
        let mut buffers = PlaybackFrame {
            mix: [0; FRAME_SAMPLES],
            local: [0; FRAME_SAMPLES],
            reference: [0; FRAME_SAMPLES],
            scratch: vec![0.0; 8 * FRAME_SAMPLES],
        };
        drain_updates(&mut ctx);
        render_frame(&mut ctx, &mut buffers);
        let mut frame = [0i16; FRAME_SAMPLES];
        assert_eq!(reference.pop_slice(&mut frame), FRAME_SAMPLES);
        assert!(
            frame.iter().all(|sample| *sample == 1_500),
            "reference = {:?}",
            &frame[..4]
        );
        assert!(buffers.mix.iter().all(|sample| *sample == 1_500));

        // Local mute of the stream: neither heard nor in the reference.
        updates
            .send(MixerUpdate::Muted {
                identity: key,
                muted: true,
            })
            .expect("send");
        drain_updates(&mut ctx);
        render_frame(&mut ctx, &mut buffers);
        assert_eq!(reference.pop_slice(&mut frame), FRAME_SAMPLES);
        assert!(frame.iter().all(|sample| *sample == 0));
    }

    #[test]
    fn deafen_silences_the_stream_audio_and_its_reference() {
        let (mut ctx, updates, mut reference) = playback_context(true);
        let key = "7:voice#screen_share_audio".to_owned();
        let (mut publisher, level, consumer) = Mixer::create_track(&key);
        updates
            .send(MixerUpdate::Add {
                identity: key,
                consumer,
                level,
            })
            .expect("send");
        for _ in 0..4 {
            publisher.push(&[1_000i16; FRAME_SAMPLES]);
        }
        let mut buffers = PlaybackFrame {
            mix: [0; FRAME_SAMPLES],
            local: [0; FRAME_SAMPLES],
            reference: [0; FRAME_SAMPLES],
            scratch: vec![0.0; 8 * FRAME_SAMPLES],
        };
        drain_updates(&mut ctx);
        render_frame(&mut ctx, &mut buffers);
        let mut frame = [1i16; FRAME_SAMPLES];
        assert_eq!(reference.pop_slice(&mut frame), FRAME_SAMPLES);
        assert!(frame.iter().all(|sample| *sample == 0));
        assert!(buffers.mix.iter().all(|sample| *sample == 0));
    }

    /// Stage P17 with P10: the loudness leveler runs per remote track inside
    /// `Mixer::mix`; the cue player adds its samples to the frame afterwards.
    /// Turning leveling on must change the voice but leave an event cue at the
    /// same amplitude, so a "someone joined" tone never follows a quiet friend
    /// up or a loud one down.
    #[test]
    fn leveling_changes_the_voice_but_not_the_event_sounds() {
        const FRAMES: usize = 80;

        fn run(leveling: bool, cue: bool) -> Vec<[i16; FRAME_SAMPLES]> {
            let (mut ctx, updates, _reference) = playback_context(false);
            ctx.sounds.set_settings(SoundSettings::default());
            let key = "2:voice".to_owned();
            let (mut publisher, level, consumer) = Mixer::create_track(&key);
            updates
                .send(MixerUpdate::Add {
                    identity: key,
                    consumer,
                    level,
                })
                .expect("send");
            updates.send(MixerUpdate::Leveling(leveling)).expect("send");
            for _ in 0..4 {
                publisher.push(&[300i16; FRAME_SAMPLES]);
            }
            if cue {
                updates
                    .send(MixerUpdate::Sound {
                        sound: EventSound::UserJoin,
                        preview: false,
                    })
                    .expect("send");
            }
            let mut buffers = PlaybackFrame {
                mix: [0; FRAME_SAMPLES],
                local: [0; FRAME_SAMPLES],
                reference: [0; FRAME_SAMPLES],
                scratch: vec![0.0; 8 * FRAME_SAMPLES],
            };
            drain_updates(&mut ctx);
            let mut rendered = Vec::with_capacity(FRAMES);
            for _ in 0..FRAMES {
                publisher.push(&[300i16; FRAME_SAMPLES]);
                render_frame(&mut ctx, &mut buffers);
                rendered.push(buffers.mix);
            }
            rendered
        }

        let leveled_quiet = run(true, false);
        let leveled_cue = run(true, true);
        let plain_quiet = run(false, false);
        let plain_cue = run(false, true);

        // The cue, taken as the difference of two otherwise identical runs,
        // must have the same amplitude with and without leveling. The mix is
        // truncated to `i16` after the cue is added, so a fractional gain on
        // the voice moves a sample by at most one LSB; a scaled cue would not.
        let mut cue_energy = 0i64;
        for frame in 0..FRAMES {
            for sample in 0..FRAME_SAMPLES {
                let leveled_delta =
                    i32::from(leveled_cue[frame][sample]) - i32::from(leveled_quiet[frame][sample]);
                let plain_delta =
                    i32::from(plain_cue[frame][sample]) - i32::from(plain_quiet[frame][sample]);
                assert!(
                    (leveled_delta - plain_delta).abs() <= 1,
                    "cue differs by more than the 1 LSB truncation at frame {frame} sample {sample}: {leveled_delta} vs {plain_delta}"
                );
                cue_energy += i64::from(plain_delta.abs());
            }
        }
        assert!(cue_energy > 0, "the cue is silent in the test");

        // And leveling did move the quiet voice, so the check is not vacuous.
        assert_ne!(
            leveled_quiet[FRAMES - 1],
            plain_quiet[FRAMES - 1],
            "the leveler left the quiet voice untouched"
        );
    }

    #[test]
    fn gate_mode_round_trips_through_atomics() {
        let shared = SharedAudio::new(&AudioConfig::default());
        assert_eq!(shared.gate_mode(), GateMode::default());
        shared.set_gate_mode(GateMode::PushToTalk);
        assert_eq!(shared.gate_mode(), GateMode::PushToTalk);
        shared.set_gate_mode(GateMode::VoiceActivation {
            threshold_db: -33.5,
            hold_ms: 120,
        });
        match shared.gate_mode() {
            GateMode::VoiceActivation {
                threshold_db,
                hold_ms,
            } => {
                assert!((threshold_db + 33.5).abs() < 0.001);
                assert_eq!(hold_ms, 120);
            }
            other => panic!("unexpected mode {other:?}"),
        }
    }

    #[test]
    fn mute_deafen_and_mic_test_flags_are_independent() {
        let shared = SharedAudio::new(&AudioConfig::default());
        shared.set_self_muted(true);
        shared.set_deafened(true);
        shared.set_mic_test(true);
        assert!(shared.self_muted());
        assert!(shared.deafened());
        assert!(shared.mic_test());
        shared.set_self_muted(false);
        assert!(!shared.self_muted());
        assert!(shared.deafened());
    }

    #[test]
    fn an_explicit_mute_or_a_released_push_to_talk_stops_the_publisher() {
        // Voice activation keeps feeding frames (DTX handles silence), but a
        // mute or a released PTT key must send no packets at all.
        let shared = SharedAudio::new(&AudioConfig::default());
        assert!(shared.feeds_publisher());

        shared.set_self_muted(true);
        assert!(!shared.feeds_publisher());
        shared.set_self_muted(false);
        assert!(shared.feeds_publisher());

        shared.set_gate_mode(GateMode::PushToTalk);
        assert!(!shared.feeds_publisher());
        shared.set_push_to_talk(true);
        assert!(shared.feeds_publisher());
        shared.set_push_to_talk(false);
        assert!(!shared.feeds_publisher());

        shared.set_gate_mode(GateMode::VoiceActivation {
            threshold_db: -45.0,
            hold_ms: 250,
        });
        assert!(shared.feeds_publisher());
    }

    #[test]
    fn the_push_to_talk_meter_is_silent_until_the_button_is_held() {
        let shared = SharedAudio::new(&AudioConfig::default());
        shared
            .own_level_bits
            .store(f32::to_bits(-20.0), Ordering::Relaxed);
        shared.set_gate_mode(GateMode::PushToTalk);

        assert_eq!(shared.meter_level_db(), SILENCE_DB);
        shared.set_push_to_talk(true);
        assert_eq!(shared.meter_level_db(), -20.0);
        shared.set_push_to_talk(false);
        assert_eq!(shared.meter_level_db(), SILENCE_DB);

        // Voice activation still shows the raw input so the threshold can be
        // set; only push-to-talk hides it while released.
        shared.set_gate_mode(GateMode::VoiceActivation {
            threshold_db: -45.0,
            hold_ms: 250,
        });
        assert_eq!(shared.meter_level_db(), -20.0);
    }

    #[test]
    fn schedule_does_not_accumulate_a_backlog() {
        let mut next = Instant::now() - Duration::from_secs(1);
        scheduler::pace(&mut next);
        assert!(next > Instant::now() - Duration::from_millis(100));
    }

    #[test]
    fn every_counter_starts_at_zero_and_records_its_event() {
        let shared = SharedAudio::new(&AudioConfig::default());
        assert_eq!(shared.counters(), AudioCounters::default());

        shared.note_capture_underrun();
        shared.note_partial_capture_frame();
        shared.note_resampler_overflow(3);
        shared.note_publish_overflow();
        shared.note_publish_underrun();
        shared.note_mixer_underrun(2);
        shared.note_track_trims(2);
        shared.note_reference_trim();
        shared.apm_error_counter().fetch_add(1, Ordering::Relaxed);
        shared
            .input_overflow_counter()
            .fetch_add(1, Ordering::Relaxed);
        shared.playback_drops.fetch_add(1, Ordering::Relaxed);

        let counters = shared.counters();
        assert_eq!(counters.capture_underruns, 1);
        assert_eq!(counters.partial_capture_frames, 1);
        assert_eq!(counters.resampler_overflows, 3);
        assert_eq!(counters.publish_overflows, 1);
        assert_eq!(counters.publish_underruns, 1);
        assert_eq!(counters.mixer_underruns, 2);
        assert_eq!(counters.track_trims, 2);
        assert_eq!(counters.reference_trims, 1);
        assert_eq!(counters.apm_errors, 1);
        assert_eq!(counters.input_overflows, 1);
        assert_eq!(counters.playback_underruns, 1);
        assert!(counters.any());
    }

    #[test]
    fn a_full_publish_ring_is_counted() {
        let shared = SharedAudio::new(&AudioConfig::default());
        let (mut producer, _consumer) = HeapRb::<i16>::new(FRAME_SAMPLES).split();
        let frame = [1i16; FRAME_SAMPLES];
        publish_frame(&mut producer, &frame, &shared);
        assert_eq!(shared.counters().publish_overflows, 0);
        publish_frame(&mut producer, &frame, &shared);
        assert_eq!(shared.counters().publish_overflows, 1);
    }

    #[test]
    fn zero_mixer_underruns_and_resampler_drops_are_not_counted() {
        let shared = SharedAudio::new(&AudioConfig::default());
        shared.note_mixer_underrun(0);
        shared.note_resampler_overflow(0);
        assert!(!shared.counters().any());
    }

    #[test]
    fn a_stall_is_counted_once_per_hundred_milliseconds() {
        let mut watch = StallWatch::new();
        let start = Instant::now();
        assert!(!watch.stalled_at(start), "a fresh watch is not stalled");
        assert!(
            !watch.stalled_at(start + STREAM_STALL / 2),
            "an empty poll between two frames is not a stall"
        );
        assert!(
            watch.stalled_at(start + STREAM_STALL),
            "100 ms without a whole frame is a stall"
        );
        assert!(
            !watch.stalled_at(start + STREAM_STALL + Duration::from_millis(1)),
            "one stall per window, not one per poll"
        );
        assert!(watch.stalled_at(start + STREAM_STALL * 2));
        watch.frame_at(start + STREAM_STALL * 2);
        assert!(!watch.stalled_at(start + STREAM_STALL * 2 + Duration::from_millis(99)));
        assert!(watch.stalled_at(start + STREAM_STALL * 3));
    }

    #[test]
    fn a_whole_frame_only_appears_when_all_480_samples_are_here() {
        use crate::resample::Resampler;
        use ringbuf::traits::Producer;

        let shared = SharedAudio::new(&AudioConfig::default());
        let (mut producer, mut consumer) = HeapRb::<f32>::new(4096).split();
        let mut resampler = Resampler::new(SAMPLE_RATE);
        let mut reported = 0;
        let mut resampled = [0.0f32; FRAME_SAMPLES];

        producer.push_slice(&[0.5f32; FRAME_SAMPLES - 1]);
        assert!(
            !drain_device(
                &shared,
                &mut consumer,
                &mut resampler,
                &mut reported,
                &mut resampled
            ),
            "479 samples must not produce a frame"
        );
        assert_eq!(resampler.buffered(), FRAME_SAMPLES - 1);

        producer.push_slice(&[0.5f32; 1]);
        assert!(drain_device(
            &shared,
            &mut consumer,
            &mut resampler,
            &mut reported,
            &mut resampled
        ));
        assert_eq!(resampler.buffered(), 0);
        assert!(resampled.iter().all(|sample| (*sample - 0.5).abs() < 1e-6));
        assert_eq!(shared.counters().resampler_overflows, 0);
    }

    #[test]
    fn the_voice_activation_preroll_returns_a_frame_three_frames_later() {
        let mut preroll = Preroll::default();
        for index in 0..PREROLL_FRAMES {
            let mut frame = [0i16; FRAME_SAMPLES];
            frame[0] = index as i16 + 1;
            assert_eq!(
                preroll.push(&frame)[0],
                0,
                "a fresh line returns silence, not the frame just written"
            );
        }
        let mut frame = [0i16; FRAME_SAMPLES];
        frame[0] = 99;
        assert_eq!(
            preroll.push(&frame)[0],
            1,
            "the first frame comes back after {PREROLL_FRAMES} frames"
        );

        preroll.clear();
        assert_eq!(preroll.push(&frame)[0], 0, "clear drops the history");
    }

    #[test]
    fn only_the_device_sources_drive_the_frame_rate() {
        assert!(!CaptureSource::Null.is_clocked());
        #[cfg(feature = "test-audio")]
        {
            let source = crate::testaudio::TestSource::open(Some(440.0), None).expect("tone");
            assert!(!CaptureSource::Test(source).is_clocked());
        }
    }

    fn monitor_buffer() -> [i16; LOCAL_PRIME_FRAMES * FRAME_SAMPLES] {
        [0i16; LOCAL_PRIME_FRAMES * FRAME_SAMPLES]
    }

    #[test]
    fn a_closed_voice_activation_gate_keeps_the_room_and_the_monitor_silent() {
        let shared = SharedAudio::new(&AudioConfig::default());
        let mode = GateMode::VoiceActivation {
            threshold_db: -45.0,
            hold_ms: 300,
        };
        let mut gate = Gate::new();
        // A quiet frame with a high speech probability, but below the level
        // threshold: the gate stays shut, as it does for a fan or a click.
        assert!(!gate.update_with_vad(mode, false, -70.0, Some(0.9)));

        let mut outgoing = [1_234i16; FRAME_SAMPLES];
        gate.apply(&mut outgoing);
        assert!(
            outgoing.iter().all(|sample| *sample == 0),
            "a closed gate must transmit silence"
        );

        let (mut monitor, mut monitor_rx) = HeapRb::<i16>::new(LOCAL_RING).split();
        let mut primed = false;
        push_local_monitor(&mut monitor, &mut primed, true, &outgoing);
        let mut loop_audio = monitor_buffer();
        let filled = monitor_rx.pop_slice(&mut loop_audio);
        assert_eq!(filled, LOCAL_PRIME_FRAMES * FRAME_SAMPLES);
        assert!(
            loop_audio.iter().all(|sample| *sample == 0),
            "the monitor must not hear audio the gate keeps out of the room"
        );

        let (mut publish, mut published) = HeapRb::<i16>::new(PUBLISH_RING).split();
        publish_frame(&mut publish, &outgoing, &shared);
        let mut sent = [1i16; FRAME_SAMPLES];
        assert_eq!(published.pop_slice(&mut sent), FRAME_SAMPLES);
        assert!(sent.iter().all(|sample| *sample == 0));
    }

    #[test]
    fn continuous_mode_feeds_the_monitor_the_unchanged_frame() {
        let mut gate = Gate::new();
        // One warm-up frame finishes the opening ramp, so the measured frame
        // is the steady open state the monitor saw before stage 2.3.4.
        assert!(gate.update(GateMode::Continuous, false, -70.0));
        let mut warmup = [77i16; FRAME_SAMPLES];
        gate.apply(&mut warmup);
        assert_eq!(gate.gain(), 1.0);

        let frame = [4_321i16; FRAME_SAMPLES];
        let mut outgoing = frame;
        gate.apply(&mut outgoing);
        assert_eq!(outgoing, frame, "continuous mode must not attenuate audio");

        let (mut monitor, mut monitor_rx) = HeapRb::<i16>::new(LOCAL_RING).split();
        let mut primed = true;
        push_local_monitor(&mut monitor, &mut primed, true, &outgoing);
        let mut loop_frame = [0i16; FRAME_SAMPLES];
        assert_eq!(monitor_rx.pop_slice(&mut loop_frame), FRAME_SAMPLES);
        assert_eq!(loop_frame, frame);
    }

    #[test]
    fn the_monitor_is_primed_with_silence_not_with_repeated_audio() {
        let frame = [500i16; FRAME_SAMPLES];
        let (mut monitor, mut monitor_rx) = HeapRb::<i16>::new(LOCAL_RING).split();
        let mut primed = false;
        push_local_monitor(&mut monitor, &mut primed, true, &frame);

        let mut primed_audio = monitor_buffer();
        let filled = monitor_rx.pop_slice(&mut primed_audio);
        assert_eq!(filled, LOCAL_PRIME_FRAMES * FRAME_SAMPLES);
        for (index, chunk) in primed_audio.chunks(FRAME_SAMPLES).enumerate() {
            if index == LOCAL_PRIME_FRAMES - 1 {
                assert_eq!(chunk, frame, "the last primed frame is the real one");
            } else {
                assert!(
                    chunk.iter().all(|sample| *sample == 0),
                    "priming fills the reserve with silence, not a repeated frame"
                );
            }
        }
        assert_ne!(
            primed_audio[..FRAME_SAMPLES],
            primed_audio[(LOCAL_PRIME_FRAMES - 1) * FRAME_SAMPLES..],
            "the old priming pushed the same frame three times; the reserve now differs from the real frame"
        );

        // Once primed, one outgoing frame adds exactly one frame to the loop.
        push_local_monitor(&mut monitor, &mut primed, true, &frame);
        assert_eq!(monitor_rx.occupied_len(), FRAME_SAMPLES);
    }

    #[test]
    fn mute_or_a_released_key_closes_the_monitor_and_reprimes_it() {
        let frame = [700i16; FRAME_SAMPLES];
        let (mut monitor, monitor_rx) = HeapRb::<i16>::new(LOCAL_RING).split();
        let mut primed = false;
        push_local_monitor(&mut monitor, &mut primed, true, &frame);
        let primed_len = monitor_rx.occupied_len();
        assert!(primed);

        // Mute or a released push-to-talk key: the loop is closed, nothing is
        // queued and the next open must prime again.
        push_local_monitor(&mut monitor, &mut primed, false, &frame);
        assert!(!primed);
        assert_eq!(monitor_rx.occupied_len(), primed_len);

        push_local_monitor(&mut monitor, &mut primed, true, &frame);
        assert!(primed);
        assert_eq!(
            monitor_rx.occupied_len(),
            primed_len + LOCAL_PRIME_FRAMES * FRAME_SAMPLES
        );
    }

    #[test]
    fn the_attack_history_replays_only_speech_frames_before_the_press() {
        let word_a = [1_111i16; FRAME_SAMPLES];
        let word_b = [2_222i16; FRAME_SAMPLES];
        let noise = [33i16; FRAME_SAMPLES];
        let mut attack = [[0i16; FRAME_SAMPLES]; PTT_PREROLL_FRAMES];

        // A word started one frame (~15 ms) before the key: both frames are
        // replayed oldest first.
        let mut history = PttHistory::default();
        history.push(&word_a, true);
        history.push(&word_b, true);
        assert_eq!(history.attack_into(&mut attack), PTT_PREROLL_FRAMES);
        assert_eq!(attack[0], word_a);
        assert_eq!(attack[1], word_b);

        // Only the last frame is speech: one frame is enough.
        history.clear();
        history.push(&noise, false);
        history.push(&word_b, true);
        assert_eq!(history.attack_into(&mut attack), 1);
        assert_eq!(attack[0], word_b);

        // A press in a pause or on a click: nothing is replayed and the
        // latency does not grow.
        history.clear();
        history.push(&word_a, true);
        history.push(&noise, false);
        assert_eq!(history.attack_into(&mut attack), 0);
        history.clear();
        history.push(&noise, false);
        assert_eq!(
            history.attack_into(&mut attack),
            0,
            "a cleared line never replays stale audio after a mode change"
        );
    }

    #[test]
    fn a_word_that_started_before_the_push_to_talk_press_is_in_the_sent_stream() {
        let word_a = [1_111i16; FRAME_SAMPLES];
        let word_b = [2_222i16; FRAME_SAMPLES];
        let current = [3_333i16; FRAME_SAMPLES];

        let mut history = PttHistory::default();
        history.push(&word_a, true);
        history.push(&word_b, true);
        let mut attack = [[0i16; FRAME_SAMPLES]; PTT_PREROLL_FRAMES];
        let attack_frames = history.attack_into(&mut attack);
        assert_eq!(attack_frames, PTT_PREROLL_FRAMES);

        // The press opens the gate; the replayed frames and the fresh one go
        // through it in order, exactly as the capture thread does.
        let mut gate = Gate::new();
        assert!(gate.update(GateMode::PushToTalk, true, -20.0));
        let shared = SharedAudio::new(&AudioConfig::default());
        let (mut publish, mut published) = HeapRb::<i16>::new(PUBLISH_RING).split();
        let frames = [attack[0], attack[1], current];
        for frame in &frames {
            let mut outgoing = *frame;
            gate.apply(&mut outgoing);
            publish_frame(&mut publish, &outgoing, &shared);
        }

        let mut sent = [0i16; 3 * FRAME_SAMPLES];
        let filled = published.pop_slice(&mut sent);
        assert_eq!(filled, 3 * FRAME_SAMPLES);
        // The 5 ms ramp eats the first 240 samples of the replayed word, not
        // its body; the second replayed frame and the fresh frame are intact.
        assert_eq!(&sent[240..FRAME_SAMPLES], &word_a[240..]);
        assert_eq!(&sent[FRAME_SAMPLES..2 * FRAME_SAMPLES], &word_b[..]);
        assert_eq!(&sent[2 * FRAME_SAMPLES..], &current[..]);
        assert!(
            sent[..240].iter().any(|sample| *sample != 0),
            "the attack is faded in, not discarded"
        );
        // A burst of three frames leaves no backlog: the publisher drains
        // whole frames every poll and returns to the normal empty ring.
        assert_eq!(published.occupied_len(), 0);
    }
}
