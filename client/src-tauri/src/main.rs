// Keep the console window hidden in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Keeps the generated TypeScript bindings reproducible without starting
    // the GUI (CI and `make gen-ipc`). Debug builds only: the shipped client
    // has no such mode and does not embed the build-machine path (2026-11-22
    // anti-cheat audit).
    #[cfg(debug_assertions)]
    if std::env::args().any(|arg| arg == "--export-bindings") {
        match rostalk_lib::export_bindings() {
            Ok(path) => println!("wrote {}", path.display()),
            Err(err) => {
                eprintln!("rostalk: failed to export IPC bindings: {err}");
                std::process::exit(1);
            }
        }
        return;
    }

    // Stage 6.2: the uninstaller calls this before removing the installation
    // when the user did not ask to keep the identity and settings. It runs
    // before Tauri (and the single-instance guard) so it works headless and
    // even while a client instance is still closing.
    if std::env::args().any(|arg| arg == "--purge-data") {
        rostalk_lib::purge_local_data();
        return;
    }

    rostalk_lib::run();
}
