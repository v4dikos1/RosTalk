//! Stream audio capture: everything the computer plays except RosTalk itself
//! (stage P15, ADR 0027).
//!
//! On Windows the capture is a WASAPI process-loopback client activated in the
//! `EXCLUDE_TARGET_PROCESS_TREE` mode with the PID of this very process, so
//! the voices, event cues and stream players of RosTalk (the core and its
//! WebView2 child processes) never reach the stream. No other process is
//! opened or enumerated: the only PID involved is our own.
//!
//! The capture thread only copies the engine's packets into a lock-free ring;
//! the engine drains whole stereo 10 ms frames from it and publishes them as
//! the `screen_share_audio` track of the voice participant.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use ringbuf::traits::Split;
use ringbuf::{HeapCons, HeapRb};
use serde::{Deserialize, Serialize};

use crate::error::VoiceError;
use crate::frame::FRAME_SAMPLES;

#[cfg(windows)]
mod windows;

/// Stream audio is stereo: games and music keep their panorama for the
/// viewers whose tract can play it.
pub const STREAM_CHANNELS: usize = 2;

/// One interleaved 10 ms stereo frame at 48 kHz.
pub const STREAM_FRAME: usize = FRAME_SAMPLES * STREAM_CHANNELS;

/// Ring between the capture thread and the publisher: one second.
const STREAM_RING: usize = STREAM_FRAME * 100;

/// Whether this machine can capture the computer's audio without RosTalk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StreamAudioSupport {
    /// A process-loopback client could be activated and initialised.
    pub supported: bool,
    /// Token-free reason when it could not (old Windows, driver error).
    pub error: Option<String>,
}

/// Where the stream audio comes from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CaptureSource {
    /// The WASAPI process loopback (Windows).
    System,
    /// A generated stereo tone with its own 10 ms clock (`test-audio`).
    #[cfg(feature = "test-audio")]
    Tone(f32),
}

/// Shared flags of a running capture.
#[derive(Debug, Default)]
pub(crate) struct CaptureFlags {
    /// Set by the owner to end the capture thread.
    pub(crate) stop: AtomicBool,
    /// Set by the capture thread when the client failed mid-stream.
    pub(crate) failed: AtomicBool,
    /// Samples dropped because the ring was full.
    pub(crate) dropped: AtomicU64,
}

/// A running capture thread. Dropping it stops the thread.
pub struct StreamCapture {
    flags: Arc<CaptureFlags>,
    thread: Option<JoinHandle<()>>,
}

impl StreamCapture {
    /// Opens the capture and returns it with the consumer of interleaved
    /// stereo samples at 48 kHz.
    ///
    /// Blocks until the client is running or failed (at most a few seconds);
    /// call it outside the audio threads.
    pub fn start(source: CaptureSource) -> Result<(Self, HeapCons<i16>), VoiceError> {
        let (producer, consumer) = HeapRb::<i16>::new(STREAM_RING).split();
        let flags = Arc::new(CaptureFlags::default());
        let thread = match source {
            CaptureSource::System => start_system(producer, flags.clone())?,
            #[cfg(feature = "test-audio")]
            CaptureSource::Tone(frequency) => start_tone(producer, flags.clone(), frequency)?,
        };
        Ok((
            Self {
                flags,
                thread: Some(thread),
            },
            consumer,
        ))
    }

    /// True when the capture client failed after it started (device lost).
    #[must_use]
    pub fn failed(&self) -> bool {
        self.flags.failed.load(Ordering::Relaxed)
    }

    /// Samples dropped because the publisher fell behind.
    #[must_use]
    pub fn dropped(&self) -> u64 {
        self.flags.dropped.load(Ordering::Relaxed)
    }

    /// Stops the thread and releases the client.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.flags.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for StreamCapture {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Tries to activate and initialise a process-loopback client without
/// starting it. The result decides whether the UI offers the core capture or
/// the WebView fallback with the echo warning.
#[must_use]
pub fn probe(source: CaptureSource) -> StreamAudioSupport {
    let result = match source {
        CaptureSource::System => probe_system(),
        #[cfg(feature = "test-audio")]
        CaptureSource::Tone(_) => Ok(()),
    };
    match result {
        Ok(()) => StreamAudioSupport {
            supported: true,
            error: None,
        },
        Err(error) => StreamAudioSupport {
            supported: false,
            error: Some(error),
        },
    }
}

#[cfg(windows)]
fn start_system(
    producer: ringbuf::HeapProd<i16>,
    flags: Arc<CaptureFlags>,
) -> Result<JoinHandle<()>, VoiceError> {
    windows::start(producer, flags)
}

#[cfg(not(windows))]
fn start_system(
    _producer: ringbuf::HeapProd<i16>,
    _flags: Arc<CaptureFlags>,
) -> Result<JoinHandle<()>, VoiceError> {
    Err(VoiceError::Device(
        "capturing the computer audio needs Windows".to_owned(),
    ))
}

#[cfg(windows)]
fn probe_system() -> Result<(), String> {
    windows::probe()
}

#[cfg(not(windows))]
fn probe_system() -> Result<(), String> {
    Err("capturing the computer audio needs Windows".to_owned())
}

/// A stereo tone on its own 10 ms clock, standing in for the system capture in
/// tests. The right channel is the left one at half amplitude, so a test can
/// tell a stereo path from a duplicated mono one.
#[cfg(feature = "test-audio")]
fn start_tone(
    mut producer: ringbuf::HeapProd<i16>,
    flags: Arc<CaptureFlags>,
    frequency: f32,
) -> Result<JoinHandle<()>, VoiceError> {
    use ringbuf::traits::Producer;
    std::thread::Builder::new()
        .name("rostalk-stream-audio".to_owned())
        .spawn(move || {
            let scheduler = crate::scheduler::AudioScheduler::new();
            let _guard = scheduler.enter_audio_thread();
            let mut frame = [0i16; STREAM_FRAME];
            let mut phase = 0.0f32;
            let step = std::f32::consts::TAU * frequency / crate::frame::SAMPLE_RATE as f32;
            let mut next = std::time::Instant::now();
            while !flags.stop.load(Ordering::Relaxed) {
                crate::scheduler::pace(&mut next);
                for pair in frame.as_chunks_mut::<STREAM_CHANNELS>().0 {
                    let value = phase.sin() * 0.25 * f32::from(i16::MAX);
                    pair[0] = value as i16;
                    pair[1] = (value * 0.5) as i16;
                    phase = (phase + step) % std::f32::consts::TAU;
                }
                let written = producer.push_slice(&frame);
                if written < frame.len() {
                    flags
                        .dropped
                        .fetch_add((frame.len() - written) as u64, Ordering::Relaxed);
                }
            }
        })
        .map_err(|error| VoiceError::Internal(format!("start the stream audio thread: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stream_frame_is_ten_milliseconds_of_stereo() {
        assert_eq!(STREAM_FRAME, 960);
        assert_eq!(STREAM_RING % STREAM_FRAME, 0);
    }

    #[cfg(feature = "test-audio")]
    #[test]
    fn the_tone_source_fills_the_ring_with_whole_stereo_frames() {
        use ringbuf::traits::{Consumer, Observer};
        let (capture, mut consumer) =
            StreamCapture::start(CaptureSource::Tone(1_000.0)).expect("tone capture");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while consumer.occupied_len() < STREAM_FRAME * 5 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        capture.stop();
        let occupied = consumer.occupied_len();
        assert!(occupied >= STREAM_FRAME * 5, "only {occupied} samples");
        assert_eq!(occupied % STREAM_FRAME, 0, "a partial frame was written");
        let mut frame = [0i16; STREAM_FRAME];
        consumer.pop_slice(&mut frame);
        let left: i64 = frame
            .iter()
            .step_by(2)
            .map(|s| i64::from(s.unsigned_abs()))
            .sum();
        let right: i64 = frame
            .iter()
            .skip(1)
            .step_by(2)
            .map(|s| i64::from(s.unsigned_abs()))
            .sum();
        assert!(left > 0 && right > 0);
        assert!(
            right * 3 < left * 2,
            "the channels are not distinct: {left} vs {right}"
        );
    }
}
