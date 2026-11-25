//! Optional WAV dumps of the audio tract for live debugging (stage 2.3.2a).
//!
//! `ROSTALK_AUDIO_DUMP=<directory>` writes 48 kHz mono 16-bit WAV files that
//! show exactly where a defect is born:
//!
//! | file | point |
//! |---|---|
//! | `1-raw.wav` | after the input resampler, before APM |
//! | `2-apm.wav` | after APM |
//! | `3-sent.wav` | after the gate, what the publisher sends |
//! | `4-rx-<n>.wav` | one remote track, before the mixer |
//! | `5-out.wav` | the mixed playback output |
//!
//! Recording never happens in the audio thread: every point has its own
//! lock-free [`HeapRb`] of ten seconds, and a background thread writes the
//! samples with `hound`. A full ring is counted, never waited for. Without the
//! environment variable nothing is allocated and no file is created; a file
//! appears only when its first samples arrive.
//!
//! The switch works in every build, release included: the user runs the
//! packaged client, not a debug binary, so a debug-only dump could not be used
//! for a live report. The guard against filling a disk is a hard cap of
//! [`LIMIT_SECONDS`] per file: the writer finalizes the WAV, logs one line and
//! closes it. The audio thread keeps running and its samples are dropped
//! without another disk write.
//!
//! See `docs/audio-debug.md` for the live checklist.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

use crate::frame::SAMPLE_RATE;

/// Environment variable that enables the dumps; its value is the directory.
pub const ENV: &str = "ROSTALK_AUDIO_DUMP";

/// Ten seconds of 48 kHz mono per dump point, as the plan requires.
const RING: usize = 10 * SAMPLE_RATE as usize;
/// Samples handed to the WAV writer per call.
const BLOCK: usize = 4_096;
/// Idle wait of a writer thread.
const IDLE: Duration = Duration::from_millis(5);
/// Hard cap per dump file: five minutes of 48 kHz mono.
///
/// The dumps run in release builds, so the writer must not be able to fill a
/// user's disk even if the variable is left in the environment.
pub const LIMIT_SECONDS: u64 = 5 * 60;
/// The same cap in samples.
pub const LIMIT_SAMPLES: u64 = LIMIT_SECONDS * SAMPLE_RATE as u64;

/// One fixed dump point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DumpKind {
    /// After the capture resampler.
    Raw,
    /// After APM.
    Apm,
    /// After the gate.
    Sent,
    /// The playback mix.
    Out,
}

impl DumpKind {
    fn file_stem(self) -> &'static str {
        match self {
            Self::Raw => "1-raw",
            Self::Apm => "2-apm",
            Self::Sent => "3-sent",
            Self::Out => "5-out",
        }
    }
}

/// Producer side of one dump point. Lives on an audio thread and only pushes
/// into a lock-free ring.
pub struct DumpTap {
    producer: HeapProd<i16>,
    overflows: Arc<AtomicU64>,
}

impl DumpTap {
    /// Copies a frame into the ring and returns immediately.
    ///
    /// A full ring means the disk could not keep up; the dropped samples are
    /// counted in [`AudioDump::overflows`], the audio thread never blocks.
    pub fn push(&mut self, samples: &[i16]) {
        let mut remaining = samples;
        while !remaining.is_empty() {
            let written = self.producer.push_slice(remaining);
            if written == 0 {
                self.overflows
                    .fetch_add(remaining.len() as u64, Ordering::Relaxed);
                return;
            }
            remaining = &remaining[written..];
        }
    }
}

/// All dump points of one pipeline, plus their writer threads.
pub struct AudioDump {
    dir: PathBuf,
    overflows: Arc<AtomicU64>,
    writers: Vec<Writer>,
    rx_next: u32,
    /// Per-file sample cap; [`LIMIT_SAMPLES`] in production, smaller in tests.
    limit: u64,
}

struct Writer {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Writer {
    /// Stops and joins the writer so the WAV header is finalized even when the
    /// runtime is dropped without [`AudioDump::finish`].
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl AudioDump {
    /// Opens the dump directory from the environment.
    ///
    /// Returns `None` without `ROSTALK_AUDIO_DUMP` and when the directory
    /// cannot be created: a diagnostic aid must never fail the engine.
    #[must_use]
    pub fn from_env() -> Option<Self> {
        let dir = std::env::var_os(ENV)?;
        let dir = PathBuf::from(dir);
        if let Err(error) = std::fs::create_dir_all(&dir) {
            log::warn!("audio dump directory {}: {error}", dir.display());
            return None;
        }
        log::info!(
            "audio dumps go to {} (at most {LIMIT_SECONDS} s per file)",
            dir.display()
        );
        Some(Self {
            dir,
            overflows: Arc::new(AtomicU64::new(0)),
            writers: Vec::new(),
            rx_next: 0,
            limit: LIMIT_SAMPLES,
        })
    }

    /// Creates one fixed dump point.
    pub fn tap(&mut self, kind: DumpKind) -> Option<DumpTap> {
        self.spawn(kind.file_stem().to_owned())
    }

    /// Creates a dump point for one remote track (`4-rx-<n>.wav`).
    ///
    /// The index is sequential and does not contain the participant identity:
    /// the file must be safe to attach to a report.
    pub fn receiver(&mut self) -> Option<DumpTap> {
        self.rx_next = self.rx_next.saturating_add(1);
        self.spawn(format!("4-rx-{}", self.rx_next))
    }

    fn spawn(&mut self, stem: String) -> Option<DumpTap> {
        let (producer, consumer) = HeapRb::<i16>::new(RING).split();
        // Never overwrite an earlier recording: a second session (the engine
        // re-opens the audio path on some device changes) writes the next free
        // name instead of truncating evidence.
        let path = free_path(&self.dir.join(format!("{stem}.wav")));
        let overflows = self.overflows.clone();
        let limit = self.limit;
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread = std::thread::Builder::new()
            .name(format!("rostalk-dump-{stem}"))
            .spawn(move || write_loop(path, consumer, thread_stop, limit))
            .map_err(|error| log::warn!("audio dump thread: {error}"))
            .ok()?;
        self.writers.push(Writer {
            stop,
            thread: Some(thread),
        });
        Some(DumpTap {
            producer,
            overflows,
        })
    }

    /// Samples dropped because a ring was full.
    #[must_use]
    pub fn overflows(&self) -> u64 {
        self.overflows.load(Ordering::Relaxed)
    }

    /// Stops the writers and finalizes the WAV headers.
    pub fn finish(mut self) {
        // Dropping a writer stops and joins its thread, which finalizes the
        // file even on this path.
        self.writers.clear();
        let overflows = self.overflows();
        if overflows > 0 {
            log::warn!("audio dump dropped {overflows} samples: the disk was too slow");
            note(
                &self.dir,
                &format!("dropped {overflows} samples: the disk was too slow"),
            );
        }
    }
}

/// Drains one ring into a WAV file. The file is created by the first samples,
/// so a silent point leaves nothing behind.
///
/// After `limit` samples the file is finalized and closed with one log line;
/// the ring keeps being drained (and the samples dropped) so the audio thread
/// never sees a full ring and the cap costs nothing.
fn write_loop(path: PathBuf, mut consumer: HeapCons<i16>, stop: Arc<AtomicBool>, limit: u64) {
    let mut writer: Option<hound::WavWriter<BufWriter<File>>> = None;
    let mut attempt_open = true;
    let mut written = 0u64;
    let mut block = [0i16; BLOCK];
    loop {
        let stopping = stop.load(Ordering::Relaxed);
        let mut filled = 0;
        while filled < block.len() {
            let read = consumer.pop_slice(&mut block[filled..]);
            if read == 0 {
                break;
            }
            filled += read;
        }
        if filled > 0 {
            if written < limit {
                if attempt_open {
                    writer = open_wav(&path);
                    attempt_open = false;
                }
                let take = ((limit - written) as usize).min(filled);
                let mut failed = false;
                if let Some(wav) = writer.as_mut() {
                    for sample in &block[..take] {
                        if wav.write_sample(*sample).is_err() {
                            failed = true;
                            break;
                        }
                    }
                    if !failed {
                        // Patch the RIFF sizes after every block: the client is
                        // a GUI process the user may kill, and a file without a
                        // finalized header looks empty in an editor.
                        if let Err(error) = wav.flush() {
                            log::warn!("audio dump flush of {}: {error}", path.display());
                        }
                    }
                }
                if failed {
                    log::warn!("audio dump write failed, stopping {}", path.display());
                    writer = None;
                }
                written += take as u64;
                if written >= limit {
                    close_wav(&path, writer.take());
                    let line = format!(
                        "{}: reached the {} s limit, the file is closed",
                        path.file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        limit / u64::from(SAMPLE_RATE)
                    );
                    log::info!("audio dump {line}");
                    if let Some(dir) = path.parent() {
                        note(dir, &line);
                    }
                }
            }
            // Past the cap the samples are drained and dropped on purpose.
        } else if stopping {
            break;
        }
        if filled == 0 {
            std::thread::sleep(IDLE);
        }
    }
    close_wav(&path, writer.take());
}

/// `<stem>.wav`, or `<stem>-2.wav`, `<stem>-3.wav`… when it already exists.
fn free_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    for index in 2u32.. {
        let candidate = path.with_file_name(format!("{stem}-{index}.wav"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("the free-name search cannot exhaust u32");
}

/// Finalizes a WAV header, if there is a file to finalize.
fn close_wav(path: &Path, writer: Option<hound::WavWriter<BufWriter<File>>>) {
    if let Some(wav) = writer {
        if let Err(error) = wav.finalize() {
            log::warn!("audio dump finalize of {} failed: {error}", path.display());
        }
    }
}

/// Appends one line to `dump.log` next to the WAV files.
///
/// Keep the reason for a closed or incomplete dump next to the evidence: the
/// client log is in `%LOCALAPPDATA%\RosTalk\logs` and may rotate at 5 MB, while
/// `dump.log` stays with the WAV files it describes. Called from the writer and
/// engine threads, never from an audio thread.
fn note(dir: &Path, line: &str) {
    use std::io::Write;

    let path = dir.join("dump.log");
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(mut file) => {
            let _ = writeln!(file, "{line}");
        }
        Err(error) => log::warn!("audio dump log {}: {error}", path.display()),
    }
}

fn open_wav(path: &Path) -> Option<hound::WavWriter<BufWriter<File>>> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    match hound::WavWriter::create(path, spec) {
        Ok(writer) => Some(writer),
        Err(error) => {
            log::warn!("audio dump {}: {error}", path.display());
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dump(dir: &std::path::Path) -> AudioDump {
        temp_dump_limit(dir, LIMIT_SAMPLES)
    }

    fn temp_dump_limit(dir: &std::path::Path, limit: u64) -> AudioDump {
        AudioDump {
            dir: dir.to_path_buf(),
            overflows: Arc::new(AtomicU64::new(0)),
            writers: Vec::new(),
            rx_next: 0,
            limit,
        }
    }

    #[test]
    fn nothing_is_created_until_samples_arrive() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut dump = temp_dump(dir.path());
        let tap = dump.tap(DumpKind::Raw).expect("tap");
        std::thread::sleep(Duration::from_millis(20));
        dump.finish();
        assert!(
            !dir.path().join("1-raw.wav").exists(),
            "an idle dump point must not create a file"
        );
        drop(tap);
    }

    #[test]
    fn samples_are_written_to_the_expected_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut dump = temp_dump(dir.path());
        let mut tap = dump.tap(DumpKind::Sent).expect("tap");
        tap.push(&[1_000i16; 480]);
        drop(tap);
        dump.finish();
        let path = dir.path().join("3-sent.wav");
        let mut reader = hound::WavReader::open(&path).expect("open");
        assert_eq!(reader.spec().sample_rate, SAMPLE_RATE);
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.len(), 480);
        let first: i16 = reader.samples::<i16>().next().expect("sample").expect("ok");
        assert_eq!(first, 1_000);
    }

    #[test]
    fn receive_points_get_sequential_names() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut dump = temp_dump(dir.path());
        let _first = dump.receiver().expect("first");
        let _second = dump.receiver().expect("second");
        assert_eq!(dump.rx_next, 2);
        dump.finish();
    }

    #[test]
    fn a_second_session_does_not_overwrite_the_first() {
        let dir = tempfile::tempdir().expect("tempdir");
        {
            let mut dump = temp_dump(dir.path());
            let mut tap = dump.tap(DumpKind::Out).expect("tap");
            tap.push(&[1_000i16; 480]);
            drop(tap);
            dump.finish();
        }
        {
            let mut dump = temp_dump(dir.path());
            let mut tap = dump.tap(DumpKind::Out).expect("tap");
            tap.push(&[2_000i16; 480]);
            drop(tap);
            dump.finish();
        }
        let first = hound::WavReader::open(dir.path().join("5-out.wav")).expect("first");
        assert_eq!(first.len(), 480);
        let second = hound::WavReader::open(dir.path().join("5-out-2.wav")).expect("second");
        assert_eq!(second.len(), 480);
    }

    #[test]
    fn a_full_ring_is_counted_instead_of_blocking() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut dump = temp_dump(dir.path());
        let mut tap = dump.tap(DumpKind::Out).expect("tap");
        // Three rings of audio pushed at once: the writer cannot keep up, and
        // the audio thread must not wait for it.
        let frame = [0i16; 480];
        for _ in 0..(3 * RING / 480) {
            tap.push(&frame);
        }
        let overflows = dump.overflows();
        drop(tap);
        dump.finish();
        assert!(overflows > 0, "the overflow counter stayed at zero");
    }

    /// The five-minute guard: the file stops at the limit, the ring is still
    /// drained so the audio thread never blocks, and the WAV header is valid.
    #[test]
    fn the_writer_stops_at_the_sample_limit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut dump = temp_dump_limit(dir.path(), 960);
        let mut tap = dump.tap(DumpKind::Apm).expect("tap");
        for _ in 0..20 {
            tap.push(&[1_000i16; 480]);
        }
        // Give the writer a chance to reach the cap before the shutdown.
        std::thread::sleep(Duration::from_millis(100));
        drop(tap);
        let overflows = dump.overflows();
        dump.finish();

        let mut reader = hound::WavReader::open(dir.path().join("2-apm.wav")).expect("open");
        assert_eq!(reader.len(), 960, "the cap must truncate the file");
        let count = reader.samples::<i16>().count();
        assert_eq!(count, 960);
        assert_eq!(
            overflows, 0,
            "samples past the cap must be drained, not counted as overflows"
        );
        let log = std::fs::read_to_string(dir.path().join("dump.log")).expect("dump.log");
        assert!(
            log.contains("2-apm.wav") && log.contains("limit"),
            "the cap must leave a line in dump.log, got {log:?}"
        );
    }
}
