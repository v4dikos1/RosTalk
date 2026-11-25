//! Wrapper around libwebrtc's `AudioProcessingModule` plus RNNoise.
//!
//! APM accepts exactly 10 ms frames (480 samples at 48 kHz) and needs a
//! reverse stream from the playback mixer for echo cancellation (ADR 0002).
//! The wrapper owns the modules on the capture thread; nothing here locks.
//!
//! The SDK cannot run a custom stage inside one APM, so the capture path uses
//! two modules around RNNoise (stage 2.3.2e, ADR 0014):
//!
//! ```text
//! APM-1 (HPF + AEC, reverse stream) → RNNoise → APM-2 (AGC)
//! ```
//!
//! AEC needs the unprocessed microphone, and AGC must amplify the clean signal
//! after the denoiser, not the noise that is about to be removed. With the
//! `WebRtc` noise model the APM's own NS joins APM-1, which is the old single
//! APM order (NS before AGC).
//!
//! Every rejected frame increments a shared counter, so a processing failure
//! shows up in the statistics instead of only in a log line (stage 2.3.1).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use livekit::webrtc::native::apm::AudioProcessingModule;

use crate::deepfilter::DeepFilter;
use crate::denoise::Denoiser;
use crate::frame::{FRAME_SAMPLES, SAMPLE_RATE};

/// Which noise suppressor runs on the capture path (stage 2.3.2e).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum NoiseModel {
    /// No noise suppression.
    Off,
    /// The WebRTC APM noise suppressor: the behaviour before 2.3.2e.
    WebRtc,
    /// RNNoise (`nnnoiseless`). The default: it also suppresses impulses and
    /// does not have to share the APM with echo cancellation.
    #[default]
    RnNoise,
    /// DeepFilterNet3, the "strong" mode (stage P17, ADR 0029): 30 ms of extra
    /// delay, about 1-4 % of a core. Implemented and measured, but not offered
    /// in the UI: it lost 7 dB of speech on the SAPI fixture (ADR 0029).
    DeepFilter,
}

impl NoiseModel {
    /// Stable name for logs and diagnostics.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::WebRtc => "webrtc",
            Self::RnNoise => "rnnoise",
            Self::DeepFilter => "deepfilter",
        }
    }
}

/// Which APM stages are on. Every stage is switchable (design 5.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingSettings {
    /// Echo cancellation with the playback mixer as the reference stream.
    pub echo_cancellation: bool,
    /// Legacy switch kept for wire compatibility (stage 2.3.2e).
    ///
    /// `false` forces [`NoiseModel::Off`]; `true` means "use `noise_model`".
    pub noise_suppression: bool,
    /// Which noise suppressor to run.
    #[serde(default)]
    pub noise_model: NoiseModel,
    /// Automatic gain control.
    pub gain_control: bool,
    /// High-pass filter.
    pub high_pass_filter: bool,
}

impl Default for ProcessingSettings {
    fn default() -> Self {
        Self {
            echo_cancellation: true,
            noise_suppression: true,
            noise_model: NoiseModel::RnNoise,
            // AGC2 adapts to the denoised signal and lifts quiet passages:
            // the keyboard/fan measurement (stage 2.3.2e) shows a 24 dB rise
            // of the pause floor, which cancels RNNoise. It stays available
            // and runs in APM-2, after the denoiser (ADR 0014).
            gain_control: false,
            high_pass_filter: true,
        }
    }
}

impl ProcessingSettings {
    /// Everything off: the music profile (design 5.2).
    #[must_use]
    pub fn disabled() -> Self {
        Self {
            echo_cancellation: false,
            noise_suppression: false,
            noise_model: NoiseModel::Off,
            gain_control: false,
            high_pass_filter: false,
        }
    }

    /// The noise model that actually runs.
    ///
    /// `noise_suppression: false` from an older UI payload wins over the new
    /// field, so a disabled suppressor stays disabled.
    #[must_use]
    pub fn effective_noise_model(&self) -> NoiseModel {
        if self.noise_suppression {
            self.noise_model
        } else {
            NoiseModel::Off
        }
    }

    /// True when at least one stage would run.
    #[must_use]
    pub fn any_enabled(&self) -> bool {
        self.echo_cancellation
            || self.effective_noise_model() != NoiseModel::Off
            || self.gain_control
            || self.high_pass_filter
    }
}

/// Owns the two `AudioProcessingModule`s and the optional RNNoise state.
pub struct ApmProcessor {
    /// HPF, AEC and (for `NoiseModel::WebRtc`) the APM noise suppressor.
    first: Option<AudioProcessingModule>,
    /// AGC only.
    second: Option<AudioProcessingModule>,
    denoiser: Option<Denoiser>,
    /// DeepFilterNet3 (`NoiseModel::DeepFilter`); never together with RNNoise.
    deep: Option<DeepFilter>,
    settings: ProcessingSettings,
    errors: Arc<AtomicU64>,
    /// Test seam: makes the next forward stream call fail like a real APM
    /// error, so the counter path is covered by a test.
    #[cfg(test)]
    fail_next: bool,
}

impl ApmProcessor {
    /// Creates the modules for the given settings. `errors` is shared with the
    /// statistics snapshot.
    ///
    /// The denoiser allocates its model, so this must run on the engine or
    /// capture thread before the loop, never in an audio callback.
    #[must_use]
    pub fn new(settings: ProcessingSettings, errors: Arc<AtomicU64>) -> Self {
        let noise = settings.effective_noise_model();
        let first_needed =
            settings.echo_cancellation || settings.high_pass_filter || noise == NoiseModel::WebRtc;
        let first = first_needed.then(|| {
            let mut apm = AudioProcessingModule::new(
                settings.echo_cancellation,
                false,
                settings.high_pass_filter,
                noise == NoiseModel::WebRtc,
            );
            // The capture and playback threads run on a 10 ms cadence; the
            // reference stream is one mixer tick behind the microphone.
            // Construction happens on the engine thread (start/set_processing),
            // so this one-time warning is allowed to log.
            if let Err(error) = apm.set_stream_delay_ms(50) {
                log::warn!("APM stream delay was rejected: {error}");
            }
            apm
        });
        let second = settings
            .gain_control
            .then(|| AudioProcessingModule::new(false, true, false, false));
        let denoiser = (noise == NoiseModel::RnNoise).then(Denoiser::new);
        let deep = (noise == NoiseModel::DeepFilter).then(DeepFilter::new);
        Self {
            first,
            second,
            denoiser,
            deep,
            settings,
            errors,
            #[cfg(test)]
            fail_next: false,
        }
    }

    /// Settings in force.
    #[must_use]
    pub fn settings(&self) -> ProcessingSettings {
        self.settings
    }

    /// True when at least one processing stage is active.
    #[must_use]
    pub fn is_enabled(&self) -> bool {
        self.first.is_some()
            || self.second.is_some()
            || self.denoiser.is_some()
            || self.deep.is_some()
    }

    /// Errors recorded since start.
    #[must_use]
    pub fn errors(&self) -> u64 {
        self.errors.load(Ordering::Relaxed)
    }

    /// Speech probability of the last denoised frame, 0..1.
    ///
    /// `None` when RNNoise does not run (also with DeepFilterNet, which has no
    /// speech probability of the same kind): the VAD gate then relies on the
    /// level alone, as before.
    #[must_use]
    pub fn vad(&self) -> Option<f32> {
        self.denoiser.as_ref().map(Denoiser::vad)
    }

    /// Processes one forward (microphone) frame through the whole chain.
    pub fn process_capture(&mut self, frame: &mut [i16; FRAME_SAMPLES]) {
        #[cfg(test)]
        if std::mem::take(&mut self.fail_next) {
            self.record_error();
            return;
        }
        if let Some(apm) = self.first.as_mut() {
            if apm.process_stream(frame, SAMPLE_RATE as i32, 1).is_err() {
                // This runs on the capture thread: no log, no `format!`, no
                // lock. The counter is reported by the engine, which logs the
                // change.
                self.record_error();
            }
        }
        if let Some(denoiser) = self.denoiser.as_mut() {
            denoiser.process_frame(frame);
        }
        if let Some(deep) = self.deep.as_mut() {
            deep.process_frame(frame);
        }
        if let Some(apm) = self.second.as_mut() {
            if apm.process_stream(frame, SAMPLE_RATE as i32, 1).is_err() {
                self.record_error();
            }
        }
    }

    /// Feeds one frame of what the user hears to the echo canceller.
    pub fn process_reverse(&mut self, frame: &mut [i16; FRAME_SAMPLES]) {
        let Some(apm) = self.first.as_mut() else {
            return;
        };
        if apm
            .process_reverse_stream(frame, SAMPLE_RATE as i32, 1)
            .is_err()
        {
            // Playback/capture thread: count only, the engine logs the counter.
            self.record_error();
        }
    }

    fn record_error(&self) {
        self.errors.fetch_add(1, Ordering::Relaxed);
    }

    /// Makes the next forward call fail (test seam for the error counter).
    #[cfg(test)]
    fn fail_next_call(&mut self) {
        self.fail_next = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn processor(settings: ProcessingSettings) -> (ApmProcessor, Arc<AtomicU64>) {
        let errors = Arc::new(AtomicU64::new(0));
        (ApmProcessor::new(settings, errors.clone()), errors)
    }

    #[test]
    fn all_disabled_creates_no_module() {
        let (processor, _) = processor(ProcessingSettings::disabled());
        assert!(!processor.is_enabled());
    }

    #[test]
    fn any_enabled_creates_the_module() {
        let (processor, _) = processor(ProcessingSettings::default());
        assert!(processor.is_enabled());
    }

    #[test]
    fn disabled_processing_leaves_the_frame_untouched() {
        let (mut processor, _) = processor(ProcessingSettings::disabled());
        let mut frame = [0i16; FRAME_SAMPLES];
        for (index, sample) in frame.iter_mut().enumerate() {
            *sample = (index as i16) * 10;
        }
        let before = frame;
        processor.process_capture(&mut frame);
        processor.process_reverse(&mut frame);
        assert_eq!(frame, before);
    }

    #[test]
    fn apm_processes_a_ten_millisecond_frame() {
        // The assertion inside APM would panic on a wrong length, so this is a
        // contract test for the 480-sample constant.
        let (mut processor, errors) = processor(ProcessingSettings::default());
        let mut frame = [1_000i16; FRAME_SAMPLES];
        processor.process_capture(&mut frame);
        processor.process_reverse(&mut frame);
        assert_eq!(errors.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn a_rejected_frame_increments_the_error_counter() {
        let (mut processor, errors) = processor(ProcessingSettings::default());
        processor.fail_next_call();
        let mut frame = [1_000i16; FRAME_SAMPLES];
        processor.process_capture(&mut frame);
        assert_eq!(processor.errors(), 1);
        assert_eq!(errors.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn every_stage_is_controllable_independently() {
        let settings = ProcessingSettings {
            echo_cancellation: true,
            noise_suppression: false,
            noise_model: NoiseModel::RnNoise,
            gain_control: false,
            high_pass_filter: false,
        };
        let (processor, _) = processor(settings);
        assert!(processor.is_enabled());
        assert_eq!(processor.settings(), settings);
        // The legacy switch wins: no denoiser was created.
        assert!(processor.denoiser.is_none());
        assert!(!ProcessingSettings::disabled().any_enabled());
    }

    #[test]
    fn rnnoise_is_the_default_and_runs_between_the_apms() {
        let settings = ProcessingSettings::default();
        assert_eq!(settings.noise_model, NoiseModel::RnNoise);
        assert_eq!(settings.effective_noise_model(), NoiseModel::RnNoise);
        // AGC is off by default (see `Default`), so APM-2 is absent here.
        assert!(!settings.gain_control);
        let (mut processor, _) = processor(settings);
        assert!(processor.denoiser.is_some());
        assert!(processor.first.is_some());
        assert!(processor.second.is_none());
        let mut frame = [1_000i16; FRAME_SAMPLES];
        // The first denoised frame is silence, so the chain ran end to end.
        processor.process_capture(&mut frame);
        assert_eq!(frame, [0i16; FRAME_SAMPLES]);
        assert_eq!(processor.vad(), Some(0.0));
    }

    #[test]
    fn agc_runs_in_the_second_apm_after_the_denoiser() {
        let settings = ProcessingSettings {
            gain_control: true,
            ..ProcessingSettings::default()
        };
        let (processor, _) = processor(settings);
        assert!(processor.denoiser.is_some());
        assert!(processor.first.is_some());
        assert!(processor.second.is_some());
    }

    #[test]
    fn webrtc_noise_goes_into_the_first_apm_only() {
        let settings = ProcessingSettings {
            noise_model: NoiseModel::WebRtc,
            gain_control: true,
            ..ProcessingSettings::default()
        };
        let (processor, _) = processor(settings);
        assert!(processor.denoiser.is_none());
        assert!(processor.first.is_some());
        assert!(processor.second.is_some());
    }

    #[test]
    fn deep_filter_replaces_rnnoise_and_never_runs_with_it() {
        let settings = ProcessingSettings {
            noise_model: NoiseModel::DeepFilter,
            ..ProcessingSettings::default()
        };
        assert_eq!(settings.effective_noise_model(), NoiseModel::DeepFilter);
        let (mut processor, errors) = processor(settings);
        assert!(processor.denoiser.is_none());
        assert!(processor.deep.is_some());
        // APM-1 keeps HPF and AEC, its own NS stays off (no double NS).
        assert!(processor.first.is_some());
        assert!(processor.is_enabled());
        // The gate has no RNNoise speech probability in this mode.
        assert_eq!(processor.vad(), None);
        let mut frame = [1_000i16; FRAME_SAMPLES];
        processor.process_capture(&mut frame);
        assert_eq!(errors.load(Ordering::Relaxed), 0);
        assert_eq!(NoiseModel::DeepFilter.name(), "deepfilter");
    }

    #[test]
    fn the_legacy_switch_turns_noise_suppression_off() {
        let settings = ProcessingSettings {
            noise_suppression: false,
            noise_model: NoiseModel::RnNoise,
            ..ProcessingSettings::default()
        };
        assert_eq!(settings.effective_noise_model(), NoiseModel::Off);
        let (processor, _) = processor(settings);
        assert!(processor.denoiser.is_none());
    }

    #[test]
    fn the_default_noise_model_is_rnnoise() {
        // `#[serde(default)]` on the field resolves to this value, which is how
        // an old UI payload without `noiseModel` keeps noise suppression on.
        assert_eq!(NoiseModel::default(), NoiseModel::RnNoise);
        assert_eq!(
            ProcessingSettings::default().noise_model,
            NoiseModel::RnNoise
        );
    }
}
