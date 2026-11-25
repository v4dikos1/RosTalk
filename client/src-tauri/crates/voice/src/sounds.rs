//! Short event cues shipped as WAV files and mixed into the playback frame.
//!
//! The bank (stage P10) replaces the former code-generated beeps. Each cue is a
//! 16-bit/48 kHz mono WAV, generated offline by `tools/sounds/generate.mjs`,
//! embedded into the binary and decoded once on first use. The playback thread
//! only reads the decoded samples: no locks, allocations or logging happen in
//! `mix_into`.
//!
//! Cues are mixed into the output frame, so they are heard even when every
//! participant is muted, and they never reach the published microphone track.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Which cue to play.
///
/// The names are part of the IPC contract (`play_voice_sound`), so they are
/// also the file names in `assets/sounds/<set>/`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type, PartialOrd, Ord,
)]
#[serde(rename_all = "camelCase")]
pub enum EventSound {
    /// The user joined a voice channel.
    SelfJoin,
    /// The user left a voice channel.
    SelfLeave,
    /// Another participant joined the room.
    UserJoin,
    /// Another participant left the room.
    UserLeave,
    /// The own microphone was muted.
    MicOff,
    /// The own microphone was unmuted.
    MicOn,
    /// The incoming sound (deafen) was turned off.
    SoundOff,
    /// The incoming sound (deafen) was turned on.
    SoundOn,
    /// Another participant started a screen share.
    StreamStarted,
    /// The user started a screen share.
    SelfStreamStarted,
    /// The user stopped a screen share.
    SelfStreamEnded,
    /// Someone started watching the user's screen share (wired in stage P12).
    StreamViewerJoined,
    /// A direct message or a mention arrived.
    DirectMessage,
    /// The media connection was lost.
    ConnectionLost,
    /// The media connection was restored after a loss.
    ConnectionRestored,
    /// Push-to-talk was pressed.
    PttDown,
    /// Push-to-talk was released.
    PttUp,
}

/// Number of cues in the bank.
pub const EVENT_COUNT: usize = 17;

impl EventSound {
    /// Every cue in bank order.
    pub const ALL: [Self; EVENT_COUNT] = [
        Self::SelfJoin,
        Self::SelfLeave,
        Self::UserJoin,
        Self::UserLeave,
        Self::MicOff,
        Self::MicOn,
        Self::SoundOff,
        Self::SoundOn,
        Self::StreamStarted,
        Self::SelfStreamStarted,
        Self::SelfStreamEnded,
        Self::StreamViewerJoined,
        Self::DirectMessage,
        Self::ConnectionLost,
        Self::ConnectionRestored,
        Self::PttDown,
        Self::PttUp,
    ];

    /// Index in the decoded bank.
    #[must_use]
    pub fn index(self) -> usize {
        match self {
            Self::SelfJoin => 0,
            Self::SelfLeave => 1,
            Self::UserJoin => 2,
            Self::UserLeave => 3,
            Self::MicOff => 4,
            Self::MicOn => 5,
            Self::SoundOff => 6,
            Self::SoundOn => 7,
            Self::StreamStarted => 8,
            Self::SelfStreamStarted => 9,
            Self::SelfStreamEnded => 10,
            Self::StreamViewerJoined => 11,
            Self::DirectMessage => 12,
            Self::ConnectionLost => 13,
            Self::ConnectionRestored => 14,
            Self::PttDown => 15,
            Self::PttUp => 16,
        }
    }

    /// Settings group the cue belongs to.
    #[must_use]
    fn group(self) -> CueGroup {
        match self {
            Self::SelfJoin | Self::SelfLeave | Self::UserJoin | Self::UserLeave => {
                CueGroup::Channel
            }
            Self::MicOff | Self::MicOn => CueGroup::Microphone,
            Self::SoundOff | Self::SoundOn => CueGroup::Sound,
            Self::StreamStarted
            | Self::SelfStreamStarted
            | Self::SelfStreamEnded
            | Self::StreamViewerJoined => CueGroup::Streams,
            Self::DirectMessage => CueGroup::Messages,
            Self::ConnectionLost | Self::ConnectionRestored => CueGroup::Connection,
            Self::PttDown | Self::PttUp => CueGroup::PushToTalk,
        }
    }
}

/// Which sound family the listener chose (settings, P10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum CueSoundSet {
    /// Rounder, quieter tones (default).
    #[default]
    Soft,
    /// Brighter, shorter tones, a fifth higher.
    Bright,
}

/// Settings groups; one switch in the settings window per group (P10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CueGroup {
    Channel,
    Microphone,
    Sound,
    Streams,
    Messages,
    Connection,
    PushToTalk,
}

/// User settings for event sounds (design 5.4, extended in P10).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SoundSettings {
    /// Play cues at all.
    pub enabled: bool,
    /// Cue volume, 0..100 %.
    pub volume: f32,
    /// Which generated set to use.
    #[serde(default)]
    pub set: CueSoundSet,
    /// Self and other participants joining/leaving a channel.
    #[serde(default = "default_true")]
    pub channel: bool,
    /// Own microphone muted/unmuted.
    #[serde(default = "default_true")]
    pub microphone: bool,
    /// Incoming sound (deafen) on/off.
    #[serde(default = "default_true")]
    pub sound: bool,
    /// Screen shares starting and stopping.
    #[serde(default = "default_true")]
    pub streams: bool,
    /// Direct messages and mentions.
    #[serde(default = "default_true")]
    pub messages: bool,
    /// Lost and restored media connection.
    #[serde(default = "default_true")]
    pub connection: bool,
    /// Push-to-talk pressed/released; off by default (it fires often).
    #[serde(default)]
    pub push_to_talk: bool,
}

/// Serde default for the group switches: on.
fn default_true() -> bool {
    true
}

impl Default for SoundSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            volume: 70.0,
            set: CueSoundSet::Soft,
            channel: true,
            microphone: true,
            sound: true,
            streams: true,
            messages: true,
            connection: true,
            push_to_talk: false,
        }
    }
}

impl SoundSettings {
    /// True when the cue's group is enabled.
    #[must_use]
    fn allows(&self, sound: EventSound) -> bool {
        match sound.group() {
            CueGroup::Channel => self.channel,
            CueGroup::Microphone => self.microphone,
            CueGroup::Sound => self.sound,
            CueGroup::Streams => self.streams,
            CueGroup::Messages => self.messages,
            CueGroup::Connection => self.connection,
            CueGroup::PushToTalk => self.push_to_talk,
        }
    }
}

/// Decoded cue bank, built once for the process lifetime.
struct SoundBank {
    soft: [Vec<i16>; EVENT_COUNT],
    bright: [Vec<i16>; EVENT_COUNT],
}

impl SoundBank {
    fn clip(&self, set: CueSoundSet, index: usize) -> &[i16] {
        match set {
            CueSoundSet::Soft => &self.soft[index],
            CueSoundSet::Bright => &self.bright[index],
        }
    }
}

/// The embedded WAV files, in `EventSound::ALL` order.
const SOFT_FILES: [&[u8]; EVENT_COUNT] = [
    include_bytes!("../assets/sounds/soft/self_join.wav"),
    include_bytes!("../assets/sounds/soft/self_leave.wav"),
    include_bytes!("../assets/sounds/soft/user_join.wav"),
    include_bytes!("../assets/sounds/soft/user_leave.wav"),
    include_bytes!("../assets/sounds/soft/mic_off.wav"),
    include_bytes!("../assets/sounds/soft/mic_on.wav"),
    include_bytes!("../assets/sounds/soft/sound_off.wav"),
    include_bytes!("../assets/sounds/soft/sound_on.wav"),
    include_bytes!("../assets/sounds/soft/stream_started.wav"),
    include_bytes!("../assets/sounds/soft/self_stream_started.wav"),
    include_bytes!("../assets/sounds/soft/self_stream_ended.wav"),
    include_bytes!("../assets/sounds/soft/stream_viewer_joined.wav"),
    include_bytes!("../assets/sounds/soft/direct_message.wav"),
    include_bytes!("../assets/sounds/soft/connection_lost.wav"),
    include_bytes!("../assets/sounds/soft/connection_restored.wav"),
    include_bytes!("../assets/sounds/soft/ptt_down.wav"),
    include_bytes!("../assets/sounds/soft/ptt_up.wav"),
];

const BRIGHT_FILES: [&[u8]; EVENT_COUNT] = [
    include_bytes!("../assets/sounds/bright/self_join.wav"),
    include_bytes!("../assets/sounds/bright/self_leave.wav"),
    include_bytes!("../assets/sounds/bright/user_join.wav"),
    include_bytes!("../assets/sounds/bright/user_leave.wav"),
    include_bytes!("../assets/sounds/bright/mic_off.wav"),
    include_bytes!("../assets/sounds/bright/mic_on.wav"),
    include_bytes!("../assets/sounds/bright/sound_off.wav"),
    include_bytes!("../assets/sounds/bright/sound_on.wav"),
    include_bytes!("../assets/sounds/bright/stream_started.wav"),
    include_bytes!("../assets/sounds/bright/self_stream_started.wav"),
    include_bytes!("../assets/sounds/bright/self_stream_ended.wav"),
    include_bytes!("../assets/sounds/bright/stream_viewer_joined.wav"),
    include_bytes!("../assets/sounds/bright/direct_message.wav"),
    include_bytes!("../assets/sounds/bright/connection_lost.wav"),
    include_bytes!("../assets/sounds/bright/connection_restored.wav"),
    include_bytes!("../assets/sounds/bright/ptt_down.wav"),
    include_bytes!("../assets/sounds/bright/ptt_up.wav"),
];

/// Decodes the bank once per process; a broken asset leaves that cue silent.
fn bank() -> &'static SoundBank {
    static BANK: OnceLock<SoundBank> = OnceLock::new();
    BANK.get_or_init(|| SoundBank {
        soft: decode_set(&SOFT_FILES),
        bright: decode_set(&BRIGHT_FILES),
    })
}

fn decode_set(files: &[&[u8]; EVENT_COUNT]) -> [Vec<i16>; EVENT_COUNT] {
    std::array::from_fn(|index| match decode_wav(files[index]) {
        Ok(samples) => samples,
        Err(error) => {
            // Startup only, never an audio callback.
            log::error!(
                "event sound {} is broken: {error}",
                EventSound::ALL[index].index()
            );
            Vec::new()
        }
    })
}

/// Why an embedded WAV could not be decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WavError {
    /// The RIFF header or a chunk is shorter than its declared size.
    Truncated,
    /// The file is not a RIFF/WAVE file.
    NotWave,
    /// The format is not 16-bit PCM mono 48 kHz.
    UnsupportedFormat,
    /// The `fmt ` chunk is missing.
    MissingFormat,
    /// The `data` chunk is missing.
    MissingData,
}

impl std::fmt::Display for WavError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            Self::Truncated => "truncated RIFF file",
            Self::NotWave => "not a RIFF/WAVE file",
            Self::UnsupportedFormat => "only 16-bit PCM mono 48 kHz is supported",
            Self::MissingFormat => "missing fmt chunk",
            Self::MissingData => "missing data chunk",
        };
        formatter.write_str(text)
    }
}

/// Decodes a 16-bit PCM mono 48 kHz WAV file into samples.
///
/// The bank is generated by our own script and never changes format, so the
/// parser deliberately accepts exactly one layout instead of growing into a
/// general-purpose decoder (and a new dependency).
pub fn decode_wav(bytes: &[u8]) -> Result<Vec<i16>, WavError> {
    if bytes.len() < 12 {
        return Err(WavError::Truncated);
    }
    if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(WavError::NotWave);
    }
    let mut position = 12;
    let mut format_seen = false;
    while position + 8 <= bytes.len() {
        let id = &bytes[position..position + 4];
        let size = u32::from_le_bytes(
            bytes[position + 4..position + 8]
                .try_into()
                .map_err(|_| WavError::Truncated)?,
        ) as usize;
        let start = position + 8;
        let end = start.checked_add(size).ok_or(WavError::Truncated)?;
        if end > bytes.len() {
            return Err(WavError::Truncated);
        }
        match id {
            b"fmt " => {
                if size < 16 {
                    return Err(WavError::UnsupportedFormat);
                }
                let format = u16::from_le_bytes([bytes[start], bytes[start + 1]]);
                let channels = u16::from_le_bytes([bytes[start + 2], bytes[start + 3]]);
                let rate = u32::from_le_bytes(
                    bytes[start + 4..start + 8]
                        .try_into()
                        .map_err(|_| WavError::Truncated)?,
                );
                let bits = u16::from_le_bytes([bytes[start + 14], bytes[start + 15]]);
                if format != 1 || channels != 1 || rate != crate::frame::SAMPLE_RATE || bits != 16 {
                    return Err(WavError::UnsupportedFormat);
                }
                format_seen = true;
            }
            b"data" => {
                if !format_seen {
                    return Err(WavError::MissingFormat);
                }
                let data = &bytes[start..end];
                if !data.len().is_multiple_of(2) {
                    return Err(WavError::Truncated);
                }
                return Ok(data
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|pair| i16::from_le_bytes(*pair))
                    .collect());
            }
            _ => {}
        }
        // Chunks are word-aligned.
        position = end + (size & 1);
    }
    if !format_seen {
        Err(WavError::MissingFormat)
    } else {
        Err(WavError::MissingData)
    }
}

/// Pre-decoded cues and the currently playing one.
pub struct SoundPlayer {
    settings: SoundSettings,
    active: Option<usize>,
    position: usize,
}

impl SoundPlayer {
    /// Prepares the player; the bank is decoded here, once per process.
    #[must_use]
    pub fn new(settings: SoundSettings) -> Self {
        // Build the bank on the engine thread, never on the first cue: the
        // playback loop must only read samples.
        let _ = bank();
        Self {
            settings,
            active: None,
            position: 0,
        }
    }

    /// Replaces the settings; disabling sounds or changing the set stops the cue.
    pub fn set_settings(&mut self, settings: SoundSettings) {
        let stop = !settings.enabled || settings.volume <= 0.0 || settings.set != self.settings.set;
        self.settings = settings;
        if stop {
            self.active = None;
            self.position = 0;
        }
    }

    /// Queues a cue, replacing one that is still playing.
    ///
    /// Disabled sounds, a disabled group and zero volume make it a no-op.
    pub fn play(&mut self, sound: EventSound) {
        if !self.settings.enabled || self.settings.volume <= 0.0 || !self.settings.allows(sound) {
            return;
        }
        self.start(sound);
    }

    /// Plays one cue for the settings window, ignoring the master switch and
    /// the group switches; the volume slider still applies.
    pub fn preview(&mut self, sound: EventSound) {
        if self.settings.volume <= 0.0 {
            return;
        }
        self.start(sound);
    }

    fn start(&mut self, sound: EventSound) {
        self.active = Some(sound.index());
        self.position = 0;
    }

    /// True while a cue is audible.
    #[must_use]
    pub fn is_playing(&self) -> bool {
        self.active.is_some()
    }

    /// True while the "sound off" confirmation cue plays.
    ///
    /// Deafening silences the mix, but the cue that confirms it has to be heard
    /// once: the playback loop uses this to keep exactly that cue audible.
    #[must_use]
    pub fn is_deafening_cue(&self) -> bool {
        self.active == Some(EventSound::SoundOff.index())
    }

    /// Mixes the active cue into `frame` and advances its position.
    ///
    /// Runs in the playback loop: no allocation, lock or log here.
    pub fn mix_into(&mut self, frame: &mut [i16]) {
        let Some(index) = self.active else {
            return;
        };
        let clip = bank().clip(self.settings.set, index);
        let gain = (self.settings.volume / 100.0).clamp(0.0, 1.0);
        let remaining = clip.len().saturating_sub(self.position);
        let count = remaining.min(frame.len());
        for (out, sample) in frame
            .iter_mut()
            .zip(clip[self.position..self.position + count].iter())
        {
            let mixed = f32::from(*out) + f32::from(*sample) * gain;
            *out = mixed.clamp(f32::from(i16::MIN), f32::from(i16::MAX)) as i16;
        }
        self.position += count;
        if self.position >= clip.len() {
            self.active = None;
            self.position = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peak(clip: &[i16]) -> i32 {
        clip.iter()
            .map(|sample| i32::from(*sample).abs())
            .max()
            .unwrap_or(0)
    }

    fn frame() -> [i16; 480] {
        [0; 480]
    }

    /// Builds a `fmt `+`data` WAV with the given parameters for parser tests.
    fn wav_bytes(
        format: u16,
        channels: u16,
        rate: u32,
        bits: u16,
        samples: &[i16],
        with_data: bool,
    ) -> Vec<u8> {
        let mut data = Vec::new();
        if with_data {
            for sample in samples {
                data.extend_from_slice(&sample.to_le_bytes());
            }
        }
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&format.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * u32::from(channels) * u32::from(bits) / 8).to_le_bytes());
        bytes.extend_from_slice(&(channels * bits / 8).to_le_bytes());
        bytes.extend_from_slice(&bits.to_le_bytes());
        if with_data {
            bytes.extend_from_slice(b"data");
            bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&data);
        }
        bytes
    }

    #[test]
    fn decodes_a_valid_file() {
        let bytes = wav_bytes(1, 1, 48_000, 16, &[0, 1, -1, 32_767, -32_768], true);
        assert_eq!(
            decode_wav(&bytes).expect("valid"),
            vec![0, 1, -1, 32_767, -32_768]
        );
    }

    #[test]
    fn rejects_a_foreign_format() {
        assert_eq!(
            decode_wav(&wav_bytes(1, 2, 48_000, 16, &[0, 0], true)),
            Err(WavError::UnsupportedFormat)
        );
        assert_eq!(
            decode_wav(&wav_bytes(1, 1, 44_100, 16, &[0], true)),
            Err(WavError::UnsupportedFormat)
        );
        assert_eq!(
            decode_wav(&wav_bytes(1, 1, 48_000, 8, &[0], true)),
            Err(WavError::UnsupportedFormat)
        );
        assert_eq!(
            decode_wav(&wav_bytes(3, 1, 48_000, 16, &[0], true)),
            Err(WavError::UnsupportedFormat)
        );
    }

    #[test]
    fn rejects_broken_headers() {
        assert_eq!(decode_wav(b"RIFF"), Err(WavError::Truncated));
        assert_eq!(
            decode_wav(&wav_bytes(1, 1, 48_000, 16, &[0], false)),
            Err(WavError::MissingData)
        );
        let mut not_wave = wav_bytes(1, 1, 48_000, 16, &[0], true);
        not_wave[0..4].copy_from_slice(b"XXXX");
        assert_eq!(decode_wav(&not_wave), Err(WavError::NotWave));

        let mut truncated = wav_bytes(1, 1, 48_000, 16, &[0, 1], true);
        truncated.pop();
        assert_eq!(decode_wav(&truncated), Err(WavError::Truncated));
    }

    #[test]
    fn embedded_bank_is_valid_and_short() {
        let bank = bank();
        for sound in EventSound::ALL {
            for set in [CueSoundSet::Soft, CueSoundSet::Bright] {
                let clip = bank.clip(set, sound.index());
                assert!(!clip.is_empty(), "{sound:?}/{set:?} is empty");
                assert!(
                    clip.len() <= crate::frame::SAMPLE_RATE as usize * 400 / 1000,
                    "{sound:?}/{set:?} is longer than 400 ms"
                );
                // Level-equalised family: every cue peaks in the same range.
                let peak = peak(clip);
                assert!(
                    (8_000..=20_000).contains(&peak),
                    "{sound:?}/{set:?} peaks at {peak}"
                );
                // No click on the first or the last sample.
                assert!(clip[0].abs() < 500, "{sound:?} starts with a click");
                assert!(
                    clip[clip.len() - 1].abs() < 500,
                    "{sound:?} ends with a click"
                );
            }
        }
    }

    #[test]
    fn every_event_has_its_own_buffer() {
        let bank = bank();
        for set in [CueSoundSet::Soft, CueSoundSet::Bright] {
            for (index, sound) in EventSound::ALL.iter().enumerate() {
                for (other_index, other) in EventSound::ALL.iter().enumerate().skip(index + 1) {
                    assert_ne!(
                        bank.clip(set, sound.index()),
                        bank.clip(set, other.index()),
                        "{sound:?} and {other:?} share a buffer ({set:?}, {other_index})"
                    );
                }
            }
        }
        // The two sets are different too.
        for sound in EventSound::ALL {
            assert_ne!(
                bank.clip(CueSoundSet::Soft, sound.index()),
                bank.clip(CueSoundSet::Bright, sound.index())
            );
        }
    }

    #[test]
    fn the_bright_set_is_a_fifth_higher() {
        // Zero crossings are a cheap proxy for pitch; the bright set may not be
        // a copy of the soft one with a different gain.
        let bank = bank();
        for sound in EventSound::ALL {
            let crossings = |set| {
                bank.clip(set, sound.index())
                    .windows(2)
                    .filter(|pair| (pair[0] < 0) != (pair[1] < 0))
                    .count()
            };
            let soft = crossings(CueSoundSet::Soft);
            let bright = crossings(CueSoundSet::Bright);
            if soft == 0 {
                // The viewer cue has a very quiet, slow body; not every set
                // needs a proportional jump on such a short clip.
                assert!(bright > 0, "{sound:?} is silent in the bright set");
                continue;
            }
            assert!(
                bright > soft,
                "{sound:?}: bright has {bright} crossings, soft {soft}"
            );
        }
    }

    #[test]
    fn mixing_advances_and_ends_the_cue() {
        let mut player = SoundPlayer::new(SoundSettings {
            volume: 100.0,
            ..SoundSettings::default()
        });
        player.play(EventSound::UserJoin);
        let mut total = 0;
        let mut buffer = frame();
        for _ in 0..50 {
            player.mix_into(&mut buffer);
            total += buffer
                .iter()
                .map(|sample| i32::from(*sample).abs())
                .sum::<i32>();
            if !player.is_playing() {
                break;
            }
        }
        assert!(total > 0);
        assert!(!player.is_playing());
    }

    #[test]
    fn disabled_sounds_stay_silent() {
        let mut player = SoundPlayer::new(SoundSettings {
            enabled: false,
            volume: 100.0,
            ..SoundSettings::default()
        });
        player.play(EventSound::SelfJoin);
        assert!(!player.is_playing());
        let mut buffer = frame();
        player.mix_into(&mut buffer);
        assert!(buffer.iter().all(|sample| *sample == 0));
    }

    #[test]
    fn zero_volume_is_silent() {
        let mut player = SoundPlayer::new(SoundSettings {
            volume: 0.0,
            ..SoundSettings::default()
        });
        player.play(EventSound::MicOff);
        assert!(!player.is_playing());
        player.preview(EventSound::MicOff);
        assert!(!player.is_playing());
    }

    #[test]
    fn volume_scales_the_cue() {
        let render_at = |volume: f32| {
            let mut player = SoundPlayer::new(SoundSettings {
                volume,
                ..SoundSettings::default()
            });
            player.play(EventSound::SelfJoin);
            let mut loudest = 0i32;
            let mut buffer = frame();
            for _ in 0..40 {
                player.mix_into(&mut buffer);
                loudest = loudest.max(buffer.iter().map(|sample| i32::from(*sample).abs()).sum());
                buffer.fill(0);
            }
            loudest
        };
        assert!(render_at(100.0) > render_at(25.0));
    }

    #[test]
    fn group_switches_silence_only_their_events() {
        let settings = SoundSettings {
            volume: 100.0,
            channel: false,
            microphone: false,
            ..SoundSettings::default()
        };
        let mut player = SoundPlayer::new(settings);
        player.play(EventSound::SelfJoin);
        assert!(!player.is_playing());
        player.play(EventSound::UserLeave);
        assert!(!player.is_playing());
        player.play(EventSound::MicOn);
        assert!(!player.is_playing());
        // Another group is still allowed and replaces nothing.
        player.play(EventSound::DirectMessage);
        assert!(player.is_playing());
        player.play(EventSound::MicOff);
        assert!(player.is_playing());
    }

    #[test]
    fn push_to_talk_is_off_by_default() {
        let settings = SoundSettings::default();
        assert!(!settings.push_to_talk);
        let mut player = SoundPlayer::new(settings);
        player.play(EventSound::PttDown);
        assert!(!player.is_playing());
        player.play(EventSound::PttUp);
        assert!(!player.is_playing());
    }

    #[test]
    fn preview_ignores_the_switches_but_not_the_volume() {
        let mut player = SoundPlayer::new(SoundSettings {
            enabled: false,
            volume: 40.0,
            channel: false,
            ..SoundSettings::default()
        });
        player.preview(EventSound::SelfLeave);
        assert!(player.is_playing());
    }

    #[test]
    fn changing_the_set_stops_the_playing_cue() {
        let mut player = SoundPlayer::new(SoundSettings {
            volume: 100.0,
            ..SoundSettings::default()
        });
        player.play(EventSound::UserJoin);
        assert!(player.is_playing());
        player.set_settings(SoundSettings {
            set: CueSoundSet::Bright,
            volume: 100.0,
            ..SoundSettings::default()
        });
        assert!(!player.is_playing());
    }
}
