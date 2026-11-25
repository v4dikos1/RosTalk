//! Streaming mono resampler used on both the capture and the playback path.
//!
//! Devices commonly run at 44.1, 32 or 16 kHz while APM, LiveKit and the mixer
//! need 48 kHz (ADR 0002). The resampler is a windowed-sinc interpolator: one
//! polyphase coefficient table covers the whole conversion, and the same filter
//! removes aliases when decimating and images when interpolating. The previous
//! linear interpolator only filtered the decimation direction, so 44.1/96 kHz
//! devices produced audible images ("sharp" sound, stage 2.3.1).
//!
//! The resampler is allocation-free after construction: [`Resampler::push`] and
//! [`Resampler::produce`] only move samples through a preallocated ring. The
//! filter needs [`HALF_TAPS`] samples of lookahead, which is 0.5 ms at 48 kHz
//! and is accounted for by the caller's buffering.

use std::collections::VecDeque;
use std::f64::consts::PI;

use crate::frame::SAMPLE_RATE;

/// Output rate of the resampler when only an input rate is given.
pub const OUTPUT_RATE: u32 = SAMPLE_RATE;

/// Taps per output sample. 191 taps with a Kaiser window (β = 7) put the
/// stopband below -75 dB, which is enough to suppress both aliases and images
/// for speech and music at 44.1/48/96 kHz: the narrowest transition is
/// 96 → 48 kHz (21.6 → 24 kHz), i.e. 0.025 of the input rate.
const TAPS: usize = 191;
/// Samples of future input the filter needs.
const HALF_TAPS: usize = TAPS / 2;
/// Polyphase table resolution: 1024 phases quantise the fractional position to
/// 1/1024 of an input sample; the resulting modulation sidebands stay below
/// -70 dB for tones up to 10 kHz.
const PHASES: usize = 1024;
/// Kaiser window shape; β = 7 ≈ -75 dB stopband attenuation.
const KAISER_BETA: f64 = 7.0;

/// Streaming resampler from an arbitrary device rate to 48 kHz (or between any
/// two rates).
pub struct Resampler {
    input_rate: u32,
    output_rate: u32,
    ratio: f64,
    buffer: VecDeque<f32>,
    /// Position of the next output sample relative to the front of `buffer`.
    position: f64,
    coefficients: Vec<f32>,
    capacity: usize,
    dropped: u64,
}

impl Resampler {
    /// Creates a resampler for a device running at `input_rate`.
    ///
    /// The buffer holds one second of input; if the audio thread falls more
    /// than a second behind, the oldest unread samples are dropped instead of
    /// growing without bound.
    #[must_use]
    pub fn new(input_rate: u32) -> Self {
        Self::new_with_rates(input_rate, OUTPUT_RATE)
    }

    /// Creates a resampler from `input_rate` to `output_rate`.
    ///
    /// The capture path always targets 48 kHz; the playback path converts the
    /// 48 kHz mix to the output device's native rate.
    #[must_use]
    pub fn new_with_rates(input_rate: u32, output_rate: u32) -> Self {
        let input_rate = input_rate.max(1);
        let output_rate = output_rate.max(1);
        let ratio = f64::from(input_rate) / f64::from(output_rate);
        let coefficients = if input_rate == output_rate {
            Vec::new()
        } else {
            // Anti-alias / anti-image cutoff at 45 % of the lower Nyquist
            // frequency, expressed in cycles per input sample.
            let cutoff = 0.45 * f64::from(input_rate.min(output_rate)) / f64::from(input_rate);
            build_coefficients(cutoff)
        };
        let capacity = input_rate as usize + TAPS;
        Self {
            input_rate,
            output_rate,
            ratio,
            buffer: VecDeque::with_capacity(capacity),
            position: 0.0,
            coefficients,
            capacity,
            dropped: 0,
        }
    }

    /// Input rate this resampler was built for.
    #[must_use]
    pub fn input_rate(&self) -> u32 {
        self.input_rate
    }

    /// Output rate of this resampler.
    #[must_use]
    pub fn output_rate(&self) -> u32 {
        self.output_rate
    }

    /// True when the input rate already equals the output rate.
    #[must_use]
    pub fn is_passthrough(&self) -> bool {
        self.input_rate == self.output_rate
    }

    /// Discards buffered samples, for example after a device change.
    pub fn reset(&mut self) {
        self.buffer.clear();
        self.position = 0.0;
        self.dropped = 0;
    }

    /// Adds one input sample.
    pub fn push(&mut self, sample: f32) {
        if self.buffer.len() == self.capacity {
            // One second of unread input: the audio thread stalled. Drop the
            // oldest sample so the buffer never allocates. `position` may
            // already point at the dropped sample; never let it go negative,
            // or the interpolator extrapolates instead of interpolating.
            self.buffer.pop_front();
            self.position = (self.position - 1.0).max(0.0);
            self.dropped = self.dropped.saturating_add(1);
        }
        self.buffer.push_back(sample);
    }

    /// Fills as much of `out` as the buffered input allows and returns the
    /// number of written samples. The caller fills the rest with silence.
    pub fn produce(&mut self, out: &mut [f32]) -> usize {
        if self.coefficients.is_empty() {
            return self.produce_passthrough(out);
        }
        if out.is_empty() || self.buffer.is_empty() {
            return 0;
        }
        let mut written = 0;
        while written < out.len() {
            let index = self.position.floor();
            if index < 0.0 || index >= self.buffer.len() as f64 {
                break;
            }
            let index = index as usize;
            // The filter needs HALF_TAPS samples of lookahead; keep them in the
            // buffer so the next block never works with fabricated samples.
            if index + HALF_TAPS >= self.buffer.len() {
                break;
            }
            let mut fraction = self.position - index as f64;
            let mut phase = (fraction * PHASES as f64).round() as usize;
            let mut centre = index;
            if phase == PHASES {
                // Rounding crossed the sample boundary; the next phase table
                // entry with the next sample is the same filter.
                phase = 0;
                fraction = 0.0;
                centre += 1;
                if centre >= self.buffer.len() {
                    break;
                }
            }
            debug_assert!((0.0..1.0).contains(&fraction));
            let table = &self.coefficients[phase * TAPS..(phase + 1) * TAPS];
            let mut sum = 0.0f32;
            for (tap, coefficient) in table.iter().enumerate() {
                // centre - HALF_TAPS + tap; samples before the stream start
                // and beyond the buffered input count as silence.
                let source = centre as isize - HALF_TAPS as isize + tap as isize;
                if source < 0 {
                    continue;
                }
                let source = source as usize;
                if source >= self.buffer.len() {
                    break;
                }
                sum += self.buffer[source] * coefficient;
            }
            out[written] = sum;
            written += 1;
            self.position += self.ratio;
        }
        // Keep HALF_TAPS samples of history before the next output: the filter
        // is centred on the output position, so popping everything up to it
        // would make the next block start with a zero-filled past and add a
        // periodic artefact at every block boundary.
        let consumed = (self.position.floor() as usize)
            .saturating_sub(HALF_TAPS)
            .min(self.buffer.len());
        self.position -= consumed as f64;
        for _ in 0..consumed {
            self.buffer.pop_front();
        }
        written
    }

    fn produce_passthrough(&mut self, out: &mut [f32]) -> usize {
        let written = out.len().min(self.buffer.len());
        for (index, sample) in out.iter_mut().take(written).enumerate() {
            *sample = self.buffer[index];
        }
        for _ in 0..written {
            self.buffer.pop_front();
        }
        written
    }

    /// Number of output samples [`Resampler::produce`] can write right now
    /// without waiting for more input (stage 2.3.2b).
    ///
    /// The capture thread only forwards whole 10 ms frames: it asks how much
    /// the resampler has ready and never pads a short frame with silence. The
    /// filter needs [`HALF_TAPS`] input samples of lookahead, so a sample is
    /// only counted when every tap behind it is real input. The estimate is
    /// rounded down by a millionth of an output sample on purpose:
    /// under-reporting costs one 2 ms poll, while over-reporting would make the
    /// caller publish a short frame.
    #[must_use]
    pub fn available(&self) -> usize {
        if self.coefficients.is_empty() {
            return self.buffer.len();
        }
        let span = self.buffer.len() as f64 - HALF_TAPS as f64 - self.position;
        if span <= 0.0 {
            return 0;
        }
        let count = (span / self.ratio - 1.0e-6).ceil();
        if count <= 0.0 {
            0
        } else {
            count as usize
        }
    }

    /// Number of buffered input samples, for tests and diagnostics.
    #[must_use]
    pub fn buffered(&self) -> usize {
        self.buffer.len()
    }

    /// Input samples discarded because the buffer was full.
    #[must_use]
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
}

/// Builds the `PHASES × TAPS` Kaiser-windowed sinc table.
///
/// `cutoff` is in cycles per input sample (0..0.5). Every phase is normalised
/// to unity DC gain so the resampler never changes the loudness.
fn build_coefficients(cutoff: f64) -> Vec<f32> {
    let mut table = vec![0.0f32; PHASES * TAPS];
    let half = (TAPS - 1) as f64 / 2.0;
    let window_norm = bessel_i0(KAISER_BETA);
    for phase in 0..PHASES {
        let fraction = phase as f64 / PHASES as f64;
        let mut sum = 0.0f64;
        for tap in 0..TAPS {
            let offset = tap as f64 - half - fraction;
            // Ideal lowpass: h[n] = 2·fc·sinc(2·fc·n), so the -6 dB point is
            // exactly at `cutoff` cycles per input sample.
            let x = 2.0 * cutoff * offset;
            let sinc = if x.abs() < 1e-12 {
                1.0
            } else {
                (PI * x).sin() / (PI * x)
            };
            let ratio = offset / half;
            let window = if ratio.abs() >= 1.0 {
                0.0
            } else {
                bessel_i0(KAISER_BETA * (1.0 - ratio * ratio).sqrt()) / window_norm
            };
            let coefficient = 2.0 * cutoff * sinc * window;
            table[phase * TAPS + tap] = coefficient as f32;
            sum += coefficient;
        }
        if sum.abs() > f64::EPSILON {
            for tap in 0..TAPS {
                table[phase * TAPS + tap] = (f64::from(table[phase * TAPS + tap]) / sum) as f32;
            }
        }
    }
    table
}

/// Zeroth-order modified Bessel function of the first kind (Kaiser window).
fn bessel_i0(x: f64) -> f64 {
    let half = x / 2.0;
    let mut term = 1.0;
    let mut sum = 1.0;
    for k in 1..64 {
        term *= half * half / (k * k) as f64;
        sum += term;
        if term < sum * 1e-16 {
            break;
        }
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::FRAME_SAMPLES;

    /// Runs a sine through the resampler and returns the output.
    fn resample_sine(input_rate: u32, frequency: f32, seconds: f32) -> Vec<f32> {
        let total = (input_rate as f32 * seconds) as usize;
        let out_total = (OUTPUT_RATE as f32 * seconds) as usize;
        let mut resampler = Resampler::new(input_rate);
        let mut out = Vec::with_capacity(out_total + 480);
        let mut block = vec![0.0f32; 480];
        for n in 0..total {
            let t = n as f64 / f64::from(input_rate);
            resampler.push((std::f64::consts::TAU * f64::from(frequency) * t).sin() as f32 * 0.5);
            if n % 480 == 479 {
                let written = resampler.produce(&mut block);
                out.extend_from_slice(&block[..written]);
            }
        }
        loop {
            let written = resampler.produce(&mut block);
            if written == 0 {
                break;
            }
            out.extend_from_slice(&block[..written]);
        }
        out
    }

    /// Amplitude at `frequency` found by a least-squares sine/cosine fit.
    fn amplitude_at(samples: &[f32], frequency: f32) -> f64 {
        amplitude_at_rate(samples, frequency, OUTPUT_RATE)
    }

    fn amplitude_at_rate(samples: &[f32], frequency: f32, rate: u32) -> f64 {
        let omega = std::f64::consts::TAU * f64::from(frequency) / f64::from(rate);
        let (mut sin_sin, mut cos_cos, mut sin_cos, mut x_sin, mut x_cos) =
            (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
        for (index, sample) in samples.iter().enumerate() {
            let phase = omega * index as f64;
            let (sin, cos) = phase.sin_cos();
            let x = f64::from(*sample);
            sin_sin += sin * sin;
            cos_cos += cos * cos;
            sin_cos += sin * cos;
            x_sin += x * sin;
            x_cos += x * cos;
        }
        let det = sin_sin * cos_cos - sin_cos * sin_cos;
        if det.abs() < 1e-12 {
            return 0.0;
        }
        let a = (x_sin * cos_cos - x_cos * sin_cos) / det;
        let b = (x_cos * sin_sin - x_sin * sin_cos) / det;
        (a * a + b * b).sqrt()
    }

    /// Total harmonic distortion plus noise relative to the fundamental.
    fn thd_plus_n(samples: &[f32], frequency: f32) -> f64 {
        let omega = std::f64::consts::TAU * f64::from(frequency) / f64::from(OUTPUT_RATE);
        let (mut sin_sin, mut cos_cos, mut sin_cos, mut x_sin, mut x_cos) =
            (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
        for (index, sample) in samples.iter().enumerate() {
            let phase = omega * index as f64;
            let (sin, cos) = phase.sin_cos();
            let x = f64::from(*sample);
            sin_sin += sin * sin;
            cos_cos += cos * cos;
            sin_cos += sin * cos;
            x_sin += x * sin;
            x_cos += x * cos;
        }
        let det = sin_sin * cos_cos - sin_cos * sin_cos;
        if det.abs() < 1e-12 {
            return 0.0;
        }
        let a = (x_sin * cos_cos - x_cos * sin_cos) / det;
        let b = (x_cos * sin_sin - x_sin * sin_cos) / det;
        // Subtract the fitted fundamental in the time domain: squaring nearly
        // equal total and fundamental powers loses all resolution.
        let mut residual = 0.0f64;
        let mut fundamental = 0.0f64;
        for (index, sample) in samples.iter().enumerate() {
            let phase = omega * index as f64;
            let (sin, cos) = phase.sin_cos();
            let fitted = a * sin + b * cos;
            fundamental += fitted * fitted;
            let difference = f64::from(*sample) - fitted;
            residual += difference * difference;
        }
        if fundamental <= f64::EPSILON {
            return 0.0;
        }
        (residual / fundamental).sqrt()
    }

    fn zero_crossings(samples: &[f32]) -> usize {
        samples
            .windows(2)
            .filter(|pair| (pair[0] < 0.0 && pair[1] >= 0.0) || (pair[0] >= 0.0 && pair[1] < 0.0))
            .count()
    }

    /// Skips the filter transient and the last 20 ms.
    fn steady(samples: &[f32]) -> &[f32] {
        let skip = 2400;
        if samples.len() < skip * 2 {
            return samples;
        }
        &samples[skip..samples.len() - skip]
    }

    #[test]
    fn passthrough_does_not_change_the_rate() {
        let mut resampler = Resampler::new(48_000);
        assert!(resampler.is_passthrough());
        for _ in 0..480 {
            resampler.push(0.25);
        }
        let mut out = [0.0f32; 480];
        assert_eq!(resampler.produce(&mut out), 480);
        assert!(out.iter().all(|sample| (sample - 0.25).abs() < 1e-6));
    }

    #[test]
    fn common_device_rates_produce_half_a_second_at_48k() {
        for rate in [44_100u32, 32_000, 24_000, 16_000, 96_000] {
            let out = resample_sine(rate, 1_000.0, 0.5);
            let expected = OUTPUT_RATE as usize / 2;
            let tolerance = OUTPUT_RATE as usize / 100; // 1 %
            assert!(
                out.len().abs_diff(expected) <= tolerance,
                "rate {rate}: got {} samples, want about {expected}",
                out.len()
            );
        }
    }

    #[test]
    fn tone_frequency_survives_resampling() {
        for rate in [44_100u32, 16_000, 96_000] {
            let out = resample_sine(rate, 1_000.0, 0.5);
            let crossings = zero_crossings(steady(&out));
            // 1 kHz over the 400 ms steady window is 400 full cycles, 800
            // crossings.
            assert!(
                (780..=820).contains(&crossings),
                "rate {rate}: {crossings} zero crossings, expected about 800"
            );
        }
    }

    /// Passband flatness: every tone up to 15 kHz keeps its amplitude within
    /// 0.5 dB, so voices do not change timbre when the device runs at 44.1 or
    /// 96 kHz.
    #[test]
    fn passband_is_flat_within_half_a_db() {
        for rate in [44_100u32, 96_000] {
            for frequency in [100.0f32, 1_000.0, 5_000.0, 10_000.0, 15_000.0] {
                let out = resample_sine(rate, frequency, 0.6);
                let amplitude = amplitude_at(steady(&out), frequency);
                let db = 20.0 * (amplitude / 0.5).log10();
                assert!(
                    db.abs() < 0.5,
                    "rate {rate}, {frequency} Hz: gain {db:.3} dB"
                );
            }
        }
    }

    /// The linear interpolator used to leave images of the input around the
    /// new Nyquist frequency, which made 44.1 kHz devices sound sharp.
    #[test]
    fn upsampling_suppresses_images() {
        // 10 kHz at 44.1 kHz has an image at 34.1 kHz after interpolation to
        // 48 kHz; it must be at least 60 dB below the fundamental.
        let out = resample_sine(44_100, 10_000.0, 0.6);
        let core = steady(&out);
        let fundamental = amplitude_at(core, 10_000.0);
        let image = amplitude_at(core, 34_100.0);
        let db = 20.0 * (image / fundamental).log10();
        assert!(db < -60.0, "image at 34.1 kHz is only {db:.1} dB below");
        eprintln!("image 10 kHz -> 34.1 kHz: {db:.1} dB");

        // The worst audible image for 44.1 kHz devices: 15 kHz folds to 29.1 kHz.
        let out = resample_sine(44_100, 15_000.0, 0.6);
        let core = steady(&out);
        let fundamental = amplitude_at(core, 15_000.0);
        let image = amplitude_at(core, 29_100.0);
        let db = 20.0 * (image / fundamental).log10();
        assert!(
            db < -60.0,
            "image of 15 kHz is only {db:.1} dB below the tone"
        );
        eprintln!("image 15 kHz -> 29.1 kHz: {db:.1} dB");

        // 48 → 96 kHz playback: a 20 kHz tone would fold to 28 kHz without an
        // anti-imaging filter.
        let mut resampler = Resampler::new_with_rates(48_000, 96_000);
        let mut out = Vec::new();
        let mut block = vec![0.0f32; 960];
        for index in 0..28_800 {
            let phase = std::f64::consts::TAU * 20_000.0 * index as f64 / 48_000.0;
            resampler.push((phase.sin() * 0.5) as f32);
            if index % 480 == 479 {
                let written = resampler.produce(&mut block);
                out.extend_from_slice(&block[..written]);
            }
        }
        let skip = 4800;
        let core = &out[skip..out.len() - skip];
        let fundamental = amplitude_at_rate(core, 20_000.0, 96_000);
        let image = amplitude_at_rate(core, 28_000.0, 96_000);
        let db = 20.0 * (image / fundamental).log10();
        assert!(db < -60.0, "20 kHz image is only {db:.1} dB below");
    }

    #[test]
    fn downsampling_attenuates_tones_above_the_new_nyquist() {
        // 30 kHz at 96 kHz would alias to 18 kHz after naive decimation.
        let out = resample_sine(96_000, 30_000.0, 0.6);
        let energy: f32 = steady(&out).iter().map(|sample| sample * sample).sum();
        let rms = (energy / steady(&out).len() as f32).sqrt();
        assert!(rms < 1e-3, "aliased RMS was {rms}");
    }

    /// THD+N of a 1 kHz tone through every supported device rate. The filter
    /// and the 512-phase table leave far less distortion than the linear
    /// interpolator (which measured about -37 dB at 44.1 kHz).
    #[test]
    fn thd_plus_noise_is_low_at_common_rates() {
        for rate in [44_100u32, 48_000, 96_000] {
            let out = resample_sine(rate, 1_000.0, 1.0);
            let distortion = thd_plus_n(steady(&out), 1_000.0);
            let db = 20.0 * distortion.log10();
            assert!(db < -70.0, "rate {rate}: THD+N {db:.1} dB");
        }
    }

    #[test]
    fn playback_resampler_converts_48k_to_44k() {
        let mut resampler = Resampler::new_with_rates(48_000, 44_100);
        assert!(!resampler.is_passthrough());
        let mut out = [0.0f32; 480];
        let mut produced = 0;
        for index in 0..48_000 {
            let t = index as f32 / 48_000.0;
            resampler.push((std::f32::consts::TAU * 440.0 * t).sin() * 0.5);
            if index % 480 == 479 {
                produced += resampler.produce(&mut out);
            }
        }
        // One second of 48 kHz audio becomes about 44 100 output samples.
        assert!(
            produced.abs_diff(44_100) <= 500,
            "produced {produced} samples"
        );
    }

    #[test]
    fn available_matches_what_produce_can_write() {
        // Every rate combination: whatever `available` reports must come out in
        // one `produce` call. Over-reporting would force the capture path to
        // pad a frame, under-reporting only delays it by one poll.
        for (input_rate, output_rate) in [
            (48_000u32, 48_000u32),
            (44_100, 48_000),
            (32_000, 48_000),
            (96_000, 48_000),
            (16_000, 48_000),
            (48_000, 44_100),
        ] {
            let mut resampler = Resampler::new_with_rates(input_rate, output_rate);
            let mut total = 0usize;
            for index in 0..(input_rate as usize) {
                let phase = std::f64::consts::TAU * 440.0 * index as f64 / f64::from(input_rate);
                resampler.push((phase.sin() * 0.25) as f32);
                if index % 61 != 0 {
                    continue;
                }
                let available = resampler.available();
                let mut out = vec![0.0f32; available];
                let written = resampler.produce(&mut out);
                assert_eq!(
                    written, available,
                    "{input_rate} -> {output_rate}: available {available}, wrote {written}"
                );
                assert!(
                    out.iter().all(|sample| sample.is_finite()),
                    "{input_rate} -> {output_rate}: non-finite output"
                );
                total += written;
            }
            assert!(total > 40_000, "produced {total} samples");
        }
    }

    #[test]
    fn a_whole_frame_needs_its_lookahead() {
        let mut passthrough = Resampler::new(48_000);
        assert_eq!(passthrough.available(), 0);
        for _ in 0..(FRAME_SAMPLES - 1) {
            passthrough.push(0.5);
        }
        assert_eq!(passthrough.available(), FRAME_SAMPLES - 1);
        passthrough.push(0.5);
        assert_eq!(passthrough.available(), FRAME_SAMPLES);

        // A conversion never reports more than the input can support.
        let mut resampler = Resampler::new_with_rates(44_100, 48_000);
        for _ in 0..FRAME_SAMPLES {
            resampler.push(0.5);
        }
        let available = resampler.available();
        assert!(
            available < FRAME_SAMPLES,
            "44.1 kHz could not produce {available} samples from {FRAME_SAMPLES} input samples"
        );
        let mut out = vec![0.0f32; available];
        assert_eq!(resampler.produce(&mut out), available);
    }

    #[test]
    fn buffer_never_grows_past_one_second() {
        let mut resampler = Resampler::new(16_000);
        for _ in 0..40_000 {
            resampler.push(0.1);
        }
        assert!(resampler.buffered() <= 16_000 + TAPS);
        assert!(resampler.dropped() > 0);
    }

    #[test]
    fn insufficient_input_writes_nothing_and_keeps_samples() {
        // 48 kHz is a passthrough: one sample in, one sample out.
        let mut passthrough = Resampler::new(48_000);
        passthrough.push(0.5);
        let mut out = [7.0f32; 480];
        assert_eq!(passthrough.produce(&mut out), 1);
        assert_eq!(out[0], 0.5);
        assert_eq!(passthrough.buffered(), 0);

        // A real conversion needs HALF_TAPS samples of lookahead before the
        // first output; nothing is dropped while it waits.
        let mut resampler = Resampler::new_with_rates(44_100, 48_000);
        resampler.push(0.5);
        let mut out = [7.0f32; 480];
        assert_eq!(resampler.produce(&mut out), 0);
        assert_eq!(out[0], 7.0);
        assert_eq!(resampler.buffered(), 1);
    }

    #[test]
    fn buffer_overflow_never_makes_the_position_negative() {
        let mut resampler = Resampler::new(16_000);
        // Overfill without producing: every dropped sample used to decrement
        // `position` past zero, so `as usize` saturated and the fraction became
        // negative (extrapolation instead of interpolation).
        for _ in 0..40_000 {
            resampler.push(0.1);
        }
        assert!(resampler.position >= 0.0, "position {}", resampler.position);
        let mut out = [0.0f32; 480];
        assert_eq!(resampler.produce(&mut out), 480);
        // The first HALF_TAPS outputs start with an empty history window; the
        // rest must be the constant input, not an extrapolation artefact.
        assert!(out[200..].iter().all(|sample| (*sample - 0.1).abs() < 1e-3));
    }

    #[test]
    fn the_filter_has_no_dc_gain_error() {
        for rate in [44_100u32, 96_000] {
            let mut resampler = Resampler::new(rate);
            for _ in 0..rate {
                resampler.push(0.25);
            }
            let mut out = vec![0.0f32; 4800];
            let written = resampler.produce(&mut out);
            assert!(written > 0);
            // Skip the start-up transient of the lookahead window.
            let core = &out[240..written];
            let mean: f32 = core.iter().sum::<f32>() / core.len() as f32;
            assert!((mean - 0.25).abs() < 2e-3, "rate {rate}: mean {mean}");
        }
    }
}
