//! RosTalk Server Setup: installs `rostalk-server` on a Linux VPS over SSH.
//!
//! P13 (ADR 0026) moved the "own hosting" wizard of stage 6.1a (ADR 0021) out
//! of the desktop client into this separate Windows application. The client
//! ships without SSH and without server binaries; this program carries the
//! signed server bundle in `server/` next to the exe and reuses the same
//! `rostalk-hosting` crate and UI wizard.
//!
//! Anti-cheat hygiene is the same as for the client (`make check-anticheat`,
//! `make check-anticheat-imports`): one window of our own, no tray, no global
//! input, no focus helpers, nothing done to other processes or windows. The
//! window is built in code so the navigation guard is attached before the
//! first page load (ADR 0023).

// Keep the console window hidden in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hosting_ipc;

use tauri::Manager;
use tauri_specta::{collect_commands, collect_events, Builder as SpectaBuilder};

fn specta_builder() -> SpectaBuilder<tauri::Wry> {
    SpectaBuilder::<tauri::Wry>::new()
        .commands(collect_commands![
            hosting_ipc::hosting_pick_key,
            hosting_ipc::hosting_probe,
            hosting_ipc::hosting_preflight,
            hosting_ipc::hosting_bundle_status,
            hosting_ipc::hosting_install_start,
            hosting_ipc::hosting_cancel,
            hosting_ipc::hosting_load_credentials,
            hosting_ipc::hosting_forget_credentials,
        ])
        .events(collect_events![hosting_ipc::HostingEventMessage])
}

/// Writes the TypeScript bindings of this application (`make gen-ipc`).
/// Debug builds only, like the client: the release exe embeds neither the
/// build-machine path nor a way to write into the source tree.
#[cfg(debug_assertions)]
fn export_bindings() -> Result<std::path::PathBuf, String> {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../ui/src/server-setup/bindings.ts");
    specta_builder()
        .export(specta_typescript::Typescript::default(), &path)
        .map_err(|err| err.to_string())?;
    Ok(path)
}

/// True for the only URLs the WebView may load: the embedded app origin and,
/// in a development build, the Vite dev server of this entry point. Same
/// rule as the client's `is_app_url` (ADR 0023).
fn is_app_url(url: &tauri::Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    match url.scheme() {
        "tauri" => host.eq_ignore_ascii_case("localhost"),
        "http" | "https" => {
            host.eq_ignore_ascii_case("tauri.localhost")
                || (cfg!(debug_assertions)
                    && url.port() == Some(1421)
                    && (host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1"))
        }
        "about" => url.as_str().eq_ignore_ascii_case("about:blank"),
        _ => false,
    }
}

/// Builds the main window from tauri.conf.json (`create: false`) with the
/// navigation guard attached.
fn build_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or_else(|| "tauri.conf.json has no main window".to_owned())?;
    tauri::WebviewWindowBuilder::from_config(app, &config)
        .and_then(|builder| builder.on_navigation(is_app_url).build())
        .map_err(|error| error.to_string())?;
    disable_native_context_menu(app);
    Ok(())
}

/// Turns off the WebView2 default context menu (reload, save page, print),
/// as in the client (stage 2.3.1).
#[cfg(windows)]
fn disable_native_context_menu(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let result = window.with_webview(|webview| {
        // SAFETY: `with_webview` runs on the WebView2 UI thread. The COM
        // interfaces are valid for the lifetime of the webview.
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            let Ok(settings) = core.Settings() else {
                return;
            };
            if let Err(error) = settings.SetAreDefaultContextMenusEnabled(false) {
                eprintln!("rostalk-server-setup: context menu: {error}");
            }
        }
    });
    if let Err(error) = result {
        eprintln!("rostalk-server-setup: context menu: {error}");
    }
}

#[cfg(not(windows))]
fn disable_native_context_menu(_app: &tauri::AppHandle) {}

fn main() {
    #[cfg(debug_assertions)]
    if std::env::args().any(|arg| arg == "--export-bindings") {
        match export_bindings() {
            Ok(path) => println!("wrote {}", path.display()),
            Err(err) => {
                eprintln!("rostalk-server-setup: failed to export IPC bindings: {err}");
                std::process::exit(1);
            }
        }
        return;
    }

    let specta = specta_builder();
    let invoke_handler = specta.invoke_handler();
    let result = tauri::Builder::default()
        .manage(hosting_ipc::HostingState::default())
        .invoke_handler(invoke_handler)
        .setup(move |app| {
            // Events are mounted before anything can emit (see the client).
            specta.mount_events(app);
            build_main_window(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(err) = result {
        eprintln!("rostalk-server-setup: failed to start: {err}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> tauri::Url {
        tauri::Url::parse(value).expect("test url")
    }

    #[test]
    fn only_the_app_origin_may_navigate() {
        assert!(is_app_url(&url("tauri://localhost/server-setup.html")));
        assert!(is_app_url(&url("http://tauri.localhost/server-setup.html")));
        assert!(is_app_url(&url("about:blank")));
        assert!(!is_app_url(&url("https://github.com/")));
        assert!(!is_app_url(&url("http://localhost:1420/")));
        assert!(!is_app_url(&url("file:///C:/Windows/")));
        assert!(!is_app_url(&url("about:srcdoc")));
    }

    #[test]
    fn the_ipc_surface_is_the_hosting_wizard_only() {
        // Exporting into a temp file proves the builder is consistent and
        // names exactly the wizard commands.
        let dir = std::env::temp_dir().join(format!(
            "rostalk-server-setup-bindings-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("bindings.ts");
        specta_builder()
            .export(specta_typescript::Typescript::default(), &path)
            .expect("export");
        let text = std::fs::read_to_string(&path).expect("read");
        let _ = std::fs::remove_dir_all(&dir);
        for command in [
            "hosting_pick_key",
            "hosting_probe",
            "hosting_preflight",
            "hosting_bundle_status",
            "hosting_install_start",
            "hosting_cancel",
            "hosting_load_credentials",
            "hosting_forget_credentials",
        ] {
            assert!(text.contains(&format!("\"{command}\"")), "{command}");
        }
        assert_eq!(text.matches("__TAURI_INVOKE<").count(), 8, "{text}");
    }
}
