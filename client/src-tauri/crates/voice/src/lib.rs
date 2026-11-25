//! RosTalk voice engine: capture, processing, gating, publishing and playback.
//!
//! ```text
//! microphone (cpal) → resampler → APM (HPF/AEC/NS/AGC) → gate → LiveKit track
//! remote microphone tracks → volume/mute → mixer → AEC reference → output
//! ```
//!
//! The engine is owned by one runtime thread; audio callbacks exchange samples
//! with it through lock-free rings (CONTRIBUTING.md, ADR 0002).

pub mod deepfilter;
pub mod denoise;
pub mod devices;
pub(crate) mod dump;
pub mod engine;
pub mod error;
pub mod frame;
pub mod gate;
pub mod level;
pub mod leveler;
pub mod loopback;
pub mod mixer;
pub mod pipeline;
pub mod processing;
pub mod resample;
pub mod scheduler;
pub mod signalling;
pub mod sounds;
pub mod stats;
pub mod stream_audio;
#[cfg(feature = "test-audio")]
mod testaudio;
#[cfg(feature = "test-audio")]
pub use testaudio::FakeClock;

pub use devices::{AudioFormats, DeviceInfo, DeviceList, OpenFormat, StreamFormatInfo};
pub use engine::{
    start, MediaCredentials, MediaPhase, MediaUpdate, ParticipantLevel, PttHookState, PttStatus,
    VoiceConfig, VoiceEvent, VoiceHandle, VoiceLevels, VoiceState,
};
pub use error::VoiceError;
pub use frame::{FRAME_MS, FRAME_SAMPLES, SAMPLE_RATE};
pub use gate::{Gate, GateMode};
pub use level::{LevelSmoother, SpeakingDetector};
pub use mixing::*;
pub use pipeline::TestAudioConfig;
pub use processing::{NoiseModel, ProcessingSettings};
pub use sounds::{CueSoundSet, EventSound, SoundSettings};
pub use stats::{StatsCollector, VoiceStats};

/// Mixer and resampler types, re-exported for tests and the shell.
mod mixing {
    pub use crate::mixer::{Mixer, TrackLevel, TrackPublisher};
    pub use crate::resample::Resampler;
}
