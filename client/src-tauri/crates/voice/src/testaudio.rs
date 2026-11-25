//! File-backed audio for integration tests (`test-audio` feature).
//!
//! The microphone is replaced by a WAV file or a generated sine, the speakers
//! by a WAV recorder. The rest of the pipeline (resampler, APM, gate, publish,
//! mixer) is exactly the production one. A file at a device rate other than
//! 48 kHz goes through the same [`crate::resample::Resampler`] as a real
//! device, so capture resampling is covered by the file loop too.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ringbuf::traits::Consumer;
use ringbuf::{HeapCons, HeapProd};

use crate::error::VoiceError;
use crate::frame::{FRAME_SAMPLES, SAMPLE_RATE};
use crate::resample::Resampler;

/// A generated or recorded input signal.
pub struct TestSource {
    tone: Option<ToneGenerator>,
    reader: Option<hound::WavReader<BufReader<File>>>,
    /// Converts a non-48 kHz file to the pipeline rate, like a real device.
    resampler: Option<Resampler>,
    /// Input samples consumed per 10 ms frame.
    per_frame: usize,
    /// The file has no more samples (and the resampler is drained).
    exhausted: bool,
}

struct ToneGenerator {
    frequency: f32,
    phase: f32,
}

impl TestSource {
    /// Opens a WAV file or starts a tone.
    pub fn open(tone_hz: Option<f32>, path: Option<&Path>) -> Result<Self, VoiceError> {
        let reader = match path {
            Some(path) => {
                let reader = hound::WavReader::open(path).map_err(|error| {
                    VoiceError::TestAudio(format!("open {}: {error}", path.display()))
                })?;
                let spec = reader.spec();
                if spec.channels != 1
                    || spec.bits_per_sample != 16
                    || spec.sample_format != hound::SampleFormat::Int
                    || spec.sample_rate == 0
                {
                    return Err(VoiceError::TestAudio(format!(
                        "{} must be mono 16-bit PCM, got {} Hz {} ch {}-bit {:?}",
                        path.display(),
                        spec.sample_rate,
                        spec.channels,
                        spec.bits_per_sample,
                        spec.sample_format
                    )));
                }
                Some(reader)
            }
            None => None,
        };
        let resampler = reader
            .as_ref()
            .filter(|reader| reader.spec().sample_rate != SAMPLE_RATE)
            .map(|reader| Resampler::new(reader.spec().sample_rate));
        let per_frame = resampler
            .as_ref()
            .map_or(FRAME_SAMPLES, |resampler| {
                (resampler.input_rate() / 100) as usize
            })
            .max(1);
        let tone = tone_hz.map(|frequency| ToneGenerator {
            frequency,
            phase: 0.0,
        });
        if reader.is_none() && tone.is_none() {
            return Err(VoiceError::TestAudio(
                "the test source needs a WAV file or a tone".to_owned(),
            ));
        }
        Ok(Self {
            tone,
            reader,
            resampler,
            per_frame,
            exhausted: false,
        })
    }

    /// True once the file has been fully consumed.
    ///
    /// Only the unit tests below need it: the pipeline infers exhaustion from
    /// `next_frame` returning false. Gated so the library build stays free of
    /// dead code (`cargo clippy --all-features -D warnings`).
    #[cfg(test)]
    #[must_use]
    pub fn is_exhausted(&self) -> bool {
        self.exhausted
    }

    /// Fills one 10 ms frame. Returns false only when the file is exhausted;
    /// the remainder of a short frame (for example the first frame of a
    /// resampled file, which waits for the filter's lookahead) is silence.
    pub fn next_frame(&mut self, out: &mut [i16; FRAME_SAMPLES]) -> bool {
        if let Some(tone) = self.tone.as_mut() {
            // -12 dBFS: loud enough to open a voice-activation gate, quiet
            // enough not to clip after APM gain.
            let gain = 0.25 * f32::from(i16::MAX);
            for sample in out.iter_mut() {
                *sample = (tone.phase * std::f32::consts::TAU)
                    .sin()
                    .mul_add(gain, 0.0) as i16;
                tone.phase = (tone.phase + tone.frequency / SAMPLE_RATE as f32).fract();
            }
            return true;
        }
        let Some(reader) = self.reader.as_mut() else {
            out.fill(0);
            return false;
        };
        if self.exhausted {
            out.fill(0);
            return false;
        }
        let mut readable = [0.0f32; FRAME_SAMPLES];
        let mut written = 0;
        let mut read = 0usize;
        for sample in reader.samples::<i16>().take(self.per_frame) {
            match sample {
                Ok(value) => {
                    read += 1;
                    if let Some(resampler) = self.resampler.as_mut() {
                        resampler.push(f32::from(value) / f32::from(i16::MAX));
                    } else if written < readable.len() {
                        readable[written] = f32::from(value) / f32::from(i16::MAX);
                        written += 1;
                    }
                }
                Err(_) => {
                    // This runs on the capture or fake-device thread: no log.
                    // A corrupt file is treated as exhausted; tests surface it
                    // through the audio they receive, not through stderr.
                    self.exhausted = true;
                    break;
                }
            }
        }
        if let Some(resampler) = self.resampler.as_mut() {
            written = resampler.produce(&mut readable);
        }
        if read == 0 {
            // The file ended. The resampler may still hold its lookahead
            // history, which can never become output without more input.
            self.exhausted = true;
        }
        for (index, sample) in out.iter_mut().enumerate() {
            *sample = if index < written {
                (readable[index].clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16
            } else {
                0
            };
        }
        !self.exhausted
    }
}

/// Writes the playback mix to a 48 kHz mono 16-bit WAV file.
pub struct TestSink {
    writer: Option<hound::WavWriter<std::io::BufWriter<File>>>,
}

impl TestSink {
    /// Creates the recording file.
    pub fn create(path: &Path) -> Result<Self, VoiceError> {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let writer = hound::WavWriter::create(path, spec).map_err(|error| {
            VoiceError::TestAudio(format!("create {}: {error}", path.display()))
        })?;
        Ok(Self {
            writer: Some(writer),
        })
    }

    /// Appends one frame.
    pub fn write(&mut self, frame: &[i16]) {
        let Some(writer) = self.writer.as_mut() else {
            return;
        };
        for sample in frame {
            // Playback thread: stop recording on the first failure without
            // logging or formatting here.
            if writer.write_sample(*sample).is_err() {
                self.writer = None;
                return;
            }
        }
    }

    /// Finalizes the WAV header.
    pub fn finish(mut self) {
        if let Some(writer) = self.writer.take() {
            // Called from the playback thread when it exits: no logging here.
            let _ = writer.finalize();
        }
    }
}

/// Clock of a simulated device (stage 2.3.2a).
///
/// The pipeline believes the device runs at 48 kHz; [`FakeClock::rate_hz`] is
/// the real crystal rate. `47_995.0` is a microphone 0.01 % slow, `48_005.0` a
/// speaker 0.01 % fast — the drift the pipeline has to absorb.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FakeClock {
    /// Real sample rate of the device clock, Hz.
    pub rate_hz: f64,
    /// Samples per device callback: 441, 480 or 512 in the regression tests.
    pub chunk: usize,
    /// Uniform callback delay in `0..=jitter_ms` milliseconds.
    pub jitter_ms: u32,
}

impl Default for FakeClock {
    fn default() -> Self {
        Self {
            rate_hz: f64::from(SAMPLE_RATE),
            chunk: FRAME_SAMPLES,
            jitter_ms: 0,
        }
    }
}

/// Deterministic jitter source; a fixed seed keeps the tests reproducible.
struct Jitter {
    state: u64,
}

impl Jitter {
    fn new(seed: u64) -> Self {
        Self { state: seed | 1 }
    }

    /// Uniform delay in `0..bound_us` microseconds.
    fn next_us(&mut self, bound_us: u64) -> u64 {
        if bound_us == 0 {
            return 0;
        }
        self.state ^= self.state << 13;
        self.state ^= self.state >> 7;
        self.state ^= self.state << 17;
        self.state % bound_us
    }
}

/// Sleeps until `deadline`; a long stall drops the missed deadlines instead of
/// bursting a backlog, like the real capture path.
fn sleep_until(deadline: Instant, next: &mut Instant) {
    let now = Instant::now();
    if deadline > now {
        std::thread::sleep(deadline - now);
    } else if now.duration_since(deadline) > Duration::from_millis(200) {
        *next = now;
    }
}

/// A simulated capture device: it pushes a [`TestSource`] into the very same
/// input ring as the cpal callback, but paced by its own clock.
///
/// The signal comes from the regular `tone_hz`/`input_wav` fields, so the
/// content and the clock are configured separately. The chunks are exact: the
/// device never invents or drops a sample, only the timing differs.
pub struct FakeDevice {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl FakeDevice {
    /// Starts the simulated device thread.
    pub fn start(
        clock: FakeClock,
        mut source: TestSource,
        mut sink: HeapProd<f32>,
        _errors: Arc<crate::devices::StreamErrorState>,
        overflows: Arc<AtomicU64>,
    ) -> Result<Self, VoiceError> {
        let chunk = clock.chunk.max(1);
        let rate = if clock.rate_hz.is_finite() && clock.rate_hz > 1.0 {
            clock.rate_hz
        } else {
            return Err(VoiceError::TestAudio(format!(
                "fake device rate must be positive, got {}",
                clock.rate_hz
            )));
        };
        let period = Duration::from_secs_f64(chunk as f64 / rate);
        let jitter_bound_us = u64::from(clock.jitter_ms) * 1_000;
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread = std::thread::Builder::new()
            .name("rostalk-fake-input".to_owned())
            .spawn(move || {
                let mut holding = [0i16; FRAME_SAMPLES];
                let mut left = 0usize;
                let mut jitter = Jitter::new(0x5EED_1234);
                let mut next = Instant::now();
                while !thread_stop.load(Ordering::Relaxed) {
                    for _ in 0..chunk {
                        if left == 0 {
                            // An exhausted file plays silence: the device is
                            // still plugged in, unlike the file source.
                            let _ = source.next_frame(&mut holding);
                            left = FRAME_SAMPLES;
                        }
                        left -= 1;
                        let value =
                            f32::from(holding[FRAME_SAMPLES - 1 - left]) / f32::from(i16::MAX);
                        crate::devices::push_input(&mut sink, value, &overflows);
                    }
                    next += period;
                    let wake = next + Duration::from_micros(jitter.next_us(jitter_bound_us));
                    sleep_until(wake, &mut next);
                }
            })
            .map_err(|error| VoiceError::TestAudio(format!("start fake device: {error}")))?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for FakeDevice {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// A simulated playback device: it pulls from the output ring at its own
/// clock, counts an underrun for every missing sample and records the WAV.
pub struct FakeOutput {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl FakeOutput {
    /// Starts the simulated output thread. `path` receives the played mix.
    pub fn start(
        clock: FakeClock,
        mut source: HeapCons<f32>,
        path: Option<&Path>,
        drops: Arc<AtomicU64>,
    ) -> Result<Self, VoiceError> {
        let chunk = clock.chunk.max(1);
        let rate = if clock.rate_hz.is_finite() && clock.rate_hz > 1.0 {
            clock.rate_hz
        } else {
            return Err(VoiceError::TestAudio(format!(
                "fake output rate must be positive, got {}",
                clock.rate_hz
            )));
        };
        let period = Duration::from_secs_f64(chunk as f64 / rate);
        let jitter_bound_us = u64::from(clock.jitter_ms) * 1_000;
        let mut writer = match path {
            Some(path) => Some(wav_writer(path)?),
            None => None,
        };
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread = std::thread::Builder::new()
            .name("rostalk-fake-output".to_owned())
            .spawn(move || {
                let mut jitter = Jitter::new(0xC0FF_EE00);
                let mut next = Instant::now();
                let mut broken = false;
                while !thread_stop.load(Ordering::Relaxed) {
                    for _ in 0..chunk {
                        let value = match source.try_pop() {
                            Some(sample) => sample,
                            None => {
                                drops.fetch_add(1, Ordering::Relaxed);
                                0.0f32
                            }
                        };
                        if let Some(sink) = writer.as_mut() {
                            let sample = (value.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
                            if sink.write_sample(sample).is_err() {
                                broken = true;
                            }
                        }
                        if broken {
                            writer = None;
                        }
                    }
                    next += period;
                    let wake = next + Duration::from_micros(jitter.next_us(jitter_bound_us));
                    sleep_until(wake, &mut next);
                }
                if let Some(writer) = writer.take() {
                    // Fake-device thread: finalize silently.
                    let _ = writer.finalize();
                }
            })
            .map_err(|error| VoiceError::TestAudio(format!("start fake output: {error}")))?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for FakeOutput {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn wav_writer(path: &Path) -> Result<hound::WavWriter<std::io::BufWriter<File>>, VoiceError> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    hound::WavWriter::create(path, spec)
        .map_err(|error| VoiceError::TestAudio(format!("create {}: {error}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tone_is_a_bounded_sine() {
        let mut source = TestSource::open(Some(1_000.0), None).expect("tone");
        let mut frame = [0i16; FRAME_SAMPLES];
        assert!(source.next_frame(&mut frame));
        let peak = frame.iter().map(|s| s.abs()).max().unwrap_or(0);
        assert!(peak > 6_000, "peak {peak}");
        assert!(peak < i16::MAX);
    }

    #[test]
    fn a_44k_file_is_resampled_to_48k() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("in.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 44_100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        {
            let mut writer = hound::WavWriter::create(&path, spec).expect("create");
            for index in 0..44_100 {
                let t = f64::from(index) / 44_100.0;
                let value = (std::f64::consts::TAU * 1_000.0 * t).sin() * 10_000.0;
                writer.write_sample(value as i16).expect("write");
            }
            writer.finalize().expect("finalize");
        }
        let mut source = TestSource::open(None, Some(&path)).expect("open");
        let mut frame = [0i16; FRAME_SAMPLES];
        let mut frames = 0;
        while source.next_frame(&mut frame) {
            frames += 1;
        }
        // One second at 48 kHz is 100 frames; the resampler lookahead makes the
        // first frame short, not missing.
        assert!((99..=101).contains(&frames), "read {frames} frames");
        assert!(source.is_exhausted());
    }

    #[test]
    fn recorder_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("out.wav");
        {
            let mut sink = TestSink::create(&path).expect("create");
            sink.write(&[1i16; FRAME_SAMPLES]);
            sink.write(&[-1i16; FRAME_SAMPLES]);
            sink.finish();
        }
        let reader = hound::WavReader::open(&path).expect("open");
        assert_eq!(reader.spec().sample_rate, SAMPLE_RATE);
        let samples: Vec<i16> = reader
            .into_samples::<i16>()
            .collect::<Result<_, _>>()
            .expect("samples");
        assert_eq!(samples.len(), FRAME_SAMPLES * 2);
        assert_eq!(samples[0], 1);
        assert_eq!(samples[FRAME_SAMPLES], -1);
    }

    #[test]
    fn rejects_a_wrong_format() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("bad.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 44_100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let writer = hound::WavWriter::create(&path, spec).expect("create");
        writer.finalize().expect("finalize");
        assert!(TestSource::open(None, Some(&path)).is_err());
    }

    #[test]
    fn requires_a_source() {
        assert!(TestSource::open(None, None).is_err());
    }

    #[test]
    fn the_fake_device_fills_the_input_ring_at_its_own_clock() {
        use ringbuf::traits::Observer;
        use ringbuf::traits::Split;

        let (producer, consumer) = ringbuf::HeapRb::<f32>::new(48_000).split();
        let source = TestSource::open(Some(440.0), None).expect("tone");
        let device = FakeDevice::start(
            FakeClock {
                rate_hz: 47_995.0,
                chunk: 441,
                jitter_ms: 3,
            },
            source,
            producer,
            Arc::new(crate::devices::StreamErrorState::new()),
            Arc::new(AtomicU64::new(0)),
        )
        .expect("fake device");
        // The thread runs on its own clock and the test binary is parallel, so
        // only check that samples really flow at roughly the device rate. Wait
        // for the second chunk instead of trusting one fixed 100 ms sleep: on a
        // loaded host (make check next to parallel builds) the device thread
        // can be stalled past the sleep, which is not a device bug. The clock
        // drops missed deadlines instead of bursting a backlog, so the count
        // still reflects the device rate.
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut samples = consumer.occupied_len();
        while samples <= 480 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
            samples = consumer.occupied_len();
        }
        drop(device);

        assert!(
            samples > 480,
            "fake device produced only {samples} samples before the deadline"
        );
        assert!(
            samples < 48_000,
            "fake device produced {samples} samples: too fast"
        );
    }

    #[test]
    fn the_fake_output_records_what_the_pipeline_pushed() {
        use ringbuf::traits::{Producer, Split};

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("played.wav");
        let (mut producer, consumer) = ringbuf::HeapRb::<f32>::new(240_000).split();
        // Five seconds of audio for a 150 ms run: a loaded host can wake the
        // test thread late (make check next to parallel builds), and the ring
        // must not run dry even then, or the test reports an underrun that the
        // fake output did not cause.
        producer.push_slice(&[0.25f32; 240_000]);
        let drops = Arc::new(AtomicU64::new(0));
        let output = FakeOutput::start(
            FakeClock {
                rate_hz: 48_005.0,
                chunk: 512,
                jitter_ms: 3,
            },
            consumer,
            Some(&path),
            drops.clone(),
        )
        .expect("fake output");
        // The output thread is clocked by the fake device; on a loaded host it
        // may not have run by a fixed sleep. Wait until the file has samples.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            let written = std::fs::metadata(&path)
                .map(|meta| meta.len() > 44)
                .unwrap_or(false);
            if written {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(output);

        let reader = hound::WavReader::open(&path).expect("open");
        assert_eq!(reader.spec().sample_rate, SAMPLE_RATE);
        assert_eq!(reader.spec().channels, 1);
        assert!(reader.len() > 0, "the fake output recorded nothing");
        // Five seconds of audio was pushed for a 150 ms run.
        assert_eq!(drops.load(Ordering::Relaxed), 0);
    }
}
