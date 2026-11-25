//! Device discovery, selection and the cpal streams.
//!
//! `cpal` 0.18 changed the device API: `Device::description()?.name()`,
//! `StreamConfig` by value and `SampleRate` is `u32` (ADR 0002). The version is
//! pinned in `Cargo.toml`.
//!
//! Live audio callbacks only convert samples and push them into a lock-free
//! ring; they never allocate, lock or log.

use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample, StreamConfig};
use ringbuf::traits::Producer;
use ringbuf::HeapProd;
use serde::{Deserialize, Serialize};

use crate::error::VoiceError;
use crate::SAMPLE_RATE;

/// Longest error message kept from a cpal callback.
///
/// The callback cannot allocate (CONTRIBUTING.md, ADR 0002), so the message is copied
/// byte by byte into fixed atomics and rebuilt outside the realtime thread.
const ERROR_MESSAGE_MAX: usize = 96;

/// No error recorded.
const KIND_NONE: u8 = 0;
/// cpal kinds we do not know yet are treated as unrecoverable (see
/// [`StreamErrorKind::Other`]); the worst case is a rate-limited rebuild.
const KIND_OTHER: u8 = 14;

/// What a cpal stream error means for the tract.
///
/// The variants mirror `cpal::ErrorKind` (0.18, pinned in `Cargo.toml`). Only a
/// small, version-stable code is stored in the callback; the enum is rebuilt
/// outside the realtime thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamErrorKind {
    /// The device is temporarily held by another application.
    DeviceBusy,
    /// The route changed; cpal already rerouted the stream.
    DeviceChanged,
    /// The device disappeared.
    DeviceNotAvailable,
    /// The audio host (WASAPI, ALSA, ...) is gone.
    HostUnavailable,
    /// Invalid argument.
    InvalidInput,
    /// The OS denied access to the device.
    PermissionDenied,
    /// Real-time scheduling was refused; audio still plays.
    RealtimeDenied,
    /// An OS resource limit was hit.
    ResourceExhausted,
    /// The stream configuration is no longer valid.
    StreamInvalidated,
    /// The requested configuration is not supported.
    UnsupportedConfig,
    /// The operation is not supported by the backend.
    UnsupportedOperation,
    /// A buffer underrun or overrun, or a reported data discontinuity.
    Xrun,
    /// An unclassified backend error.
    BackendError,
    /// An unclassified cpal error.
    Other,
}

impl StreamErrorKind {
    /// Whether the stream is unusable and the tract must be rebuilt.
    ///
    /// `Xrun` is a glitch: the stream keeps running (WASAPI even reports one
    /// on the first capture buffer of many devices), so tearing the tract down
    /// would lose audio and, inside a channel, the media session for no reason.
    /// `DeviceChanged` is informational — cpal already rerouted. `RealtimeDenied`
    /// only means the thread was not promoted; the samples still flow.
    #[must_use]
    pub fn is_fatal(self) -> bool {
        !matches!(
            self,
            Self::Xrun | Self::DeviceChanged | Self::RealtimeDenied
        )
    }

    /// Short name for logs and diagnostics.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::DeviceBusy => "DeviceBusy",
            Self::DeviceChanged => "DeviceChanged",
            Self::DeviceNotAvailable => "DeviceNotAvailable",
            Self::HostUnavailable => "HostUnavailable",
            Self::InvalidInput => "InvalidInput",
            Self::PermissionDenied => "PermissionDenied",
            Self::RealtimeDenied => "RealtimeDenied",
            Self::ResourceExhausted => "ResourceExhausted",
            Self::StreamInvalidated => "StreamInvalidated",
            Self::UnsupportedConfig => "UnsupportedConfig",
            Self::UnsupportedOperation => "UnsupportedOperation",
            Self::Xrun => "Xrun",
            Self::BackendError => "BackendError",
            Self::Other => "Other",
        }
    }
}

fn encode_kind(kind: cpal::ErrorKind) -> u8 {
    match kind {
        cpal::ErrorKind::DeviceBusy => 1,
        cpal::ErrorKind::DeviceChanged => 2,
        cpal::ErrorKind::DeviceNotAvailable => 3,
        cpal::ErrorKind::HostUnavailable => 4,
        cpal::ErrorKind::InvalidInput => 5,
        cpal::ErrorKind::PermissionDenied => 6,
        cpal::ErrorKind::RealtimeDenied => 7,
        cpal::ErrorKind::ResourceExhausted => 8,
        cpal::ErrorKind::StreamInvalidated => 9,
        cpal::ErrorKind::UnsupportedConfig => 10,
        cpal::ErrorKind::UnsupportedOperation => 11,
        cpal::ErrorKind::Xrun => 12,
        cpal::ErrorKind::BackendError => 13,
        _ => KIND_OTHER,
    }
}

fn decode_kind(code: u8) -> Option<StreamErrorKind> {
    match code {
        KIND_NONE => None,
        1 => Some(StreamErrorKind::DeviceBusy),
        2 => Some(StreamErrorKind::DeviceChanged),
        3 => Some(StreamErrorKind::DeviceNotAvailable),
        4 => Some(StreamErrorKind::HostUnavailable),
        5 => Some(StreamErrorKind::InvalidInput),
        6 => Some(StreamErrorKind::PermissionDenied),
        7 => Some(StreamErrorKind::RealtimeDenied),
        8 => Some(StreamErrorKind::ResourceExhausted),
        9 => Some(StreamErrorKind::StreamInvalidated),
        10 => Some(StreamErrorKind::UnsupportedConfig),
        11 => Some(StreamErrorKind::UnsupportedOperation),
        12 => Some(StreamErrorKind::Xrun),
        13 => Some(StreamErrorKind::BackendError),
        _ => Some(StreamErrorKind::Other),
    }
}

/// One error reported by the cpal callback, read outside the realtime thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamError {
    /// Classified kind.
    pub kind: StreamErrorKind,
    /// cpal's message, when it had one (WASAPI maps HRESULTs to text).
    pub message: Option<String>,
    /// Errors recorded on this stream since it was opened.
    pub count: u64,
    /// True the first time this stream's error state is taken.
    pub first: bool,
}

/// Error slot shared with the cpal callback of one stream.
///
/// The callback only stores bytes into atomics: no allocation, no locks and no
/// logging on the audio thread. The engine reads and clears it from its own
/// thread.
#[derive(Debug)]
pub struct StreamErrorState {
    kind: AtomicU8,
    count: AtomicU64,
    /// Errors already taken, for the `first` flag.
    seen: AtomicU64,
    message_len: AtomicU32,
    message: [AtomicU8; ERROR_MESSAGE_MAX],
}

impl Default for StreamErrorState {
    fn default() -> Self {
        Self {
            kind: AtomicU8::new(KIND_NONE),
            count: AtomicU64::new(0),
            seen: AtomicU64::new(0),
            message_len: AtomicU32::new(0),
            // `AtomicU8` is not `Copy`, hence the const block.
            message: [const { AtomicU8::new(0) }; ERROR_MESSAGE_MAX],
        }
    }
}

impl StreamErrorState {
    /// Creates an empty slot.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Records an error from the realtime callback.
    ///
    /// Best effort by design: the message is truncated to
    /// [`ERROR_MESSAGE_MAX`] bytes. The kind is published last, so a reader
    /// that sees a kind also sees a complete message.
    fn record(&self, error: &cpal::Error) {
        self.count.fetch_add(1, Ordering::Relaxed);
        let message = error.message().unwrap_or_default().as_bytes();
        let len = message.len().min(ERROR_MESSAGE_MAX);
        self.message_len.store(0, Ordering::Release);
        for (slot, byte) in self.message.iter().zip(message.iter()).take(len) {
            slot.store(*byte, Ordering::Relaxed);
        }
        self.message_len.store(len as u32, Ordering::Release);
        self.kind
            .store(encode_kind(error.kind()), Ordering::Release);
    }

    /// Takes the pending error, if any, leaving the slot empty.
    ///
    /// The cumulative `count` is kept so a stream that keeps failing can be
    /// told apart from a one-off glitch.
    pub fn take(&self) -> Option<StreamError> {
        let code = self.kind.swap(KIND_NONE, Ordering::AcqRel);
        let kind = decode_kind(code)?;
        let len = (self.message_len.load(Ordering::Acquire) as usize).min(ERROR_MESSAGE_MAX);
        let mut bytes = Vec::with_capacity(len);
        for slot in self.message.iter().take(len) {
            bytes.push(slot.load(Ordering::Relaxed));
        }
        let message = String::from_utf8_lossy(&bytes).trim().to_owned();
        let count = self.count.load(Ordering::Relaxed);
        let seen = self.seen.swap(count, Ordering::AcqRel);
        Some(StreamError {
            kind,
            message: (!message.is_empty()).then_some(message),
            count,
            first: seen == 0,
        })
    }

    /// True when an error is waiting to be taken.
    #[must_use]
    pub fn has_error(&self) -> bool {
        self.kind.load(Ordering::Acquire) != KIND_NONE
    }
}

/// Conversion of a backend sample to the mono `f32` pipeline format.
///
/// cpal's `Sample` trait needs a `ToSample` bound we cannot express generically
/// here, so the few formats a device can use are converted explicitly.
trait ToMono: SizedSample {
    fn to_mono(self) -> f32;
}

/// Conversion of the mono `f32` pipeline format back to a backend sample.
trait FromMono: SizedSample {
    fn from_mono(value: f32) -> Self;
}

macro_rules! impl_float {
    ($($ty:ty),*) => {
        $(
            impl ToMono for $ty {
                fn to_mono(self) -> f32 {
                    self as f32
                }
            }
            impl FromMono for $ty {
                fn from_mono(value: f32) -> Self {
                    value.clamp(-1.0, 1.0) as $ty
                }
            }
        )*
    };
}

macro_rules! impl_signed {
    ($($ty:ty => $scale:expr),*) => {
        $(
            impl ToMono for $ty {
                fn to_mono(self) -> f32 {
                    self as f32 / $scale
                }
            }
            impl FromMono for $ty {
                fn from_mono(value: f32) -> Self {
                    (value.clamp(-1.0, 1.0) * $scale) as $ty
                }
            }
        )*
    };
}

macro_rules! impl_unsigned {
    ($($ty:ty => $half:expr),*) => {
        $(
            impl ToMono for $ty {
                fn to_mono(self) -> f32 {
                    (self as f32 - $half) / $half
                }
            }
            impl FromMono for $ty {
                fn from_mono(value: f32) -> Self {
                    (value.clamp(-1.0, 1.0) * $half + $half) as $ty
                }
            }
        )*
    };
}

impl_float!(f32, f64);
impl_signed!(
    i8 => 128.0,
    i16 => 32768.0,
    i32 => 2_147_483_648.0,
    i64 => 9_223_372_036_854_775_808.0
);
impl_unsigned!(
    u8 => 128.0,
    u16 => 32768.0,
    u32 => 2_147_483_648.0,
    u64 => 9_223_372_036_854_775_808.0
);

/// One selectable input or output device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// Stable device id, suitable for storing in settings.
    pub id: String,
    /// Human-readable name from the OS.
    pub name: String,
    /// Whether this is the current system default.
    pub is_default: bool,
    /// Channel count of the default configuration.
    pub channels: u16,
    /// Native sample rate; the engine resamples to 48 kHz when it differs.
    pub sample_rate: u32,
    /// Sample format, for diagnostics only.
    pub sample_format: String,
}

/// All devices visible to the default host, plus the defaults.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceList {
    pub inputs: Vec<DeviceInfo>,
    pub outputs: Vec<DeviceInfo>,
    /// Device id of the default input, if any.
    pub default_input: Option<String>,
    /// Device id of the default output, if any.
    pub default_output: Option<String>,
}

impl DeviceList {
    /// True when `id` is one of the listed inputs.
    #[must_use]
    pub fn has_input(&self, id: &str) -> bool {
        self.inputs.iter().any(|device| device.id == id)
    }

    /// True when `id` is one of the listed outputs.
    #[must_use]
    pub fn has_output(&self, id: &str) -> bool {
        self.outputs.iter().any(|device| device.id == id)
    }
}

/// One stream format: channel count, sample rate and sample format.
///
/// Used for the log line written when a device is opened and for the
/// diagnostics export (stage P5); it never crosses the IPC boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenFormat {
    /// Channels the stream was opened with.
    pub channels: u16,
    /// Sample rate of the opened stream.
    pub sample_rate: u32,
    /// Sample format name (`F32`, `I16`, ...).
    pub sample_format: String,
}

impl OpenFormat {
    fn new(channels: u16, sample_rate: u32, sample_format: SampleFormat) -> Self {
        Self {
            channels,
            sample_rate,
            sample_format: format!("{sample_format:?}"),
        }
    }

    /// `8 ch, 48000 Hz, F32` — compact, locale-free and safe to paste into a
    /// report.
    #[must_use]
    pub fn describe(&self) -> String {
        format!(
            "{} ch, {} Hz, {}",
            self.channels, self.sample_rate, self.sample_format
        )
    }
}

/// The format an input or output stream is running with, plus the format the
/// device uses by default (the WASAPI mix format).
///
/// Written to the log and to the diagnostics export when the device is opened
/// (stage P5); the troubleshoot of a multichannel device starts with this pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamFormatInfo {
    /// Format the stream is running with.
    pub opened: OpenFormat,
    /// Format the device reports as its default.
    pub default: OpenFormat,
}

/// Input and output formats of the running tract.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AudioFormats {
    pub input: Option<StreamFormatInfo>,
    pub output: Option<StreamFormatInfo>,
}

/// Lists input and output devices with their default configurations.
///
/// Never fails: a broken backend yields an empty list and the engine falls back
/// to "no device", which is reported to the UI.
#[must_use]
pub fn list_devices() -> DeviceList {
    let host = cpal::default_host();
    let default_input = host
        .default_input_device()
        .and_then(|device| device.id().ok())
        .map(|id| id.to_string());
    let default_output = host
        .default_output_device()
        .and_then(|device| device.id().ok())
        .map(|id| id.to_string());

    let mut inputs = Vec::new();
    if let Ok(devices) = host.input_devices() {
        for device in devices {
            if let Some(info) = describe(&device, true) {
                inputs.push(info);
            }
        }
    }
    let mut outputs = Vec::new();
    if let Ok(devices) = host.output_devices() {
        for device in devices {
            if let Some(info) = describe(&device, false) {
                outputs.push(info);
            }
        }
    }

    DeviceList {
        inputs,
        outputs,
        default_input,
        default_output,
    }
}

fn describe(device: &cpal::Device, input: bool) -> Option<DeviceInfo> {
    let id = device.id().ok()?.to_string();
    let name = device
        .description()
        .ok()
        .map(|description| description.name().to_owned())
        .unwrap_or_else(|| id.clone());
    let config = if input {
        device.default_input_config().ok()
    } else {
        device.default_output_config().ok()
    };
    let (channels, sample_rate, sample_format) = match config {
        Some(config) => (
            config.channels(),
            config.sample_rate(),
            format!("{:?}", config.sample_format()),
        ),
        None => (0, 0, String::new()),
    };
    Some(DeviceInfo {
        id,
        name,
        is_default: false,
        channels,
        sample_rate,
        sample_format,
    })
}

/// True when `device` is still available.
#[must_use]
pub fn device_available(id: &str, input: bool) -> bool {
    let host = cpal::default_host();
    let mut devices = match host.devices() {
        Ok(devices) => devices,
        Err(_) => return false,
    };
    devices.any(|device| {
        let matches = device
            .id()
            .ok()
            .map(|candidate| candidate.to_string() == id)
            .unwrap_or(false);
        matches
            && if input {
                device.supports_input()
            } else {
                device.supports_output()
            }
    })
}

fn find_device(id: Option<&str>, input: bool) -> Result<cpal::Device, VoiceError> {
    let host = cpal::default_host();
    if let Some(id) = id {
        if let Ok(devices) = host.devices() {
            for device in devices {
                let matches = device
                    .id()
                    .ok()
                    .map(|candidate| candidate.to_string() == id)
                    .unwrap_or(false);
                let direction = if input {
                    device.supports_input()
                } else {
                    device.supports_output()
                };
                if matches && direction {
                    return Ok(device);
                }
            }
        }
        log::debug!("selected audio device is gone, falling back to the default");
    }
    let fallback = if input {
        host.default_input_device()
    } else {
        host.default_output_device()
    };
    fallback.ok_or_else(|| {
        VoiceError::Device(if input {
            "no input device".to_owned()
        } else {
            "no output device".to_owned()
        })
    })
}

/// Channel count the mono pipeline fills completely: the front left and right
/// pair. Anything wider is opened only when the device offers nothing else.
const PREFERRED_OUTPUT_CHANNELS: u16 = 2;

/// One format a device offers, mirrored from `cpal::SupportedStreamConfigRange`
/// so the choice can be unit-tested without a device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FormatRange {
    pub channels: u16,
    pub min_sample_rate: u32,
    pub max_sample_rate: u32,
    pub sample_format: SampleFormat,
}

impl FormatRange {
    fn from_default(config: &cpal::SupportedStreamConfig) -> Self {
        Self {
            channels: config.channels(),
            min_sample_rate: config.sample_rate(),
            max_sample_rate: config.sample_rate(),
            sample_format: config.sample_format(),
        }
    }

    /// Rank of this range for the requested rate and the rate to open it with.
    ///
    /// A range that covers 48 kHz wins, then one that covers the device default
    /// rate, then the closest clamped rate: the playback resampler already
    /// handles a different rate (ADR 0002, ADR 0013), so a rate change is not
    /// an error, but 48 kHz is what the pipeline is built for.
    ///
    /// WASAPI reports one range per common sample rate with `min == max`
    /// (cpal 0.18.2 `host/wasapi/device.rs`, `supported_formats`), so taking
    /// "the first stereo range" would open the stream at 5512 Hz.
    fn rate_for(&self, default_rate: u32) -> (u8, u32) {
        if (self.min_sample_rate..=self.max_sample_rate).contains(&SAMPLE_RATE) {
            return (0, SAMPLE_RATE);
        }
        if (self.min_sample_rate..=self.max_sample_rate).contains(&default_rate) {
            return (1, default_rate);
        }
        let low = self.min_sample_rate.max(1);
        let high = self.max_sample_rate.max(low);
        (2, default_rate.clamp(low, high))
    }
}

/// The format the output stream is opened with (stage P5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OutputFormatChoice {
    pub channels: u16,
    pub sample_rate: u32,
    pub sample_format: SampleFormat,
    /// True when no stereo format was offered and the device default was used.
    pub is_default: bool,
}

impl OutputFormatChoice {
    fn of_default(range: FormatRange) -> Self {
        Self {
            channels: range.channels,
            sample_rate: range.min_sample_rate,
            sample_format: range.sample_format,
            is_default: true,
        }
    }
}

/// Picks the output format: stereo F32, then stereo I16, else the device
/// default.
///
/// The mixer is mono (ADR 0007), so a 7.1 endpoint only ever gets a signal in
/// the front pair; opening it as stereo when the device allows it keeps the
/// direct-out layout simple. On WASAPI the endpoint reports only its mix format
/// channel count in `supported_output_configs()` (cpal 0.18.2
/// `host/wasapi/device.rs`, `supported_formats`), so a 7.1 device lands on the
/// default branch and the callback maps the mono sample to channels 0 and 1.
/// Tests: `stereo_f32_at_48_khz_is_preferred`, `a_stereo_device_without_f32_gets_i16`,
/// `a_stereo_device_on_another_rate_keeps_the_default_rate`,
/// `a_multichannel_device_without_stereo_keeps_its_default`.
pub(crate) fn choose_output_format(
    ranges: &[FormatRange],
    default: FormatRange,
) -> OutputFormatChoice {
    let default_rate = default.min_sample_rate;
    for preferred in [Some(SampleFormat::F32), Some(SampleFormat::I16), None] {
        let best = ranges
            .iter()
            .filter(|range| {
                range.channels == PREFERRED_OUTPUT_CHANNELS
                    && preferred.is_none_or(|format| range.sample_format == format)
            })
            .min_by_key(|range| range.rate_for(default_rate).0);
        if let Some(range) = best {
            return OutputFormatChoice {
                channels: range.channels,
                sample_rate: range.rate_for(default_rate).1,
                sample_format: range.sample_format,
                is_default: false,
            };
        }
    }
    OutputFormatChoice::of_default(default)
}

/// Everything `supported_output_configs()` reports, or nothing when the backend
/// cannot enumerate formats.
fn supported_output_ranges(device: &cpal::Device) -> Vec<FormatRange> {
    match device.supported_output_configs() {
        Ok(configs) => configs
            .map(|config| FormatRange {
                channels: config.channels(),
                min_sample_rate: config.min_sample_rate(),
                max_sample_rate: config.max_sample_rate(),
                sample_format: config.sample_format(),
            })
            .collect(),
        Err(error) => {
            log::debug!("could not list the output formats: {error}");
            Vec::new()
        }
    }
}

/// Widest microphone layout the downmixer tracks.
///
/// 64 matches the width of the channel mask; no capture layout comes close
/// (7.1 is 8 channels). A wider device keeps the old average of every channel.
pub(crate) const MAX_MIC_CHANNELS: usize = 64;

/// A capture channel this far below the loudest one (20 dB) is noise or a dead
/// line, not the microphone.
const MIC_CHANNEL_RANGE: f32 = 0.1;

/// Peak a callback block must reach (−46 dBFS) before the downmixer decides
/// which channels carry the microphone. Below it the block is silence and the
/// old average of all channels is kept.
const MIC_LOCK_PEAK: f32 = 0.005;

/// Mono downmix of a multichannel microphone.
///
/// A 7.1 headset exposes several capture channels while the pipeline is mono.
/// Averaging all of them (the behaviour before stage P5) attenuates the voice
/// by 6–18 dB when only the front channels carry the microphone, because the
/// dead channels pull the average to zero.
///
/// The first block that is louder than [`MIC_LOCK_PEAK`] decides which channels
/// carry the microphone: the ones within 20 dB of the loudest. The set is then
/// fixed for the life of the stream (a device change reopens the stream), so
/// the level does not pump while somebody talks. Until then every channel is
/// averaged — the old behaviour, and on a silent block identical to silence.
///
/// No allocation, no locks: a fixed channel mask and a fixed peak array.
#[derive(Debug)]
pub(crate) struct MicDownmix {
    mask: u64,
    peak: [f32; MAX_MIC_CHANNELS],
}

impl MicDownmix {
    pub(crate) fn new() -> Self {
        Self {
            mask: 0,
            peak: [0.0; MAX_MIC_CHANNELS],
        }
    }

    /// True until the channel set is known; the capture callback only collects
    /// peaks while this is true.
    pub(crate) fn is_undecided(&self) -> bool {
        self.mask == 0
    }

    /// Records one channel sample of the current block.
    pub(crate) fn observe(&mut self, index: usize, value: f32) {
        if let Some(peak) = self.peak.get_mut(index) {
            let level = value.abs();
            if level > *peak {
                *peak = level;
            }
        }
    }

    /// Mixes one frame of `f32` channel samples into the mono pipeline sample.
    pub(crate) fn mix(&self, frame: &[f32]) -> f32 {
        let mut sum = 0.0f32;
        let mut used = 0u32;
        for (index, &value) in frame.iter().enumerate() {
            if self.uses(index) {
                sum += value;
                used += 1;
            }
        }
        if used == 0 {
            0.0
        } else {
            sum / used as f32
        }
    }

    /// Whether a channel belongs to the current downmix.
    fn uses(&self, index: usize) -> bool {
        if self.mask == 0 {
            return true;
        }
        index < MAX_MIC_CHANNELS && self.mask & (1u64 << index) != 0
    }

    /// Chooses the channel mask from the peaks of this block.
    ///
    /// Called once per cpal callback, before the block is mixed; the peaks are
    /// cleared so every block is judged on its own until one decides.
    pub(crate) fn finish_block(&mut self, channels: usize) {
        if self.mask != 0 {
            return;
        }
        let loudest = self
            .peak
            .iter()
            .take(channels.min(MAX_MIC_CHANNELS))
            .fold(0.0f32, |max, peak| max.max(*peak));
        if loudest >= MIC_LOCK_PEAK && channels <= MAX_MIC_CHANNELS {
            let threshold = loudest * MIC_CHANNEL_RANGE;
            let mut mask = 0u64;
            for (index, peak) in self.peak.iter().take(channels).enumerate() {
                if *peak >= threshold {
                    mask |= 1 << index;
                }
            }
            self.mask = mask;
        }
        self.peak.fill(0.0);
    }
}

/// A running capture stream. Drop it to stop capturing.
pub struct CaptureStream {
    _stream: cpal::Stream,
    device_id: String,
    device_name: String,
    sample_rate: u32,
    format: StreamFormatInfo,
}

impl CaptureStream {
    /// Id of the device that was actually opened (may differ from the request
    /// after a fallback to the default).
    #[must_use]
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// Native sample rate of the opened stream.
    #[must_use]
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Human-readable device name.
    #[must_use]
    pub fn device_name(&self) -> &str {
        &self.device_name
    }

    /// Opened format and the device default, for the log and diagnostics.
    #[must_use]
    pub fn format(&self) -> &StreamFormatInfo {
        &self.format
    }
}

/// A running playback stream. Drop it to stop playback.
pub struct PlaybackStream {
    _stream: cpal::Stream,
    device_id: String,
    device_name: String,
    sample_rate: u32,
    format: StreamFormatInfo,
}

impl PlaybackStream {
    /// Id of the device that was actually opened.
    #[must_use]
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// Native sample rate of the opened stream.
    #[must_use]
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Human-readable device name.
    #[must_use]
    pub fn device_name(&self) -> &str {
        &self.device_name
    }

    /// Opened format and the device default, for the log and diagnostics.
    #[must_use]
    pub fn format(&self) -> &StreamFormatInfo {
        &self.format
    }
}

/// Opens the selected input device and pushes mono `f32` samples into `sink`.
///
/// The returned stream must be kept alive. `errors` is filled from the stream
/// error callback (which cannot allocate) and polled by the engine.
pub fn open_capture(
    id: Option<&str>,
    sink: HeapProd<f32>,
    errors: Arc<StreamErrorState>,
    overflows: Arc<AtomicU64>,
) -> Result<CaptureStream, VoiceError> {
    let device = find_device(id, true)?;
    let device_id = device
        .id()
        .map(|value| value.to_string())
        .unwrap_or_default();
    let device_name = device
        .description()
        .map(|description| description.name().to_owned())
        .unwrap_or_default();
    let supported = device
        .default_input_config()
        .map_err(|err| VoiceError::Stream(format!("input configuration: {err}")))?;
    let config = StreamConfig {
        channels: supported.channels(),
        sample_rate: supported.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };
    let channels = usize::from(supported.channels());
    let sample_rate = supported.sample_rate();
    let default_format = OpenFormat::new(channels as u16, sample_rate, supported.sample_format());
    log::info!(
        "input device {device_name:?}: {} channel(s), {} Hz, {}",
        default_format.channels,
        default_format.sample_rate,
        default_format.sample_format
    );
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build_input::<f32>(&device, config, channels, sink, errors, overflows),
        SampleFormat::F64 => build_input::<f64>(&device, config, channels, sink, errors, overflows),
        SampleFormat::I8 => build_input::<i8>(&device, config, channels, sink, errors, overflows),
        SampleFormat::I16 => build_input::<i16>(&device, config, channels, sink, errors, overflows),
        SampleFormat::I32 => build_input::<i32>(&device, config, channels, sink, errors, overflows),
        SampleFormat::I64 => build_input::<i64>(&device, config, channels, sink, errors, overflows),
        SampleFormat::U8 => build_input::<u8>(&device, config, channels, sink, errors, overflows),
        SampleFormat::U16 => build_input::<u16>(&device, config, channels, sink, errors, overflows),
        SampleFormat::U32 => build_input::<u32>(&device, config, channels, sink, errors, overflows),
        SampleFormat::U64 => build_input::<u64>(&device, config, channels, sink, errors, overflows),
        format => {
            return Err(VoiceError::Stream(format!(
                "unsupported input sample format {format:?}"
            )))
        }
    }?;
    stream
        .play()
        .map_err(|err| VoiceError::Stream(format!("start input stream: {err}")))?;
    Ok(CaptureStream {
        _stream: stream,
        device_id,
        device_name,
        sample_rate,
        format: StreamFormatInfo {
            opened: default_format.clone(),
            default: default_format,
        },
    })
}

fn build_input<T>(
    device: &cpal::Device,
    config: StreamConfig,
    channels: usize,
    mut sink: HeapProd<f32>,
    errors: Arc<StreamErrorState>,
    overflows: Arc<AtomicU64>,
) -> Result<cpal::Stream, VoiceError>
where
    T: ToMono + Send + 'static,
{
    let channels = channels.max(1);
    // The downmix state and its per-frame scratch live in the callback: a fixed
    // mask and a fixed array, no allocation, no locks and no logging.
    let mut downmix = MicDownmix::new();
    let mut values = [0.0f32; MAX_MIC_CHANNELS];
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                // Learn the microphone channels from the first block with
                // signal, before mixing it: deciding afterwards would make the
                // first 10 ms of the first word 6–18 dB quieter.
                if downmix.is_undecided() {
                    for frame in data.chunks_exact(channels) {
                        for (index, sample) in frame.iter().enumerate() {
                            downmix.observe(index, sample.to_mono());
                        }
                    }
                    downmix.finish_block(channels);
                }
                for frame in data.chunks_exact(channels) {
                    let len = frame.len().min(MAX_MIC_CHANNELS);
                    for (slot, sample) in values.iter_mut().zip(frame.iter()) {
                        *slot = sample.to_mono();
                    }
                    // A full ring means the processing thread is behind; the
                    // newest sample is dropped rather than blocking the driver,
                    // and the drop is counted for diagnostics.
                    let mixed = downmix.mix(&values[..len]);
                    push_input(&mut sink, mixed, &overflows);
                }
            },
            move |error| errors.record(&error),
            None,
        )
        .map_err(|err| VoiceError::Stream(format!("build input stream: {err}")))
}

/// Pushes one sample into the capture ring, counting a full ring.
///
/// Kept separate from the cpal callback so the overflow path is unit-tested
/// without a device.
pub(crate) fn push_input(sink: &mut HeapProd<f32>, sample: f32, overflows: &AtomicU64) {
    if sink.try_push(sample).is_err() {
        overflows.fetch_add(1, Ordering::Relaxed);
    }
}

/// Opens the selected output device and plays mono `f32` samples from `source`.
///
/// The returned stream must be kept alive. `errors` is filled from the stream
/// error callback.
pub fn open_playback(
    id: Option<&str>,
    source: ringbuf::HeapCons<f32>,
    errors: Arc<StreamErrorState>,
    drops: Arc<std::sync::atomic::AtomicU64>,
) -> Result<PlaybackStream, VoiceError> {
    let device = find_device(id, false)?;
    let device_id = device
        .id()
        .map(|value| value.to_string())
        .unwrap_or_default();
    let device_name = device
        .description()
        .map(|description| description.name().to_owned())
        .unwrap_or_default();
    let supported = device
        .default_output_config()
        .map_err(|err| VoiceError::Stream(format!("output configuration: {err}")))?;
    let default_format = OpenFormat::new(
        supported.channels(),
        supported.sample_rate(),
        supported.sample_format(),
    );
    // Stage P5: stereo when the device offers it, otherwise its default
    // multichannel format with the mono sample mapped to the front pair.
    let choice = choose_output_format(
        &supported_output_ranges(&device),
        FormatRange::from_default(&supported),
    );
    let config = StreamConfig {
        channels: choice.channels,
        sample_rate: choice.sample_rate,
        buffer_size: cpal::BufferSize::Default,
    };
    let channels = usize::from(choice.channels);
    let sample_rate = choice.sample_rate;
    let opened = OpenFormat::new(choice.channels, choice.sample_rate, choice.sample_format);
    log::info!(
        "output device {device_name:?}: device default {}; opened {}{}",
        default_format.describe(),
        opened.describe(),
        if choice.is_default {
            " (device default, mono goes to channels 0 and 1)"
        } else {
            " (stereo)"
        }
    );
    let stream = match choice.sample_format {
        SampleFormat::F32 => build_output::<f32>(&device, config, channels, source, errors, drops),
        SampleFormat::F64 => build_output::<f64>(&device, config, channels, source, errors, drops),
        SampleFormat::I8 => build_output::<i8>(&device, config, channels, source, errors, drops),
        SampleFormat::I16 => build_output::<i16>(&device, config, channels, source, errors, drops),
        SampleFormat::I32 => build_output::<i32>(&device, config, channels, source, errors, drops),
        SampleFormat::I64 => build_output::<i64>(&device, config, channels, source, errors, drops),
        SampleFormat::U8 => build_output::<u8>(&device, config, channels, source, errors, drops),
        SampleFormat::U16 => build_output::<u16>(&device, config, channels, source, errors, drops),
        SampleFormat::U32 => build_output::<u32>(&device, config, channels, source, errors, drops),
        SampleFormat::U64 => build_output::<u64>(&device, config, channels, source, errors, drops),
        format => {
            return Err(VoiceError::Stream(format!(
                "unsupported output sample format {format:?}"
            )))
        }
    }?;
    stream
        .play()
        .map_err(|err| VoiceError::Stream(format!("start output stream: {err}")))?;
    Ok(PlaybackStream {
        _stream: stream,
        device_id,
        device_name,
        sample_rate,
        format: StreamFormatInfo {
            opened,
            default: default_format,
        },
    })
}

fn build_output<T>(
    device: &cpal::Device,
    config: StreamConfig,
    channels: usize,
    mut source: ringbuf::HeapCons<f32>,
    errors: Arc<StreamErrorState>,
    drops: Arc<std::sync::atomic::AtomicU64>,
) -> Result<cpal::Stream, VoiceError>
where
    T: FromMono + Send + 'static,
{
    let channels = channels.max(1);
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                for frame in data.chunks_exact_mut(channels) {
                    // Starved output plays silence; the underrun is counted for
                    // the connection indicator and the diagnostics.
                    let sample = next_output_sample(&mut source, &drops);
                    write_output_frame(frame, sample);
                }
            },
            move |error| errors.record(&error),
            None,
        )
        .map_err(|err| VoiceError::Stream(format!("build output stream: {err}")))
}

/// Maps one mono pipeline sample onto the channels of an output frame.
///
/// Mono goes to the front left and right channels (indices 0 and 1) and every
/// other channel is set to silence. On a 5.1/7.1 endpoint this leaves the
/// centre, the LFE (index 3) and the surrounds silent: a voice copied into the
/// subwoofer and the rear speakers is not what the user expects, and the
/// duplicated signal in an 8-channel virtual device is the Razer hiss report
/// (stage P5). A one-channel device gets the sample as is.
///
/// Allocation-free and lock-free: it runs in the cpal callback.
fn write_output_frame<T: FromMono>(frame: &mut [T], sample: f32) {
    match frame {
        [] => {}
        [mono] => *mono = T::from_mono(sample),
        [left, right, rest @ ..] => {
            *left = T::from_mono(sample);
            *right = T::from_mono(sample);
            for channel in rest {
                *channel = T::from_mono(0.0);
            }
        }
    }
}

/// Pops one playback sample, counting the frame as an underrun when the ring is
/// empty. Kept separate from the cpal callback so it is unit-testable.
fn next_output_sample(source: &mut ringbuf::HeapCons<f32>, drops: &AtomicU64) -> f32 {
    match ringbuf::traits::Consumer::try_pop(source) {
        Some(sample) => sample,
        None => {
            drops.fetch_add(1, Ordering::Relaxed);
            0.0
        }
    }
}

/// Watches the device list and signals every change, including plugging and
/// unplugging a headset.
///
/// Returns a join handle; the thread stops when the receiver is dropped.
pub fn spawn_device_watcher(
    interval: std::time::Duration,
    sender: std::sync::mpsc::Sender<DeviceList>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("rostalk-devices".to_owned())
        .spawn(move || {
            let mut previous = list_devices();
            loop {
                std::thread::sleep(interval);
                let current = list_devices();
                if current != previous {
                    previous = current.clone();
                    if sender.send(current).is_err() {
                        return;
                    }
                }
            }
        })
        .unwrap_or_else(|error| {
            log::warn!("could not start the device watcher: {error}");
            std::thread::spawn(|| {})
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ringbuf::traits::Split;

    #[test]
    fn listing_does_not_fail_without_devices() {
        // CI runners may have no audio device at all; the call must still
        // return a usable, possibly empty, list.
        let devices = list_devices();
        for device in devices.inputs.iter().chain(&devices.outputs) {
            assert!(!device.id.is_empty());
            assert!(!device.name.is_empty());
        }
    }

    #[test]
    fn unknown_id_is_not_available() {
        assert!(!device_available("definitely-not-a-device", true));
        assert!(!device_available("definitely-not-a-device", false));
    }

    #[test]
    fn device_list_helpers_are_consistent() {
        let list = DeviceList::default();
        assert!(!list.has_input("x"));
        assert!(!list.has_output("x"));
    }

    #[test]
    fn a_full_capture_ring_counts_an_overflow_instead_of_blocking() {
        let (mut producer, _consumer) = ringbuf::HeapRb::<f32>::new(2).split();
        let overflows = AtomicU64::new(0);
        push_input(&mut producer, 0.1, &overflows);
        push_input(&mut producer, 0.2, &overflows);
        assert_eq!(overflows.load(Ordering::Relaxed), 0);
        push_input(&mut producer, 0.3, &overflows);
        assert_eq!(overflows.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn an_empty_playback_ring_counts_an_underrun() {
        let (_producer, mut consumer) = ringbuf::HeapRb::<f32>::new(2).split();
        let drops = AtomicU64::new(0);
        assert_eq!(next_output_sample(&mut consumer, &drops), 0.0);
        assert_eq!(drops.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn a_filled_playback_ring_plays_the_sample_without_a_underrun() {
        let (mut producer, mut consumer) = ringbuf::HeapRb::<f32>::new(2).split();
        producer.try_push(0.4).expect("push");
        let drops = AtomicU64::new(0);
        assert_eq!(next_output_sample(&mut consumer, &drops), 0.4);
        assert_eq!(drops.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn a_benign_xrun_is_not_a_reason_to_rebuild_the_tract() {
        // WASAPI reports a data discontinuity on the first capture buffer of
        // some devices. The stream keeps running; treating it as fatal made
        // the tract restart on every heartbeat (stage 2.3.2a.1).
        assert!(!StreamErrorKind::Xrun.is_fatal());
        assert!(!StreamErrorKind::DeviceChanged.is_fatal());
        assert!(!StreamErrorKind::RealtimeDenied.is_fatal());
        assert!(StreamErrorKind::DeviceNotAvailable.is_fatal());
        assert!(StreamErrorKind::StreamInvalidated.is_fatal());
        assert!(StreamErrorKind::BackendError.is_fatal());
        assert!(StreamErrorKind::Other.is_fatal());
    }

    #[test]
    fn a_stream_error_keeps_the_kind_the_message_and_the_count() {
        let state = StreamErrorState::new();
        assert!(!state.has_error());
        assert!(state.take().is_none());

        state.record(&cpal::Error::with_message(
            cpal::ErrorKind::DeviceNotAvailable,
            "endpoint unplugged",
        ));
        assert!(state.has_error());
        let error = state.take().expect("one error");
        assert_eq!(error.kind, StreamErrorKind::DeviceNotAvailable);
        assert_eq!(error.message.as_deref(), Some("endpoint unplugged"));
        assert_eq!(error.count, 1);
        assert!(error.first);
        // Taking it clears the slot so the engine does not handle it twice.
        assert!(!state.has_error());
        assert!(state.take().is_none());

        state.record(&cpal::Error::new(cpal::ErrorKind::Xrun));
        let error = state.take().expect("second error");
        assert_eq!(error.kind, StreamErrorKind::Xrun);
        assert_eq!(error.message, None);
        assert_eq!(error.count, 2);
        assert!(!error.first);
    }

    #[test]
    fn every_cpal_kind_round_trips_through_the_callback_code() {
        let kinds = [
            cpal::ErrorKind::DeviceBusy,
            cpal::ErrorKind::DeviceChanged,
            cpal::ErrorKind::DeviceNotAvailable,
            cpal::ErrorKind::HostUnavailable,
            cpal::ErrorKind::InvalidInput,
            cpal::ErrorKind::PermissionDenied,
            cpal::ErrorKind::RealtimeDenied,
            cpal::ErrorKind::ResourceExhausted,
            cpal::ErrorKind::StreamInvalidated,
            cpal::ErrorKind::UnsupportedConfig,
            cpal::ErrorKind::UnsupportedOperation,
            cpal::ErrorKind::Xrun,
            cpal::ErrorKind::BackendError,
            cpal::ErrorKind::Other,
        ];
        let mut seen = Vec::new();
        for kind in kinds {
            let decoded = decode_kind(encode_kind(kind)).expect("known kind");
            assert!(
                !seen.contains(&decoded),
                "{kind:?} collides with another kind"
            );
            seen.push(decoded);
        }
        assert_eq!(seen.len(), 14);
        assert_eq!(encode_kind(cpal::ErrorKind::Xrun), 12);
        assert_eq!(decode_kind(12), Some(StreamErrorKind::Xrun));
    }

    // --- Stage P5: output channel mapping -------------------------------

    #[test]
    fn a_seven_point_one_output_keeps_the_signal_in_the_front_pair() {
        // 7.1 order: FL, FR, FC, LFE, BL, BR, SL, SR. The old callback copied
        // the mono sample into every channel, LFE included (the Razer hiss
        // report); now only the front pair carries it.
        let mut frame = [0.0f32; 8];
        write_output_frame(&mut frame, 0.5);
        assert_eq!(frame, [0.5, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(frame[3], 0.0, "LFE must stay silent");
    }

    #[test]
    fn a_five_point_one_output_keeps_the_signal_in_the_front_pair() {
        // 5.1 order: FL, FR, FC, LFE, BL, BR.
        let mut frame = [0.25f32; 6];
        write_output_frame(&mut frame, -0.5);
        assert_eq!(frame, [-0.5, -0.5, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(frame[3], 0.0, "LFE must stay silent");
    }

    #[test]
    fn a_stereo_output_gets_the_sample_in_both_channels() {
        let mut frame = [0.0f32; 2];
        write_output_frame(&mut frame, 0.75);
        assert_eq!(frame, [0.75, 0.75]);
    }

    #[test]
    fn a_mono_output_gets_the_sample_once() {
        let mut frame = [0.0f32; 1];
        write_output_frame(&mut frame, -0.25);
        assert_eq!(frame, [-0.25]);
    }

    #[test]
    fn an_empty_output_frame_is_left_alone() {
        let mut frame: [f32; 0] = [];
        write_output_frame(&mut frame, 0.5);
        assert!(frame.is_empty());
    }

    #[test]
    fn the_channel_mapping_also_silences_the_extra_channels_in_i16() {
        // The conversion of silence is format specific: for `i16` it is 0, for
        // the unsigned formats the neutral midpoint.
        let mut frame = [1i16; 8];
        write_output_frame(&mut frame, 0.5);
        assert_eq!(frame, [16_384, 16_384, 0, 0, 0, 0, 0, 0]);
        let mut unsigned = [7u8; 4];
        write_output_frame(&mut unsigned, 0.0);
        assert_eq!(unsigned, [128, 128, 128, 128]);
    }

    // --- Stage P5: output format choice ---------------------------------

    fn range(channels: u16, min: u32, max: u32, sample_format: SampleFormat) -> FormatRange {
        FormatRange {
            channels,
            min_sample_rate: min,
            max_sample_rate: max,
            sample_format,
        }
    }

    #[test]
    fn stereo_f32_at_48_khz_is_preferred() {
        let default = range(2, 44_100, 44_100, SampleFormat::I16);
        let ranges = [
            range(2, 44_100, 44_100, SampleFormat::I16),
            range(2, 44_100, 48_000, SampleFormat::F32),
        ];
        assert_eq!(
            choose_output_format(&ranges, default),
            OutputFormatChoice {
                channels: 2,
                sample_rate: 48_000,
                sample_format: SampleFormat::F32,
                is_default: false,
            }
        );
    }

    #[test]
    fn a_stereo_device_without_f32_gets_i16() {
        let default = range(2, 44_100, 44_100, SampleFormat::F32);
        let ranges = [
            range(2, 44_100, 48_000, SampleFormat::F64),
            range(2, 44_100, 48_000, SampleFormat::I16),
        ];
        let choice = choose_output_format(&ranges, default);
        assert_eq!(choice.sample_format, SampleFormat::I16);
        assert_eq!(choice.channels, 2);
        assert_eq!(choice.sample_rate, 48_000);
        assert!(!choice.is_default);
    }

    #[test]
    fn a_stereo_device_on_another_rate_keeps_the_default_rate() {
        // No 48 kHz in the range: the device default rate is used and the
        // playback resampler converts to it (ADR 0002).
        let default = range(2, 44_100, 44_100, SampleFormat::F32);
        let ranges = [range(2, 44_100, 44_100, SampleFormat::F32)];
        let choice = choose_output_format(&ranges, default);
        assert_eq!(choice.sample_rate, 44_100);
        assert!(!choice.is_default);
    }

    #[test]
    fn a_wasapi_rate_table_picks_the_48_khz_entry_not_the_first_one() {
        // WASAPI reports one stereo F32 range per common rate, each with
        // min == max (cpal 0.18.2 supported_formats), and 5512 Hz is first in
        // the list. Taking the first match opened the stream at 8 kHz on a
        // real endpoint; the 48 kHz entry must win.
        let default = range(2, 48_000, 48_000, SampleFormat::F32);
        let ranges = [
            range(2, 5_512, 5_512, SampleFormat::F32),
            range(2, 8_000, 8_000, SampleFormat::F32),
            range(2, 22_050, 22_050, SampleFormat::F32),
            range(2, 44_100, 44_100, SampleFormat::F32),
            range(2, 48_000, 48_000, SampleFormat::F32),
            range(2, 96_000, 96_000, SampleFormat::F32),
            range(2, 48_000, 48_000, SampleFormat::I16),
        ];
        let choice = choose_output_format(&ranges, default);
        assert_eq!(choice.sample_rate, 48_000);
        assert_eq!(choice.sample_format, SampleFormat::F32);
    }

    #[test]
    fn a_rate_table_without_48_khz_keeps_the_device_rate() {
        // Same shape, but the endpoint does not offer 48 kHz: the device
        // default rate (44.1 kHz here) is the next choice, not 5512 Hz.
        let default = range(2, 44_100, 44_100, SampleFormat::F32);
        let ranges = [
            range(2, 5_512, 5_512, SampleFormat::F32),
            range(2, 8_000, 8_000, SampleFormat::F32),
            range(2, 44_100, 44_100, SampleFormat::F32),
        ];
        assert_eq!(choose_output_format(&ranges, default).sample_rate, 44_100);
    }

    #[test]
    fn a_multichannel_device_without_stereo_keeps_its_default() {
        // WASAPI reports only the mix format channel count for output
        // (cpal 0.18.2 host/wasapi/device.rs), so a 7.1 endpoint has no stereo
        // entry and the default 8-channel format is opened; the callback then
        // maps mono to channels 0 and 1.
        let default = range(8, 48_000, 48_000, SampleFormat::F32);
        let ranges = [
            range(8, 44_100, 44_100, SampleFormat::F32),
            range(8, 48_000, 48_000, SampleFormat::F32),
        ];
        assert_eq!(
            choose_output_format(&ranges, default),
            OutputFormatChoice {
                channels: 8,
                sample_rate: 48_000,
                sample_format: SampleFormat::F32,
                is_default: true,
            }
        );
    }

    #[test]
    fn a_mono_device_is_opened_as_mono() {
        let default = range(1, 48_000, 48_000, SampleFormat::I16);
        let ranges = [range(1, 16_000, 48_000, SampleFormat::I16)];
        let choice = choose_output_format(&ranges, default);
        assert_eq!(choice.channels, 1);
        assert!(choice.is_default);
    }

    #[test]
    fn an_unlisted_rate_is_brought_into_the_range() {
        // Defensive: a backend that reports a narrow range still gets a rate it
        // claims to support instead of a failed stream.
        let default = range(2, 96_000, 96_000, SampleFormat::F32);
        let ranges = [range(2, 32_000, 44_100, SampleFormat::F32)];
        assert_eq!(
            choose_output_format(&ranges, default).sample_rate,
            44_100,
            "the default rate is clamped into the advertised range"
        );
    }

    // --- Stage P5: microphone downmix -----------------------------------

    #[test]
    fn a_stereo_microphone_with_one_dead_channel_keeps_its_level() {
        // Before P5 the callback averaged all channels, so a mic that only
        // feeds the left channel lost 6 dB.
        let mut downmix = MicDownmix::new();
        downmix.observe(0, 0.5);
        downmix.observe(1, 0.0);
        downmix.finish_block(2);
        assert!(!downmix.is_undecided());
        assert!((downmix.mix(&[0.5, 0.0]) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn a_duplicated_stereo_microphone_is_not_made_louder() {
        let mut downmix = MicDownmix::new();
        downmix.observe(0, 0.25);
        downmix.observe(1, 0.25);
        downmix.finish_block(2);
        assert!((downmix.mix(&[0.25, 0.25]) - 0.25).abs() < 1e-6);
    }

    #[test]
    fn a_seven_point_one_microphone_uses_only_the_channels_with_signal() {
        // 8 capture channels, the microphone on the first two, 30 dB of noise
        // on one of the rest: only the loud pair is mixed.
        let mut downmix = MicDownmix::new();
        let frame = [0.4f32, 0.4, 0.0, 0.0, 0.0, 0.0, 0.0, 0.01];
        for (index, value) in frame.iter().enumerate() {
            downmix.observe(index, *value);
        }
        downmix.finish_block(8);
        assert!((downmix.mix(&frame) - 0.4).abs() < 1e-6);
    }

    #[test]
    fn a_silent_block_does_not_lock_the_channel_set() {
        // Leading silence must not fix the mask on noise; the first block with
        // speech decides.
        let mut downmix = MicDownmix::new();
        downmix.observe(0, 0.0);
        downmix.observe(1, 0.0);
        downmix.finish_block(2);
        assert!(downmix.is_undecided());
        downmix.observe(0, 0.0);
        downmix.observe(1, 0.5);
        downmix.finish_block(2);
        assert!(!downmix.is_undecided());
        assert!((downmix.mix(&[0.0, 0.5]) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn a_mono_microphone_passes_through_unchanged() {
        let mut downmix = MicDownmix::new();
        downmix.observe(0, 0.3);
        downmix.finish_block(1);
        assert!((downmix.mix(&[0.3]) - 0.3).abs() < 1e-6);
        assert!((downmix.mix(&[-0.3]) + 0.3).abs() < 1e-6);
    }

    #[test]
    fn an_all_silent_frame_mixes_to_silence() {
        let downmix = MicDownmix::new();
        assert_eq!(downmix.mix(&[0.0, 0.0, 0.0, 0.0]), 0.0);
    }

    #[test]
    fn a_microphone_wider_than_the_mask_keeps_the_old_average() {
        // More than 64 channels cannot be described by the mask; the downmixer
        // stays on the average of all channels instead of guessing.
        let mut downmix = MicDownmix::new();
        downmix.observe(0, 0.9);
        downmix.finish_block(MAX_MIC_CHANNELS + 1);
        assert!(downmix.is_undecided());
        assert!((downmix.mix(&[0.5, 0.5]) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn the_format_describe_is_compact_and_locale_free() {
        let format = OpenFormat::new(8, 48_000, SampleFormat::F32);
        assert_eq!(format.describe(), "8 ch, 48000 Hz, F32");
    }
}
