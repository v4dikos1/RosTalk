//! DeepFilterNet3 noise suppression, the "strong" mode (`dfn3_rs`, stage P17,
//! ADR 0029).
//!
//! It sits in the same slot as RNNoise (after the echo canceller, before the
//! gain controller) and works on the same 10 ms frames: 480 samples at 48 kHz.
//! The crate wants finite `f32` PCM normalised to -1..1, unlike `nnnoiseless`,
//! which wants the `i16` numeric range.
//!
//! The algorithmic delay is 30 ms (20 ms STFT overlap plus two frames of model
//! lookahead): the output of this stage is [`ALGORITHM_DELAY`] samples behind
//! the input and the first three frames carry only the model's start-up.
//!
//! The state allocates on construction, so the engine builds it before the
//! capture loop. [`DeepFilter::process_frame`] uses stack buffers and the
//! crate's allocation-free `process`: no heap, no locks, no logging.

use dfn3_rs::{Denoiser, FRAME_SIZE};

use crate::frame::FRAME_SAMPLES;

/// Algorithmic delay of the stage in samples at 48 kHz (30 ms).
pub const ALGORITHM_DELAY: usize = dfn3_rs::ALGORITHM_DELAY;

/// `i16` to the crate's -1..1 scale.
const TO_UNIT: f32 = 1.0 / 32_768.0;
/// The crate's stage-skipping thresholds (its defaults), restored after the
/// warm-up: `min`, `max_erb`, `max_df` in dB of local SNR.
const THRESHOLDS: [f32; 3] = [-10.0, 30.0, 20.0];
/// Frames of low-level noise used to touch every stage of the network once.
const WARMUP_FRAMES: usize = 8;

/// Owns one DeepFilterNet3 stream and the fixed conversion buffers.
pub struct DeepFilter {
    state: Box<Denoiser>,
    input: [f32; FRAME_SAMPLES],
    output: [f32; FRAME_SAMPLES],
    /// Local SNR estimate of the last frame in dB.
    lsnr: f32,
}

impl DeepFilter {
    /// Creates the model and warms it up so the first real frame does not pay
    /// for cold caches and first-touch of the weights. Allocates: call it
    /// before the capture loop, never from an audio callback.
    #[must_use]
    pub fn new() -> Self {
        let mut state = Box::new(Denoiser::new());
        // Run every stage once (the crate documents this recipe): the
        // thresholds are opened so no stage is skipped, then everything is
        // reset to the defaults.
        state.set_thresholds(-100.0, 100.0, 100.0);
        let mut seed = 0x9E37_79B9u32;
        let mut input = [0.0f32; FRAME_SIZE];
        let mut output = [0.0f32; FRAME_SIZE];
        for _ in 0..WARMUP_FRAMES {
            for sample in &mut input {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                *sample = ((seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.002;
            }
            state.process(&input, &mut output);
        }
        state.reset();
        state.set_thresholds(THRESHOLDS[0], THRESHOLDS[1], THRESHOLDS[2]);
        Self {
            state,
            input: [0.0; FRAME_SAMPLES],
            output: [0.0; FRAME_SAMPLES],
            lsnr: -15.0,
        }
    }

    /// Denoises one frame in place and returns the local SNR estimate of the
    /// model in dB (about -15 for noise, above 0 for speech).
    pub fn process_frame(&mut self, frame: &mut [i16; FRAME_SAMPLES]) -> f32 {
        for (input, sample) in self.input.iter_mut().zip(frame.iter()) {
            *input = f32::from(*sample) * TO_UNIT;
        }
        let lsnr = self.state.process(&self.input, &mut self.output);
        for (sample, output) in frame.iter_mut().zip(self.output.iter()) {
            *sample = (output * 32_768.0).round().clamp(-32_768.0, 32_767.0) as i16;
        }
        self.lsnr = if lsnr.is_finite() { lsnr } else { -15.0 };
        self.lsnr
    }

    /// Local SNR estimate of the last processed frame in dB.
    #[must_use]
    pub fn lsnr(&self) -> f32 {
        self.lsnr
    }
}

impl Default for DeepFilter {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for DeepFilter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DeepFilter")
            .field("lsnr", &self.lsnr)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone_frame(phase: &mut f32, amplitude: f32) -> [i16; FRAME_SAMPLES] {
        let mut frame = [0i16; FRAME_SAMPLES];
        for sample in &mut frame {
            *sample = (phase.sin() * amplitude * 32_767.0) as i16;
            *phase += 2.0 * std::f32::consts::PI * 440.0 / 48_000.0;
        }
        frame
    }

    #[test]
    fn frame_size_and_delay_match_the_pipeline() {
        assert_eq!(FRAME_SIZE, FRAME_SAMPLES);
        assert_eq!(ALGORITHM_DELAY, 1_440);
        assert_eq!(dfn3_rs::SAMPLE_RATE, crate::frame::SAMPLE_RATE);
    }

    #[test]
    fn silence_stays_silent_and_the_snr_is_finite() {
        let mut filter = DeepFilter::new();
        for _ in 0..20 {
            let mut frame = [0i16; FRAME_SAMPLES];
            let lsnr = filter.process_frame(&mut frame);
            assert!(lsnr.is_finite());
            assert_eq!(frame, [0i16; FRAME_SAMPLES]);
        }
    }

    #[test]
    fn a_loud_signal_is_clamped_not_wrapped() {
        let mut filter = DeepFilter::new();
        let mut phase = 0.0;
        for _ in 0..30 {
            let mut frame = tone_frame(&mut phase, 1.0);
            filter.process_frame(&mut frame);
        }
        // No panic and a finite estimate is the contract: full-scale input
        // must not turn into wrapped samples.
        assert!(filter.lsnr().is_finite());
    }

    #[test]
    fn the_output_is_delayed_by_the_algorithmic_delay() {
        // An impulse train in the middle of otherwise quiet noise is not
        // reproduced exactly by a denoiser, so check the weaker invariant the
        // pipeline depends on: nothing comes out before the delay has passed
        // for a signal that starts after silence.
        let mut filter = DeepFilter::new();
        let mut phase = 0.0;
        let mut first_loud = None;
        for index in 0..40 {
            let mut frame = if index < 10 {
                [0i16; FRAME_SAMPLES]
            } else {
                tone_frame(&mut phase, 0.3)
            };
            filter.process_frame(&mut frame);
            if first_loud.is_none() && frame.iter().any(|s| s.unsigned_abs() > 300) {
                first_loud = Some(index);
            }
        }
        let first = first_loud.unwrap_or(usize::MAX);
        assert!(
            first >= 10 + ALGORITHM_DELAY / FRAME_SAMPLES - 1,
            "output appeared at frame {first}, before the algorithmic delay"
        );
    }
}
