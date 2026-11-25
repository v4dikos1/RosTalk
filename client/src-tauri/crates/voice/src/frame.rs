//! Frame constants and level math shared by the capture and playback paths.
//!
//! The whole pipeline works on 48 kHz mono `i16` frames of exactly 10 ms: that
//! is the format `AudioProcessingModule` accepts and the format
//! `NativeAudioSource` publishes (ADR 0002).

/// Sample rate of the internal pipeline and of the published track.
pub const SAMPLE_RATE: u32 = 48_000;

/// Samples in one 10 ms frame at [`SAMPLE_RATE`].
pub const FRAME_SAMPLES: usize = (SAMPLE_RATE as usize) / 100;

/// Duration of one frame in milliseconds.
pub const FRAME_MS: u64 = 10;

/// Level reported for a silent frame; keeps `log10(0)` out of the math.
pub const SILENCE_DB: f32 = -90.0;

/// Level in dBFS of a frame of `i16` samples.
///
/// The RMS is taken over the whole frame; a fully silent frame maps to
/// [`SILENCE_DB`]. Values above 0 dB are possible after automatic gain control
/// and are intentionally not clamped here.
#[must_use]
pub fn frame_level_db(frame: &[i16]) -> f32 {
    if frame.is_empty() {
        return SILENCE_DB;
    }
    let mut sum = 0.0f64;
    for sample in frame {
        let value = f64::from(*sample) / f64::from(i16::MAX);
        sum += value * value;
    }
    let rms = (sum / frame.len() as f64).sqrt();
    amplitude_to_db(rms as f32)
}

/// Converts a linear amplitude (0..1) to dBFS, with a floor.
#[must_use]
pub fn amplitude_to_db(amplitude: f32) -> f32 {
    if !amplitude.is_finite() || amplitude <= 0.0 {
        return SILENCE_DB;
    }
    20.0 * amplitude.log10()
}

/// Converts dBFS to a linear gain factor.
#[must_use]
pub fn db_to_amplitude(db: f32) -> f32 {
    if db <= SILENCE_DB {
        return 0.0;
    }
    10f32.powf(db / 20.0)
}

/// Applies a linear gain to a frame in place, clamping to `i16`.
pub fn apply_gain(frame: &mut [i16], gain: f32) {
    if (gain - 1.0).abs() < f32::EPSILON {
        return;
    }
    for sample in frame {
        let scaled = f32::from(*sample) * gain;
        *sample = scaled.clamp(f32::from(i16::MIN), f32::from(i16::MAX)) as i16;
    }
}

/// Mono frame of silence.
#[must_use]
pub fn silence() -> [i16; FRAME_SAMPLES] {
    [0; FRAME_SAMPLES]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_is_exactly_ten_milliseconds() {
        assert_eq!(FRAME_SAMPLES * 100, SAMPLE_RATE as usize);
        assert_eq!(FRAME_MS, 10);
    }

    #[test]
    fn silence_is_the_floor() {
        assert_eq!(frame_level_db(&[0; FRAME_SAMPLES]), SILENCE_DB);
        assert_eq!(frame_level_db(&[]), SILENCE_DB);
    }

    #[test]
    fn full_scale_square_is_zero_db() {
        let mut frame = [i16::MAX; FRAME_SAMPLES];
        assert!((frame_level_db(&frame) - 0.0).abs() < 0.01);
        frame.fill(i16::MIN + 1);
        assert!((frame_level_db(&frame) - 0.0).abs() < 0.01);
    }

    #[test]
    fn half_amplitude_is_about_minus_six_db() {
        let frame = [i16::MAX / 2; 64];
        let level = frame_level_db(&frame);
        assert!((level + 6.02).abs() < 0.1, "level was {level}");
    }

    #[test]
    fn gain_clamps() {
        let mut frame = [20_000i16, -20_000, 100];
        apply_gain(&mut frame, 2.0);
        assert_eq!(frame, [i16::MAX, i16::MIN, 200]);
        apply_gain(&mut frame, 4.0);
        assert_eq!(frame, [i16::MAX, i16::MIN, 800]);
    }

    #[test]
    fn db_round_trip() {
        for db in [-60.0f32, -20.0, -6.0, 0.0] {
            let amplitude = db_to_amplitude(db);
            assert!((amplitude_to_db(amplitude) - db).abs() < 0.001);
        }
    }
}
