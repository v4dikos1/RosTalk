//! Diagnostic probe for cpal stream errors on the real devices.
//!
//! Run on Windows with real hardware:
//!
//! ```text
//! cargo run -p rostalk-voice --example audio_error_probe -- --seconds 12
//! cargo run -p rostalk-voice --example audio_error_probe -- --mode in --seconds 12
//! cargo run -p rostalk-voice --example audio_error_probe -- --mode out --seconds 12
//! cargo run -p rostalk-voice --example audio_error_probe -- --legacy --seconds 8
//! ```
//!
//! The probe opens the same devices through [`rostalk_voice::devices`] as the
//! engine and prints every cpal stream error with its kind and cpal message.
//!
//! By default it applies the fixed policy (stage 2.3.2a.1): a non-fatal
//! `Xrun`/`DeviceChanged`/`RealtimeDenied` leaves the streams alone, and a
//! fatal error rebuilds the tract at most once per two seconds. With
//! `--legacy` it reproduces the old engine: any error rebuilt both streams on
//! every heartbeat, which on this machine meant ~2 rebuilds per second.
//!
//! `--input`/`--output` take a device id or a part of the device name. Nothing
//! sensitive is printed: only device names, ids, error kinds and counts.

use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ringbuf::traits::Split;
use ringbuf::{HeapCons, HeapProd};
use rostalk_voice::devices::{
    self, CaptureStream, DeviceList, PlaybackStream, StreamError, StreamErrorState,
};

/// One second of input at the highest rate the tract supports.
const INPUT_RING: usize = 96_000;
/// One second of output.
const OUTPUT_RING: usize = 96_000;
/// Polling interval, half of the engine heartbeat.
const POLL: Duration = Duration::from_millis(50);
/// Delay before a rebuild after a fatal error, unless `--legacy`.
const REBUILD_DELAY: Duration = Duration::from_secs(2);
/// The old engine rebuilt on the heartbeat, every 500 ms.
const LEGACY_RETRY_DELAY: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Both,
    Input,
    Output,
}

impl Mode {
    fn opens_input(self) -> bool {
        self != Self::Output
    }

    fn opens_output(self) -> bool {
        self != Self::Input
    }
}

struct Options {
    seconds: u64,
    mode: Mode,
    legacy: bool,
    input: Option<String>,
    output: Option<String>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            seconds: 12,
            mode: Mode::Both,
            legacy: false,
            input: None,
            output: None,
        }
    }
}

fn parse_options(args: &[String]) -> Result<Options, String> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        index += 1;
        let mut value = || {
            let value = args.get(index).cloned();
            index += 1;
            value.ok_or_else(|| format!("{arg} needs a value"))
        };
        match arg {
            "--seconds" => {
                options.seconds = value()?
                    .parse()
                    .map_err(|_| "--seconds needs a number".to_owned())?;
            }
            "--mode" => {
                options.mode = match value()?.as_str() {
                    "both" => Mode::Both,
                    "in" => Mode::Input,
                    "out" => Mode::Output,
                    other => return Err(format!("unknown mode {other:?}")),
                };
            }
            "--input" => options.input = Some(value()?),
            "--output" => options.output = Some(value()?),
            "--legacy" => options.legacy = true,
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(options)
}

struct Capture {
    stream: CaptureStream,
    errors: Arc<StreamErrorState>,
    /// Kept alive so the callback has a ring to write into.
    _consumer: HeapCons<f32>,
}

struct Playback {
    stream: PlaybackStream,
    errors: Arc<StreamErrorState>,
    /// Kept alive so the callback has a ring to read from.
    _producer: HeapProd<f32>,
}

fn open_capture(id: Option<&str>) -> Result<Capture, String> {
    let (producer, consumer) = ringbuf::HeapRb::<f32>::new(INPUT_RING).split();
    let errors = Arc::new(StreamErrorState::new());
    let stream = devices::open_capture(id, producer, errors.clone(), Arc::new(AtomicU64::new(0)))
        .map_err(|error| error.to_string())?;
    Ok(Capture {
        stream,
        errors,
        _consumer: consumer,
    })
}

fn open_playback(id: Option<&str>) -> Result<Playback, String> {
    let (producer, consumer) = ringbuf::HeapRb::<f32>::new(OUTPUT_RING).split();
    let errors = Arc::new(StreamErrorState::new());
    let stream = devices::open_playback(id, consumer, errors.clone(), Arc::new(AtomicU64::new(0)))
        .map_err(|error| error.to_string())?;
    Ok(Playback {
        stream,
        errors,
        _producer: producer,
    })
}

/// Resolves `--input`/`--output` against the visible devices.
///
/// An exact id wins, then a name substring (case-insensitive), then the id
/// substring, so a probe run can pick the headset instead of the default.
fn resolve(list: &DeviceList, query: Option<&String>, input: bool) -> Option<Option<String>> {
    let query = query?;
    let candidates = if input { &list.inputs } else { &list.outputs };
    if let Some(device) = candidates.iter().find(|device| device.id == *query) {
        return Some(Some(device.id.clone()));
    }
    let lower = query.to_lowercase();
    candidates
        .iter()
        .find(|device| device.name.to_lowercase().contains(&lower))
        .or_else(|| {
            candidates
                .iter()
                .find(|device| device.id.to_lowercase().contains(&lower))
        })
        .map(|device| Some(device.id.clone()))
}

fn print_devices(list: &DeviceList) {
    println!("inputs:");
    for device in &list.inputs {
        let default = if list.default_input.as_deref() == Some(device.id.as_str()) {
            " (default)"
        } else {
            ""
        };
        println!(
            "  {:?}{default} ch={} rate={} format={}",
            device.name, device.channels, device.sample_rate, device.sample_format
        );
    }
    println!("outputs:");
    for device in &list.outputs {
        let default = if list.default_output.as_deref() == Some(device.id.as_str()) {
            " (default)"
        } else {
            ""
        };
        println!(
            "  {:?}{default} ch={} rate={} format={}",
            device.name, device.channels, device.sample_rate, device.sample_format
        );
    }
}

fn describe(error: &StreamError) -> String {
    match &error.message {
        Some(message) => format!("kind={} message={message:?}", error.kind.name()),
        None => format!("kind={} message=none", error.kind.name()),
    }
}

/// Returns true when the error should rebuild the tract under the policy.
fn should_rebuild(error: &StreamError, legacy: bool) -> bool {
    legacy || error.kind.is_fatal()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = match parse_options(&args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("audio_error_probe: {error}");
            std::process::exit(2);
        }
    };

    let list = devices::list_devices();
    print_devices(&list);
    let input_id = match resolve(&list, options.input.as_ref(), true) {
        Some(id) => id,
        None if options.input.is_some() => {
            return Err("no input device matches --input".into());
        }
        None => None,
    };
    let output_id = match resolve(&list, options.output.as_ref(), false) {
        Some(id) => id,
        None if options.output.is_some() => {
            return Err("no output device matches --output".into());
        }
        None => None,
    };
    println!(
        "mode={:?} legacy={} seconds={}",
        options.mode, options.legacy, options.seconds
    );

    let started = Instant::now();
    let deadline = started + Duration::from_secs(options.seconds);
    let mut capture = if options.mode.opens_input() {
        Some(open_capture(input_id.as_deref())?)
    } else {
        None
    };
    let mut playback = if options.mode.opens_output() {
        Some(open_playback(output_id.as_deref())?)
    } else {
        None
    };
    if let Some(capture) = &capture {
        println!(
            "capture: id={:?} name={:?}",
            capture.stream.device_id(),
            capture.stream.device_name()
        );
    }
    if let Some(playback) = &playback {
        println!(
            "playback: id={:?} name={:?}",
            playback.stream.device_id(),
            playback.stream.device_name()
        );
    }

    let mut errors: u64 = 0;
    let mut rebuilds: u64 = 0;
    let mut pending = false;
    let mut next_rebuild = started;
    while Instant::now() < deadline {
        let now = Instant::now();
        let mut sides = Vec::new();
        if let Some(capture) = &capture {
            if let Some(error) = capture.errors.take() {
                sides.push(("capture", error));
            }
        }
        if let Some(playback) = &playback {
            if let Some(error) = playback.errors.take() {
                sides.push(("playback", error));
            }
        }
        for (side, error) in sides {
            errors += 1;
            println!(
                "[{:>7.3}s] {side} stream error #{errors}: {} count={}",
                started.elapsed().as_secs_f64(),
                describe(&error),
                error.count
            );
            if !should_rebuild(&error, options.legacy) {
                println!(
                    "[{:>7.3}s] {side}: {} is non-fatal, the stream keeps running",
                    started.elapsed().as_secs_f64(),
                    error.kind.name()
                );
                continue;
            }
            pending = true;
            if now < next_rebuild {
                println!(
                    "[{:>7.3}s] {side}: rebuild deferred ({})",
                    started.elapsed().as_secs_f64(),
                    if options.legacy {
                        "next heartbeat"
                    } else {
                        "backoff"
                    }
                );
            }
        }
        if pending && now >= next_rebuild {
            pending = false;
            rebuilds += 1;
            println!(
                "[{:>7.3}s] rebuild #{rebuilds}: reopening the tract (legacy={})",
                started.elapsed().as_secs_f64(),
                options.legacy
            );
            // The old engine dropped both streams; the fixed one still rebuilds
            // the shared tract but only for fatal errors, never for an Xrun.
            capture = None;
            playback = None;
            std::thread::sleep(Duration::from_millis(20));
            if options.mode.opens_input() {
                capture = Some(open_capture(input_id.as_deref())?);
            }
            if options.mode.opens_output() {
                playback = Some(open_playback(output_id.as_deref())?);
            }
            next_rebuild = if options.legacy {
                now + LEGACY_RETRY_DELAY
            } else {
                now + REBUILD_DELAY
            };
        }
        std::thread::sleep(POLL);
    }

    println!(
        "summary: {errors} error(s), {rebuilds} rebuild(s) in {:?}",
        started.elapsed()
    );
    let verdict = if options.legacy {
        "legacy policy rebuilt on every error; compare the count with the default run"
    } else if rebuilds == 0 {
        "no rebuild: the tract stayed up"
    } else if rebuilds <= 1 {
        "one rebuild: explained by a fatal stream error"
    } else {
        "more than one rebuild: check the error kinds above"
    };
    println!("verdict: {verdict}");
    drop((capture, playback));
    Ok(())
}
