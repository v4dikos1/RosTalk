//! Economy mode: destroy the WebView after the window sat in the tray.
//!
//! Design 5.5 keeps the Rust core and the voice engine alive while the WebView
//! goes away; the next tray click builds a fresh window, which hydrates from
//! `getState` and therefore shows the same channel, users and chat unread
//! counters. Destroying the window is safe for the single-instance guard and
//! close-to-tray (ADR 0010): the tray icon belongs to the application, not to
//! the window.
//!
//! The mode does not run while the user is streaming or watching a stream. The
//! stream engine arrives in stage 5.1; until then the check is conservative: any
//! stream in the own channel keeps the WebView alive, because that is the only
//! stream the client could be watching.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use rostalk_core::{CoreHandle, CoreState};

/// How often the hidden window is checked. The check is cheap and the timer is
/// minute-granular, so five seconds of slack costs nothing.
const CHECK_INTERVAL: Duration = Duration::from_secs(5);

/// Set before an intentional exit so the last-window handler does not keep the
/// process alive in the tray.
static EXIT_ALLOWED: AtomicBool = AtomicBool::new(false);

/// Marks the next application exit as intentional (the Quit tray item or a
/// close without close-to-tray).
pub fn allow_exit() {
    EXIT_ALLOWED.store(true, Ordering::SeqCst);
}

/// Whether an `ExitRequested` event must be prevented. The economy mode leaves
/// the process without any window; the tray icon is the way back.
pub fn keep_running() -> bool {
    !EXIT_ALLOWED.load(Ordering::SeqCst)
}

/// Whether the hidden window must stay alive because a stream is running.
///
/// Own streaming is explicit in the snapshot. Another user's stream only counts
/// in the own channel: that is the only media the interface can be watching.
pub fn stream_blocks_economy(state: &CoreState) -> bool {
    let own_channel = state
        .users
        .iter()
        .find(|user| user.id == state.self_user_id && state.self_user_id != 0)
        .map(|user| user.channel_id)
        .unwrap_or(0);
    state.users.iter().any(|user| {
        user.streaming
            && (user.id == state.self_user_id
                || (own_channel != 0 && user.channel_id == own_channel))
    })
}

/// Whether the WebView has been hidden long enough to be destroyed.
pub fn idle_due(hidden_for: Duration, idle_minutes: u32) -> bool {
    let minutes = idle_minutes.max(1);
    hidden_for >= Duration::from_secs(u64::from(minutes) * 60)
}

/// Starts the background watcher. It exits with the process; there is nothing
/// to join because the thread only reads the application state.
pub fn start(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("rostalk-economy".to_owned())
        .spawn(move || watch(app));
    if let Err(error) = spawned {
        log::warn!("economy mode is unavailable: {error}");
    }
}

fn watch(app: AppHandle) {
    let mut hidden_since: Option<Instant> = None;
    loop {
        std::thread::sleep(CHECK_INTERVAL);
        let Some(core) = app.try_state::<std::sync::Arc<CoreHandle>>() else {
            continue;
        };
        let settings = core.settings();
        let Some(window) = app.get_webview_window("main") else {
            // Already destroyed (or never created): nothing to do.
            hidden_since = None;
            continue;
        };
        let visible = window.is_visible().unwrap_or(true);
        let stream = stream_blocks_economy(&core.state());
        if !settings.economy_mode || visible || stream {
            if hidden_since.take().is_some() {
                log::debug!(
                    "economy mode: the idle timer was reset (enabled={}, visible={visible}, stream={stream})",
                    settings.economy_mode
                );
            }
            continue;
        }
        let since = *hidden_since.get_or_insert_with(|| {
            log::debug!(
                "economy mode: the window is hidden; destroying the WebView in {} min",
                settings.economy_mode_idle_minutes
            );
            Instant::now()
        });
        if !idle_due(since.elapsed(), settings.economy_mode_idle_minutes) {
            continue;
        }
        log::info!("economy mode: destroying the hidden WebView");
        if let Err(error) = window.destroy() {
            log::warn!("could not destroy the hidden window: {error}");
        }
        hidden_since = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rostalk_core::{ConnectionPhase, CoreState, UserView, VoiceStateView};

    fn state(users: Vec<UserView>, self_id: u64) -> CoreState {
        CoreState {
            connection: ConnectionPhase::Connected,
            reconnect: None,
            server: None,
            roles: Vec::new(),
            channels: Vec::new(),
            users,
            self_user_id: self_id,
            nickname: String::new(),
            profile: Default::default(),
            permissions: None,
            unread: Vec::new(),
            servers: Vec::new(),
            active_server_id: None,
            error: None,
            protocol_version: 1,
            client_version: String::new(),
        }
    }

    fn user(id: u64, channel_id: u64, streaming: bool) -> UserView {
        UserView {
            id,
            nickname: format!("user{id}"),
            role_ids: Vec::new(),
            color: None,
            channel_id,
            voice: VoiceStateView::default(),
            streaming,
            watching_user_ids: Vec::new(),
            connected_at_unix_ms: 0,
            avatar_hash: String::new(),
        }
    }

    #[test]
    fn own_stream_keeps_the_webview() {
        let state = state(vec![user(1, 5, true), user(2, 5, false)], 1);
        assert!(stream_blocks_economy(&state));
    }

    #[test]
    fn a_stream_in_the_same_channel_keeps_the_webview() {
        let state = state(vec![user(1, 5, false), user(2, 5, true)], 1);
        assert!(stream_blocks_economy(&state));
    }

    #[test]
    fn a_stream_in_another_channel_does_not() {
        let state = state(vec![user(1, 5, false), user(2, 9, true)], 1);
        assert!(!stream_blocks_economy(&state));
    }

    #[test]
    fn sitting_in_the_lobby_with_own_stream_blocks() {
        let state = state(vec![user(1, 0, true)], 1);
        assert!(stream_blocks_economy(&state));
    }

    #[test]
    fn the_idle_check_uses_whole_minutes() {
        assert!(!idle_due(Duration::from_secs(299), 5));
        assert!(idle_due(Duration::from_secs(300), 5));
        assert!(
            idle_due(Duration::from_secs(60), 0),
            "zero means one minute"
        );
    }

    #[test]
    fn the_exit_flag_is_global() {
        // The flag starts false; allow_exit is only used before a real exit.
        allow_exit();
        assert!(!keep_running());
    }
}
