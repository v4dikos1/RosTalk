//! Typed IPC surface of the Rust core (stages 2.2, 2.3 and 2.4).
//!
//! Every command and event is registered with `tauri-specta`, so the UI gets
//! its types from `bindings.ts` instead of hand-written duplicates. The UI has
//! no network access of its own: all server traffic goes through these
//! commands.
//!
//! Settings live in the core and are persisted next to `servers.json`; the
//! audio commands drive the real stage 2.3 voice engine (devices, gate,
//! processing, level meter and loopback check). There is one audio tract.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_specta::Event as _;

use rostalk_core::{
    AudioProcessing, ChatProxyView, ChatTarget, ClientSettings, ConnectRequest, CoreError,
    CoreErrorCode, CoreEvent, CoreHandle, CoreState, CueSettings, GateSettings, HotkeyAction,
    IdentityInfo, LocalePreference, ParticipantSettings, ServerProbeView, VoiceStatePatch,
};
use rostalk_voice::loopback::StreamAudioSupport;
use rostalk_voice::stream_audio::{stream_gain, StreamAudioState};
use rostalk_voice::{
    DeviceList, EventSound, GateMode, ProcessingSettings, SoundSettings, VoiceError, VoiceEvent,
    VoiceHandle, VoiceState,
};

/// One event sent to the WebView: a full snapshot or one state delta.
///
/// A newtype wrapper is needed because the `tauri_specta::Event` derive is
/// implemented in this crate, while the payload type lives in `rostalk-core`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(transparent)]
pub struct CoreStateEvent(pub CoreEvent);

/// Voice engine events: state, levels, statistics and device changes.
///
/// The payload never contains media tokens or URLs; those stay inside the
/// voice task and the core.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(transparent)]
pub struct VoiceEventMessage(pub VoiceEvent);

/// An invitation link received from the OS (`rostalk://...`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(transparent)]
pub struct DeepLinkEvent(pub String);

/// Path the user chose in the native identity file dialog.
///
/// Export and import are the only commands that touch an arbitrary filesystem
/// path, and the WebView is the caller. Remembering the dialog result keeps the
/// page from turning them into a general write/decrypt primitive for paths it
/// picked itself: only the file the user selected in a native, modal dialog can
/// be written or read. The value is replaced on every pick, so a retry after a
/// wrong password works without choosing the file again.
#[derive(Debug, Default)]
pub struct IdentityPathState(Mutex<Option<String>>);

impl IdentityPathState {
    /// Remembers the file chosen in the dialog.
    ///
    /// A cancelled dialog keeps the previous choice: cancelling must not be a
    /// way for a page to invalidate the approval a user already gave.
    fn remember(&self, path: Option<String>) {
        let Some(path) = path else {
            return;
        };
        if let Ok(mut current) = self.0.lock() {
            *current = Some(path);
        }
    }

    /// True when `path` is the file the user selected in the dialog.
    #[must_use]
    pub fn approves(&self, path: &str) -> bool {
        self.0
            .lock()
            .map(|current| current.as_deref() == Some(path))
            .unwrap_or(false)
    }
}

/// Health check kept from stage 2.1; the about pane uses it to prove the IPC
/// round trip and to show the real client version.
#[tauri::command]
#[specta::specta]
pub fn ping() -> rostalk_core::PingReply {
    rostalk_core::ping()
}

/// Writes one interface error into the local diagnostics log.
///
/// The page sends only the panel name, the error message and the React
/// component stack; no tokens, keys, messages or other user content. Lengths
/// are bounded so a render loop cannot fill the log.
#[tauri::command]
#[specta::specta]
pub fn log_ui_error(scope: String, message: String, stack: Option<String>) {
    let scope = clip(&scope, 64);
    let message = message.replace(['\r', '\n'], " ");
    let message = clip(&message, 500);
    match stack.as_deref().map(|value| clip(value, 2_000)) {
        Some(stack) => log::error!(target: "ui", "interface error in {scope}: {message}\n{stack}"),
        None => log::error!(target: "ui", "interface error in {scope}: {message}"),
    }
}

/// Truncates a string at a character boundary, keeping at most `max` chars.
fn clip(value: &str, max: usize) -> &str {
    match value.char_indices().nth(max) {
        Some((index, _)) => &value[..index],
        None => value,
    }
}

/// Returns the current snapshot. Called once when the window mounts; every
/// later change arrives as a [`CoreStateEvent`].
#[tauri::command]
#[specta::specta]
pub fn get_state(core: State<'_, Arc<CoreHandle>>) -> CoreState {
    core.state()
}

/// Connects to a server: by invitation link or by a typed `host:port`
/// (ADR 0008). Resolves after `Welcome`.
#[tauri::command]
#[specta::specta]
pub async fn connect(
    core: State<'_, Arc<CoreHandle>>,
    request: ConnectRequest,
) -> Result<CoreState, CoreError> {
    core.connect(request).await
}

/// Reads the TLS certificate a direct login would pin, without sending any
/// credential. The UI shows the SHA-256 to the user (ADR 0008).
#[tauri::command]
#[specta::specta]
pub async fn probe_server(
    core: State<'_, Arc<CoreHandle>>,
    host: String,
) -> Result<ServerProbeView, CoreError> {
    core.probe_server(&host).await
}

/// Closes the active connection and clears the channel tree.
#[tauri::command]
#[specta::specta]
pub async fn disconnect(core: State<'_, Arc<CoreHandle>>) -> Result<(), CoreError> {
    core.disconnect().await
}

/// Joins a voice channel.
#[tauri::command]
#[specta::specta]
pub async fn join_channel(
    core: State<'_, Arc<CoreHandle>>,
    channel_id: u64,
    password: Option<String>,
) -> Result<(), CoreError> {
    core.join_channel(channel_id, password).await
}

/// Leaves the current voice channel.
#[tauri::command]
#[specta::specta]
pub async fn leave_channel(core: State<'_, Arc<CoreHandle>>) -> Result<(), CoreError> {
    core.leave_channel().await
}

/// Posts a channel or direct message. Attachments must already be uploaded
/// through the loopback proxy and identified by their ids.
#[tauri::command]
#[specta::specta]
pub async fn send_message(
    core: State<'_, Arc<CoreHandle>>,
    target: ChatTarget,
    body: String,
    attachment_ids: Vec<u64>,
) -> Result<(), CoreError> {
    core.send_message(target, body, attachment_ids).await
}

/// Replaces the body of a message.
#[tauri::command]
#[specta::specta]
pub async fn edit_message(
    core: State<'_, Arc<CoreHandle>>,
    message_id: u64,
    body: String,
) -> Result<(), CoreError> {
    core.edit_message(message_id, body).await
}

/// Removes a message and its attachments.
#[tauri::command]
#[specta::specta]
pub async fn delete_message(
    core: State<'_, Arc<CoreHandle>>,
    message_id: u64,
) -> Result<(), CoreError> {
    core.delete_message(message_id).await
}

/// Advances the read marker of a conversation.
#[tauri::command]
#[specta::specta]
pub async fn mark_read(
    core: State<'_, Arc<CoreHandle>>,
    target: ChatTarget,
    up_to_message_id: u64,
) -> Result<(), CoreError> {
    core.mark_read(target, up_to_message_id).await
}

/// Coordinates of the loopback chat proxy, `null` while disconnected.
#[tauri::command]
#[specta::specta]
pub fn chat_proxy(core: State<'_, Arc<CoreHandle>>) -> Option<ChatProxyView> {
    core.chat_proxy()
}

/// Screen-share signalling coordinates (stage 5.1). The media token and the
/// certificate pin stay in the core; the page only gets the loopback URL.
#[tauri::command]
#[specta::specta]
pub async fn request_stream_credentials(
    core: State<'_, Arc<CoreHandle>>,
    channel_id: u64,
) -> Result<rostalk_core::StreamCredentialsView, CoreError> {
    core.request_stream_credentials(channel_id).await
}

/// Replaces the set of screen shares the caller watches (stage P12).
/// The page sends the whole set after every watch/unwatch; the server keeps
/// only live shares of the caller's own voice channel. The audience comes back
/// in the presence (`watchingUserIds`) of every participant, so the page never
/// invents a viewer list of its own.
#[tauri::command]
#[specta::specta]
pub async fn set_watching(
    core: State<'_, Arc<CoreHandle>>,
    streamer_ids: Vec<u64>,
) -> Result<(), CoreError> {
    core.set_watching(streamer_ids).await
}

/// Changes own microphone/deafen/away flags.
#[tauri::command]
#[specta::specta]
pub async fn set_voice_state(
    core: State<'_, Arc<CoreHandle>>,
    voice: State<'_, VoiceHandle>,
    patch: VoiceStatePatch,
) -> Result<(), CoreError> {
    core.set_voice_state(patch.clone()).await?;
    if let Some(muted) = patch.self_muted {
        voice
            .set_self_muted(muted)
            .map_err(|error| CoreError::internal(error.user_message()))?;
    }
    if let Some(deafened) = patch.self_deafened {
        voice
            .set_deafened(deafened)
            .map_err(|error| CoreError::internal(error.user_message()))?;
    }
    Ok(())
}

/// Current voice engine state, for a window that opens after the event.
#[tauri::command]
#[specta::specta]
pub fn get_voice_state(voice: State<'_, VoiceHandle>) -> VoiceState {
    voice.state()
}

/// Input and output devices with the current defaults.
#[tauri::command]
#[specta::specta]
pub fn get_voice_devices(voice: State<'_, VoiceHandle>) -> DeviceList {
    voice.devices()
}

/// Selects an input device; `null` means the system default.
#[tauri::command]
#[specta::specta]
pub fn set_voice_input_device(
    core: State<'_, Arc<CoreHandle>>,
    voice: State<'_, VoiceHandle>,
    id: Option<String>,
) -> Result<(), CoreError> {
    voice
        .set_input_device(id.clone())
        .map_err(|error| CoreError::internal(error.user_message()))?;
    let mut current = core.settings();
    current.voice.input_device = id;
    core.update_settings(current)?;
    Ok(())
}

/// Selects an output device; `null` means the system default.
#[tauri::command]
#[specta::specta]
pub fn set_voice_output_device(
    core: State<'_, Arc<CoreHandle>>,
    voice: State<'_, VoiceHandle>,
    id: Option<String>,
) -> Result<(), CoreError> {
    voice
        .set_output_device(id.clone())
        .map_err(|error| CoreError::internal(error.user_message()))?;
    let mut current = core.settings();
    current.voice.output_device = id;
    core.update_settings(current)?;
    Ok(())
}

/// Master playback volume, 0..200 %; persisted for the next start.
#[tauri::command]
#[specta::specta]
pub fn set_voice_output_volume(
    core: State<'_, Arc<CoreHandle>>,
    voice: State<'_, VoiceHandle>,
    volume: u8,
) -> Result<(), CoreError> {
    let volume = volume.min(200);
    voice
        .set_output_volume(f32::from(volume) / 100.0)
        .map_err(|error| CoreError::internal(error.user_message()))?;
    let mut current = core.settings();
    current.voice.output_volume = volume;
    core.update_settings(current)?;
    Ok(())
}

/// Replaces the transmission gate (push-to-talk, voice activation, continuous)
/// and persists it, so the next start uses the same mode.
#[tauri::command]
#[specta::specta]
pub fn set_voice_gate(
    core: State<'_, Arc<CoreHandle>>,
    voice: State<'_, VoiceHandle>,
    mode: GateMode,
) -> Result<(), CoreError> {
    voice
        .set_gate(mode)
        .map_err(|error| CoreError::internal(error.user_message()))?;
    persist_gate(&core, mode)?;
    Ok(())
}

/// Enables or disables the APM stages and persists them.
#[tauri::command]
#[specta::specta]
pub fn set_voice_processing(
    core: State<'_, Arc<CoreHandle>>,
    voice: State<'_, VoiceHandle>,
    settings: ProcessingSettings,
) -> Result<(), CoreError> {
    voice
        .set_processing(settings)
        .map_err(|error| CoreError::internal(error.user_message()))?;
    let mut current = core.settings();
    current.voice.processing = core_processing(settings);
    core.update_settings(current)?;
    Ok(())
}

/// Replaces the event cue switches and persists them.
#[tauri::command]
#[specta::specta]
pub fn set_voice_sounds(
    core: State<'_, Arc<CoreHandle>>,
    voice: State<'_, VoiceHandle>,
    settings: SoundSettings,
) -> Result<(), CoreError> {
    voice
        .set_sounds(settings)
        .map_err(|error| CoreError::internal(error.user_message()))?;
    let mut current = core.settings();
    current.voice.sounds = CueSettings {
        enabled: settings.enabled,
        volume: settings.volume.clamp(0.0, 100.0).round() as u8,
        set: match settings.set {
            rostalk_voice::CueSoundSet::Soft => rostalk_core::SoundSet::Soft,
            rostalk_voice::CueSoundSet::Bright => rostalk_core::SoundSet::Bright,
        },
        channel: settings.channel,
        microphone: settings.microphone,
        sound: settings.sound,
        streams: settings.streams,
        messages: settings.messages,
        connection: settings.connection,
        push_to_talk: settings.push_to_talk,
    };
    core.update_settings(current)?;
    Ok(())
}

/// Plays one event cue. UI-originated events (streams, messages) use this;
/// the voice engine applies the saved switches and volume.
#[tauri::command]
#[specta::specta]
pub fn play_voice_sound(voice: State<'_, VoiceHandle>, sound: EventSound) -> Result<(), CoreError> {
    voice
        .play_sound(sound)
        .map_err(|error| CoreError::internal(error.user_message()))
}

/// Plays one cue for the settings window, ignoring the switches.
#[tauri::command]
#[specta::specta]
pub fn preview_voice_sound(
    voice: State<'_, VoiceHandle>,
    sound: EventSound,
) -> Result<(), CoreError> {
    voice
        .preview_sound(sound)
        .map_err(|error| CoreError::internal(error.user_message()))
}

/// Per-participant playback volume, 0..200 %.
#[tauri::command]
#[specta::specta]
pub fn set_voice_participant_volume(
    voice: State<'_, VoiceHandle>,
    identity: String,
    volume: f32,
) -> Result<(), CoreError> {
    voice
        .set_participant_volume(identity, volume)
        .map_err(|error| CoreError::internal(error.user_message()))
}

/// Local mute of one participant.
#[tauri::command]
#[specta::specta]
pub fn set_voice_participant_muted(
    voice: State<'_, VoiceHandle>,
    identity: String,
    muted: bool,
) -> Result<(), CoreError> {
    voice
        .set_participant_muted(identity, muted)
        .map_err(|error| CoreError::internal(error.user_message()))
}

/// Whether the core can capture the computer audio without RosTalk's own sound
/// (WASAPI process loopback, stage P15). The stream dialog asks once before
/// it offers the option; `supported: false` means the WebView fallback with
/// the echo warning.
#[tauri::command]
#[specta::specta]
pub async fn stream_audio_support(
    voice: State<'_, VoiceHandle>,
) -> Result<StreamAudioSupport, CoreError> {
    let voice = voice.inner().clone();
    tauri::async_runtime::spawn_blocking(move || voice.stream_audio_support())
        .await
        .map_err(|error| CoreError::internal(format!("stream audio probe: {error}")))
}

/// Last known stream-audio state, for a window that opens after the event.
#[tauri::command]
#[specta::specta]
pub fn get_stream_audio_state(voice: State<'_, VoiceHandle>) -> StreamAudioState {
    voice.stream_audio_state()
}

/// Starts capturing the computer audio (everything except RosTalk) and
/// publishes it from the voice participant (ADR 0027).
#[tauri::command]
#[specta::specta]
pub async fn start_stream_audio(voice: State<'_, VoiceHandle>) -> Result<(), CoreError> {
    let voice = voice.inner().clone();
    voice.start_stream_audio().await.map_err(stream_audio_error)
}

/// Stops the own stream-audio capture.
#[tauri::command]
#[specta::specta]
pub fn stop_stream_audio(voice: State<'_, VoiceHandle>) -> Result<(), CoreError> {
    voice
        .stop_stream_audio()
        .map_err(|error| CoreError::internal(error.user_message()))
}

/// Plays (or stops) one user's stream audio through the core mixer, where it
/// also feeds the echo canceller's reference.
#[tauri::command]
#[specta::specta]
pub fn watch_stream_audio(
    voice: State<'_, VoiceHandle>,
    user_id: u64,
    watching: bool,
) -> Result<(), CoreError> {
    voice
        .watch_stream_audio(user_id, watching)
        .map_err(|error| CoreError::internal(error.user_message()))
}

/// Volume 0..200 % and local mute of one user's stream audio.
#[tauri::command]
#[specta::specta]
pub fn set_stream_audio_volume(
    voice: State<'_, VoiceHandle>,
    user_id: u64,
    volume: u16,
    muted: bool,
) -> Result<(), CoreError> {
    let (gain, muted) = stream_gain(volume, muted);
    voice
        .set_stream_audio_volume(user_id, gain, muted)
        .map_err(|error| CoreError::internal(error.user_message()))
}

fn stream_audio_error(error: VoiceError) -> CoreError {
    match error {
        VoiceError::PublishNotAllowed => CoreError::new(
            CoreErrorCode::ServerError,
            "the server does not allow streaming audio in this channel",
        ),
        other => CoreError::internal(other.user_message()),
    }
}

/// Starts or stops the microphone loopback (mic test, no server needed).
#[tauri::command]
#[specta::specta]
pub fn set_voice_mic_test(voice: State<'_, VoiceHandle>, enabled: bool) -> Result<(), CoreError> {
    voice
        .set_mic_test(enabled)
        .map_err(|error| CoreError::internal(error.user_message()))
}

/// Changes the global push-to-talk binding and persists it.
///
/// Only single keys and the X1/X2 default are supported by Raw Input; the
/// settings window records the value. `null` restores the mouse-button pair.
#[tauri::command]
#[specta::specta]
pub fn set_voice_ptt_binding(
    core: State<'_, Arc<CoreHandle>>,
    voice: State<'_, VoiceHandle>,
    accelerator: Option<String>,
) -> Result<(), CoreError> {
    let mut current = core.settings();
    if let Some(binding) = current
        .voice
        .hotkeys
        .iter_mut()
        .find(|binding| binding.action == HotkeyAction::PushToTalk)
    {
        binding.accelerator = accelerator;
    }
    let saved = core.update_settings(current)?;
    crate::sync_push_to_talk(&voice, &saved);
    Ok(())
}

/// Reads text from the OS clipboard for the custom right-click menu.
///
/// The WebView2 context menu is disabled (stage 2.3.1); Chromium does not allow
/// `execCommand("paste")`, so Paste goes through this command and
/// `insertText`. The text never leaves the machine and is not logged.
#[tauri::command]
#[specta::specta]
pub fn read_clipboard_text() -> Result<String, CoreError> {
    rostalk_platform::clipboard::read_text().map_err(|error| CoreError::internal(error.to_string()))
}

/// Sends one encoded `rostalk.v1.AdminAction` and returns the encoded
/// `AdminResult`. The UI owns the generated TypeScript messages, so the IPC
/// layer stays a thin relay and the wire contract has one source of truth.
///
/// The bytes never contain a bearer token in transit to the server: token
/// creation is a server-side operation whose reply carries the secret once.
#[tauri::command]
#[specta::specta]
pub async fn admin_action(
    core: State<'_, Arc<CoreHandle>>,
    request: Vec<u8>,
) -> Result<Vec<u8>, CoreError> {
    core.admin_action(request).await
}

/// Changes the display name on the server and saves it in the local profile.
#[tauri::command]
#[specta::specta]
pub async fn set_nickname(
    core: State<'_, Arc<CoreHandle>>,
    nickname: String,
) -> Result<(), CoreError> {
    core.set_nickname(nickname).await
}

/// Forgets a saved server.
#[tauri::command]
#[specta::specta]
pub fn remove_server(
    core: State<'_, Arc<CoreHandle>>,
    id: String,
) -> Result<Vec<rostalk_core::ServerBookmark>, CoreError> {
    core.remove_server(&id)
}

/// Returns the local Ed25519 identity (public parts only).
#[tauri::command]
#[specta::specta]
pub async fn identity_info(core: State<'_, Arc<CoreHandle>>) -> Result<IdentityInfo, CoreError> {
    core.identity_info().await
}

/// Writes the identity to a password protected file.
///
/// The path must be the file chosen in the native dialog: see
/// [`IdentityPathState`]. Without that check a page could write an encrypted
/// identity (and create directories) anywhere on disk, or overwrite data it has
/// no other way to reach.
#[tauri::command]
#[specta::specta]
pub async fn export_identity(
    core: State<'_, Arc<CoreHandle>>,
    chosen: State<'_, IdentityPathState>,
    path: String,
    password: String,
) -> Result<(), CoreError> {
    ensure_chosen(&chosen, &path)?;
    core.export_identity(path, password).await
}

/// Replaces the local identity from a password protected file.
///
/// Importing is gated the same way: it is the only other command that reads an
/// arbitrary path, and a page must not be able to point the Argon2id password
/// check (or the keychain write) at a file of its choosing.
#[tauri::command]
#[specta::specta]
pub async fn import_identity(
    core: State<'_, Arc<CoreHandle>>,
    chosen: State<'_, IdentityPathState>,
    path: String,
    password: String,
) -> Result<IdentityInfo, CoreError> {
    ensure_chosen(&chosen, &path)?;
    core.import_identity(path, password).await
}

/// Opens a native file dialog for an identity file. The WebView only receives
/// the chosen path, never filesystem access.
#[tauri::command]
#[specta::specta]
pub async fn pick_identity_path(
    chosen: State<'_, IdentityPathState>,
    mode: String,
) -> Result<Option<String>, CoreError> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let dialog = rfd::FileDialog::new()
            .add_filter("RosTalk identity", &["rostalkkey"])
            .set_file_name("rostalk-identity.rostalkkey");
        let picked = if mode == "save" {
            dialog.save_file()
        } else {
            dialog.pick_file()
        };
        picked.map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten();
    chosen.remember(picked.clone());
    Ok(picked)
}

/// Accepts only the path the user selected in the native dialog.
fn ensure_chosen(chosen: &IdentityPathState, path: &str) -> Result<(), CoreError> {
    if chosen.approves(path) {
        return Ok(());
    }
    Err(CoreError::new(
        CoreErrorCode::InvalidRequest,
        "the identity file must be chosen with the native dialog",
    ))
}

/// Persisted client settings.
#[tauri::command]
#[specta::specta]
pub fn get_settings(core: State<'_, Arc<CoreHandle>>) -> ClientSettings {
    core.settings()
}

/// Replaces and persists the settings; returns the sanitised value.
///
/// The running voice engine receives the new devices, gate, processing, cue
/// switches and mute flags immediately, without restarting the application.
#[tauri::command]
#[specta::specta]
pub fn update_settings(
    app: tauri::AppHandle,
    core: State<'_, Arc<CoreHandle>>,
    voice: State<'_, VoiceHandle>,
    settings: ClientSettings,
) -> Result<ClientSettings, CoreError> {
    let previous = core.settings();
    let saved = core.update_settings(settings)?;
    if saved.locale != previous.locale {
        crate::apply_tray_language(&app, saved.locale);
    }
    // Consent takes effect immediately: granting opens the file, revoking
    // closes it. `set_enabled` is idempotent, so unrelated writes are cheap.
    crate::logging::set_enabled(
        saved.diagnostics.consent == rostalk_core::DiagnosticsConsent::Granted,
    );
    if saved.autostart != previous.autostart {
        crate::apply_autostart(&app, saved.autostart);
    }
    crate::apply_voice_settings(&voice, &saved);
    Ok(saved)
}

/// Stores local volume and mute for one user (`server_id:user_id`).
#[tauri::command]
#[specta::specta]
pub fn set_participant_preference(
    core: State<'_, Arc<CoreHandle>>,
    key: String,
    volume: u8,
    muted: bool,
) -> Result<Vec<ParticipantSettings>, CoreError> {
    core.set_participant_preference(&key, volume, muted)
}

/// Finishes the first-run wizard and remembers the nickname.
#[tauri::command]
#[specta::specta]
pub fn complete_onboarding(
    core: State<'_, Arc<CoreHandle>>,
    nickname: String,
) -> Result<ClientSettings, CoreError> {
    core.complete_onboarding(&nickname)
}

/// Shows the first-run wizard again on the next start.
#[tauri::command]
#[specta::specta]
pub fn reset_onboarding(core: State<'_, Arc<CoreHandle>>) -> Result<ClientSettings, CoreError> {
    core.reset_onboarding()
}

/// A `rostalk://` link received before the window was ready.
#[tauri::command]
#[specta::specta]
pub fn take_pending_link(state: State<'_, crate::DeepLinkState>) -> Option<String> {
    state.take()
}

/// Checks the configured update source for a newer signed release (stage 6.2).
///
/// The source is the persisted setting or `ROSTALK_UPDATE_SOURCE`; nothing is
/// downloaded here. The UI shows the version and asks before installing.
#[tauri::command]
#[specta::specta]
pub async fn check_for_update(
    app: tauri::AppHandle,
    core: State<'_, Arc<CoreHandle>>,
) -> Result<crate::updates::UpdateCheck, CoreError> {
    crate::updates::check_for_update(&app, &core.settings()).await
}

/// Downloads, verifies and installs the announced update (stage 6.2).
///
/// On Windows the client exits when the NSIS installer starts; the installer
/// restarts it afterwards. The caller must have shown the version to the user.
#[tauri::command]
#[specta::specta]
pub async fn install_update(
    app: tauri::AppHandle,
    core: State<'_, Arc<CoreHandle>>,
) -> Result<(), CoreError> {
    crate::updates::install_update(&app, &core.settings()).await
}

/// Ends the client, exactly like the tray `Quit` item.
/// The title bar has its own cross, which goes through `Window::close()` and
/// therefore ADR 0010 (tray or quit). "Quit" in the profile menu is an explicit
/// departure and always ends the process, as ADR 0010 requires.
#[tauri::command]
#[specta::specta]
pub fn quit_app(app: tauri::AppHandle) {
    crate::economy::allow_exit();
    app.exit(0);
}

/// Persists the gate selected with the quick control.
fn persist_gate(core: &CoreHandle, mode: GateMode) -> Result<(), CoreError> {
    let mut current = core.settings();
    current.voice.gate = core_gate(mode);
    core.update_settings(current)?;
    Ok(())
}

/// Converts the engine gate into the persisted type.
fn core_gate(mode: GateMode) -> GateSettings {
    match mode {
        GateMode::Continuous => GateSettings::Continuous,
        GateMode::PushToTalk => GateSettings::PushToTalk,
        GateMode::VoiceActivation {
            threshold_db,
            hold_ms,
        } => GateSettings::VoiceActivation {
            threshold_db,
            hold_ms,
        },
    }
}

/// Converts the engine processing switches into the persisted type.
fn core_processing(settings: ProcessingSettings) -> AudioProcessing {
    AudioProcessing {
        echo_cancellation: settings.echo_cancellation,
        noise_suppression: settings.noise_suppression,
        noise_model: match settings.noise_model {
            rostalk_voice::NoiseModel::Off => rostalk_core::NoiseSuppressor::Off,
            rostalk_voice::NoiseModel::WebRtc => rostalk_core::NoiseSuppressor::WebRtc,
            rostalk_voice::NoiseModel::RnNoise => rostalk_core::NoiseSuppressor::RnNoise,
            rostalk_voice::NoiseModel::DeepFilter => rostalk_core::NoiseSuppressor::DeepFilter,
        },
        gain_control: settings.gain_control,
        high_pass_filter: settings.high_pass_filter,
    }
}

/// Emits one core event to the WebView.
pub fn emit_core_event(app: &tauri::AppHandle, event: CoreEvent) {
    mirror_server_mute(app, &event);
    if let Err(error) = CoreStateEvent(event).emit(app) {
        // Never log the payload: it can contain a nickname, but never a token.
        eprintln!("rostalk: failed to emit a core event: {error}");
    }
}

/// Mirrors a server-forced microphone mute into the local audio pipeline.
///
/// The server is authoritative for `self_muted`: the idle channel (ADR 0009)
/// and moderation both change it without a local command. The local flag only
/// gates capture, and the media plane refuses to publish regardless, but a
/// client that kept capturing would look like it tried to bypass the server.
/// Only own-presence events are mirrored, so unrelated traffic never overrides
/// a just-sent local toggle.
fn mirror_server_mute(app: &tauri::AppHandle, event: &CoreEvent) {
    use rostalk_core::StateDelta;
    use tauri::Manager as _;

    let Some(voice) = app.try_state::<VoiceHandle>() else {
        return;
    };
    let Some(core) = app.try_state::<Arc<CoreHandle>>() else {
        return;
    };
    let state = core.state();
    let relevant = match event {
        CoreEvent::Snapshot(_) => true,
        CoreEvent::Delta(StateDelta::UserUpdated(user)) => user.id == state.self_user_id,
        _ => false,
    };
    if !relevant {
        return;
    }
    let muted = state
        .users
        .iter()
        .find(|user| user.id == state.self_user_id)
        .is_some_and(|user| user.voice.self_muted);
    if let Err(error) = voice.set_self_muted(muted) {
        eprintln!(
            "rostalk: could not apply the server mute locally: {}",
            error.user_message()
        );
    }
}

/// Emits one voice event to the WebView.
pub fn emit_voice_event(app: &tauri::AppHandle, event: VoiceEvent) {
    if let Err(error) = VoiceEventMessage(event).emit(app) {
        // Voice events never contain credentials; the error is still enough.
        eprintln!("rostalk: failed to emit a voice event: {error}");
    }
}

/// Emits an invitation link received while the window is already running.
pub fn emit_deep_link(app: &tauri::AppHandle, link: String) {
    if let Err(error) = DeepLinkEvent(link).emit(app) {
        eprintln!("rostalk: failed to emit a deep link: {error}");
    }
}

/// Locale used for the tray menu; kept here so the labels stay in one place.
pub fn tray_labels(locale: LocalePreference) -> (&'static str, &'static str, &'static str) {
    match locale {
        LocalePreference::Ru => ("Показать RosTalk", "Выйти", "RosTalk — голосовой чат"),
        LocalePreference::En => ("Show RosTalk", "Quit RosTalk", "RosTalk voice chat"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_dialog_path_is_accepted() {
        let state = IdentityPathState::default();
        assert!(!state.approves("/tmp/me.rostalkkey"));
        state.remember(Some("/tmp/me.rostalkkey".to_owned()));
        assert!(state.approves("/tmp/me.rostalkkey"));
        assert!(!state.approves("/tmp/other.rostalkkey"));
        // Cancelling the dialog keeps the approval for the previous file; a new
        // pick replaces it.
        state.remember(None);
        assert!(state.approves("/tmp/me.rostalkkey"));
        state.remember(Some("/tmp/other.rostalkkey".to_owned()));
        assert!(!state.approves("/tmp/me.rostalkkey"));
        assert!(state.approves("/tmp/other.rostalkkey"));
    }

    #[test]
    fn a_path_the_user_did_not_choose_is_rejected() {
        let state = IdentityPathState::default();
        let error = ensure_chosen(&state, "C:\\Windows\\System32\\drivers\\etc\\hosts")
            .expect_err("no dialog");
        assert_eq!(error.code, CoreErrorCode::InvalidRequest);
    }

    #[test]
    fn ui_error_text_is_bounded_at_char_boundaries() {
        assert_eq!(clip("abcdef", 3), "abc");
        assert_eq!(clip("абвгд", 2), "аб");
        assert_eq!(clip("abc", 10), "abc");
        assert_eq!(clip("", 4), "");
    }
}
