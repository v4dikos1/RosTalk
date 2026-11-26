//! Tauri shell of the RosTalk desktop client.
//!
//! Stage 2.1 owns the window, the tray, the single-instance guard and the
//! typed IPC bridge. Stage 2.2 adds the real core: identity in the keychain,
//! the control-plane connection and the state store. Stage 2.4 adds persisted
//! settings, `rostalk://` deep links and the localized tray; the voice engine is
//! stage 2.3. The UI in `client/ui` only talks to the core through the
//! `CoreApi` interface (design 5.1).

mod diagnostics;
mod economy;
mod ipc;
mod logging;
mod native_stream;
mod ptt;
mod updates;

// `PathBuf` and the TypeScript exporter exist only for the debug build: the
// release client has no `--export-bindings` mode, so it embeds neither the
// build-machine path nor a way to write into the source tree (2026-11-22
// anti-cheat audit, "dev flags in release").
#[cfg(debug_assertions)]
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use rostalk_core::{
    AudioProcessing, ClientSettings, CoreEvent, CoreHandle, CueSettings, DiagnosticsConsent,
    GateSettings, LocalePreference, VoiceMediaCredentials,
};
use rostalk_platform::{IdentityVault, KeyringStore};
use rostalk_voice::{
    GateMode, MediaCredentials, MediaUpdate, ProcessingSettings, SoundSettings, VoiceConfig,
    VoiceHandle,
};
#[cfg(debug_assertions)]
use specta_typescript::Typescript;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_window_state::StateFlags;
use tauri_specta::{collect_commands, collect_events, Builder as SpectaBuilder};

/// Keychain service and account used for the local identity.
const KEYCHAIN_SERVICE: &str = "dev.rostalk.desktop";

/// Tauri application identifier. `app_data_dir()` appends it to `%APPDATA%`,
/// and the uninstaller removes both roaming and local data (stage 6.2).
const APP_IDENTIFIER: &str = "dev.rostalk.desktop";

/// Invitation link received from the OS before the window was ready.
#[derive(Debug, Default)]
pub struct DeepLinkState(Mutex<Option<String>>);

impl DeepLinkState {
    /// Remembers a link; the last one wins.
    pub fn set(&self, link: String) {
        if let Ok(mut pending) = self.0.lock() {
            *pending = Some(link);
        }
    }

    /// Takes the pending link, if any.
    #[must_use]
    pub fn take(&self) -> Option<String> {
        self.0.lock().ok().and_then(|mut pending| pending.take())
    }
}

fn specta_builder() -> SpectaBuilder<tauri::Wry> {
    SpectaBuilder::<tauri::Wry>::new()
        // Server ids are SQLite rowids and timestamps are Unix milliseconds;
        // both stay well below 2^53, so TypeScript `number` is exact here.
        .dangerously_cast_bigints_to_number()
        .commands(collect_commands![
            ipc::ping,
            ipc::log_ui_error,
            ipc::get_state,
            ipc::connect,
            ipc::probe_server,
            ipc::disconnect,
            ipc::join_channel,
            ipc::leave_channel,
            ipc::send_message,
            ipc::edit_message,
            ipc::delete_message,
            ipc::mark_read,
            ipc::chat_proxy,
            ipc::request_stream_credentials,
            ipc::set_watching,
            native_stream::native_stream_support,
            native_stream::start_native_stream,
            native_stream::stop_native_stream,
            native_stream::get_native_stream_state,
            native_stream::native_stream_stats,
            ipc::set_voice_state,
            ipc::toggle_voice_state,
            ipc::set_nickname,
            ipc::remove_server,
            ipc::identity_info,
            ipc::export_identity,
            ipc::import_identity,
            ipc::pick_identity_path,
            ipc::get_settings,
            ipc::update_settings,
            ipc::set_participant_preference,
            ipc::complete_onboarding,
            ipc::reset_onboarding,
            ipc::get_voice_state,
            ipc::get_voice_devices,
            ipc::set_voice_input_device,
            ipc::set_voice_output_device,
            ipc::set_voice_output_volume,
            ipc::set_voice_gate,
            ipc::set_voice_processing,
            ipc::set_voice_participant_volume,
            ipc::set_voice_participant_muted,
            ipc::set_voice_mic_test,
            ipc::set_voice_sounds,
            ipc::play_voice_sound,
            ipc::preview_voice_sound,
            ipc::set_voice_ptt_binding,
            ipc::stream_audio_support,
            ipc::get_stream_audio_state,
            ipc::start_stream_audio,
            ipc::stop_stream_audio,
            ipc::watch_stream_audio,
            ipc::set_stream_audio_volume,
            ipc::read_clipboard_text,
            ipc::take_pending_link,
            ipc::quit_app,
            ipc::admin_action,
            diagnostics::export_diagnostics,
            diagnostics::clear_diagnostics,
            ipc::check_for_update,
            ipc::install_update,
        ])
        .events(collect_events![
            ipc::CoreStateEvent,
            ipc::VoiceEventMessage,
            native_stream::NativeStreamEventMessage,
            ipc::DeepLinkEvent,
            updates::UpdateProgressEvent,
        ])
}

/// Path of the generated TypeScript bindings committed to the UI tree.
///
/// `client/src-tauri/../ui` resolves to `client/ui` both in a local checkout
/// and on CI, independent of the process working directory.
#[cfg(debug_assertions)]
fn bindings_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ui/src/core/tauri/bindings.ts")
}

/// Writes the TypeScript bindings for the IPC commands and events.
///
/// Exposed through `rostalk --export-bindings` so the check can run without a
/// Tauri test harness (the harness executable has no Windows application
/// manifest and cannot import the common controls library). `make gen-ipc`
/// and the Windows CI job use the same entry point.
///
/// Debug builds only: a release client must not carry a mode that writes into
/// the directory it was built in, nor the build-machine path (2026-11-22
/// anti-cheat audit).
#[cfg(debug_assertions)]
pub fn export_bindings() -> Result<PathBuf, String> {
    let path = bindings_path();
    specta_builder()
        .export(Typescript::default(), &path)
        .map_err(|err| err.to_string())?;
    Ok(path)
}

/// Builds the core with the Windows keychain as the identity store.
fn create_core(app: &tauri::AppHandle) -> Result<Arc<CoreHandle>, Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    adopt_legacy_data(&data_dir);
    std::fs::create_dir_all(&data_dir)?;

    let vault = IdentityVault::new(KEYCHAIN_SERVICE, KeyringStore::new(KEYCHAIN_SERVICE));
    match rostalk_platform::legacy::adopt_identity(
        &vault,
        &KeyringStore::new(rostalk_platform::legacy::LEGACY_CLIENT_IDENTIFIER),
    ) {
        Ok(true) => log::info!("adopted the identity of a previous Hearth install"),
        Ok(false) => {}
        Err(error) => log::warn!("could not adopt the previous Hearth identity: {error}"),
    }
    let emit_handle = app.clone();
    let events: Arc<dyn Fn(CoreEvent) + Send + Sync> =
        Arc::new(move |event| ipc::emit_core_event(&emit_handle, event));
    let core = CoreHandle::new(Arc::new(vault), &data_dir, events)?;
    Ok(Arc::new(core))
}

/// Copies servers and settings left by a client published as "Hearth" into the
/// new data folder on first start (ADR 0033). The old folder is kept: its own
/// uninstaller removes it, and a rollback finds it intact.
fn adopt_legacy_data(data_dir: &std::path::Path) {
    let Some(parent) = data_dir.parent() else {
        return;
    };
    let legacy = parent.join(rostalk_platform::legacy::LEGACY_CLIENT_IDENTIFIER);
    match rostalk_platform::legacy::adopt_dir(&legacy, data_dir) {
        Ok(true) => log::info!("adopted the settings of a previous Hearth install"),
        Ok(false) => {}
        Err(error) => log::warn!("could not adopt the previous Hearth settings: {error}"),
    }
}

/// Removes the local identity and the per-user data directories.
///
/// Called by the NSIS uninstaller (`--purge-data`) only when the user did not
/// choose to keep the data, and by nothing else. The identity is in the
/// Windows Credential Manager; settings, bookmarks and the WebView profile are
/// under `%APPDATA%\dev.rostalk.desktop` and `%LOCALAPPDATA%\dev.rostalk.desktop`.
/// The install directory itself is removed by the uninstaller.
pub fn purge_local_data() {
    let vault = IdentityVault::new(KEYCHAIN_SERVICE, KeyringStore::new(KEYCHAIN_SERVICE));
    if let Err(error) = vault.forget() {
        eprintln!("rostalk: could not remove the stored identity: {error}");
    }
    for variable in ["APPDATA", "LOCALAPPDATA"] {
        let Some(base) = std::env::var_os(variable) else {
            continue;
        };
        let dir = std::path::PathBuf::from(base).join(APP_IDENTIFIER);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                eprintln!("rostalk: could not remove {}: {error}", dir.display());
            }
        }
    }
}

/// Enables or disables the per-user logon entry, keeping the tray start.
///
/// `tauri-plugin-autostart` writes `HKCU\Software\Microsoft\Windows\
/// CurrentVersion\Run\RosTalk` with `--minimized`, which the same user can
/// remove; no service, driver or elevation is involved.
pub(crate) fn apply_autostart(app: &tauri::AppHandle, enabled: bool) {
    let manager = app.autolaunch();
    let current = manager.is_enabled().unwrap_or(false);
    if enabled == current {
        return;
    }
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    if let Err(error) = result {
        eprintln!("rostalk: could not update the autostart entry: {error}");
    }
}

/// Converts the persisted gate into the engine type.
fn engine_gate(gate: GateSettings) -> GateMode {
    match gate {
        GateSettings::Continuous => GateMode::Continuous,
        GateSettings::PushToTalk => GateMode::PushToTalk,
        GateSettings::VoiceActivation {
            threshold_db,
            hold_ms,
        } => GateMode::VoiceActivation {
            threshold_db,
            hold_ms,
        },
    }
}

/// Converts the persisted processing switches into the engine type.
fn engine_processing(processing: AudioProcessing) -> ProcessingSettings {
    ProcessingSettings {
        echo_cancellation: processing.echo_cancellation,
        noise_suppression: processing.noise_suppression,
        noise_model: match processing.noise_model {
            rostalk_core::NoiseSuppressor::Off => rostalk_voice::NoiseModel::Off,
            rostalk_core::NoiseSuppressor::WebRtc => rostalk_voice::NoiseModel::WebRtc,
            rostalk_core::NoiseSuppressor::RnNoise => rostalk_voice::NoiseModel::RnNoise,
            rostalk_core::NoiseSuppressor::DeepFilter => rostalk_voice::NoiseModel::DeepFilter,
        },
        gain_control: processing.gain_control,
        high_pass_filter: processing.high_pass_filter,
    }
}

/// Converts the persisted cue switches into the engine type.
fn engine_sounds(sounds: CueSettings) -> SoundSettings {
    SoundSettings {
        enabled: sounds.enabled,
        volume: f32::from(sounds.volume),
        set: match sounds.set {
            rostalk_core::SoundSet::Soft => rostalk_voice::CueSoundSet::Soft,
            rostalk_core::SoundSet::Bright => rostalk_voice::CueSoundSet::Bright,
        },
        channel: sounds.channel,
        microphone: sounds.microphone,
        sound: sounds.sound,
        streams: sounds.streams,
        messages: sounds.messages,
        connection: sounds.connection,
        push_to_talk: sounds.push_to_talk,
    }
}

/// Starts the voice engine with the persisted devices, gate and flags.
fn create_voice(
    app: &tauri::AppHandle,
    settings: &ClientSettings,
) -> Result<VoiceHandle, Box<dyn std::error::Error>> {
    let emit_handle = app.clone();
    let events: Arc<dyn Fn(rostalk_voice::VoiceEvent) + Send + Sync> =
        Arc::new(move |event| ipc::emit_voice_event(&emit_handle, event));
    let config = VoiceConfig {
        input_device: settings.voice.input_device.clone(),
        output_device: settings.voice.output_device.clone(),
        processing: engine_processing(settings.voice.processing),
        gate: engine_gate(settings.voice.gate),
        // Mute and deafen survive a restart (stage 2.3.1); the core also
        // restores them on the server after connecting.
        self_muted: settings.self_muted,
        deafened: settings.self_deafened,
        sounds: engine_sounds(settings.voice.sounds),
        output_volume: f32::from(settings.voice.output_volume) / 100.0,
        level_voices: settings.voice.level_voices,
        ..VoiceConfig::default()
    };
    Ok(rostalk_voice::start(config, events)?)
}

/// Connects the core's media credentials to the voice engine.
///
/// Credentials live only in the core's memory and in the voice task; they never
/// cross the IPC bridge.
fn wire_media(core: &CoreHandle, voice: &VoiceHandle) {
    let voice = voice.clone();
    core.set_media_sink(Arc::new(
        move |credentials: Option<VoiceMediaCredentials>| {
            let update = match credentials {
                Some(credentials) => MediaUpdate::Available(MediaCredentials {
                    url: credentials.url,
                    room: credentials.room,
                    token: credentials.token,
                    participant_identity: credentials.participant_identity,
                    channel_id: credentials.channel_id,
                    expires_in_seconds: credentials.expires_in_seconds,
                    generation: credentials.generation,
                    bitrate_bps: credentials.bitrate_bps,
                    stereo: credentials.stereo,
                    processing_enabled: credentials.processing_enabled,
                    tls_fingerprint: credentials.tls_fingerprint,
                }),
                None => MediaUpdate::Unavailable { channel_id: 0 },
            };
            if let Err(error) = voice.apply_media(update) {
                eprintln!(
                    "rostalk: voice engine is not running: {}",
                    error.user_message()
                );
            }
        },
    ));
}

/// Pushes the persisted audio settings into the running engine, without a
/// restart.
///
/// Called after every `update_settings` and once after start. Device changes
/// rebuild the audio tract inside the engine; the rest is a cheap state update.
///
/// Mute and deafen are deliberately not part of this path (stage P25). They are
/// live voice state: `set_voice_state` persists them after the server accepts a
/// change, while the settings object the UI saves can still carry an old
/// mirror. Writing those flags here would resurrect the old value and silently
/// mute (or unmute) somebody who just used the control bar or a hotkey. The
/// start path still restores the saved flags through `VoiceConfig` in
/// `create_voice`, and a profile load goes through the same core state.
pub(crate) fn apply_voice_settings(
    core: &Arc<CoreHandle>,
    voice: &VoiceHandle,
    settings: &ClientSettings,
) {
    let voice_settings = &settings.voice;
    if let Err(error) = voice.set_input_device(voice_settings.input_device.clone()) {
        log_voice("input device", &error);
    }
    if let Err(error) = voice.set_output_device(voice_settings.output_device.clone()) {
        log_voice("output device", &error);
    }
    if let Err(error) = voice.set_gate(engine_gate(voice_settings.gate)) {
        log_voice("gate", &error);
    }
    if let Err(error) = voice.set_processing(engine_processing(voice_settings.processing)) {
        log_voice("processing", &error);
    }
    if let Err(error) = voice.set_sounds(engine_sounds(voice_settings.sounds)) {
        log_voice("sounds", &error);
    }
    if let Err(error) = voice.set_output_volume(f32::from(voice_settings.output_volume) / 100.0) {
        log_voice("output volume", &error);
    }
    if let Err(error) = voice.set_level_voices(voice_settings.level_voices) {
        log_voice("voice leveling", &error);
    }
    sync_global_input(core, voice, settings);
}

fn log_voice(what: &str, error: &rostalk_voice::VoiceError) {
    eprintln!("rostalk: could not apply {what}: {}", error.user_message());
}

/// Accelerators already installed, so slider changes do not restart the global
/// hook on every settings write.
fn installed_global_input() -> &'static Mutex<Option<String>> {
    static INSTALLED: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    INSTALLED.get_or_init(|| Mutex::new(None))
}

/// The accelerator stored for one action.
fn hotkey_accelerator(
    settings: &ClientSettings,
    action: rostalk_core::HotkeyAction,
) -> Option<String> {
    settings
        .voice
        .hotkeys
        .iter()
        .find(|binding| binding.action == action)
        .and_then(|binding| binding.accelerator.clone())
}

/// One queued toggle and the session in which the key was pressed.
struct ToggleRequest {
    action: ptt::GlobalAction,
    session: Option<SessionKey>,
}

/// Identity of the live control session. A reconnect or a channel move changes
/// it, so a toggle queued in the old session is dropped instead of acting on the
/// new one.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionKey {
    server: Option<String>,
    self_user_id: u64,
    channel_id: u64,
    connected_at_unix_ms: i64,
}

fn session_key(state: &rostalk_core::CoreState) -> Option<SessionKey> {
    if state.connection != rostalk_core::ConnectionPhase::Connected {
        return None;
    }
    let self_user = state
        .users
        .iter()
        .find(|user| user.id == state.self_user_id)?;
    Some(SessionKey {
        server: state.server.as_ref().map(|server| server.id.clone()),
        self_user_id: state.self_user_id,
        channel_id: self_user.channel_id,
        connected_at_unix_ms: self_user.connected_at_unix_ms,
    })
}

/// A queued toggle may run only in the exact session it was pressed in.
fn session_matches(queued: Option<&SessionKey>, current: Option<&SessionKey>) -> bool {
    matches!((queued, current), (Some(queued), Some(current)) if queued == current)
}

/// Serializes the manual control-bar toggle and the global hotkey worker,
/// including the voice-engine update after the core request.
pub(crate) fn voice_toggle_lock() -> &'static tauri::async_runtime::Mutex<()> {
    static LOCK: OnceLock<tauri::async_runtime::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tauri::async_runtime::Mutex::new(()))
}

/// The single worker that applies hotkey toggles in order.
///
/// It has no private target cache: `CoreHandle::toggle_voice_state` reads the
/// persisted `VoicePreferences`, which both this worker and the manual IPC
/// update after a successful server request. That keeps a manual change in the
/// same channel visible to the next hotkey and still flips twice on two quick
/// presses before the server echo arrives.
struct ToggleWorker {
    core: Arc<CoreHandle>,
    voice: VoiceHandle,
}

impl ToggleWorker {
    async fn apply(&mut self, request: ToggleRequest) {
        let _guard = voice_toggle_lock().lock().await;
        let state = self.core.state();
        let current = session_key(&state);
        if !session_matches(request.session.as_ref(), current.as_ref()) {
            log::info!("global hotkey: dropped a toggle queued for another session");
            return;
        }
        let Some(self_user) = state
            .users
            .iter()
            .find(|user| user.id == state.self_user_id)
        else {
            return;
        };
        let idle_channel = state
            .channels
            .iter()
            .find(|channel| channel.id == self_user.channel_id)
            .is_some_and(|channel| channel.afk);
        match request.action {
            ptt::GlobalAction::ToggleMute if self_user.voice.server_muted || idle_channel => {
                log::info!("global hotkey: mute ignored, the server owns this state");
                return;
            }
            ptt::GlobalAction::ToggleDeafen if self_user.voice.server_deafened => {
                log::info!("global hotkey: deafen ignored, the server owns this state");
                return;
            }
            _ => {}
        }
        let field = match request.action {
            ptt::GlobalAction::ToggleMute => rostalk_core::VoiceToggle::Mute,
            ptt::GlobalAction::ToggleDeafen => rostalk_core::VoiceToggle::Deafen,
        };
        let next = match self.core.toggle_voice_state(field).await {
            Ok(next) => next,
            Err(error) => {
                log::warn!(
                    "global hotkey: the server rejected the change: {}",
                    error.message
                );
                return;
            }
        };
        match field {
            rostalk_core::VoiceToggle::Mute => {
                let _ = self.voice.set_self_muted(next);
            }
            rostalk_core::VoiceToggle::Deafen => {
                let _ = self.voice.set_deafened(next);
            }
        }
        log::info!("global hotkey: {:?} applied", request.action);
    }
}

/// The single long-lived toggle worker and its queue.
fn toggle_sender(
    core: Arc<CoreHandle>,
    voice: VoiceHandle,
) -> std::sync::mpsc::Sender<ToggleRequest> {
    static SENDER: OnceLock<std::sync::mpsc::Sender<ToggleRequest>> = OnceLock::new();
    SENDER
        .get_or_init(|| {
            let (sender, receiver) = std::sync::mpsc::channel();
            let mut worker = ToggleWorker { core, voice };
            let spawned = std::thread::Builder::new()
                .name("rostalk-hotkey-toggles".to_owned())
                .spawn(move || {
                    while let Ok(request) = receiver.recv() {
                        // The core call is async; the dedicated thread gives
                        // the toggles a strict order without a polling loop.
                        tauri::async_runtime::block_on(worker.apply(request));
                    }
                });
            if let Err(error) = spawned {
                log::warn!("could not start the global hotkey worker: {error}");
            }
            sender
        })
        .clone()
}

/// Forwards a global toggle from the Raw Input thread to the serial worker.
///
/// The server is authoritative: a moderator mute or deafen and the idle
/// channel (ADR 0009) are stronger than a local shortcut. The request goes
/// through the same core toggle as the control-bar buttons.
fn global_toggle_sink(core: Arc<CoreHandle>, voice: VoiceHandle) -> ptt::ToggleSink {
    let sender = toggle_sender(core.clone(), voice);
    Arc::new(move |action: ptt::GlobalAction| {
        // The Raw Input callback must return at once; the queue is unbounded.
        let session = session_key(&core.state());
        let _ = sender.send(ToggleRequest { action, session });
    })
}

/// Installs Raw Input for the configured global bindings when they changed.
///
/// A single key or mouse button is global by itself; a modifier combination
/// needs `backgroundHotkeys` (ADR 0012). Failure of one action does not stop
/// the others: an invalid push-to-talk binding still leaves valid mute/deafen
/// toggles registered. Failure is not fatal in any case: the voice-activation
/// gate keeps working without push-to-talk, and the UI shows the binding and
/// the installation error.
pub(crate) fn sync_global_input(
    core: &Arc<CoreHandle>,
    voice: &VoiceHandle,
    settings: &ClientSettings,
) {
    use rostalk_core::HotkeyAction;

    let config = ptt::GlobalConfig {
        push_to_talk: hotkey_accelerator(settings, HotkeyAction::PushToTalk),
        toggle_mute: hotkey_accelerator(settings, HotkeyAction::ToggleMute),
        toggle_deafen: hotkey_accelerator(settings, HotkeyAction::ToggleDeafen),
        background_hotkeys: settings.voice.background_hotkeys,
    };
    let signature = format!(
        "{}|{}|{}|{}",
        config.push_to_talk.as_deref().unwrap_or_default(),
        config.toggle_mute.as_deref().unwrap_or_default(),
        config.toggle_deafen.as_deref().unwrap_or_default(),
        config.background_hotkeys
    );
    let changed = installed_global_input()
        .lock()
        .map(|installed| installed.as_deref() != Some(signature.as_str()))
        .unwrap_or(true);
    if !changed {
        return;
    }
    let result = ptt::install_global_input(
        voice,
        &config,
        global_toggle_sink(core.clone(), voice.clone()),
    );
    if let Err(error) = voice.set_ptt_status(result.ptt) {
        log::warn!(
            "could not report the push-to-talk status: {}",
            error.user_message()
        );
    }
    if let Err(error) = voice.set_global_input_status(result.global) {
        log::warn!(
            "could not report the global input status: {}",
            error.user_message()
        );
    }
    if let Ok(mut installed) = installed_global_input().lock() {
        *installed = Some(signature);
    }
}

/// Disables the built-in WebView2 context menu (Back/Reload/Save as/Print).
///
/// Text selection and keyboard copy/paste are unaffected; the UI adds its own
/// small Cut/Copy/Paste menu for fields. WebView2 is the only webview backend
/// of the Windows client, so the call is Windows-only.
#[cfg(windows)]
fn disable_native_context_menu(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("rostalk: no main window to configure the context menu");
        return;
    };
    let result = window.with_webview(|webview| {
        // SAFETY: `with_webview` runs on the WebView2 UI thread. The COM
        // interfaces are valid for the lifetime of the webview.
        unsafe {
            let controller = webview.controller();
            let core = match controller.CoreWebView2() {
                Ok(core) => core,
                Err(error) => {
                    eprintln!("rostalk: WebView2 is not ready for the context menu: {error}");
                    return;
                }
            };
            let settings = match core.Settings() {
                Ok(settings) => settings,
                Err(error) => {
                    eprintln!("rostalk: could not read the WebView2 settings: {error}");
                    return;
                }
            };
            if let Err(error) = settings.SetAreDefaultContextMenusEnabled(false) {
                eprintln!("rostalk: could not disable the WebView2 context menu: {error}");
            }
        }
    });
    if let Err(error) = result {
        eprintln!("rostalk: could not configure the WebView2 context menu: {error}");
    }
}

/// No native context menu to disable outside Windows.
#[cfg(not(windows))]
fn disable_native_context_menu(_app: &tauri::AppHandle) {}

/// Shows the main window and asks Windows for the foreground without tao's
/// window-focus helper.
///
/// In economy mode the window may have been destroyed while hidden (design
/// 5.5); it is built again here from the same Tauri configuration and hydrates
/// from the core's snapshot. The tray icon and the single-instance guard belong
/// to the application, so both keep working without a window.
///
/// In tao 0.37.3 that helper (`platform_impl/windows/window.rs:139`) delegates
/// to `force_window_active`: when `SetForegroundWindow` fails it presses and
/// releases a synthetic ALT via `SendInput` (`window.rs:1526-1553`). That is
/// synthetic input, which the project forbids outright (CONTRIBUTING.md,
/// "Anti-cheat safety"; `docs/anticheat.md`; ADR 0012), and the
/// failure case is exactly ours: showing the window from the tray while a game
/// owns the foreground. So we call `SetForegroundWindow` for our own HWND
/// ourselves and stop there (stage 2.3.3a, `docs/anticheat.md`). A refused call
/// leaves the window unfocused; the user clicks it. There is deliberately no
/// fallback: no tao focus helper, no `SendInput`/`keybd_event`, no
/// `AttachThreadInput`.
fn show_main_window(app: &tauri::AppHandle) {
    let Some(window) = ensure_main_window(app) else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();

    // The Windows client is the shipped product; other targets only keep the
    // workspace buildable (CONTRIBUTING.md, "Environment").
    #[cfg(windows)]
    {
        // `hwnd()` returns `windows::Win32::Foundation::HWND`, a transparent
        // wrapper over `*mut c_void` (windows 0.62.2, pulled in by tauri).
        // windows-sys 0.61.2 declares its own `HWND` as exactly that pointer,
        // so the inner field is passed as is, with no extra conversion.
        match window.hwnd() {
            Ok(hwnd) => {
                // BOOL is 0 when Windows refuses (another process owns the
                // foreground, e.g. a running game). Then nothing happens and
                // the window stays unfocused on purpose.
                let _ = unsafe {
                    windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd.0)
                };
            }
            Err(error) => eprintln!("rostalk: no window handle for the foreground: {error}"),
        }
    }
}

/// Builds the main window if it is not there (first start or after economy
/// mode destroyed the WebView).
///
/// The window configuration comes from `tauri.conf.json` (with `"create":
/// false`, so this is the only place that builds it), which keeps the label,
/// size and security settings in one place. The window-state plugin restores
/// position and size. The new WebView starts with the same offline UI and calls
/// `getState`, which returns the core's live snapshot: nothing about the
/// session lives in the WebView.
///
/// `on_navigation` runs before the request: only the app's own origin may load,
/// so injected content cannot replace the UI with a remote page. A link to
/// another site is stopped here and stays in the chat text.
fn ensure_main_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(window) = app.get_webview_window("main") {
        return Some(window);
    }
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
    else {
        eprintln!("rostalk: tauri.conf.json has no main window");
        return None;
    };
    let built = tauri::WebviewWindowBuilder::from_config(app, &config)
        .and_then(|builder| builder.on_navigation(is_app_url).build());
    match built {
        Ok(window) => {
            // The WebView2 context menu is re-disabled here too: economy mode
            // destroys the WebView and a rebuilt one would get it back.
            disable_native_context_menu(app);
            Some(window)
        }
        Err(error) => {
            eprintln!("rostalk: could not build the main window: {error}");
            None
        }
    }
}

/// True for the only URLs the main WebView may load: the embedded app origin
/// and, in a development build, the Vite dev server.
///
/// Everything else is a navigation attempt from injected content or a link to
/// another site; neither may replace the privileged UI.
fn is_app_url(url: &tauri::Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    match url.scheme() {
        "tauri" => host.eq_ignore_ascii_case("localhost"),
        "http" | "https" => {
            host.eq_ignore_ascii_case("tauri.localhost")
                || (cfg!(debug_assertions)
                    && url.port() == Some(1420)
                    && (host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1"))
        }
        // WebView2 uses it before the first real navigation; it carries no
        // content and no origin.
        "about" => url.as_str().eq_ignore_ascii_case("about:blank"),
        _ => false,
    }
}

/// Builds the tray menu in the selected language.
fn tray_menu(app: &tauri::AppHandle, locale: LocalePreference) -> tauri::Result<Menu<tauri::Wry>> {
    let (show_label, quit_label, _) = ipc::tray_labels(locale);
    let show = MenuItemBuilder::with_id("show", show_label).build(app)?;
    let quit = MenuItemBuilder::with_id("quit", quit_label).build(app)?;
    MenuBuilder::new(app).items(&[&show, &quit]).build()
}

/// Re-labels the tray after a language change. Errors are non-fatal: the
/// window keeps working with the old labels until the next start.
pub fn apply_tray_language(app: &tauri::AppHandle, locale: LocalePreference) {
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };
    if let Ok(menu) = tray_menu(app, locale) {
        let _ = tray.set_menu(Some(menu));
    }
    let (_, _, tooltip) = ipc::tray_labels(locale);
    let _ = tray.set_tooltip(Some(tooltip));
}

fn setup_tray(app: &tauri::AppHandle, locale: LocalePreference) -> tauri::Result<()> {
    let menu = tray_menu(app, locale)?;
    let (_, _, tooltip) = ipc::tray_labels(locale);

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip(tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                // The economy mode leaves no window to close; mark the exit as
                // intentional so the last-window handler does not block it.
                economy::allow_exit();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Extracts a `rostalk://` invitation link from a command line.
fn find_deep_link(args: impl IntoIterator<Item = String>) -> Option<String> {
    args.into_iter()
        .map(|arg| arg.trim_matches('"').to_owned())
        .find(|arg| arg.starts_with("rostalk://"))
}

/// Starts the desktop application and blocks until the last window closes.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install the local logger before anything that can report a problem: the
    // voice engine logs stream errors and rebuilds, and a release build has no
    // console (stage 2.3.2a.1).
    logging::init();
    let specta = specta_builder();
    let invoke_handler = specta.invoke_handler();

    // Development builds keep the committed bindings in sync. The Windows CI
    // job re-exports them and fails on a diff, so a stale file cannot reach
    // `main` unnoticed.
    #[cfg(debug_assertions)]
    if let Err(err) = export_bindings() {
        eprintln!("rostalk: failed to export IPC bindings: {err}");
    }

    let pending_link = DeepLinkState::default();
    if let Some(link) = find_deep_link(std::env::args().skip(1)) {
        pending_link.set(link);
    }
    // Autostart launches `rostalk.exe --minimized`; the window is created by
    // tauri.conf.json, so it is hidden in `setup` below.
    let start_minimized = std::env::args().skip(1).any(|arg| arg == "--minimized");

    let result = tauri::Builder::default()
        // The single-instance plugin must be registered first.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(link) = find_deep_link(argv) {
                app.state::<DeepLinkState>().set(link.clone());
                ipc::emit_deep_link(app, link);
            }
            show_main_window(app);
        }))
        // Stage 6.2: the optional logon entry starts the client in the tray.
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("RosTalk")
                .arg("--minimized")
                .build(),
        )
        // Stage 6.2: signed updates. Endpoints and the public key come from
        // the settings/config; the plugin exposes no command to the WebView,
        // so the whole flow stays behind the core IPC (capabilities/default).
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Visibility and decorations are not restored on purpose. Visibility:
        // the window-state plugin calls tao's window-focus helper after `show`
        // while restoring it, and that call can fall back to a synthetic ALT
        // (`show_main_window` above). Decorations: the plugin would restore the
        // old `decorated: true` from a pre-P7 state and put the system caption
        // back on top of the custom title bar. Both belong to `tauri.conf.json`
        // now; only size, position and the maximized flag are worth restoring.
        // Stage 2.3.3a and ADR 0024.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    StateFlags::all() & !StateFlags::VISIBLE & !StateFlags::DECORATIONS,
                )
                .build(),
        )
        .manage(pending_link)
        .manage(ipc::IdentityPathState::default())
        .manage(std::sync::Arc::new(
            native_stream::NativeStreamManager::default(),
        ))
        .invoke_handler(invoke_handler)
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let Some(core) = window.app_handle().try_state::<Arc<CoreHandle>>() else {
                    return;
                };
                // Settings decide whether closing hides the window (tray keeps
                // voice running) or quits the client (ADR 0010). Hidden for a
                // while, the WebView is destroyed by economy mode (design 5.5).
                if core.settings().close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    // A real quit: the last-window handler must not keep the
                    // process alive in the tray.
                    economy::allow_exit();
                }
            }
            if let WindowEvent::Destroyed = event {
                // A native publisher is not tied to the WebView lifetime. Do
                // not leave an invisible stream running when the main window is
                // destroyed by economy mode; the WebView2 path ends with it.
                if window.label() == "main" {
                    if let Some(manager) = window
                        .app_handle()
                        .try_state::<Arc<native_stream::NativeStreamManager>>()
                    {
                        manager.stop_active();
                    }
                    if let Some(voice) = window.app_handle().try_state::<VoiceHandle>() {
                        let _ = voice.stop_stream_audio();
                    }
                }
            }
        })
        .setup(move |app| {
            // Events must be mounted before the core or the voice engine can
            // emit the first snapshot: `tauri-specta` panics inside `emit`
            // when the registry is missing, and a panic in the voice thread
            // would leave the application without audio (stage 2.3.1b).
            specta.mount_events(app);
            let core = create_core(app.handle())?;
            let settings = core.settings();
            // The settings are the only source of the diagnostics consent: the
            // file is opened here, after the load, and never before.
            logging::set_enabled(settings.diagnostics.consent == DiagnosticsConsent::Granted);
            let voice = create_voice(app.handle(), &settings)?;
            wire_media(&core, &voice);
            // The engine started from these values; this also installs the
            // configured global bindings and reports the push-to-talk status.
            apply_voice_settings(&core, &voice, &settings);
            app.manage(voice);
            app.manage(core);
            apply_autostart(app.handle(), settings.autostart);
            setup_tray(app.handle(), settings.locale)?;
            // `create: false` in tauri.conf.json: the window is built here so
            // the navigation guard and the context-menu tweak are attached
            // before the first page load. Autostart (`--minimized`, stage
            // 6.2) starts in the tray: no window is built until the user
            // opens it from the tray, which `show_main_window` handles.
            if !start_minimized {
                let _ = ensure_main_window(app.handle());
            }
            // Economy mode: the window is destroyed after the configured time
            // in the tray; the core and the voice engine stay alive.
            economy::start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match result {
        Ok(app) => app,
        Err(err) => {
            eprintln!("rostalk: failed to start: {err}");
            std::process::exit(1);
        }
    };
    // With economy mode the process may legitimately have no window: the tray
    // is the way back and the core keeps voice running. Only an explicit Quit
    // (or closing a non-tray window) is allowed to end the process.
    app.run(|_app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if economy::keep_running() {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Exit => {
            // Never leave a native capture thread or the computer-audio
            // capture running after the process starts shutting down.
            if let Some(manager) = _app.try_state::<Arc<native_stream::NativeStreamManager>>() {
                manager.stop_active();
            }
            if let Some(voice) = _app.try_state::<VoiceHandle>() {
                let _ = voice.stop_stream_audio();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> tauri::Url {
        tauri::Url::parse(value).expect("test url")
    }

    #[test]
    fn only_the_app_origin_may_navigate() {
        for allowed in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html?x=1#top",
            "about:blank",
        ] {
            assert!(is_app_url(&url(allowed)), "{allowed}");
        }
        for denied in [
            "https://example.com/",
            "http://tauri.localhost.evil.example/",
            "file:///C:/Windows/System32/drivers/etc/hosts",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "http://localhost:1421/",
            "http://127.0.0.1:8080/",
            "ipc://localhost/",
        ] {
            assert!(!is_app_url(&url(denied)), "{denied}");
        }
        // The Vite dev server is allowed in a development build only.
        assert_eq!(
            is_app_url(&url("http://localhost:1420/")),
            cfg!(debug_assertions)
        );
    }

    #[test]
    fn a_toggle_queued_in_another_session_is_dropped() {
        let base = SessionKey {
            server: Some("server".to_owned()),
            self_user_id: 1,
            channel_id: 2,
            connected_at_unix_ms: 10,
        };
        assert!(session_matches(Some(&base), Some(&base.clone())));
        let moved = SessionKey {
            channel_id: 3,
            ..base.clone()
        };
        assert!(!session_matches(Some(&base), Some(&moved)));
        let reconnected = SessionKey {
            connected_at_unix_ms: 11,
            ..base.clone()
        };
        assert!(!session_matches(Some(&base), Some(&reconnected)));
        assert!(!session_matches(None, Some(&base)));
        assert!(!session_matches(Some(&base), None));
    }
}
