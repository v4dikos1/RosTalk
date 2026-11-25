//! RNNoise noise suppression (`nnnoiseless`, stage 2.3.2e, ADR 0014).
//!
//! The capture path runs the denoiser after the echo canceller and before the
//! gain controller: the echo canceller needs the raw microphone and the
//! reference stream, while the gain controller must amplify clean speech, not
//! the noise that is about to be removed.
//!
//! RNNoise works on exactly the same 10 ms frames as the rest of the pipeline
//! (480 samples at 48 kHz) and expects the input in the `i16` numeric range
//! even though the buffers are `f32` (see `nnnoiseless` 0.5.2,
//! `DenoiseState::process_frame`).
//!
//! The state allocates on construction, so the engine creates it before the
//! capture loop and swaps the whole denoiser when the settings change. The
//! processing call itself uses only stack buffers: no heap, no locks and no
//! logging, which keeps it safe for the audio thread.

use nnnoiseless::DenoiseState;

use crate::frame::FRAME_SAMPLES;

/// Owns one RNNoise state and the fixed conversion buffers.
pub struct Denoiser {
    state: Box<DenoiseState<'static>>,
    input: [f32; FRAME_SAMPLES],
    output: [f32; FRAME_SAMPLES],
    /// The first output is a fade-in artifact of the model and is replaced by
    /// silence, as the crate documentation requires.
    first: bool,
    /// Speech probability returned by the last processed frame, 0..1.
    vad: f32,
}

impl Denoiser {
    /// Creates the model. Allocates: call it before the capture loop, never
    /// from an audio callback.
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: DenoiseState::new(),
            input: [0.0; FRAME_SAMPLES],
            output: [0.0; FRAME_SAMPLES],
            first: true,
            vad: 0.0,
        }
    }

    /// Denoises one frame in place and returns the speech probability of that
    /// frame (0..1).
    ///
    /// The very first frame after construction yields silence: its output is
    /// the model's fade-in artifact. The probability of that frame is dropped
    /// together with the audio, so the VAD gate never acts on a frame the
    /// other side does not hear.
    pub fn process_frame(&mut self, frame: &mut [i16; FRAME_SAMPLES]) -> f32 {
        for (input, sample) in self.input.iter_mut().zip(frame.iter()) {
            // The crate wants the i16 numeric range, not -1..1.
            *input = f32::from(*sample);
        }
        let vad = self.state.process_frame(&mut self.output, &self.input);
        if self.first {
            self.first = false;
            self.vad = 0.0;
            frame.fill(0);
            return self.vad;
        }
        for (sample, output) in frame.iter_mut().zip(self.output.iter()) {
            *sample = output.round().clamp(-32_768.0, 32_767.0) as i16;
        }
        self.vad = vad.clamp(0.0, 1.0);
        self.vad
    }

    /// Speech probability of the last processed frame.
    #[must_use]
    pub fn vad(&self) -> f32 {
        self.vad
    }
}

impl Default for Denoiser {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for Denoiser {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Denoiser")
            .field("first", &self.first)
            .field("vad", &self.vad)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise_frame(seed: &mut u32) -> [i16; FRAME_SAMPLES] {
        let mut frame = [0i16; FRAME_SAMPLES];
        for sample in &mut frame {
            // xorshift: deterministic, no dependency on the test harness.
            *seed ^= *seed << 13;
            *seed ^= *seed >> 17;
            *seed ^= *seed << 5;
            let unit = (*seed >> 8) as f32 / (1u32 << 24) as f32;
            *sample = ((unit * 2.0 - 1.0) * 0.05 * f32::from(i16::MAX)) as i16;
        }
        frame
    }

    fn rms(frame: &[i16]) -> f64 {
        let sum: f64 = frame
            .iter()
            .map(|sample| {
                let value = f64::from(*sample) / f64::from(i16::MAX);
                value * value
            })
            .sum();
        (sum / frame.len() as f64).sqrt()
    }

    #[test]
    fn frame_size_matches_the_pipeline() {
        assert_eq!(DenoiseState::FRAME_SIZE, FRAME_SAMPLES);
        assert_eq!(FRAME_SAMPLES, 480);
    }

    #[test]
    fn the_first_frame_is_silence() {
        let mut denoiser = Denoiser::new();
        let mut frame = noise_frame(&mut 0x5EED_1234);
        assert_eq!(denoiser.process_frame(&mut frame), 0.0);
        assert_eq!(frame, [0i16; FRAME_SAMPLES]);
        assert_eq!(denoiser.vad(), 0.0);
    }

    #[test]
    fn stationary_noise_is_attenuated() {
        let mut denoiser = Denoiser::new();
        let mut seed = 0x1234_5678;
        let mut input_rms = 0.0;
        let mut output_rms = 0.0;
        for index in 0..100 {
            let mut frame = noise_frame(&mut seed);
            input_rms = rms(&frame);
            denoiser.process_frame(&mut frame);
            if index >= 80 {
                output_rms = rms(&frame);
            }
        }
        eprintln!("stationary noise: {input_rms:.5} -> {output_rms:.5}");
        assert!(
            output_rms < input_rms,
            "RNNoise left the stationary noise at {output_rms:.5} of {input_rms:.5}"
        );
    }

    #[test]
    fn the_vad_probability_stays_in_range() {
        let mut denoiser = Denoiser::new();
        let mut seed = 0x0BAD_F00D;
        for _ in 0..20 {
            let mut frame = noise_frame(&mut seed);
            let vad = denoiser.process_frame(&mut frame);
            assert!((0.0..=1.0).contains(&vad), "vad was {vad}");
            assert_eq!(vad, denoiser.vad());
        }
    }
}
