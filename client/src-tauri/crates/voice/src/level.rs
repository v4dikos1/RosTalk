//! Level metering and the per-participant "speaking" flag.
//!
//! The UI receives these values at most ten times per second; the smoothing
//! and the hold window make the indicator readable instead of flickering.

use crate::frame::{frame_level_db, FRAME_MS, SILENCE_DB};

/// Smoothing of the meter: fast attack, slower release.
#[derive(Debug, Clone)]
pub struct LevelSmoother {
    value_db: f32,
    attack: f32,
    release: f32,
}

impl Default for LevelSmoother {
    fn default() -> Self {
        Self::new(0.55, 0.15)
    }
}

impl LevelSmoother {
    /// Creates a smoother with the given per-frame coefficients (0..1).
    #[must_use]
    pub fn new(attack: f32, release: f32) -> Self {
        Self {
            value_db: SILENCE_DB,
            attack: attack.clamp(0.0, 1.0),
            release: release.clamp(0.0, 1.0),
        }
    }

    /// Feeds one frame and returns the smoothed level in dBFS.
    pub fn update_frame(&mut self, frame: &[i16]) -> f32 {
        self.update(frame_level_db(frame))
    }

    /// Feeds a precomputed level.
    pub fn update(&mut self, level_db: f32) -> f32 {
        let coefficient = if level_db > self.value_db {
            self.attack
        } else {
            self.release
        };
        if level_db <= SILENCE_DB && self.value_db <= SILENCE_DB {
            self.value_db = SILENCE_DB;
        } else {
            let linear_current = db_to_linear(self.value_db);
            let linear_next = db_to_linear(level_db);
            let mixed = linear_current + coefficient * (linear_next - linear_current);
            self.value_db = linear_to_db(mixed);
        }
        self.value_db
    }

    /// Current smoothed level.
    #[must_use]
    pub fn value_db(&self) -> f32 {
        self.value_db
    }
}

/// Hysteresis detector: opens at `threshold_db`, stays open for `hold_ms`.
#[derive(Debug, Clone)]
pub struct SpeakingDetector {
    threshold_db: f32,
    release_db: f32,
    hold_frames: u32,
    remaining: u32,
    speaking: bool,
}

impl Default for SpeakingDetector {
    fn default() -> Self {
        Self::new(-45.0, 300)
    }
}

impl SpeakingDetector {
    /// Creates a detector.
    #[must_use]
    pub fn new(threshold_db: f32, hold_ms: u32) -> Self {
        Self {
            threshold_db,
            release_db: threshold_db - 4.0,
            hold_frames: hold_ms / FRAME_MS as u32,
            remaining: 0,
            speaking: false,
        }
    }

    /// Feeds one level and returns the current speaking state.
    pub fn update(&mut self, level_db: f32) -> bool {
        if level_db >= self.threshold_db {
            self.speaking = true;
            self.remaining = self.hold_frames;
        } else if self.speaking {
            if level_db >= self.release_db {
                self.remaining = self.hold_frames;
            } else if self.remaining > 0 {
                self.remaining -= 1;
            } else {
                self.speaking = false;
            }
        }
        self.speaking
    }

    /// Current state.
    #[must_use]
    pub fn is_speaking(&self) -> bool {
        self.speaking
    }

    /// Clears the state when a track disappears.
    pub fn reset(&mut self) {
        self.speaking = false;
        self.remaining = 0;
    }
}

fn db_to_linear(db: f32) -> f32 {
    if db <= SILENCE_DB {
        0.0
    } else {
        10f32.powf(db / 20.0)
    }
}

fn linear_to_db(value: f32) -> f32 {
    if value <= 1e-9 {
        SILENCE_DB
    } else {
        20.0 * value.log10()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(amplitude: f32) -> [i16; 480] {
        let mut frame = [0i16; 480];
        for (index, sample) in frame.iter_mut().enumerate() {
            let phase = index as f32 / 48_000.0 * 1_000.0 * std::f32::consts::TAU;
            *sample = (phase.sin() * amplitude * f32::from(i16::MAX)) as i16;
        }
        frame
    }

    #[test]
    fn smoother_follows_a_loud_frame_quickly() {
        let mut smoother = LevelSmoother::default();
        let mut level = SILENCE_DB;
        for _ in 0..3 {
            level = smoother.update_frame(&tone(0.5));
        }
        assert!(level > -12.0, "level was {level}");
    }

    #[test]
    fn smoother_releases_slower_than_it_attacks() {
        let mut fast = LevelSmoother::new(1.0, 1.0);
        let mut slow = LevelSmoother::new(1.0, 0.1);
        fast.update(-6.0);
        slow.update(-6.0);
        fast.update(SILENCE_DB);
        slow.update(SILENCE_DB);
        assert!(fast.value_db() < slow.value_db());
    }

    #[test]
    fn silence_stays_at_the_floor() {
        let mut smoother = LevelSmoother::default();
        for _ in 0..10 {
            smoother.update(SILENCE_DB);
        }
        assert_eq!(smoother.value_db(), SILENCE_DB);
    }

    #[test]
    fn speaking_opens_and_holds() {
        let mut detector = SpeakingDetector::new(-40.0, 50); // 5 frames
        assert!(detector.update(-30.0));
        for _ in 0..5 {
            assert!(detector.update(-60.0));
        }
        assert!(!detector.update(-60.0));
    }

    #[test]
    fn speaking_ignores_a_single_quiet_frame() {
        let mut detector = SpeakingDetector::default();
        assert!(detector.update(-20.0));
        assert!(detector.update(SILENCE_DB));
        assert!(detector.is_speaking());
    }

    #[test]
    fn reset_clears_the_flag() {
        let mut detector = SpeakingDetector::default();
        detector.update(0.0);
        detector.reset();
        assert!(!detector.is_speaking());
    }
}
