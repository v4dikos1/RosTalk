//! Transmission gate: push-to-talk, voice activation and continuous mode.
//!
//! The gate runs after APM and before publishing (design 5.2). A closed gate
//! publishes silence rather than stopping the track: the LiveKit track and its
//! Opus stream stay alive, DTX removes the packets on the wire.

use serde::{Deserialize, Serialize};

use crate::frame::{FRAME_MS, FRAME_SAMPLES};

/// Length of the gain ramp when the gate opens or closes, in samples.
///
/// 240 samples is 5 ms at 48 kHz: an amplitude step of a whole frame over this
/// window is inaudible, while a shorter one starts to click (stage 2.3.2d).
const FADE_SAMPLES: f32 = 240.0;
/// Gain change per sample during the ramp.
const FADE_STEP: f32 = 1.0 / FADE_SAMPLES;

/// Speech probability below which voice activation does not open (stage 2.3.2e).
///
/// RNNoise returns 0..1 per 10 ms frame. Requiring 0.5 keeps a keyboard click
/// or a fan from opening the microphone even when it is loud enough for the
/// level threshold; once the gate is open the usual hold keeps word tails.
pub const VAD_THRESHOLD: f32 = 0.5;

/// How the microphone decides whether to transmit.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum GateMode {
    /// Always transmit (the gate is open).
    Continuous,
    /// Transmit while the push-to-talk key or mouse button is held.
    PushToTalk,
    /// Transmit while the level is above `threshold_db`, and for `hold_ms`
    /// after it falls below the release threshold.
    VoiceActivation {
        /// Opening threshold in dBFS, for example `-45.0`.
        threshold_db: f32,
        /// How long the gate stays open after the level drops, milliseconds.
        hold_ms: u32,
    },
}

impl Default for GateMode {
    fn default() -> Self {
        Self::VoiceActivation {
            threshold_db: -45.0,
            hold_ms: 300,
        }
    }
}

impl GateMode {
    /// Short stable name for logs and the UI.
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Self::Continuous => "continuous",
            Self::PushToTalk => "push-to-talk",
            Self::VoiceActivation { .. } => "voice-activation",
        }
    }
}

/// Frame-driven gate state machine.
///
/// One instance lives on the capture thread; [`Gate::update`] is called once
/// per 10 ms frame and performs no allocation.
#[derive(Debug, Default)]
pub struct Gate {
    open: bool,
    hold_remaining: u32,
    /// Current output gain, 0..1. Moves towards 1 while the gate is open and
    /// towards 0 while it is closed, [`FADE_STEP`] per sample.
    gain: f32,
}

impl Gate {
    /// New gate, closed until the first frame decides.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// True while the gate transmits.
    #[must_use]
    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Advances the gate by one frame.
    ///
    /// `push_to_talk` is the current state of the bound key or mouse button
    /// (ignored in the other modes); `level_db` is the level of the processed
    /// frame.
    pub fn update(&mut self, mode: GateMode, push_to_talk: bool, level_db: f32) -> bool {
        self.update_with_vad(mode, push_to_talk, level_db, None)
    }

    /// Advances the gate by one frame, with the optional RNNoise speech
    /// probability of the same frame.
    ///
    /// `vad` is `Some(0..1)` while RNNoise runs and `None` when it does not.
    /// Voice activation opens only when the level *and* the probability pass
    /// their thresholds, so an impulse or a fan does not open the microphone;
    /// without RNNoise the level alone decides, exactly as before stage
    /// 2.3.2e.
    pub fn update_with_vad(
        &mut self,
        mode: GateMode,
        push_to_talk: bool,
        level_db: f32,
        vad: Option<f32>,
    ) -> bool {
        match mode {
            GateMode::Continuous => self.open = true,
            GateMode::PushToTalk => self.open = push_to_talk,
            GateMode::VoiceActivation {
                threshold_db,
                hold_ms,
            } => {
                // 6 dB of hysteresis keeps a signal hovering at the threshold
                // from chattering on every frame (stage 2.3.2d).
                let release_db = threshold_db - 6.0;
                let hold_frames = hold_ms / FRAME_MS as u32;
                let speech = vad.is_none_or(|probability| probability >= VAD_THRESHOLD);
                if level_db >= threshold_db && speech {
                    self.open = true;
                    self.hold_remaining = hold_frames;
                } else if self.open {
                    if level_db >= release_db {
                        // Still inside the hysteresis band: refresh the hold.
                        self.hold_remaining = hold_frames;
                    } else if self.hold_remaining > 0 {
                        self.hold_remaining -= 1;
                    } else {
                        self.open = false;
                    }
                }
            }
        }
        self.open
    }

    /// Applies the gate to one frame in place, with a linear 5 ms ramp.
    ///
    /// A closed gate multiplies the frame by 0, an open one passes it through;
    /// the transition between the two is spread over [`FADE_SAMPLES`] samples
    /// so the output never steps from signal to silence or back
    /// (stage 2.3.2d).
    pub fn apply(&mut self, frame: &mut [i16; FRAME_SAMPLES]) {
        let target = if self.open { 1.0 } else { 0.0 };
        if self.gain == target {
            if target == 0.0 {
                frame.fill(0);
            }
            return;
        }
        for sample in frame.iter_mut() {
            if self.gain < target {
                self.gain = (self.gain + FADE_STEP).min(target);
            } else {
                self.gain = (self.gain - FADE_STEP).max(target);
            }
            *sample = (f32::from(*sample) * self.gain) as i16;
        }
    }

    /// Current output gain, for tests and diagnostics.
    #[must_use]
    pub fn gain(&self) -> f32 {
        self.gain
    }

    /// Forces the gate closed, for example when the user is muted.
    ///
    /// The output fades out through [`Gate::apply`]; this only changes the
    /// target, it does not truncate the signal.
    pub fn reset(&mut self) {
        self.open = false;
        self.hold_remaining = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuous_is_always_open() {
        let mut gate = Gate::new();
        assert!(gate.update(GateMode::Continuous, false, -90.0));
        assert!(gate.update(GateMode::Continuous, false, -90.0));
    }

    #[test]
    fn push_to_talk_follows_the_key() {
        let mut gate = Gate::new();
        assert!(!gate.update(GateMode::PushToTalk, false, 0.0));
        assert!(gate.update(GateMode::PushToTalk, true, -90.0));
        assert!(!gate.update(GateMode::PushToTalk, false, -90.0));
    }

    #[test]
    fn voice_activation_opens_at_the_threshold() {
        let mode = GateMode::VoiceActivation {
            threshold_db: -40.0,
            hold_ms: 50,
        };
        let mut gate = Gate::new();
        assert!(!gate.update(mode, false, -50.0));
        assert!(gate.update(mode, false, -39.0));
        assert!(gate.update(mode, false, -39.0));
    }

    #[test]
    fn voice_activation_holds_then_releases() {
        let mode = GateMode::VoiceActivation {
            threshold_db: -40.0,
            hold_ms: 50, // five frames
        };
        let mut gate = Gate::new();
        assert!(gate.update(mode, false, -30.0));
        // Well below the release threshold: five hold frames remain open.
        for _ in 0..5 {
            assert!(gate.update(mode, false, -60.0));
        }
        assert!(!gate.update(mode, false, -60.0));
    }

    #[test]
    fn hysteresis_does_not_chatter() {
        let mode = GateMode::VoiceActivation {
            threshold_db: -40.0,
            hold_ms: 0,
        };
        let mut gate = Gate::new();
        assert!(gate.update(mode, false, -39.0));
        // -41 is inside the 3 dB band below the threshold: still open.
        assert!(gate.update(mode, false, -41.0));
        assert!(!gate.update(mode, false, -50.0));
    }

    #[test]
    fn voice_activation_requires_the_vad_probability_to_open() {
        let mode = GateMode::VoiceActivation {
            threshold_db: -40.0,
            hold_ms: 50,
        };
        let mut gate = Gate::new();
        // A loud keyboard click: above the level threshold but not speech.
        assert!(!gate.update_with_vad(mode, false, -20.0, Some(0.1)));
        assert!(!gate.is_open());
        // The same level while RNNoise says "speech".
        assert!(gate.update_with_vad(mode, false, -20.0, Some(0.9)));
    }

    #[test]
    fn without_rnnoise_the_level_alone_opens_the_gate() {
        let mode = GateMode::VoiceActivation {
            threshold_db: -40.0,
            hold_ms: 50,
        };
        let mut gate = Gate::new();
        assert!(gate.update_with_vad(mode, false, -20.0, None));
    }

    #[test]
    fn a_low_vad_does_not_cut_an_open_word() {
        let mode = GateMode::VoiceActivation {
            threshold_db: -40.0,
            hold_ms: 50,
        };
        let mut gate = Gate::new();
        assert!(gate.update_with_vad(mode, false, -20.0, Some(0.9)));
        // A click during the word: the gate is open, so the hold and the
        // hysteresis, not the probability, decide when it closes.
        assert!(gate.update_with_vad(mode, false, -20.0, Some(0.0)));
    }

    #[test]
    fn reset_closes_the_gate() {
        let mut gate = Gate::new();
        assert!(gate.update(GateMode::Continuous, false, 0.0));
        gate.reset();
        assert!(!gate.is_open());
    }

    /// A 1 kHz sine at `-6 dBFS`, phase-continuous between frames.
    fn sine_frame(start: usize) -> [i16; FRAME_SAMPLES] {
        let mut frame = [0i16; FRAME_SAMPLES];
        for (index, sample) in frame.iter_mut().enumerate() {
            let phase = (start + index) as f32 / 48_000.0 * 1_000.0 * std::f32::consts::TAU;
            *sample = (phase.sin() * 0.5 * f32::from(i16::MAX)) as i16;
        }
        frame
    }

    fn max_step(samples: &[i16]) -> i32 {
        samples
            .windows(2)
            .map(|pair| (i32::from(pair[1]) - i32::from(pair[0])).abs())
            .max()
            .unwrap_or(0)
    }

    #[test]
    fn a_fade_in_and_out_do_not_step_harder_than_the_signal() {
        let mode = GateMode::VoiceActivation {
            threshold_db: -40.0,
            hold_ms: 0,
        };
        let mut gate = Gate::new();
        let mut input = Vec::new();
        let mut output = Vec::new();

        // Opening: five frames, the first one starts the 5 ms ramp.
        for frame_index in 0..5 {
            let frame = sine_frame(frame_index * FRAME_SAMPLES);
            input.extend_from_slice(&frame);
            let mut gated = frame;
            assert!(gate.update(mode, false, -20.0));
            gate.apply(&mut gated);
            output.extend_from_slice(&gated);
        }
        assert_eq!(gate.gain(), 1.0);

        // Closing: the ramp starts on the next frame.
        for frame_index in 5..10 {
            let frame = sine_frame(frame_index * FRAME_SAMPLES);
            input.extend_from_slice(&frame);
            let mut gated = frame;
            assert!(!gate.update(mode, false, -60.0));
            gate.apply(&mut gated);
            output.extend_from_slice(&gated);
        }
        assert_eq!(gate.gain(), 0.0);

        let signal_step = max_step(&input);
        let gated_step = max_step(&output);
        assert!(
            gated_step <= signal_step,
            "the fade stepped by {gated_step} while the sine steps by {signal_step}"
        );
    }

    #[test]
    fn reset_fades_out_instead_of_cutting_the_signal() {
        let mut gate = Gate::new();
        let mode = GateMode::VoiceActivation {
            threshold_db: -40.0,
            hold_ms: 0,
        };
        let mut gated = sine_frame(0);
        assert!(gate.update(mode, false, -20.0));
        gate.apply(&mut gated);
        assert_eq!(gate.gain(), 1.0);

        let input = sine_frame(FRAME_SAMPLES);
        gated = input;
        gate.reset();
        gate.apply(&mut gated);
        assert!(
            max_step(&gated) <= max_step(&input),
            "reset cut the signal instead of fading it"
        );
        assert!(gate.gain() < 0.1, "the ramp did not reach silence");
    }
}
