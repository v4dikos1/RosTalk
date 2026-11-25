//! Loudness levelling of one remote voice (stage P17, ADR 0029).
//!
//! Friends talk into microphones with very different gain. The leveler brings
//! every incoming track to about the same speech level before the per-user
//! volume and the mixer, so one quiet and one loud participant can share a
//! single master slider.
//!
//! It is deliberately slow and small:
//!
//! 1. A 10 ms frame above [`ACTIVE_FLOOR_DB`] updates a smoothed speech level
//!    (RMS in dB, attack 0.5 s, release 2.5 s). Pauses and noise never move
//!    the estimate, so the leveler does not pump the room tone up between
//!    sentences.
//! 2. The wanted gain is `TARGET_DB - level`, clamped to
//!    [`MIN_GAIN_DB`]..[`MAX_GAIN_DB`], and the applied gain follows it with a
//!    slew limit: up at 3 dB/s, down at 10 dB/s.
//! 3. A peak limiter caps every frame at [`CEILING`] (-1 dBFS): the gain of a
//!    frame is lowered instantly when the peak would cross it and recovers
//!    over about 0.2 s. The gain is ramped sample by sample across the frame,
//!    so a gain change is never a step.
//!
//! The state is a handful of floats: processing allocates nothing, takes no
//! lock and logs nothing, so it is safe for the playback thread.

use crate::frame::{db_to_amplitude, frame_level_db, SILENCE_DB};

/// Speech level the leveler aims for, in dBFS RMS.
pub const TARGET_DB: f32 = -22.0;
/// Frames quieter than this do not update the speech level (room tone, pauses).
pub const ACTIVE_FLOOR_DB: f32 = -50.0;
/// Largest cut: a shouting participant is lowered by at most this much.
pub const MIN_GAIN_DB: f32 = -12.0;
/// Largest boost: a quiet microphone is raised by at most this much.
pub const MAX_GAIN_DB: f32 = 12.0;
/// Peak ceiling after the gain: -1 dBFS in the 0..1 scale.
pub const CEILING: f32 = 0.891_25;

/// Per-frame smoothing of the level when speech gets louder: about 0.5 s.
const LEVEL_ATTACK: f32 = 0.02;
/// Per-frame smoothing of the level when speech gets quieter: about 2.5 s.
const LEVEL_RELEASE: f32 = 0.004;
/// Gain increase per 10 ms frame: 3 dB/s.
const SLEW_UP_DB: f32 = 0.03;
/// Gain decrease per 10 ms frame: 10 dB/s.
const SLEW_DOWN_DB: f32 = 0.1;
/// Return to unity when the feature is switched off: 30 dB/s, still no click
/// because the ramp inside the frame is linear.
const SLEW_OFF_DB: f32 = 0.3;
/// Samples over which the limiter brings the gain down: 1 ms at 48 kHz.
const LIMITER_RAMP: usize = 48;
/// Limiter recovery per frame: the held reduction closes by this share.
const LIMITER_RELEASE: f32 = 0.05;

/// Level estimator, slew-limited gain and peak limiter for one track.
#[derive(Debug, Clone)]
pub struct Leveler {
    /// Smoothed speech level in dBFS; `None` until the first active frame.
    level_db: Option<f32>,
    /// Gain in dB applied at the end of the previous frame (the smooth part).
    gain_db: f32,
    /// Linear limiter reduction in 0..=1 that recovers towards 1.
    limiter: f32,
    /// Linear gain applied at the end of the previous frame.
    previous: f32,
}

impl Default for Leveler {
    fn default() -> Self {
        Self::new()
    }
}

impl Leveler {
    /// A leveler at unity gain.
    #[must_use]
    pub fn new() -> Self {
        Self {
            level_db: None,
            gain_db: 0.0,
            limiter: 1.0,
            previous: 1.0,
        }
    }

    /// Smooth gain currently applied, in dB (limiter not included).
    #[must_use]
    pub fn gain_db(&self) -> f32 {
        self.gain_db
    }

    /// Smoothed speech level in dBFS, `None` before any speech.
    #[must_use]
    pub fn level_db(&self) -> Option<f32> {
        self.level_db
    }

    /// True when the frame would pass through unchanged: switched off and back
    /// at unity, so the caller can skip the pass altogether.
    #[must_use]
    pub fn is_idle(&self, enabled: bool) -> bool {
        !enabled && self.gain_db == 0.0 && self.limiter >= 1.0 && self.previous == 1.0
    }

    /// Levels one frame in place. With `enabled == false` the gain returns to
    /// unity at [`SLEW_OFF_DB`] instead of jumping.
    pub fn process(&mut self, frame: &mut [i16], enabled: bool) {
        if frame.is_empty() {
            return;
        }
        if enabled {
            self.track_level(frame);
        }
        let wanted = if enabled {
            self.level_db.map_or(0.0, |level| {
                (TARGET_DB - level).clamp(MIN_GAIN_DB, MAX_GAIN_DB)
            })
        } else {
            0.0
        };
        let step = if !enabled {
            SLEW_OFF_DB
        } else if wanted > self.gain_db {
            SLEW_UP_DB
        } else {
            SLEW_DOWN_DB
        };
        self.gain_db += (wanted - self.gain_db).clamp(-step, step);
        if (self.gain_db - wanted).abs() < 1e-4 {
            self.gain_db = wanted;
        }
        let mut gain = db_to_amplitude(self.gain_db);

        // Peak limiter: the reduction is instant, the release is gradual.
        self.limiter += (1.0 - self.limiter) * LIMITER_RELEASE;
        if self.limiter > 0.9999 {
            self.limiter = 1.0;
        }
        let peak = frame
            .iter()
            .map(|sample| f32::from(sample.unsigned_abs()) / 32_768.0)
            .fold(0.0f32, f32::max);
        let mut ramp = frame.len();
        if peak * gain * self.limiter > CEILING {
            self.limiter = CEILING / (peak * gain);
            // A burst after a boosted quiet voice: come down within about a
            // millisecond instead of across the whole frame.
            ramp = ramp.min(LIMITER_RAMP);
        }
        gain *= self.limiter;

        // Linear ramp from the previous frame's gain to this one; the ceiling
        // also clamps the few samples of a fast ramp that are still ahead of
        // the new gain, so no sample ever crosses it.
        let start = self.previous;
        let delta = (gain - start) / ramp as f32;
        let ceiling = (CEILING * 32_768.0).floor();
        let mut current = start;
        for (index, sample) in frame.iter_mut().enumerate() {
            if index < ramp {
                current += delta;
            } else {
                current = gain;
            }
            let value = f32::from(*sample) * current;
            *sample = value.round().clamp(-ceiling, ceiling) as i16;
        }
        self.previous = gain;
    }

    fn track_level(&mut self, frame: &[i16]) {
        let frame_db = frame_level_db(frame);
        if frame_db <= SILENCE_DB || frame_db < ACTIVE_FLOOR_DB {
            return;
        }
        self.level_db = Some(match self.level_db {
            None => frame_db,
            Some(level) => {
                let coefficient = if frame_db > level {
                    LEVEL_ATTACK
                } else {
                    LEVEL_RELEASE
                };
                level + coefficient * (frame_db - level)
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::FRAME_SAMPLES;

    /// A 440 Hz tone with the given RMS in dBFS, as a frame generator.
    struct Tone {
        phase: f32,
        amplitude: f32,
    }

    impl Tone {
        fn new(rms_db: f32) -> Self {
            Self {
                phase: 0.0,
                // RMS of a sine is the peak divided by sqrt(2).
                amplitude: db_to_amplitude(rms_db) * std::f32::consts::SQRT_2,
            }
        }

        fn frame(&mut self) -> [i16; FRAME_SAMPLES] {
            let mut frame = [0i16; FRAME_SAMPLES];
            for sample in &mut frame {
                *sample = (self.phase.sin() * self.amplitude * 32_767.0) as i16;
                self.phase += 2.0 * std::f32::consts::PI * 440.0 / 48_000.0;
            }
            frame
        }
    }

    fn run(leveler: &mut Leveler, tone: &mut Tone, frames: usize, enabled: bool) -> f32 {
        let mut last = SILENCE_DB;
        for _ in 0..frames {
            let mut frame = tone.frame();
            leveler.process(&mut frame, enabled);
            last = frame_level_db(&frame);
        }
        last
    }

    #[test]
    fn a_quiet_voice_is_raised_towards_the_target_slowly() {
        let mut leveler = Leveler::new();
        let mut tone = Tone::new(-34.0);
        // After one second the gain has risen by at most the slew (3 dB).
        let after_1s = run(&mut leveler, &mut tone, 100, true);
        assert!(
            after_1s - -34.0 <= 3.5,
            "the boost was too fast: {after_1s}"
        );
        assert!(after_1s > -34.0 + 1.0, "no boost after 1 s: {after_1s}");
        // After ten seconds it sits within a dB of the target (12 dB wanted).
        let settled = run(&mut leveler, &mut tone, 1_000, true);
        assert!((settled - TARGET_DB).abs() < 1.0, "settled at {settled}");
    }

    #[test]
    fn a_loud_voice_is_lowered() {
        let mut leveler = Leveler::new();
        let mut tone = Tone::new(-12.0);
        let settled = run(&mut leveler, &mut tone, 1_500, true);
        assert!((settled - TARGET_DB).abs() < 1.0, "settled at {settled}");
        assert!(leveler.gain_db() <= -9.0);
    }

    #[test]
    fn the_gain_is_clamped_in_both_directions() {
        let mut quiet = Leveler::new();
        let mut tone = Tone::new(-48.0);
        run(&mut quiet, &mut tone, 3_000, true);
        assert!((quiet.gain_db() - MAX_GAIN_DB).abs() < 0.01);

        let mut loud = Leveler::new();
        let mut tone = Tone::new(-3.0);
        run(&mut loud, &mut tone, 3_000, true);
        assert!((loud.gain_db() - MIN_GAIN_DB).abs() < 0.01);
    }

    #[test]
    fn room_tone_below_the_floor_is_never_boosted() {
        let mut leveler = Leveler::new();
        let mut tone = Tone::new(-62.0);
        let level = run(&mut leveler, &mut tone, 2_000, true);
        assert_eq!(leveler.gain_db(), 0.0);
        assert_eq!(leveler.level_db(), None);
        assert!((level - -62.0).abs() < 1.0, "room tone changed: {level}");
    }

    #[test]
    fn pauses_hold_the_gain_instead_of_pumping_it() {
        let mut leveler = Leveler::new();
        let mut tone = Tone::new(-34.0);
        run(&mut leveler, &mut tone, 1_500, true);
        let before = leveler.gain_db();
        assert!(before > 8.0);
        let mut silence = Tone::new(-70.0);
        run(&mut leveler, &mut silence, 500, true);
        assert!((leveler.gain_db() - before).abs() < 0.01);
    }

    #[test]
    fn the_limiter_never_lets_a_peak_above_the_ceiling() {
        let mut leveler = Leveler::new();
        // Settle the gain at +12 dB on a quiet voice, then hit it with a burst.
        let mut quiet = Tone::new(-40.0);
        run(&mut leveler, &mut quiet, 3_000, true);
        let mut loud = Tone::new(-4.0);
        let limit = (CEILING * 32_768.0) as i32 + 2;
        for _ in 0..50 {
            let mut frame = loud.frame();
            leveler.process(&mut frame, true);
            let peak = frame
                .iter()
                .map(|sample| i32::from(*sample).abs())
                .max()
                .unwrap_or(0);
            assert!(peak <= limit, "peak {peak} above the ceiling {limit}");
        }
    }

    #[test]
    fn the_gain_has_no_step_inside_or_between_frames() {
        let mut leveler = Leveler::new();
        let mut tone = Tone::new(-34.0);
        let mut previous = 0i32;
        let mut worst = 0i32;
        for _ in 0..600 {
            let mut frame = tone.frame();
            leveler.process(&mut frame, true);
            for sample in frame {
                worst = worst.max((i32::from(sample) - previous).abs());
                previous = i32::from(sample);
            }
        }
        // A 440 Hz tone at about -22 dBFS RMS moves at most ~250 per sample at
        // 48 kHz; a gain step would add far more than that.
        assert!(worst < 600, "largest step between samples was {worst}");
    }

    #[test]
    fn switching_off_returns_to_unity_without_a_jump() {
        let mut leveler = Leveler::new();
        let mut tone = Tone::new(-34.0);
        run(&mut leveler, &mut tone, 1_500, true);
        assert!(leveler.gain_db() > 8.0);
        // The last processed sample of the leveled stream is the reference.
        let mut warm = tone.frame();
        leveler.process(&mut warm, true);
        let mut previous = i32::from(warm[479]);
        let mut worst = 0i32;
        let mut frames = 0;
        while !leveler.is_idle(false) {
            let mut frame = tone.frame();
            leveler.process(&mut frame, false);
            for sample in frame {
                worst = worst.max((i32::from(sample) - previous).abs());
                previous = i32::from(sample);
            }
            frames += 1;
            assert!(frames < 500, "never returned to unity");
        }
        assert!(worst < 600, "largest step while switching off: {worst}");
        // Idle means a bit-exact pass-through.
        let mut frame = tone.frame();
        let before = frame;
        leveler.process(&mut frame, false);
        assert_eq!(frame, before);
    }

    #[test]
    fn two_voices_end_up_within_two_decibels() {
        let mut quiet = Leveler::new();
        let mut loud = Leveler::new();
        let mut a = Tone::new(-36.0);
        let mut b = Tone::new(-14.0);
        let a_out = run(&mut quiet, &mut a, 3_000, true);
        let b_out = run(&mut loud, &mut b, 3_000, true);
        assert!(
            (a_out - b_out).abs() < 2.0,
            "quiet {a_out:.1} dB, loud {b_out:.1} dB"
        );
    }
}
