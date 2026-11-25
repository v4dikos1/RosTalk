//! Stream audio in the core (stage P15, ADR 0027): the types reported to the
//! UI, the publisher of the captured computer audio and the helpers that map
//! remote `screen_share_audio` tracks to users and mixer keys.
//!
//! The streamer's core captures everything except RosTalk (see
//! [`crate::loopback`]) and publishes it from the voice participant. A viewer's
//! core subscribes to the `screen_share_audio` publications of the users it
//! watches — from any participant of that user, which also covers an older
//! client whose WebView participant publishes the system audio — and mixes
//! them into the same mixer as the voices, so the AEC reference contains them.

use std::borrow::Cow;

use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use ringbuf::traits::{Consumer, Observer};
use ringbuf::HeapCons;
use serde::{Deserialize, Serialize};

use crate::frame::{FRAME_SAMPLES, SAMPLE_RATE};
use crate::loopback::{STREAM_CHANNELS, STREAM_FRAME};

/// Opus bitrate of the published stream audio: stereo game or music audio.
pub const STREAM_AUDIO_BITRATE: u64 = 128_000;

/// Publisher poll: the same 3 ms as the microphone publisher (ADR 0013). The
/// capture thread sets the pace; the publisher only forwards whole frames.
pub(crate) const STREAM_PUBLISH_POLL: std::time::Duration = std::time::Duration::from_millis(3);

/// The ring may lag the capture by at most 200 ms before it is cut back.
const STREAM_MAX_BACKLOG: usize = STREAM_FRAME * 20;
/// What an emergency trim keeps: two frames.
const STREAM_KEEP_BACKLOG: usize = STREAM_FRAME * 2;

/// State of the own stream-audio capture.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum StreamCaptureState {
    /// No capture: not streaming, or streaming without computer audio.
    #[default]
    Off,
    /// The capture runs and the track is published.
    Live,
    /// The capture or the publication failed; see `error`.
    Failed,
}

/// Stream audio as seen by the UI: the own capture and the remote streams the
/// core can play.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StreamAudioState {
    /// Own capture.
    pub capture: StreamCaptureState,
    /// Token-free error of the own capture.
    pub error: Option<String>,
    /// Users in the room who publish stream audio, ascending.
    pub available: Vec<u64>,
    /// Users whose stream audio is subscribed and mixed, ascending.
    pub playing: Vec<u64>,
}

/// Control-plane user id of a media identity `<user id>:<kind>`.
///
/// Only the user part is read: which participant publishes the audio does not
/// matter, the track type comes from its source (design 4.7).
#[must_use]
pub fn user_id_of(identity: &str) -> Option<u64> {
    let (user, _kind) = identity.split_once(':')?;
    user.parse::<u64>().ok().filter(|id| *id > 0)
}

/// Mixer key of a remote stream-audio track. It must not collide with the
/// key of the same participant's microphone, which is the bare identity.
#[must_use]
pub fn mixer_key(identity: &str) -> String {
    format!("{identity}#screen_share_audio")
}

/// Per-stream playback gain 0..2 from the UI percent, with the local mute.
#[must_use]
pub fn stream_gain(percent: u16, muted: bool) -> (f32, bool) {
    (f32::from(percent.min(200)) / 100.0, muted)
}

/// Bounds the stream ring like the microphone publish ring: more than 200 ms
/// is cut to 20 ms. Returns how many samples were dropped.
pub(crate) fn trim_stream_backlog(consumer: &mut HeapCons<i16>) -> usize {
    let occupied = consumer.occupied_len();
    if occupied <= STREAM_MAX_BACKLOG {
        return 0;
    }
    // Keep whole stereo frames: drop down to the frame boundary.
    let drop = occupied - STREAM_KEEP_BACKLOG;
    let drop = drop - drop % STREAM_CHANNELS;
    consumer.skip(drop)
}

/// Pops one whole interleaved stereo frame, or nothing.
pub(crate) fn pop_stream_frame(
    consumer: &mut HeapCons<i16>,
    frame: &mut [i16; STREAM_FRAME],
) -> bool {
    if consumer.occupied_len() < STREAM_FRAME {
        return false;
    }
    consumer.pop_slice(frame) == STREAM_FRAME
}

/// Forwards captured stereo frames to the published native source until the
/// task is aborted. Runs on the engine runtime, not in an audio callback.
pub(crate) async fn stream_publisher_loop(mut consumer: HeapCons<i16>, source: NativeAudioSource) {
    let mut frame = [0i16; STREAM_FRAME];
    // Start from fresh audio, not from what queued during the publication.
    let _ = consumer.skip(consumer.occupied_len() - consumer.occupied_len() % STREAM_CHANNELS);
    loop {
        tokio::time::sleep(STREAM_PUBLISH_POLL).await;
        let dropped = trim_stream_backlog(&mut consumer);
        if dropped > 0 {
            log::debug!("stream audio backlog dropped {dropped} samples");
        }
        while pop_stream_frame(&mut consumer, &mut frame) {
            let audio = AudioFrame {
                data: Cow::Borrowed(&frame[..]),
                sample_rate: SAMPLE_RATE,
                num_channels: STREAM_CHANNELS as u32,
                samples_per_channel: FRAME_SAMPLES as u32,
            };
            if let Err(error) = source.capture_frame(&audio).await {
                log::debug!("stream audio capture_frame failed: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ringbuf::traits::{Producer, Split};
    use ringbuf::HeapRb;

    #[test]
    fn the_user_comes_from_the_identity_prefix() {
        assert_eq!(user_id_of("12:voice"), Some(12));
        assert_eq!(user_id_of("12:stream"), Some(12));
        assert_eq!(user_id_of("0:voice"), None);
        assert_eq!(user_id_of("voice"), None);
        assert_eq!(user_id_of("x:voice"), None);
    }

    #[test]
    fn the_mixer_key_never_equals_the_microphone_key() {
        assert_ne!(mixer_key("7:voice"), "7:voice");
        assert_eq!(mixer_key("7:voice"), "7:voice#screen_share_audio");
    }

    #[test]
    fn the_gain_covers_zero_to_two_hundred_percent() {
        assert_eq!(stream_gain(0, false), (0.0, false));
        assert_eq!(stream_gain(150, false), (1.5, false));
        assert_eq!(stream_gain(200, true), (2.0, true));
        assert_eq!(stream_gain(900, false), (2.0, false));
    }

    #[test]
    fn only_whole_stereo_frames_are_popped() {
        let (mut producer, mut consumer) = HeapRb::<i16>::new(STREAM_FRAME * 4).split();
        let mut frame = [0i16; STREAM_FRAME];
        producer.push_slice(&[1i16; STREAM_FRAME - 2]);
        assert!(!pop_stream_frame(&mut consumer, &mut frame));
        producer.push_slice(&[2i16; 2]);
        assert!(pop_stream_frame(&mut consumer, &mut frame));
        assert_eq!(frame[0], 1);
        assert_eq!(frame[STREAM_FRAME - 1], 2);
        assert_eq!(consumer.occupied_len(), 0);
    }

    #[test]
    fn a_stalled_publisher_keeps_twenty_milliseconds_of_whole_frames() {
        let (mut producer, mut consumer) = HeapRb::<i16>::new(STREAM_FRAME * 40).split();
        producer.push_slice(&vec![0i16; STREAM_FRAME * 30]);
        let dropped = trim_stream_backlog(&mut consumer);
        assert_eq!(dropped, STREAM_FRAME * 28);
        assert_eq!(consumer.occupied_len(), STREAM_KEEP_BACKLOG);
        assert_eq!(trim_stream_backlog(&mut consumer), 0);
    }

    #[test]
    fn a_backlog_below_the_limit_is_kept() {
        let (mut producer, mut consumer) = HeapRb::<i16>::new(STREAM_FRAME * 40).split();
        producer.push_slice(&vec![0i16; STREAM_FRAME * 20]);
        assert_eq!(trim_stream_backlog(&mut consumer), 0);
        assert_eq!(consumer.occupied_len(), STREAM_FRAME * 20);
    }
}
