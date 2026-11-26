//! Diagnostic probe for the Raw Input push-to-talk path.
//!
//! Run on Windows:
//!
//! ```text
//! cargo run -p rostalk-platform --example raw_input_probe
//! cargo run -p rostalk-platform --example raw_input_probe -- --keyboard
//! cargo run -p rostalk-platform --example raw_input_probe -- --rebind
//! ```
//!
//! Focus another window (Notepad, a game) and press X1/X2. Each event
//! is printed with a timestamp; no input is swallowed and nothing is injected.
//! The probe registers only the mouse by default: the client captures the
//! keyboard only when the user configures an explicit key (anti-cheat
//! hygiene). `--keyboard` adds the keyboard usage to check that a physical key
//! arrives as its layout-independent scan code (playtest-1, P4).
//! This is the same registration the client uses (ADR 0012), so it is the
//! quickest way to check that background input works while a game is focused.
//!
//! `--rebind` stops and reinstalls the registration three times, the sequence
//! the client runs when the user changes the push-to-talk binding. It prints
//! only the result of each test action, never the input.
//!
//! The probe never logs window titles, text, tokens or secrets.

use std::sync::Arc;
use std::time::{Duration, Instant};

fn main() {
    let keyboard = std::env::args().any(|arg| arg == "--keyboard");
    if std::env::args().any(|arg| arg == "--rebind") {
        rebind();
        return;
    }
    let started = Instant::now();
    let handler = Arc::new(move |event| {
        println!("{:>8.3}s {event:?}", started.elapsed().as_secs_f64());
    });

    let hook = match rostalk_platform::install_input_hook(handler, keyboard) {
        Ok(hook) => hook,
        Err(error) => {
            eprintln!("raw input is unavailable: {error}");
            std::process::exit(1);
        }
    };

    if keyboard {
        println!("listening for Raw Input; focus another window and press any key");
    } else {
        println!("listening for Raw Input; focus another window and press X1/X2");
    }
    println!("press Ctrl+C to stop");
    std::thread::sleep(Duration::from_secs(600));
    drop(hook);
}

/// Runs the stop/install sequence a binding change performs.
fn rebind() {
    for (index, keyboard) in [false, true, false].into_iter().enumerate() {
        let handler = Arc::new(|_| {});
        match rostalk_platform::install_input_hook(handler, keyboard) {
            Ok(hook) => {
                println!("install {} (keyboard {keyboard}): ok", index + 1);
                hook.stop();
                println!("stop {}: ok", index + 1);
            }
            Err(error) => {
                println!("install {} (keyboard {keyboard}): {error}", index + 1);
                std::process::exit(1);
            }
        }
    }
    println!("rebind sequence: 3/3 registrations finished");
}
