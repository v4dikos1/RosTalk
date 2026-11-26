//! Optional native screen publisher (stage P16).
//!
//! The WebView2 stream path is untouched. This module owns the explicit native
//! mode: it asks the core for the current `<uid>:stream` credentials, opens the
//! system picker with the main window as the owner, and keeps the native
//! publisher alive across token renewals. It is off unless the user turns it on
//! in the stream dialog, and no hardware encoder is probed or required.
//!
//! Two rules keep a cancelled or restarted run from leaking into the next one:
//!
//! * the run is registered *before* the first await, so a stop or a channel
//!   change always finds it and sets its cancel flag;
//! * every event is checked against the run generation while the event gate is
//!   held, so a late event from an old run cannot publish, change the screen or
//!   start/stop the computer audio of a newer run.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::MutexGuard;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rostalk_core::{CoreError, CoreErrorCode, CoreHandle};
use rostalk_voice::native_stream::{
    self, NativePreset, NativeStreamEvent, NativeStreamHandle, NativeStreamStats,
    NativeStreamSupport,
};
use rostalk_voice::{VoiceError, VoiceHandle};
use serde::{Deserialize, Serialize};
use tauri::{Manager as _, State};
use tauri_specta::Event as _;
use tokio::sync::Mutex as AsyncMutex;

/// One event sent to the WebView. The payload is token-free and carries the
/// caller's run id, so the UI can attribute it to exactly one start/stop pair.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct NativeStreamEventMessage {
    pub run_id: String,
    pub event: NativeStreamEvent,
}

#[derive(Default)]
struct Inner {
    active: Option<Active>,
    last: Option<NativeStreamEventMessage>,
    generation: u64,
}

struct Active {
    generation: u64,
    /// The id supplied by the caller of `start_native_stream`. A stop with any
    /// other id is a no-op, even if it belongs to a superseded run.
    run_id: String,
    /// Shared with the worker and its handle. It is set synchronously, so a
    /// stop reaches the modal picker even while the command channel is idle.
    cancel: Arc<AtomicBool>,
    handle: Option<NativeStreamHandle>,
    /// A stop or a terminal event ended this run. Late non-terminal events are
    /// dropped; a terminal event is still delivered once.
    ended: bool,
    /// The terminal event was already emitted to the UI.
    terminal_seen: bool,
}

/// What an event may do after the generation check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EventDisposition {
    /// The event belongs to an old or already ended run.
    Drop,
    /// A live run event that may update the UI.
    Emit,
    /// The first terminal event of a live run.
    Terminal,
}

fn is_terminal(event: &NativeStreamEvent) -> bool {
    matches!(
        event,
        NativeStreamEvent::Cancelled
            | NativeStreamEvent::Ended { .. }
            | NativeStreamEvent::Error { .. }
            | NativeStreamEvent::Stopped
    )
}

/// A run id is an opaque caller key, not a secret: keep it short enough for the
/// event payload and reject control characters before it reaches a log.
fn validate_run_id(run_id: &str) -> Result<(), CoreError> {
    if run_id.is_empty() || run_id.len() > 128 {
        return Err(CoreError::new(
            CoreErrorCode::InvalidRequest,
            "native stream run id must be between 1 and 128 bytes",
        ));
    }
    if run_id.chars().any(char::is_control) {
        return Err(CoreError::new(
            CoreErrorCode::InvalidRequest,
            "native stream run id must not contain control characters",
        ));
    }
    Ok(())
}

/// The computer-audio ownership of the native publisher. Only one run may own
/// the P15 capture; the async gate serializes starts and stops so a delayed
/// start cannot enable transmission after a stop.
#[derive(Debug, Default)]
struct AudioState {
    owner: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioClaim {
    /// This run must start the engine capture.
    Start,
    /// The run already owns it; nothing to do.
    Skip,
    /// A previous run still shows as the owner but is no longer active. Stop
    /// it before this run starts its own capture.
    ReplaceStale,
}

impl AudioState {
    fn claim(&mut self, generation: u64, owner_active: bool) -> AudioClaim {
        match self.owner {
            None => {
                self.owner = Some(generation);
                AudioClaim::Start
            }
            Some(owner) if owner == generation => AudioClaim::Skip,
            Some(_) if owner_active => AudioClaim::Skip,
            Some(_) => {
                self.owner = Some(generation);
                AudioClaim::ReplaceStale
            }
        }
    }

    /// Called after the engine start returned. Returns true when the caller
    /// must stop the capture because the run ended while it was starting.
    fn settle_start(&mut self, generation: u64, still_active: bool) -> bool {
        if !still_active && self.owner == Some(generation) {
            self.owner = None;
            return true;
        }
        false
    }

    /// Releases the run's ownership. Returns true when the caller must stop the
    /// engine capture.
    fn release(&mut self, generation: u64) -> bool {
        if self.owner == Some(generation) {
            self.owner = None;
            return true;
        }
        false
    }
}

/// App-wide state of the optional native publisher.
pub struct NativeStreamManager {
    inner: Mutex<Inner>,
    /// Held while an event is checked and emitted. `begin` takes it too, so an
    /// event either reaches the UI before the new generation is registered or
    /// is rejected as stale.
    dispatch: Mutex<()>,
    /// Serializes the async start/stop of the optional computer audio.
    audio: AsyncMutex<AudioState>,
}

impl Default for NativeStreamManager {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            dispatch: Mutex::new(()),
            audio: AsyncMutex::new(AudioState::default()),
        }
    }
}

impl NativeStreamManager {
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn gate(&self) -> MutexGuard<'_, ()> {
        self.dispatch
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Registers a run before any await. A stop or channel change that happens
    /// while the caller fetches credentials finds this entry and cancels it.
    fn begin(&self, run_id: String) -> Result<(u64, Arc<AtomicBool>), CoreError> {
        let _gate = self.gate();
        let mut inner = self.inner();
        if inner.active.as_ref().is_some_and(|active| !active.ended) {
            return Err(CoreError::new(
                CoreErrorCode::InvalidRequest,
                "a native stream is already running",
            ));
        }
        inner.generation += 1;
        let generation = inner.generation;
        let cancel = Arc::new(AtomicBool::new(false));
        inner.last = None;
        inner.active = Some(Active {
            generation,
            run_id,
            cancel: cancel.clone(),
            handle: None,
            ended: false,
            terminal_seen: false,
        });
        Ok((generation, cancel))
    }

    fn attach(&self, generation: u64, handle: NativeStreamHandle) {
        let mut inner = self.inner();
        match inner.active.as_mut() {
            Some(active) if active.generation == generation && !active.ended => {
                active.handle = Some(handle);
            }
            _ => {
                // The worker ended (or was stopped) before start returned. Its
                // terminal event already reached the UI; dropping the handle
                // stops the worker now.
                drop(inner);
                handle.stop();
            }
        }
    }

    fn finish(&self, generation: u64) {
        let handle = {
            let mut inner = self.inner();
            match inner.active.as_mut() {
                Some(active) if active.generation == generation => {
                    active.ended = true;
                    active.handle.take()
                }
                _ => None,
            }
        };
        if let Some(handle) = handle {
            handle.stop();
        }
    }

    /// Cancels the active run and returns its generation. The cancel flag is
    /// set even when the worker has not been attached yet, which is what stops
    /// a credential fetch or a modal picker from continuing. This is the
    /// privileged app-wide path used by shutdown and window destruction.
    pub(crate) fn stop_active(&self) -> Option<u64> {
        let _gate = self.gate();
        let (generation, handle) = {
            let mut inner = self.inner();
            let active = inner.active.as_mut()?;
            active.cancel.store(true, Ordering::SeqCst);
            active.ended = true;
            (active.generation, active.handle.take())
        };
        if let Some(handle) = handle {
            handle.stop();
        }
        Some(generation)
    }

    /// Cancels one caller's run. A late completion from an older start/stop
    /// carries the older id and must not touch a newer run.
    pub(crate) fn stop_run(&self, run_id: &str) -> Option<u64> {
        let _gate = self.gate();
        let (generation, handle) = {
            let mut inner = self.inner();
            let active = inner.active.as_mut()?;
            if active.run_id != run_id || active.ended {
                return None;
            }
            active.cancel.store(true, Ordering::SeqCst);
            active.ended = true;
            (active.generation, active.handle.take())
        };
        if let Some(handle) = handle {
            handle.stop();
        }
        Some(generation)
    }

    fn is_active(&self, generation: u64) -> bool {
        let inner = self.inner();
        inner
            .active
            .as_ref()
            .is_some_and(|active| active.generation == generation && !active.ended)
    }

    fn update_token(&self, generation: u64, token: String) {
        let inner = self.inner();
        if let Some(active) = inner
            .active
            .as_ref()
            .filter(|active| active.generation == generation && !active.ended)
        {
            if let Some(handle) = active.handle.as_ref() {
                handle.update_credentials(token);
            }
        }
    }

    /// Checks the event against the current run and records it. Must be called
    /// with the event gate held.
    fn classify(&self, generation: u64, event: &NativeStreamEvent) -> EventDisposition {
        let mut inner = self.inner();
        if inner.generation != generation {
            return EventDisposition::Drop;
        }
        let Some(active) = inner.active.as_mut() else {
            return EventDisposition::Drop;
        };
        if active.generation != generation {
            return EventDisposition::Drop;
        }
        if is_terminal(event) {
            if active.terminal_seen {
                return EventDisposition::Drop;
            }
            active.terminal_seen = true;
            active.ended = true;
            inner.last = Some(NativeStreamEventMessage {
                run_id: active.run_id.clone(),
                event: event.clone(),
            });
            return EventDisposition::Terminal;
        }
        if active.ended {
            return EventDisposition::Drop;
        }
        inner.last = Some(NativeStreamEventMessage {
            run_id: active.run_id.clone(),
            event: event.clone(),
        });
        EventDisposition::Emit
    }

    fn last(&self) -> Option<NativeStreamEventMessage> {
        self.inner().last.clone()
    }

    /// Token-free counters of the live run, for the measurement harness and a
    /// support report. `None` once the worker has ended.
    fn stats(&self) -> Option<NativeStreamStats> {
        let inner = self.inner();
        inner
            .active
            .as_ref()
            .and_then(|active| active.handle.as_ref())
            .map(NativeStreamHandle::stats)
    }

    /// Starts or keeps the computer audio for one run. The guard is held across
    /// the engine start, so a stop queued meanwhile waits and the post-start
    /// check below undoes a start that lost the race.
    async fn enable_audio(&self, generation: u64, voice: &VoiceHandle) {
        let mut state = self.audio.lock().await;
        if !self.is_active(generation) {
            return;
        }
        let owner_active = state
            .owner
            .map(|owner| owner == generation || self.is_active(owner))
            .unwrap_or(false);
        match state.claim(generation, owner_active) {
            AudioClaim::Skip => return,
            AudioClaim::Start => {}
            AudioClaim::ReplaceStale => {
                // The old capture is still running although its generation
                // already ended. Stop it before taking ownership.
                let _ = voice.stop_stream_audio();
            }
        }
        match tokio::time::timeout(Duration::from_secs(10), voice.start_stream_audio()).await {
            Ok(Ok(())) => {
                if state.settle_start(generation, self.is_active(generation)) {
                    let _ = voice.stop_stream_audio();
                }
            }
            Ok(Err(error)) => {
                let _ = state.release(generation);
                log::warn!(
                    "native stream audio did not start: {}",
                    error.user_message()
                );
            }
            Err(_) => {
                // The engine did not answer; release ownership and queue a
                // stop after the start command, so a late start cannot keep
                // transmitting.
                let _ = state.release(generation);
                log::warn!("native stream audio did not start in time");
                let _ = voice.stop_stream_audio();
            }
        }
    }

    /// Stops the computer audio only when this run owns it. A terminal event
    /// from an old run therefore cannot stop the audio of a newer one.
    async fn disable_audio(&self, generation: u64, voice: &VoiceHandle) {
        let mut state = self.audio.lock().await;
        if state.release(generation) {
            let _ = voice.stop_stream_audio();
        }
    }
}

/// Whether this machine supports the optional native mode. This is an OS/API
/// probe, not a hardware-encoder check.
#[tauri::command]
#[specta::specta]
pub fn native_stream_support() -> NativeStreamSupport {
    native_stream::support()
}

/// Starts the native publisher after the system picker chooses a source.
///
/// The command returns once the run is registered and the worker is queued;
/// `Picking`, `Publishing`, `Cancelled`, `Error` and `Stopped` arrive as
/// events. No capture starts on a cancelled picker, and the caller must not
/// fall back to WebView2 by itself.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn start_native_stream(
    app: tauri::AppHandle,
    core: State<'_, Arc<CoreHandle>>,
    voice: State<'_, VoiceHandle>,
    manager: State<'_, Arc<NativeStreamManager>>,
    channel_id: u64,
    run_id: String,
    preset: String,
    include_audio: bool,
) -> Result<(), CoreError> {
    let support = native_stream::support();
    if !support.supported {
        return Err(CoreError::new(
            CoreErrorCode::InvalidRequest,
            support
                .reason
                .unwrap_or_else(|| "native capture is unavailable".to_owned()),
        ));
    }
    validate_run_id(&run_id)?;
    let Some(preset) = NativePreset::parse(&preset) else {
        return Err(CoreError::new(
            CoreErrorCode::InvalidRequest,
            "native capture supports 720p30 and 1080p30; choose another preset in the WebView2 mode",
        ));
    };
    let core = core.inner().clone();
    let voice = voice.inner().clone();
    let manager = manager.inner().clone();

    // Register before the first await. A stop or channel change racing the
    // credential request finds this run and cancels it; it must never open the
    // picker or create a capture afterwards.
    let (generation, cancel) = manager.begin(run_id.clone())?;

    let config = match core.native_stream_config(channel_id).await {
        Ok(config) => config,
        Err(error) => {
            manager.finish(generation);
            return Err(error);
        }
    };
    if !manager.is_active(generation) {
        return Ok(());
    }
    #[cfg(windows)]
    let owner_hwnd = match app.get_webview_window("main") {
        Some(window) => match window.hwnd() {
            Ok(handle) => handle.0 as isize,
            Err(error) => {
                manager.finish(generation);
                return Err(CoreError::new(
                    CoreErrorCode::InvalidRequest,
                    format!("could not read the main window handle: {error}"),
                ));
            }
        },
        None => {
            manager.finish(generation);
            return Err(CoreError::new(
                CoreErrorCode::InvalidRequest,
                "the main window is not available for the system picker",
            ));
        }
    };
    #[cfg(not(windows))]
    let owner_hwnd = 0;
    if !manager.is_active(generation) {
        return Ok(());
    }

    let app_events = app.clone();
    let manager_events = manager.clone();
    let voice_events = voice.clone();
    let event_run_id = run_id.clone();
    let sink: Arc<dyn Fn(NativeStreamEvent) + Send + Sync> = Arc::new(move |event| {
        // Checking and emitting under the gate makes a new generation wait for
        // this event or makes this event stale, never both at once.
        let _gate = manager_events.gate();
        let disposition = manager_events.classify(generation, &event);
        if disposition == EventDisposition::Drop {
            return;
        }
        let message = NativeStreamEventMessage {
            run_id: event_run_id.clone(),
            event: event.clone(),
        };
        if let Err(error) = message.emit(&app_events) {
            // The event is token-free; the error is enough.
            eprintln!("rostalk: failed to emit a native stream event: {error}");
        }
        match disposition {
            EventDisposition::Terminal => {
                manager_events.finish(generation);
                let manager = manager_events.clone();
                let voice = voice_events.clone();
                tauri::async_runtime::spawn(async move {
                    manager.disable_audio(generation, &voice).await;
                });
            }
            EventDisposition::Emit
                if include_audio && matches!(event, NativeStreamEvent::Publishing { .. }) =>
            {
                let manager = manager_events.clone();
                let voice = voice_events.clone();
                tauri::async_runtime::spawn(async move {
                    manager.enable_audio(generation, &voice).await;
                });
            }
            EventDisposition::Emit => {}
            EventDisposition::Drop => unreachable!("checked above"),
        }
    });

    let config = rostalk_voice::native_stream::NativeStreamConfig {
        gateway: config.gateway,
        fingerprint: config.fingerprint,
        token: config.token,
        room: config.room,
        preset,
        owner_hwnd,
    };
    let handle = match native_stream::start(config, sink, cancel) {
        Ok(handle) => handle,
        Err(error) => {
            manager.finish(generation);
            return Err(native_error(error));
        }
    };
    manager.attach(generation, handle);

    // LiveKit tokens live for 60 seconds. The room stays connected, but a
    // reconnect needs a fresh token; renew it well before expiry.
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(45)).await;
            if !manager.is_active(generation) {
                break;
            }
            match core.native_stream_config(channel_id).await {
                Ok(config) => manager.update_token(generation, config.token),
                Err(error) => {
                    // Never log the token or the URL. A failed renewal is not
                    // fatal while the current room is up; retry next tick.
                    log::warn!("native stream token renewal failed: {}", error.message);
                }
            }
        }
    });
    Ok(())
}

/// Stops the native publisher and the computer audio it owns. With a run id
/// only that caller's run is stopped; `None` is the privileged app-wide path
/// used by shutdown. The worker emits `Stopped`; the UI mirrors that event.
#[tauri::command]
#[specta::specta]
pub async fn stop_native_stream(
    voice: State<'_, VoiceHandle>,
    manager: State<'_, Arc<NativeStreamManager>>,
    run_id: Option<String>,
) -> Result<(), CoreError> {
    let voice = voice.inner().clone();
    let stopped = match run_id.as_deref() {
        Some(run_id) => manager.stop_run(run_id),
        None => manager.stop_active(),
    };
    if let Some(generation) = stopped {
        manager.disable_audio(generation, &voice).await;
    }
    Ok(())
}

/// Last native event, for a dialog that opens after the stream started. The
/// envelope carries the run id so a stale dialog cannot apply it to a new run.
#[tauri::command]
#[specta::specta]
pub fn get_native_stream_state(
    manager: State<'_, Arc<NativeStreamManager>>,
) -> Option<NativeStreamEventMessage> {
    manager.last()
}

/// Token-free counters of the active run: WGC acquired/stored, frames fed and
/// cumulative outbound RTP per simulcast layer. Used by the live measurement
/// harness; it carries neither a token nor a URL.
#[tauri::command]
#[specta::specta]
pub fn native_stream_stats(
    manager: State<'_, Arc<NativeStreamManager>>,
) -> Option<NativeStreamStats> {
    manager.stats()
}

fn native_error(error: VoiceError) -> CoreError {
    CoreError::internal(error.user_message())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn publishing() -> NativeStreamEvent {
        NativeStreamEvent::Publishing {
            preset: "720p30".to_owned(),
            cursor_disabled: true,
            border_removed: true,
        }
    }

    #[test]
    fn begin_registers_before_any_await_and_stop_cancels_it() {
        let manager = NativeStreamManager::default();
        let (generation, cancel) = manager.begin("run-a".to_owned()).expect("first run");
        assert!(manager.is_active(generation));
        assert_eq!(manager.stop_active(), Some(generation));
        assert!(cancel.load(Ordering::SeqCst));
        assert!(!manager.is_active(generation));
    }

    #[test]
    fn second_run_is_rejected_while_the_first_is_live() {
        let manager = NativeStreamManager::default();
        let (first, _) = manager.begin("run-a".to_owned()).expect("first run");
        assert!(manager.begin("run-b".to_owned()).is_err());
        manager.stop_active();
        let (second, _) = manager
            .begin("run-b".to_owned())
            .expect("restart after stop");
        assert_ne!(first, second);
    }

    #[test]
    fn a_stale_run_id_cannot_stop_a_newer_run() {
        let manager = NativeStreamManager::default();
        let (first, _) = manager.begin("run-a".to_owned()).expect("run a");
        assert_eq!(manager.stop_run("run-b"), None);
        assert!(manager.is_active(first));
        assert_eq!(manager.stop_run("run-a"), Some(first));

        let (second, _) = manager.begin("run-b".to_owned()).expect("run b");
        assert_eq!(manager.stop_run("run-a"), None);
        assert!(manager.is_active(second));
        assert_eq!(manager.stop_run("run-b"), Some(second));
    }

    #[test]
    fn repeated_stop_of_the_same_run_is_a_no_op() {
        let manager = NativeStreamManager::default();
        let (generation, _) = manager.begin("run-a".to_owned()).expect("run");
        assert_eq!(manager.stop_run("run-a"), Some(generation));
        assert_eq!(manager.stop_run("run-a"), None);
    }

    #[test]
    fn late_events_of_an_old_run_are_dropped() {
        let manager = NativeStreamManager::default();
        let (old, _) = manager.begin("old".to_owned()).expect("old run");
        manager.stop_active();
        let (new, _) = manager.begin("new".to_owned()).expect("new run");

        let _gate = manager.gate();
        assert_eq!(manager.classify(old, &publishing()), EventDisposition::Drop);
        assert_eq!(
            manager.classify(old, &NativeStreamEvent::Stopped),
            EventDisposition::Drop
        );
        assert_eq!(manager.classify(new, &publishing()), EventDisposition::Emit);
    }

    #[test]
    fn a_stop_drops_late_non_terminal_events_but_delivers_one_terminal() {
        let manager = NativeStreamManager::default();
        let (generation, _) = manager.begin("run-a".to_owned()).expect("run");
        {
            let _gate = manager.gate();
            assert_eq!(
                manager.classify(generation, &NativeStreamEvent::Picking),
                EventDisposition::Emit
            );
        }
        manager.stop_active();
        {
            let _gate = manager.gate();
            assert_eq!(
                manager.classify(generation, &publishing()),
                EventDisposition::Drop
            );
            assert_eq!(
                manager.classify(generation, &NativeStreamEvent::Stopped),
                EventDisposition::Terminal
            );
            assert_eq!(
                manager.classify(generation, &NativeStreamEvent::Stopped),
                EventDisposition::Drop
            );
        }
    }

    #[test]
    fn the_last_event_carries_the_caller_run_id() {
        let manager = NativeStreamManager::default();
        let (generation, _) = manager.begin("run-a".to_owned()).expect("run");
        {
            let _gate = manager.gate();
            assert_eq!(
                manager.classify(generation, &NativeStreamEvent::Picking),
                EventDisposition::Emit
            );
        }
        let last = manager.last().expect("last event");
        assert_eq!(last.run_id, "run-a");
        assert!(matches!(last.event, NativeStreamEvent::Picking));
    }

    #[test]
    fn run_id_is_validated_before_it_reaches_the_manager() {
        assert!(validate_run_id("run-a_1").is_ok());
        assert!(validate_run_id("").is_err());
        assert!(validate_run_id("bad\nrun").is_err());
        assert!(validate_run_id(&"x".repeat(129)).is_err());
    }

    #[test]
    fn audio_ownership_is_bound_to_one_generation() {
        let mut audio = AudioState::default();
        assert_eq!(audio.claim(1, false), AudioClaim::Start);
        assert_eq!(audio.claim(1, true), AudioClaim::Skip);
        // A live owner cannot be taken over.
        assert_eq!(audio.claim(2, true), AudioClaim::Skip);
        // An ended owner is stopped and replaced.
        assert_eq!(audio.claim(2, false), AudioClaim::ReplaceStale);

        // The start finished after a stop: it must be undone.
        assert!(audio.settle_start(2, false));
        assert_eq!(audio.owner, None);
        // A start that finishes while the run is live stays.
        audio.claim(3, false);
        assert!(!audio.settle_start(3, true));
        assert_eq!(audio.owner, Some(3));
        // A late terminal of an older run cannot release a newer owner.
        assert!(!audio.release(2));
        assert_eq!(audio.owner, Some(3));
        assert!(audio.release(3));
        assert_eq!(audio.owner, None);
    }

    #[test]
    fn a_delayed_start_cannot_take_ownership_after_stop() {
        let manager = NativeStreamManager::default();
        let (generation, _) = manager.begin("run-a".to_owned()).expect("run");
        manager.stop_active();
        // This is the first check `enable_audio` performs after awaiting the
        // audio gate: the run is gone, so the engine start is never sent.
        assert!(!manager.is_active(generation));
    }
}
