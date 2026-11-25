//! Local diagnostics log for the desktop shell.
//!
//! The voice engine reports stream errors and rebuilds through `log`, but the
//! shell had no logger, so those lines were lost — especially in a release
//! build, which has no console (`windows_subsystem = "windows"`). The log is
//! written to `%LOCALAPPDATA%\RosTalk\logs\rostalk.log` and mirrored to stderr
//! when the process has one (stage 2.3.2a.1).
//!
//! The file is written only after the user allows diagnostics at the first-run
//! wizard or in the settings window: the shell calls [`set_enabled`] with the
//! persisted consent. Before a decision (`Undecided`) and after a refusal
//! (`Denied`) the logger keeps writing to stderr only. Nothing is uploaded anywhere;
//! the user exports the file and hands it over.
//!
//! Level defaults to `info`; `ROSTALK_LOG=debug` (or `trace`, `warn`, `error`,
//! `off`) raises it for a diagnostic run. `ROSTALK_LOG_DIR` overrides the
//! directory. The file is rotated once it reaches five megabytes.
//!
//! Nothing secret is logged by this module: it only formats records the crates
//! already emit. The voice crates never log tokens or audio content.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use log::{LevelFilter, Log, Metadata, Record};

/// Rotate the file once it reaches this size.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
/// Level used when `ROSTALK_LOG` is absent or unknown.
const DEFAULT_LEVEL: LevelFilter = LevelFilter::Info;
/// Name of the current file inside the log directory.
const LOG_FILE: &str = "rostalk.log";
/// Rotated file kept next to the current one.
const PREVIOUS_LOG_FILE: &str = "rostalk.log.1";

struct FileLogger {
    /// Open file handle; `None` while consent is absent or denied.
    file: Mutex<Option<LogFile>>,
    /// Consent. Kept apart from the handle so clearing the log leaves no empty
    /// file behind: the next record opens a fresh one.
    enabled: AtomicBool,
    started: Instant,
}

/// The open file plus how much this process has written to it.
///
/// The size is tracked here instead of calling `metadata()` for every record:
/// a long session must rotate without a syscall on the hot path.
struct LogFile {
    file: File,
    written: u64,
}

impl FileLogger {
    /// Writes one already formatted line to stderr and, when allowed, the file.
    fn write_line(&self, line: &str) {
        // A release GUI has no console; a development run does. Never `eprint!`:
        // it panics when the standard handle is invalid, which would turn a
        // diagnostic line into an application crash.
        let _ = std::io::stderr().write_all(line.as_bytes());
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let Ok(mut guard) = self.file.lock() else {
            return;
        };
        if guard.is_none() {
            let Some(path) = log_path() else {
                return;
            };
            *guard = open_log(&path);
            if guard.is_none() {
                return;
            }
        }
        let mut rotate = false;
        if let Some(log) = guard.as_mut() {
            let _ = log.file.write_all(line.as_bytes());
            let _ = log.file.flush();
            log.written += line.len() as u64;
            rotate = log.written > MAX_LOG_BYTES;
        }
        if rotate {
            if let Some(path) = log_path() {
                *guard = rotate_log(&path);
            }
        }
    }
}

impl Log for FileLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let elapsed = self.started.elapsed();
        let line = format!(
            "[{:>9.3}s] {:<5} {}: {}\n",
            elapsed.as_secs_f64(),
            record.level(),
            record.target(),
            record.args()
        );
        self.write_line(&line);
    }

    fn flush(&self) {
        if let Ok(mut guard) = self.file.lock() {
            if let Some(log) = guard.as_mut() {
                let _ = log.file.flush();
            }
        }
    }
}

static LOGGER: OnceLock<FileLogger> = OnceLock::new();

/// Installs the logger once. Safe to call from `run` before Tauri starts.
///
/// The file stays closed until [`set_enabled(true)`](set_enabled): consent lives
/// in the settings, which the core loads after this point.
pub fn init() {
    let level = level_from_env();
    let logger = LOGGER.get_or_init(|| FileLogger {
        file: Mutex::new(None),
        enabled: AtomicBool::new(false),
        started: Instant::now(),
    });
    if log::set_logger(logger).is_ok() {
        log::set_max_level(level);
        log::info!(
            "RosTalk {} started; the diagnostics log stays off until consent",
            env!("CARGO_PKG_VERSION")
        );
    }
}

/// Opens or closes the log file. Safe from any thread and idempotent.
///
/// Called after the settings load and after every settings write that can
/// change the consent. On the first open a `diagnostics enabled` line is
/// written, so an exported file shows when the user allowed it.
pub fn set_enabled(enabled: bool) {
    let Some(logger) = LOGGER.get() else {
        return;
    };
    if enabled {
        if logger.enabled.swap(true, Ordering::Relaxed) {
            return;
        }
        let Some(path) = log_path() else {
            logger.enabled.store(false, Ordering::Relaxed);
            return;
        };
        logger.write_line(&format!(
            "[{:>9.3}s] INFO  rostalk::logging: diagnostics enabled; log file {}\n",
            logger.started.elapsed().as_secs_f64(),
            path.display()
        ));
    } else {
        if !logger.enabled.swap(false, Ordering::Relaxed) {
            return;
        }
        if let Ok(mut guard) = logger.file.lock() {
            if let Some(log) = guard.as_mut() {
                let _ = log.file.flush();
            }
            *guard = None;
        }
        log::info!("diagnostics disabled; the log file is closed");
    }
}

/// True while records are written to the file.
#[must_use]
pub fn is_enabled() -> bool {
    LOGGER
        .get()
        .is_some_and(|logger| logger.enabled.load(Ordering::Relaxed))
}

/// Deletes `rostalk.log` and `rostalk.log.1`.
///
/// The open file is closed first. Consent is untouched: when it was granted a
/// fresh file appears with the next record, not as an empty file at once, so
/// the user sees that the old log is really gone.
pub fn clear() -> std::io::Result<()> {
    let Some(path) = log_path() else {
        return Ok(());
    };
    if let Some(logger) = LOGGER.get() {
        let mut guard = logger
            .file
            .lock()
            .map_err(|_| std::io::Error::other("the log lock is poisoned"))?;
        if let Some(log) = guard.as_mut() {
            let _ = log.file.flush();
        }
        *guard = None;
    }
    for file in [path.clone(), previous_path(&path)] {
        match std::fs::remove_file(&file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// Excerpt of the current and the rotated file, newest first.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LogSnapshot {
    /// Log text with a header per file; empty when no file exists.
    pub text: String,
    /// Number of files that existed when the snapshot was taken.
    pub files: usize,
    /// True when some part of a file did not fit into the budget.
    pub truncated: bool,
}

/// Reads at most `max_bytes` from `rostalk.log` and then `rostalk.log.1`.
///
/// The newest file comes first: when the budget runs out, the lines closest to
/// the failure survive. A truncated file keeps its tail and starts after the
/// first partial line; the section header says so.
#[must_use]
pub fn read_recent(max_bytes: u64) -> LogSnapshot {
    let mut snapshot = LogSnapshot::default();
    let Some(current) = log_path() else {
        return snapshot;
    };
    let mut remaining = max_bytes;
    for (label, file) in [
        (LOG_FILE, current.clone()),
        (PREVIOUS_LOG_FILE, previous_path(&current)),
    ] {
        let Ok(metadata) = std::fs::metadata(&file) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        snapshot.files += 1;
        let len = metadata.len();
        let take = len.min(remaining);
        let truncated = take < len;
        snapshot.truncated |= truncated;
        if take == 0 {
            continue;
        }
        let Ok(mut reader) = File::open(&file) else {
            continue;
        };
        if truncated && reader.seek(SeekFrom::End(-(take as i64))).is_err() {
            continue;
        }
        let mut buffer = vec![0_u8; take as usize];
        if reader.read_exact(&mut buffer).is_err() {
            continue;
        }
        let mut text = String::from_utf8_lossy(&buffer).into_owned();
        if truncated {
            // Do not start the excerpt in the middle of a line.
            if let Some(end) = text.find('\n') {
                text.drain(..=end);
            }
        }
        snapshot.text.push_str(&format!(
            "--- {label}{} ---\n",
            if truncated {
                " (обрезано: показан конец файла)"
            } else {
                ""
            }
        ));
        snapshot.text.push_str(&text);
        if !text.ends_with('\n') {
            snapshot.text.push('\n');
        }
        remaining = remaining.saturating_sub(take);
    }
    snapshot
}

fn level_from_env() -> LevelFilter {
    let Ok(value) = std::env::var("ROSTALK_LOG") else {
        return DEFAULT_LEVEL;
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "off" => LevelFilter::Off,
        "error" => LevelFilter::Error,
        "warn" => LevelFilter::Warn,
        "info" => LevelFilter::Info,
        "debug" => LevelFilter::Debug,
        "trace" => LevelFilter::Trace,
        _ => DEFAULT_LEVEL,
    }
}

fn log_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("ROSTALK_LOG_DIR") {
        return Some(PathBuf::from(dir).join(LOG_FILE));
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    Some(base.join("RosTalk").join("logs").join(LOG_FILE))
}

fn previous_path(path: &Path) -> PathBuf {
    path.with_extension("log.1")
}

/// Opens the log for append, rotating the previous file when it is too large.
fn open_log(path: &Path) -> Option<LogFile> {
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return None;
        }
    }
    if std::fs::metadata(path).is_ok_and(|metadata| metadata.len() > MAX_LOG_BYTES) {
        let _ = std::fs::remove_file(previous_path(path));
        let _ = std::fs::rename(path, previous_path(path));
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()?;
    let written = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    Some(LogFile { file, written })
}

/// Rotates a full log while the process is running: the current file becomes
/// `rostalk.log.1` and a fresh one is opened. A failure to rename keeps the old
/// handle, so logging never stops because rotation failed.
fn rotate_log(path: &Path) -> Option<LogFile> {
    let previous = previous_path(path);
    let _ = std::fs::remove_file(&previous);
    let rotated = std::fs::rename(path, &previous).is_ok();
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()?;
    if !rotated {
        // The old file could not be moved (a lock or permissions); appending is
        // still safer than dropping every record.
        return Some(LogFile {
            written: file.metadata().map(|meta| meta.len()).unwrap_or(0),
            file,
        });
    }
    Some(LogFile { file, written: 0 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::MutexGuard;

    /// `ROSTALK_LOG_DIR` is process-wide, so the tests below take turns.
    static ENV_LOCK: Mutex<()> = Mutex::new(());
    /// Distinguishes temporary directories created in the same second.
    static NEXT_DIR: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    struct TempLogDir {
        _lock: MutexGuard<'static, ()>,
        dir: PathBuf,
    }

    impl TempLogDir {
        fn new() -> Self {
            let lock = ENV_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let unique = NEXT_DIR.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("rostalk-log-test-{}-{unique}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp dir");
            std::env::set_var("ROSTALK_LOG_DIR", &dir);
            init();
            set_enabled(false);
            Self { _lock: lock, dir }
        }

        fn file(&self) -> PathBuf {
            self.dir.join(LOG_FILE)
        }
    }

    impl Drop for TempLogDir {
        fn drop(&mut self) {
            set_enabled(false);
            let _ = std::fs::remove_dir_all(&self.dir);
            std::env::remove_var("ROSTALK_LOG_DIR");
        }
    }

    #[test]
    fn the_file_is_written_only_after_consent() {
        let temp = TempLogDir::new();
        log::info!("undecided: this line must stay off the disk");
        assert!(!temp.file().exists(), "no consent, no file");
        assert!(!is_enabled());

        set_enabled(true);
        log::info!("granted: this line belongs in the file");
        let text = std::fs::read_to_string(temp.file()).expect("log file");
        assert!(text.contains("diagnostics enabled"), "{text}");
        assert!(text.contains("granted: this line belongs in the file"));
        assert!(!text.contains("undecided"));

        set_enabled(false);
        let length = std::fs::metadata(temp.file()).expect("metadata").len();
        log::info!("denied: this line must not be appended");
        assert_eq!(
            std::fs::metadata(temp.file()).expect("metadata").len(),
            length
        );
        assert!(!is_enabled());
    }

    #[test]
    fn the_excerpt_reads_both_files_and_marks_truncation() {
        let temp = TempLogDir::new();
        std::fs::write(temp.file(), "current line one\ncurrent line two\n").expect("write");
        std::fs::write(previous_path(&temp.file()), "old line\n").expect("write");

        let snapshot = read_recent(1024);
        assert_eq!(snapshot.files, 2);
        assert!(!snapshot.truncated);
        assert!(snapshot.text.contains("current line two"));
        assert!(snapshot.text.contains("old line"));

        let tiny = read_recent(20);
        assert!(tiny.truncated);
        assert!(tiny.text.contains("обрезано"));
    }

    #[test]
    fn a_full_log_is_rotated_while_it_is_open() {
        let temp = TempLogDir::new();
        // A file exactly at the limit is still appendable: rotation happens
        // after the next record, not only on open.
        std::fs::write(temp.file(), vec![b'.'; MAX_LOG_BYTES as usize]).expect("seed");
        set_enabled(true);
        log::info!("this record overflows the file");
        let previous = previous_path(&temp.file());
        assert!(previous.exists(), "the full file becomes rostalk.log.1");
        assert!(std::fs::metadata(&previous).expect("metadata").len() >= MAX_LOG_BYTES);
        let text = std::fs::read_to_string(temp.file()).expect("fresh log");
        assert!(text.contains("overflow"), "{text}");
        set_enabled(false);
    }

    #[test]
    fn clearing_removes_both_files_and_reopens_the_log() {
        let temp = TempLogDir::new();
        set_enabled(true);
        log::info!("line before clearing");
        assert!(temp.file().exists());

        clear().expect("clear");
        assert!(!temp.file().exists());
        assert!(!previous_path(&temp.file()).exists());
        assert!(is_enabled(), "the granted log is reopened");

        log::info!("line after clearing");
        let text = std::fs::read_to_string(temp.file()).expect("log file");
        assert!(text.contains("line after clearing"));
        set_enabled(false);
    }
}
