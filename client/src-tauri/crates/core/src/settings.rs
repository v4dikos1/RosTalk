//! Persisted client settings (stages 2.3.1 and 2.4).
//!
//! The core owns these values, not the WebView: they survive a restart, a
//! reinstall of the UI bundle and a window that is recreated from the tray
//! (design 5.1, stage 2.4 requirement 8). The single file lives next to
//! `servers.json`; it never contains tokens, passwords or private keys.
//!
//! Stage 2.4 shipped a separate `settings.json` with theme/language and a
//! `profile.json` from stage 2.3.1 with the nickname and the self mute/deafen
//! flags. The integration keeps one store: the profile fields live in
//! `ClientSettings`, and a legacy `profile.json` (and the stage 2.4 settings
//! layout) is migrated on the first start without losing the user's theme,
//! language, nickname or devices.
//!
//! The UI sends a whole [`ClientSettings`] object on every change. The store
//! sanitises it (ranges, unknown locales, duplicate hotkeys) before writing, so
//! a bug in the WebView cannot persist an invalid configuration.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::error::{CoreError, CoreErrorCode};

/// Version of the settings file layout. Version 2 adds the appearance section
/// (preset, accent, density, radius, scale, chat background); version 3 adds
/// the diagnostics consent. A version 1 file is migrated on load: the old
/// `theme` selects the initial preset, so a light theme becomes `paper` and a
/// dark one stays `rostalk`. Files older than version 3 get `Undecided`: the
/// client never assumes consent for a log it was not allowed to keep.
pub const SETTINGS_FORMAT_VERSION: u32 = 3;

/// File name inside the application data directory.
const SETTINGS_FILE: &str = "settings.json";

/// Stage 2.3.1 profile file, imported and then left untouched on disk.
pub const LEGACY_PROFILE_FILE: &str = "profile.json";

/// Theme selected by the user. The desktop client ships two themes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    Dark,
    Light,
}

/// Design preset. The preset owns surfaces, text and semantic colours; the
/// accent is layered on top. `theme` stays a stored field for the tray, the
/// window title and an older UI bundle, but it is always derived from here.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum AppearancePreset {
    /// Warm dark surfaces with the ember accent. Settings written before the
    /// RosTalk rename store it as `hearth` (ADR 0033).
    #[default]
    #[serde(rename = "rostalk", alias = "hearth")]
    RosTalk,
    /// Retired in stage P9: it duplicated `RosTalk`. Still parsed so an older
    /// settings file loads; `sanitized` migrates it to `RosTalk`.
    Graphite,
    /// Warm light paper with dark ink.
    Paper,
    /// True black for OLED panels.
    Amoled,
    /// High-contrast variant.
    Contrast,
}

impl AppearancePreset {
    /// Dark/light flag written to `theme`.
    #[must_use]
    pub fn theme(self) -> ThemePreference {
        match self {
            Self::Paper => ThemePreference::Light,
            Self::RosTalk | Self::Graphite | Self::Amoled | Self::Contrast => ThemePreference::Dark,
        }
    }

    /// Preset that matches a pre-appearance theme.
    #[must_use]
    pub fn from_theme(theme: ThemePreference) -> Self {
        match theme {
            ThemePreference::Dark => Self::RosTalk,
            ThemePreference::Light => Self::Paper,
        }
    }
}

/// Accent layered over the preset. `Auto` keeps the preset's own accent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum AppearanceAccent {
    #[default]
    Auto,
    Ember,
    Ice,
    Violet,
    Moss,
    Rose,
    Mono,
}

/// Row density of lists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum AppearanceDensity {
    #[default]
    Comfortable,
    Compact,
}

/// Corner radius family.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum AppearanceRadius {
    Sharp,
    #[default]
    Default,
    Round,
}

/// Pattern behind the message feed. Retired in stage P9: the feed has no
/// pattern any more. The values still parse; `sanitized` resets them to `None`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ChatBackground {
    #[default]
    None,
    Dots,
    Grid,
}

/// Scale of the whole interface in percent. Only values supported by the
/// stylesheet are persisted; anything else is snapped to the nearest one.
pub const FONT_SCALES: [u16; 3] = [100, 112, 125];

/// Appearance settings (stage UI polish). Stored next to the rest of the
/// client settings so the tray, the next window and an older bundle agree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    #[serde(default)]
    pub preset: AppearancePreset,
    #[serde(default)]
    pub accent: AppearanceAccent,
    #[serde(default)]
    pub density: AppearanceDensity,
    #[serde(default)]
    pub radius: AppearanceRadius,
    /// 100, 112 or 125 percent.
    #[serde(default = "default_font_scale")]
    pub font_scale: u16,
    #[serde(default)]
    pub chat_background: ChatBackground,
}

const fn default_font_scale() -> u16 {
    100
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            preset: AppearancePreset::RosTalk,
            accent: AppearanceAccent::Auto,
            density: AppearanceDensity::Comfortable,
            radius: AppearanceRadius::Default,
            font_scale: default_font_scale(),
            chat_background: ChatBackground::None,
        }
    }
}

impl AppearanceSettings {
    fn sanitized(mut self) -> Self {
        // Stage P9 retired the graphite preset and the feed patterns.
        if self.preset == AppearancePreset::Graphite {
            self.preset = AppearancePreset::RosTalk;
        }
        self.chat_background = ChatBackground::None;
        self.font_scale = FONT_SCALES
            .into_iter()
            .min_by_key(|value| value.abs_diff(self.font_scale))
            .unwrap_or(100);
        self
    }
}

/// Whether the user allows the local diagnostics log to be written.
///
/// `Undecided` is the state before the first-run wizard asks and the state of
/// a settings file that predates the consent. Only `Granted` opens the file;
/// `Denied` and `Undecided` keep it closed. Nothing is ever uploaded.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticsConsent {
    #[default]
    Undecided,
    Granted,
    Denied,
}

/// Diagnostics preferences. The section is stored next to the rest of the
/// client settings and survives a UI bundle that does not know about it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSettings {
    #[serde(default)]
    pub consent: DiagnosticsConsent,
}

/// Interface language. Russian and English are the supported locales.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum LocalePreference {
    Ru,
    En,
}

impl LocalePreference {
    /// Two-letter tag understood by `Intl` and i18next.
    #[must_use]
    pub fn tag(self) -> &'static str {
        match self {
            Self::Ru => "ru",
            Self::En => "en",
        }
    }
}

/// How the microphone is gated before transmission.
///
/// This is the persisted counterpart of `rostalk_voice::GateMode`; the core
/// does not depend on the voice crate, so the shell converts between them.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum GateSettings {
    /// Always transmit while the microphone is open.
    Continuous,
    /// Transmit only while the push-to-talk key/button is held.
    PushToTalk,
    /// Transmit while the level stays above the activation threshold.
    VoiceActivation {
        /// Opening threshold in dBFS.
        threshold_db: f32,
        /// How long the gate stays open after the level drops, ms.
        hold_ms: u32,
    },
}

impl Default for GateSettings {
    fn default() -> Self {
        Self::VoiceActivation {
            threshold_db: -45.0,
            hold_ms: 300,
        }
    }
}

impl GateSettings {
    fn sanitized(self) -> Self {
        match self {
            Self::VoiceActivation {
                threshold_db,
                hold_ms,
            } => Self::VoiceActivation {
                threshold_db: threshold_db.clamp(-80.0, 0.0),
                hold_ms: hold_ms.min(2_000),
            },
            other => other,
        }
    }
}

/// Which noise suppressor runs on the capture path.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum NoiseSuppressor {
    Off,
    WebRtc,
    #[default]
    RnNoise,
    /// DeepFilterNet3, the "strong" mode (stage P17, ADR 0029).
    DeepFilter,
}

/// Audio-processing stages from design 5.2.
///
/// The names mirror `rostalk_voice::ProcessingSettings`; the shell converts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioProcessing {
    /// Acoustic echo cancellation (AEC3 in the engine).
    pub echo_cancellation: bool,
    /// Noise suppression master switch.
    pub noise_suppression: bool,
    /// Which noise suppressor to run.
    pub noise_model: NoiseSuppressor,
    /// Automatic gain control.
    pub gain_control: bool,
    /// High-pass filter.
    pub high_pass_filter: bool,
}

impl Default for AudioProcessing {
    fn default() -> Self {
        // Stage 2.3.2e: RNNoise without AGC (ADR 0014).
        Self {
            echo_cancellation: true,
            noise_suppression: true,
            noise_model: NoiseSuppressor::RnNoise,
            gain_control: false,
            high_pass_filter: true,
        }
    }
}

/// Event cue settings (P10 groups; stage 2.4 had join/leave/mute).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CueSettings {
    /// Master switch for every cue.
    pub enabled: bool,
    /// Playback volume in percent, 0..=100.
    pub volume: u8,
    /// Which generated set to play.
    pub set: SoundSet,
    /// Self and other participants joining/leaving a channel.
    pub channel: bool,
    /// Own microphone muted/unmuted.
    pub microphone: bool,
    /// Incoming sound (deafen) on/off.
    pub sound: bool,
    /// Screen shares starting and stopping.
    pub streams: bool,
    /// Direct messages and mentions.
    pub messages: bool,
    /// Lost and restored media connection.
    pub connection: bool,
    /// Push-to-talk pressed/released (off by default).
    pub push_to_talk: bool,
}

/// Which generated cue set the user prefers (P10).
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    specta::Type,
    Default,
    PartialOrd,
    Ord,
)]
#[serde(rename_all = "camelCase")]
pub enum SoundSet {
    /// Rounder, quieter tones (default).
    #[default]
    Soft,
    /// Brighter, shorter tones, a fifth higher.
    Bright,
}

impl Default for CueSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            volume: 70,
            set: SoundSet::Soft,
            channel: true,
            microphone: true,
            sound: true,
            streams: true,
            messages: true,
            connection: true,
            push_to_talk: false,
        }
    }
}

/// Wire shape for reading cue settings; every field is optional so a file from
/// stage 2.4 (`join`/`leave`/`mute`) and a file with missing new groups load.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct CueSettingsWire {
    enabled: Option<bool>,
    volume: Option<u8>,
    set: Option<SoundSet>,
    channel: Option<bool>,
    microphone: Option<bool>,
    sound: Option<bool>,
    streams: Option<bool>,
    messages: Option<bool>,
    connection: Option<bool>,
    push_to_talk: Option<bool>,
    // Stage 2.4 keys.
    join: Option<bool>,
    leave: Option<bool>,
    mute: Option<bool>,
}

impl<'de> Deserialize<'de> for CueSettings {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = CueSettingsWire::deserialize(deserializer)?;
        let defaults = Self::default();
        // Stage 2.4 had one switch for join and one for leave; the P10 group
        // covers both, so a disabled half keeps the group off.
        let legacy_channel = wire.join.unwrap_or(true) && wire.leave.unwrap_or(true);
        Ok(Self {
            enabled: wire.enabled.unwrap_or(defaults.enabled),
            volume: wire.volume.unwrap_or(defaults.volume),
            set: wire.set.unwrap_or(defaults.set),
            channel: wire.channel.unwrap_or(legacy_channel),
            microphone: wire.microphone.or(wire.mute).unwrap_or(defaults.microphone),
            sound: wire.sound.unwrap_or(defaults.sound),
            streams: wire.streams.unwrap_or(defaults.streams),
            messages: wire.messages.unwrap_or(defaults.messages),
            connection: wire.connection.unwrap_or(defaults.connection),
            push_to_talk: wire.push_to_talk.unwrap_or(defaults.push_to_talk),
        })
    }
}

/// Actions that can be bound to a keyboard shortcut or a mouse button.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, specta::Type,
)]
#[serde(rename_all = "camelCase")]
pub enum HotkeyAction {
    PushToTalk,
    ToggleMute,
    ToggleDeafen,
    CommandPalette,
    OpenSettings,
    LeaveChannel,
}

impl HotkeyAction {
    /// Stable id used by the UI for labels and tests.
    #[must_use]
    pub fn id(self) -> &'static str {
        match self {
            Self::PushToTalk => "pushToTalk",
            Self::ToggleMute => "toggleMute",
            Self::ToggleDeafen => "toggleDeafen",
            Self::CommandPalette => "commandPalette",
            Self::OpenSettings => "openSettings",
            Self::LeaveChannel => "leaveChannel",
        }
    }

    /// All actions in the order shown in the settings window.
    #[must_use]
    pub fn all() -> [Self; 6] {
        [
            Self::PushToTalk,
            Self::ToggleMute,
            Self::ToggleDeafen,
            Self::CommandPalette,
            Self::OpenSettings,
            Self::LeaveChannel,
        ]
    }
}

/// One hotkey assignment. `accelerator` is a canonical string such as
/// `Ctrl+Shift+K`, `F8` or `X1/X2`; `None` means unbound.
///
/// Push-to-talk defaults to the X1/X2 side buttons handled by the global Raw
/// Input hook; the value is shown as a hint and a plain key can be bound
/// explicitly in the settings window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyBinding {
    pub action: HotkeyAction,
    pub accelerator: Option<String>,
}

/// Per-user playback preferences, keyed by `server_id:user_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantSettings {
    /// `<server identity>:<user id>`; user ids are only unique per server.
    pub key: String,
    /// Playback volume in percent, 0..=200.
    pub volume: u8,
    /// Locally muted for this user.
    pub muted: bool,
}

/// Voice settings from design 5.2.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSettings {
    /// Device id from the OS, `None` means the system default.
    pub input_device: Option<String>,
    /// Device id from the OS, `None` means the system default.
    pub output_device: Option<String>,
    pub gate: GateSettings,
    pub processing: AudioProcessing,
    /// Output volume in percent, 0..=200.
    pub output_volume: u8,
    /// Level the loudness of incoming voices (stage P17). Off by default.
    #[serde(default)]
    pub level_voices: bool,
    pub sounds: CueSettings,
    pub hotkeys: Vec<HotkeyBinding>,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            input_device: None,
            output_device: None,
            gate: GateSettings::default(),
            processing: AudioProcessing::default(),
            output_volume: 100,
            level_voices: false,
            sounds: CueSettings::default(),
            hotkeys: default_hotkeys(),
        }
    }
}

/// Default hotkeys. Push-to-talk is the X1/X2 side button pair.
#[must_use]
pub fn default_hotkeys() -> Vec<HotkeyBinding> {
    HotkeyAction::all()
        .into_iter()
        .map(|action| HotkeyBinding {
            action,
            accelerator: match action {
                HotkeyAction::PushToTalk => Some("X1/X2".to_owned()),
                HotkeyAction::ToggleMute => Some("Ctrl+Shift+M".to_owned()),
                HotkeyAction::ToggleDeafen => Some("Ctrl+Shift+D".to_owned()),
                HotkeyAction::CommandPalette => Some("Ctrl+K".to_owned()),
                HotkeyAction::OpenSettings => Some("Ctrl+Comma".to_owned()),
                HotkeyAction::LeaveChannel => Some("Ctrl+Shift+L".to_owned()),
            },
        })
        .collect()
}

/// ЙЦУКЕН character and the QWERTY key in the same place (playtest-1, P4).
///
/// Settings written before P4 stored the character the layout produced, so
/// `Ctrl+Л` never matched `Ctrl+K` in the English layout. The values are the
/// canonical spellings the store keeps.
const YCUKEN_TO_QWERTY: [(char, &str); 33] = [
    ('й', "Q"),
    ('ц', "W"),
    ('у', "E"),
    ('к', "R"),
    ('е', "T"),
    ('н', "Y"),
    ('г', "U"),
    ('ш', "I"),
    ('щ', "O"),
    ('з', "P"),
    ('х', "["),
    ('ъ', "]"),
    ('ф', "A"),
    ('ы', "S"),
    ('в', "D"),
    ('а', "F"),
    ('п', "G"),
    ('р', "H"),
    ('о', "J"),
    ('л', "K"),
    ('д', "L"),
    ('ж', ";"),
    ('э', "'"),
    ('я', "Z"),
    ('ч', "X"),
    ('с', "C"),
    ('м', "V"),
    ('и', "B"),
    ('т', "N"),
    ('ь', "M"),
    ('б', "Comma"),
    ('ю', "Period"),
    ('ё', "`"),
];

/// QWERTY key of a single Cyrillic character, or `None` for anything else.
fn latin_key(key: &str) -> Option<&'static str> {
    let mut chars = key.chars();
    let (Some(ch), None) = (chars.next(), chars.next()) else {
        return None;
    };
    let lower = ch.to_lowercase().next().unwrap_or(ch);
    YCUKEN_TO_QWERTY
        .iter()
        .find(|(cyrillic, _)| *cyrillic == lower)
        .map(|(_, latin)| *latin)
}

/// Rewrites a saved accelerator to the physical key: `Ctrl+Л` -> `Ctrl+K`.
fn migrate_accelerator(accelerator: &str) -> String {
    let trimmed = accelerator.trim();
    let Some((modifiers, key)) = trimmed.rsplit_once('+') else {
        return latin_key(trimmed).map_or_else(|| trimmed.to_owned(), |latin| latin.to_owned());
    };
    match latin_key(key) {
        Some(latin) => format!("{modifiers}+{latin}"),
        None => trimmed.to_owned(),
    }
}

/// The local profile the UI mirrors.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    /// Preferred nickname. Empty until the user has chosen one.
    pub nickname: String,
}

/// Last self mute/deafen flags, restored on the next start and reconnect.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoicePreferences {
    /// The own microphone is muted.
    pub self_muted: bool,
    /// All playback is muted.
    pub self_deafened: bool,
}

/// Whether the economy mode is on by default. It only frees memory the user
/// does not see: the WebView is rebuilt from a core snapshot on the next open.
fn default_economy_mode() -> bool {
    true
}

/// Minutes in the tray before the WebView is destroyed.
fn default_economy_minutes() -> u32 {
    5
}

/// The channel member pane is shown on a wide window by default.
fn default_members_pane_open() -> bool {
    true
}

/// Everything the core persists for the interface and the voice engine.
///
/// `theme` and `compact` stay in the file: the tray, the window title and an
/// older UI bundle still read them. Both are derived from `appearance` whenever
/// the core saves or loads, so the two representations cannot disagree.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSettings {
    pub version: u32,
    pub theme: ThemePreference,
    pub locale: LocalePreference,
    /// Dense rows (28 px instead of 30 px); derived from `appearance.density`.
    pub compact: bool,
    /// Closing the window hides it to the tray instead of quitting.
    pub close_to_tray: bool,
    /// Destroy the WebView after the window sits in the tray (design 5.5).
    /// The core and the voice engine keep running.
    #[serde(default = "default_economy_mode")]
    pub economy_mode: bool,
    /// Minutes in the tray before the WebView is destroyed.
    #[serde(default = "default_economy_minutes")]
    pub economy_mode_idle_minutes: u32,
    /// The right-hand channel member pane is shown (stage P8). On a narrow
    /// window the pane opens over the content and is not persisted, so this
    /// value only describes the wide layout.
    #[serde(default = "default_members_pane_open")]
    pub members_pane_open: bool,
    /// First-run wizard finished (or skipped by a returning user).
    pub onboarding_complete: bool,
    /// Where the client looks for updates (stage 6.2): an `https://` URL to a
    /// static `latest.json` manifest or a local directory containing it. Empty
    /// means "not configured"; `ROSTALK_UPDATE_SOURCE` overrides it at runtime.
    #[serde(default)]
    pub update_source: Option<String>,
    /// Start the client at Windows logon, minimized to the tray (stage 6.2).
    /// Off by default. The justification lives outside the file: HKCU Run.
    #[serde(default)]
    pub autostart: bool,
    /// Last nickname, offered on the next connect.
    pub nickname: String,
    /// Voice channel joined after the next successful connect, if it exists.
    pub default_channel_id: Option<u64>,
    /// Own microphone was muted on the last run (stage 2.3.1).
    #[serde(default)]
    pub self_muted: bool,
    /// Playback was muted on the last run (stage 2.3.1).
    #[serde(default)]
    pub self_deafened: bool,
    /// Design preset, accent and layout options.
    pub appearance: AppearanceSettings,
    /// Local diagnostics consent and nothing else.
    pub diagnostics: DiagnosticsSettings,
    pub voice: VoiceSettings,
    pub participants: Vec<ParticipantSettings>,
    /// True when the incoming payload carried an `appearance` section. An UI
    /// bundle built before the appearance stage sends the whole settings
    /// object without it; `replace` then keeps the stored section instead of
    /// resetting the user's preset.
    #[serde(skip)]
    appearance_provided: bool,
    /// Same rule for `diagnostics`: an older bundle must not silently reset
    /// the user's consent to `Undecided` (or, worse, to a decision they made).
    #[serde(skip)]
    diagnostics_provided: bool,
}

/// Wire shape used to notice a missing `appearance` or `diagnostics` section.
/// Serde cannot tell "absent" from "defaulted" once the struct is built, so the
/// answer is recorded while parsing.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientSettingsWire {
    version: u32,
    theme: ThemePreference,
    locale: LocalePreference,
    compact: bool,
    close_to_tray: bool,
    #[serde(default = "default_economy_mode")]
    economy_mode: bool,
    #[serde(default = "default_economy_minutes")]
    economy_mode_idle_minutes: u32,
    #[serde(default = "default_members_pane_open")]
    members_pane_open: bool,
    onboarding_complete: bool,
    #[serde(default)]
    update_source: Option<String>,
    #[serde(default)]
    autostart: bool,
    nickname: String,
    default_channel_id: Option<u64>,
    #[serde(default)]
    self_muted: bool,
    #[serde(default)]
    self_deafened: bool,
    #[serde(default)]
    appearance: Option<AppearanceSettings>,
    #[serde(default)]
    diagnostics: Option<DiagnosticsSettings>,
    voice: VoiceSettings,
    #[serde(default)]
    participants: Vec<ParticipantSettings>,
}

impl<'de> Deserialize<'de> for ClientSettings {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = ClientSettingsWire::deserialize(deserializer)?;
        let appearance_provided = wire.appearance.is_some();
        let diagnostics_provided = wire.diagnostics.is_some();
        Ok(Self {
            version: wire.version,
            theme: wire.theme,
            locale: wire.locale,
            compact: wire.compact,
            close_to_tray: wire.close_to_tray,
            economy_mode: wire.economy_mode,
            economy_mode_idle_minutes: wire.economy_mode_idle_minutes,
            members_pane_open: wire.members_pane_open,
            onboarding_complete: wire.onboarding_complete,
            update_source: wire.update_source,
            autostart: wire.autostart,
            nickname: wire.nickname,
            default_channel_id: wire.default_channel_id,
            self_muted: wire.self_muted,
            self_deafened: wire.self_deafened,
            appearance: wire.appearance.unwrap_or_default(),
            diagnostics: wire.diagnostics.unwrap_or_default(),
            voice: wire.voice,
            participants: wire.participants,
            appearance_provided,
            diagnostics_provided,
        })
    }
}

impl Default for ClientSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_FORMAT_VERSION,
            theme: ThemePreference::Dark,
            locale: LocalePreference::Ru,
            compact: false,
            close_to_tray: true,
            economy_mode: default_economy_mode(),
            economy_mode_idle_minutes: default_economy_minutes(),
            members_pane_open: default_members_pane_open(),
            onboarding_complete: false,
            update_source: None,
            autostart: false,
            nickname: String::new(),
            default_channel_id: None,
            self_muted: false,
            self_deafened: false,
            appearance: AppearanceSettings::default(),
            diagnostics: DiagnosticsSettings::default(),
            voice: VoiceSettings::default(),
            participants: Vec::new(),
            appearance_provided: true,
            diagnostics_provided: true,
        }
    }
}

impl ClientSettings {
    /// Volume and mute for one user, falling back to 100 % and unmuted.    #[must_use]
    pub fn participant(&self, key: &str) -> (u8, bool) {
        self.participants
            .iter()
            .find(|entry| entry.key == key)
            .map_or((100, false), |entry| (entry.volume, entry.muted))
    }

    /// The profile part of the settings, for `CoreState.profile`.
    #[must_use]
    pub fn profile(&self) -> ProfileView {
        ProfileView {
            nickname: self.nickname.clone(),
        }
    }

    /// Last self mute/deafen flags.
    #[must_use]
    pub fn voice_preferences(&self) -> VoicePreferences {
        VoicePreferences {
            self_muted: self.self_muted,
            self_deafened: self.self_deafened,
        }
    }

    /// Applies the same invariants the store enforces on load and save.
    fn sanitized(mut self) -> Self {
        self.version = SETTINGS_FORMAT_VERSION;
        self.appearance_provided = true;
        self.diagnostics_provided = true;
        self.appearance = self.appearance.sanitized();
        // Derived fields: the appearance section is the only source of truth.
        self.theme = self.appearance.preset.theme();
        self.compact = self.appearance.density == AppearanceDensity::Compact;
        self.economy_mode_idle_minutes = self.economy_mode_idle_minutes.clamp(1, 240);
        self.nickname = self.nickname.trim().chars().take(64).collect();
        self.update_source = self
            .update_source
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(2048).collect());
        self.default_channel_id = self.default_channel_id.filter(|id| *id != 0);
        self.voice.output_volume = self.voice.output_volume.min(200);
        self.voice.sounds.volume = self.voice.sounds.volume.min(100);
        self.voice.gate = self.voice.gate.sanitized();
        self.participants.retain(|entry| entry.key.len() <= 160);
        for entry in &mut self.participants {
            entry.volume = entry.volume.min(200);
        }
        self.participants.sort_by(|a, b| a.key.cmp(&b.key));
        self.participants.dedup_by(|a, b| a.key == b.key);

        // Every action appears exactly once, in the UI order. Unknown actions
        // are dropped and missing ones get an unbound entry.
        let mut bindings = Vec::with_capacity(HotkeyAction::all().len());
        for action in HotkeyAction::all() {
            let accelerator = self
                .voice
                .hotkeys
                .iter()
                .find(|binding| binding.action == action)
                .and_then(|binding| binding.accelerator.clone())
                .map(|value| migrate_accelerator(&value))
                .filter(|value| !value.is_empty());
            bindings.push(HotkeyBinding {
                action,
                accelerator,
            });
        }
        for binding in &mut bindings {
            if binding.action == HotkeyAction::PushToTalk && binding.accelerator.is_none() {
                // The global hook always captures X1/X2; an "unbound" PTT
                // would contradict what the engine actually does.
                binding.accelerator = Some("X1/X2".to_owned());
            }
        }
        // Two actions on one accelerator would fire twice; the first (in UI
        // order) keeps it.
        let mut used: Vec<String> = Vec::new();
        for binding in &mut bindings {
            if let Some(accelerator) = &binding.accelerator {
                if used
                    .iter()
                    .any(|taken| taken.eq_ignore_ascii_case(accelerator))
                {
                    binding.accelerator = None;
                } else {
                    used.push(accelerator.clone());
                }
            }
        }
        self.voice.hotkeys = bindings;
        self
    }
}

/// Settings on disk.
#[derive(Debug)]
pub struct SettingsStore {
    path: PathBuf,
    settings: ClientSettings,
}

impl SettingsStore {
    /// Loads `settings.json` from `dir`, importing the stage 2.4 layout and the
    /// stage 2.3.1 `profile.json` when needed. A missing or damaged file yields
    /// the defaults: a broken settings file must not prevent the client from
    /// starting.
    #[must_use]
    pub fn open(dir: &Path) -> Self {
        let path = dir.join(SETTINGS_FILE);
        let legacy = read_legacy_profile(dir);
        let (mut settings, imported) = match std::fs::read(&path) {
            Ok(data) => match parse_settings(&data) {
                Some(settings) => (settings, false),
                None => {
                    log::warn!("settings.json is damaged and will be ignored");
                    (ClientSettings::default(), false)
                }
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                (ClientSettings::default(), legacy.is_some())
            }
            Err(err) => {
                log::warn!("could not read settings.json: {err}");
                (ClientSettings::default(), false)
            }
        };
        // A profile from stage 2.3.1 fills gaps only on the first migration;
        // after `settings.json` exists it is the single source of truth.
        let mut changed = false;
        if imported {
            if let Some(profile) = legacy {
                if settings.nickname.trim().is_empty() && !profile.nickname.trim().is_empty() {
                    settings.nickname = profile.nickname;
                    changed = true;
                }
                if profile.self_muted && !settings.self_muted {
                    settings.self_muted = true;
                    changed = true;
                }
                if profile.self_deafened && !settings.self_deafened {
                    settings.self_deafened = true;
                    changed = true;
                }
            }
        }
        let sanitized = settings.clone().sanitized();
        // Sanitising also migrates old values (a Cyrillic accelerator, a file
        // format bump). Persisting that difference keeps `settings.json` a
        // single canonical source instead of migrating again on every start.
        let normalized = sanitized != settings;
        let store = Self {
            path,
            settings: sanitized,
        };
        if (imported || changed || normalized) && !store.path.as_os_str().is_empty() {
            if let Err(err) = store.save() {
                log::warn!("could not write the migrated settings: {}", err.message);
            }
        }
        store
    }

    /// In-memory store for unit tests.
    #[must_use]
    pub fn in_memory() -> Self {
        Self {
            path: PathBuf::new(),
            settings: ClientSettings::default(),
        }
    }

    /// Current settings.
    #[must_use]
    pub fn settings(&self) -> ClientSettings {
        self.settings.clone()
    }

    /// Stored nickname, empty when the user has not chosen one.
    #[must_use]
    pub fn nickname(&self) -> &str {
        &self.settings.nickname
    }

    /// Stored self mute/deafen flags.
    #[must_use]
    pub fn voice_preferences(&self) -> VoicePreferences {
        self.settings.voice_preferences()
    }

    /// Replaces the self mute/deafen flags and writes the file.
    pub fn set_voice_preferences(&mut self, voice: VoicePreferences) -> Result<(), CoreError> {
        if self.settings.voice_preferences() == voice {
            return Ok(());
        }
        self.settings.self_muted = voice.self_muted;
        self.settings.self_deafened = voice.self_deafened;
        self.save()
    }

    /// Replaces the nickname and writes the file. The nickname is trimmed and
    /// must not be empty.
    pub fn set_nickname(&mut self, nickname: &str) -> Result<ProfileView, CoreError> {
        let nickname = nickname.trim();
        if nickname.is_empty() {
            return Err(CoreError::new(
                CoreErrorCode::InvalidRequest,
                "nickname must not be empty",
            ));
        }
        if nickname.chars().count() > 64 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidRequest,
                "nickname is longer than 64 characters",
            ));
        }
        self.settings.nickname = nickname.to_owned();
        self.save()?;
        Ok(self.settings.profile())
    }

    /// Replaces and persists the settings. Returns the sanitised value.
    ///
    /// A payload from a UI bundle built before the appearance stage has no
    /// `appearance` field; the stored section is kept instead of being reset to
    /// the defaults. The same guard keeps a bundle that predates the
    /// diagnostics consent from resetting the user's decision. Everything else
    /// is a full replacement.
    pub fn replace(&mut self, settings: ClientSettings) -> Result<ClientSettings, CoreError> {
        let mut settings = settings;
        if !settings.appearance_provided {
            settings.appearance = self.settings.appearance.clone();
        }
        if !settings.diagnostics_provided {
            settings.diagnostics = self.settings.diagnostics;
        }
        self.settings = settings.sanitized();
        self.save()?;
        Ok(self.settings())
    }

    /// Stores one user's volume and local mute.
    pub fn set_participant(
        &mut self,
        key: &str,
        volume: u8,
        muted: bool,
    ) -> Result<Vec<ParticipantSettings>, CoreError> {
        let volume = volume.min(200);
        let existing = self
            .settings
            .participants
            .iter_mut()
            .find(|entry| entry.key == key);
        if let Some(entry) = existing {
            entry.volume = volume;
            entry.muted = muted;
        } else {
            self.settings.participants.push(ParticipantSettings {
                key: key.to_owned(),
                volume,
                muted,
            });
        }
        self.settings = self.settings.clone().sanitized();
        self.save()?;
        Ok(self.settings.participants.clone())
    }

    /// Marks the first-run wizard as finished.
    pub fn complete_onboarding(&mut self, nickname: &str) -> Result<ClientSettings, CoreError> {
        self.settings.onboarding_complete = true;
        self.settings.nickname = nickname.to_owned();
        self.settings = self.settings.clone().sanitized();
        self.save()?;
        Ok(self.settings())
    }

    /// Shows the first-run wizard again (settings action).
    pub fn reset_onboarding(&mut self) -> Result<ClientSettings, CoreError> {
        self.settings.onboarding_complete = false;
        self.save()?;
        Ok(self.settings())
    }

    fn save(&self) -> Result<(), CoreError> {
        if self.path.as_os_str().is_empty() {
            return Ok(());
        }
        let data = serde_json::to_vec_pretty(&self.settings)
            .map_err(|err| CoreError::internal(format!("encode settings.json: {err}")))?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| CoreError::internal(format!("create app data dir: {err}")))?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, data)
            .map_err(|err| CoreError::internal(format!("write settings.json: {err}")))?;
        std::fs::rename(&tmp, &self.path)
            .map_err(|err| CoreError::internal(format!("replace settings.json: {err}")))
    }
}

/// Parses a settings file of either layout (stage 2.4 or unified).
///
/// The stage 2.4 file used a plain string for the gate and different names for
/// two APM switches. Rewriting it as JSON first keeps the parser simple and
/// keeps a single `ClientSettings` shape.
fn parse_settings(data: &[u8]) -> Option<ClientSettings> {
    // A file saved by an editor or an older tool may start with a UTF-8 BOM;
    // `serde_json` rejects it, and the user would lose every setting.
    let data = data.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(data);
    let mut value: Value = serde_json::from_slice(data).ok()?;
    let version = value.get("version").and_then(Value::as_u64).unwrap_or(1);
    // Version 1 is the unified layout without `appearance`; version 2 adds it
    // and version 3 adds `diagnostics` (absent means `Undecided`). A file from
    // a newer client is reset rather than half-read.
    if version == 0 || version > u64::from(SETTINGS_FORMAT_VERSION) {
        log::warn!("settings.json has an unknown version and will be reset");
        return None;
    }
    if let Some(voice) = value.get_mut("voice").and_then(Value::as_object_mut) {
        let legacy_gate = voice.get("gate").and_then(Value::as_str).map(str::to_owned);
        if let Some(gate) = legacy_gate {
            let threshold = voice
                .get("activationThresholdDb")
                .and_then(Value::as_f64)
                .unwrap_or(-45.0);
            let converted = match gate.as_str() {
                "pushToTalk" => serde_json::json!({ "mode": "pushToTalk" }),
                "continuous" => serde_json::json!({ "mode": "continuous" }),
                _ => serde_json::json!({
                    "mode": "voiceActivation",
                    "threshold_db": threshold,
                    "hold_ms": 300,
                }),
            };
            voice.insert("gate".to_owned(), converted);
        }
        voice.remove("activationThresholdDb");
        if let Some(processing) = voice.get_mut("processing").and_then(Value::as_object_mut) {
            if let Some(gain) = processing.remove("automaticGain") {
                processing.entry("gainControl").or_insert(gain);
            }
            if let Some(high_pass) = processing.remove("highPass") {
                processing.entry("highPassFilter").or_insert(high_pass);
            }
            if !processing.contains_key("noiseModel") {
                let noise = processing
                    .get("noiseSuppression")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                processing.insert(
                    "noiseModel".to_owned(),
                    Value::String(if noise { "rnNoise" } else { "off" }.to_owned()),
                );
            }
        }
    }
    let mut settings: ClientSettings = serde_json::from_value(value)
        .map_err(|err| {
            log::warn!("settings.json has an invalid shape and will be ignored: {err}");
        })
        .ok()?;
    if version == 1 && !settings.appearance_provided {
        // The old theme select becomes the initial preset: a light theme is
        // paper, a dark one stays the default rostalk. Other appearance fields
        // start from their defaults.
        settings.appearance.preset = AppearancePreset::from_theme(settings.theme);
        settings.appearance.density = if settings.compact {
            AppearanceDensity::Compact
        } else {
            AppearanceDensity::Comfortable
        };
        settings.appearance_provided = true;
    }
    Some(settings)
}

/// Reads the stage 2.3.1 `profile.json` if it is present.
fn read_legacy_profile(dir: &Path) -> Option<LegacyProfile> {
    let path = dir.join(LEGACY_PROFILE_FILE);
    let data = std::fs::read(&path).ok()?;
    let data = data.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&data);
    match serde_json::from_slice::<LegacyProfile>(data) {
        Ok(profile) => Some(profile),
        Err(err) => {
            log::warn!("profile.json is damaged and will be ignored: {err}");
            None
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProfile {
    #[serde(default)]
    nickname: String,
    #[serde(default)]
    self_muted: bool,
    #[serde(default)]
    self_deafened: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_enable_the_voice_profile_and_bind_ptt_to_the_side_buttons() {
        let settings = ClientSettings::default();
        assert_eq!(settings.theme, ThemePreference::Dark);
        assert_eq!(settings.appearance.preset, AppearancePreset::RosTalk);
        assert_eq!(settings.appearance.accent, AppearanceAccent::Auto);
        assert_eq!(settings.appearance.font_scale, 100);
        assert_eq!(settings.locale, LocalePreference::Ru);
        assert_eq!(settings.voice.gate, GateSettings::default());
        assert!(settings.voice.processing.echo_cancellation);
        assert_eq!(
            settings.voice.processing.noise_model,
            NoiseSuppressor::RnNoise
        );
        let ptt = settings
            .voice
            .hotkeys
            .iter()
            .find(|binding| binding.action == HotkeyAction::PushToTalk);
        assert_eq!(
            ptt.and_then(|binding| binding.accelerator.as_deref()),
            Some("X1/X2")
        );
        let palette = settings
            .voice
            .hotkeys
            .iter()
            .find(|binding| binding.action == HotkeyAction::CommandPalette);
        assert_eq!(
            palette.and_then(|binding| binding.accelerator.as_deref()),
            Some("Ctrl+K")
        );
    }

    #[test]
    fn cue_settings_load_from_every_layout_and_round_trip() {
        // Stage 2.4 layout: independent join/leave/mute switches.
        let legacy: CueSettings = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "volume": 45,
            "join": false,
            "leave": true,
            "mute": false,
        }))
        .expect("stage 2.4 cue settings");
        assert_eq!(legacy.volume, 45);
        assert!(!legacy.channel);
        assert!(!legacy.microphone);
        assert!(!legacy.push_to_talk);

        // A file with only the master switch fills every group with defaults.
        let sparse: CueSettings =
            serde_json::from_value(serde_json::json!({ "enabled": false })).expect("sparse");
        assert!(!sparse.enabled);
        assert!(sparse.channel && sparse.streams && sparse.connection);
        assert!(!sparse.push_to_talk);

        // The current layout survives a write and a read.
        let current = CueSettings {
            enabled: true,
            volume: 80,
            set: SoundSet::Bright,
            channel: true,
            microphone: false,
            sound: true,
            streams: false,
            messages: true,
            connection: true,
            push_to_talk: true,
        };
        let json = serde_json::to_value(current).expect("json");
        assert_eq!(json["set"], serde_json::json!("bright"));
        let restored: CueSettings = serde_json::from_value(json).expect("round trip");
        assert_eq!(restored, current);
    }

    #[test]
    fn values_are_clamped_and_hotkey_conflicts_are_resolved() {
        let mut settings = ClientSettings::default();
        settings.voice.output_volume = 250;
        settings.voice.gate = GateSettings::VoiceActivation {
            threshold_db: -300.0,
            hold_ms: 9_999,
        };
        settings.voice.hotkeys = vec![
            HotkeyBinding {
                action: HotkeyAction::PushToTalk,
                accelerator: Some("F8".to_owned()),
            },
            HotkeyBinding {
                action: HotkeyAction::ToggleMute,
                accelerator: Some("f8".to_owned()),
            },
        ];
        let settings = settings.sanitized();
        assert_eq!(settings.voice.output_volume, 200);
        match settings.voice.gate {
            GateSettings::VoiceActivation {
                threshold_db,
                hold_ms,
            } => {
                assert_eq!(threshold_db, -80.0);
                assert_eq!(hold_ms, 2_000);
            }
            other => panic!("unexpected gate {other:?}"),
        }
        // Every action is present exactly once.
        assert_eq!(settings.voice.hotkeys.len(), HotkeyAction::all().len());
        let bindings: Vec<_> = settings
            .voice
            .hotkeys
            .iter()
            .filter(|binding| binding.accelerator.as_deref() == Some("F8"))
            .collect();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].action, HotkeyAction::PushToTalk);
    }

    #[test]
    fn settings_survive_a_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = SettingsStore::open(dir.path());
        let mut settings = store.settings();
        settings.appearance.preset = AppearancePreset::Paper;
        settings.appearance.density = AppearanceDensity::Compact;
        settings.locale = LocalePreference::En;
        settings.close_to_tray = false;
        settings.nickname = "  Alice  ".to_owned();
        settings.voice.output_volume = 140;
        settings.voice.gate = GateSettings::PushToTalk;
        settings.self_muted = true;
        store.replace(settings).expect("save");
        store
            .set_participant("server:7", 175, true)
            .expect("participant");
        store.complete_onboarding("Alice").expect("onboarding");

        let reopened = SettingsStore::open(dir.path());
        let settings = reopened.settings();
        assert_eq!(settings.theme, ThemePreference::Light);
        assert_eq!(settings.locale, LocalePreference::En);
        assert!(settings.compact);
        assert!(!settings.close_to_tray);
        assert_eq!(settings.nickname, "Alice");
        assert_eq!(settings.voice.output_volume, 140);
        assert_eq!(settings.voice.gate, GateSettings::PushToTalk);
        assert!(settings.self_muted);
        assert!(settings.onboarding_complete);
        assert_eq!(settings.participant("server:7"), (175, true));
    }

    #[test]
    fn update_source_is_trimmed_and_autostart_defaults_off() {
        let settings = ClientSettings::default();
        assert!(settings.update_source.is_none());
        assert!(!settings.autostart);

        let settings = ClientSettings {
            update_source: Some("  https://updates.example/rostalk/latest.json  ".to_owned()),
            autostart: true,
            ..ClientSettings::default()
        };
        let settings = settings.sanitized();
        assert_eq!(
            settings.update_source.as_deref(),
            Some("https://updates.example/rostalk/latest.json")
        );
        assert!(settings.autostart);

        let settings = ClientSettings {
            update_source: Some("   ".to_owned()),
            ..ClientSettings::default()
        };
        assert!(settings.sanitized().update_source.is_none());
    }

    #[test]
    fn a_damaged_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(SETTINGS_FILE), b"{ not json").expect("write");
        let store = SettingsStore::open(dir.path());
        assert_eq!(store.settings(), ClientSettings::default());
    }

    #[test]
    fn economy_mode_defaults_on_and_clamps_its_minutes() {
        assert!(ClientSettings::default().economy_mode);
        assert_eq!(ClientSettings::default().economy_mode_idle_minutes, 5);

        let mut store = SettingsStore::in_memory();
        let mut settings = store.settings();
        settings.economy_mode = false;
        settings.economy_mode_idle_minutes = 0;
        let saved = store.replace(settings).expect("save");
        assert!(!saved.economy_mode);
        assert_eq!(saved.economy_mode_idle_minutes, 1);

        let mut settings = saved;
        settings.economy_mode_idle_minutes = 999;
        let saved = store.replace(settings).expect("save high");
        assert_eq!(saved.economy_mode_idle_minutes, 240);
    }

    #[test]
    fn the_stage_2_4_layout_without_economy_fields_gets_the_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        let legacy = serde_json::json!({
            "version": 1,
            "theme": "dark",
            "locale": "ru",
            "compact": false,
            "closeToTray": true,
            "onboardingComplete": true,
            "nickname": "Alice",
            "defaultChannelId": null,
            "selfMuted": false,
            "selfDeafened": false,
            "voice": serde_json::to_value(VoiceSettings::default()).expect("voice"),
            "participants": []
        });
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            serde_json::to_vec(&legacy).expect("json"),
        )
        .expect("write");
        let store = SettingsStore::open(dir.path());
        let settings = store.settings();
        assert_eq!(settings.nickname, "Alice");
        assert!(settings.economy_mode);
        assert_eq!(settings.economy_mode_idle_minutes, 5);
        // The member pane did not exist before P8; a wide window shows it.
        assert!(settings.members_pane_open);
    }

    #[test]
    fn the_member_pane_visibility_survives_a_restart() {
        assert!(ClientSettings::default().members_pane_open);
        let mut store = SettingsStore::in_memory();
        let mut settings = store.settings();
        settings.members_pane_open = false;
        let saved = store.replace(settings).expect("save");
        assert!(!saved.members_pane_open);
        assert!(!store.settings().members_pane_open);
    }

    #[test]
    fn participant_volume_is_clamped_and_replaced() {
        let mut store = SettingsStore::in_memory();
        store.set_participant("a:1", 240, false).expect("first");
        let list = store.set_participant("a:1", 20, true).expect("second");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].volume, 20);
        assert!(list[0].muted);
    }

    #[test]
    fn the_stage_2_4_settings_layout_is_migrated() {
        let dir = tempfile::tempdir().expect("tempdir");
        let legacy = serde_json::json!({
            "version": 1,
            "theme": "light",
            "locale": "en",
            "compact": true,
            "closeToTray": false,
            "onboardingComplete": true,
            "nickname": "Alice",
            "defaultChannelId": 7,
            "voice": {
                "inputDevice": "mic-1",
                "outputDevice": "spk-1",
                "gate": "voiceActivation",
                "activationThresholdDb": -37,
                "processing": {
                    "echoCancellation": true,
                    "noiseSuppression": true,
                    "automaticGain": false,
                    "highPass": true
                },
                "outputVolume": 130,
                "sounds": { "enabled": true, "volume": 50, "join": true, "leave": false, "mute": true },
                "hotkeys": []
            },
            "participants": [{ "key": "s:1", "volume": 150, "muted": false }]
        });
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend(serde_json::to_vec(&legacy).expect("json"));
        std::fs::write(dir.path().join(SETTINGS_FILE), bytes).expect("write");

        let settings = SettingsStore::open(dir.path()).settings();
        assert_eq!(settings.theme, ThemePreference::Light);
        assert_eq!(settings.appearance.preset, AppearancePreset::Paper);
        assert_eq!(settings.locale, LocalePreference::En);
        assert!(settings.compact);
        assert_eq!(settings.nickname, "Alice");
        assert_eq!(settings.default_channel_id, Some(7));
        assert_eq!(settings.voice.input_device.as_deref(), Some("mic-1"));
        assert_eq!(settings.voice.output_volume, 130);
        assert_eq!(
            settings.voice.gate,
            GateSettings::VoiceActivation {
                threshold_db: -37.0,
                hold_ms: 300
            }
        );
        assert_eq!(
            settings.voice.processing.noise_model,
            NoiseSuppressor::RnNoise
        );
        assert!(!settings.voice.processing.gain_control);
        assert!(settings.voice.processing.high_pass_filter);
        // Stage 2.4 cue switches become P10 groups: a disabled `leave` keeps
        // the whole channel group off, `mute` maps to the microphone group.
        assert_eq!(settings.voice.sounds.volume, 50);
        assert!(!settings.voice.sounds.channel);
        assert!(settings.voice.sounds.microphone);
        assert_eq!(settings.voice.sounds.set, SoundSet::Soft);
        assert!(!settings.voice.sounds.push_to_talk);
        assert_eq!(settings.participant("s:1"), (150, false));
    }

    #[test]
    fn retired_preset_and_feed_patterns_are_migrated() {
        let mut settings = ClientSettings::default();
        settings.appearance.preset = AppearancePreset::Graphite;
        settings.appearance.chat_background = ChatBackground::Grid;
        let settings = settings.sanitized();
        assert_eq!(settings.appearance.preset, AppearancePreset::RosTalk);
        assert_eq!(settings.appearance.chat_background, ChatBackground::None);
        assert_eq!(settings.theme, ThemePreference::Dark);

        // A file written by an older build loads and is migrated on open.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = SettingsStore::open(dir.path());
        let mut value = serde_json::to_value(store.settings()).expect("json");
        value["appearance"]["preset"] = serde_json::json!("graphite");
        value["appearance"]["chatBackground"] = serde_json::json!("dots");
        let payload: ClientSettings = serde_json::from_value(value).expect("payload");
        let saved = store.replace(payload).expect("replace");
        assert_eq!(saved.appearance.preset, AppearancePreset::RosTalk);
        assert_eq!(saved.appearance.chat_background, ChatBackground::None);
    }

    #[test]
    fn preset_saved_before_the_rename_still_loads() {
        // ADR 0033: settings.json written as "Hearth" stores the warm preset as
        // "hearth"; new files store "rostalk", which the UI expects.
        let preset: AppearancePreset = serde_json::from_str("\"hearth\"").expect("legacy");
        assert_eq!(preset, AppearancePreset::RosTalk);
        assert_eq!(
            serde_json::to_string(&AppearancePreset::RosTalk).expect("json"),
            "\"rostalk\""
        );
    }

    #[test]
    fn appearance_is_derived_and_font_scale_is_snapped() {
        let mut settings = ClientSettings::default();
        settings.appearance.preset = AppearancePreset::Paper;
        settings.appearance.density = AppearanceDensity::Compact;
        settings.appearance.font_scale = 116;
        let mut settings = settings.sanitized();
        assert_eq!(settings.theme, ThemePreference::Light);
        assert!(settings.compact);
        assert_eq!(settings.appearance.font_scale, 112);

        settings.appearance.preset = AppearancePreset::Amoled;
        settings.appearance.density = AppearanceDensity::Comfortable;
        let settings = settings.sanitized();
        assert_eq!(settings.theme, ThemePreference::Dark);
        assert!(!settings.compact);
    }

    #[test]
    fn diagnostics_defaults_to_undecided_and_survives_a_restart() {
        assert_eq!(
            ClientSettings::default().diagnostics.consent,
            DiagnosticsConsent::Undecided
        );
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = SettingsStore::open(dir.path());
        let mut settings = store.settings();
        settings.diagnostics.consent = DiagnosticsConsent::Granted;
        store.replace(settings).expect("save consent");

        let reopened = SettingsStore::open(dir.path()).settings();
        assert_eq!(reopened.diagnostics.consent, DiagnosticsConsent::Granted);
        assert_eq!(reopened.version, SETTINGS_FORMAT_VERSION);
    }

    #[test]
    fn a_version_2_file_gets_undecided_diagnostics() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut value = serde_json::to_value(ClientSettings::default()).expect("json");
        let object = value.as_object_mut().expect("object");
        object.insert("version".to_owned(), Value::from(2));
        object.remove("diagnostics");
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            serde_json::to_vec(&value).expect("json"),
        )
        .expect("write");

        let settings = SettingsStore::open(dir.path()).settings();
        assert_eq!(
            settings.diagnostics.consent,
            DiagnosticsConsent::Undecided,
            "an old file must never imply consent"
        );
    }

    #[test]
    fn a_payload_without_diagnostics_keeps_the_stored_consent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = SettingsStore::open(dir.path());
        let mut settings = store.settings();
        settings.diagnostics.consent = DiagnosticsConsent::Denied;
        store.replace(settings).expect("save consent");

        // An older bundle sends the whole object without the section.
        let mut value = serde_json::to_value(store.settings()).expect("json");
        value.as_object_mut().expect("object").remove("diagnostics");
        let payload: ClientSettings = serde_json::from_value(value).expect("payload");
        assert!(!payload.diagnostics_provided);
        assert_eq!(
            payload.diagnostics.consent,
            DiagnosticsConsent::Undecided,
            "the wire default alone is not a decision"
        );

        let saved = store.replace(payload).expect("replace");
        assert_eq!(saved.diagnostics.consent, DiagnosticsConsent::Denied);
        let reopened = SettingsStore::open(dir.path()).settings();
        assert_eq!(reopened.diagnostics.consent, DiagnosticsConsent::Denied);
    }

    #[test]
    fn a_payload_without_appearance_keeps_the_stored_section() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = SettingsStore::open(dir.path());
        let mut settings = store.settings();
        settings.appearance.preset = AppearancePreset::Paper;
        settings.appearance.accent = AppearanceAccent::Ice;
        settings.appearance.density = AppearanceDensity::Compact;
        settings.appearance.radius = AppearanceRadius::Round;
        store.replace(settings).expect("save appearance");

        // An older bundle sends the whole object, but it predates the section.
        let mut value = serde_json::to_value(store.settings()).expect("json");
        value.as_object_mut().expect("object").remove("appearance");
        let payload: ClientSettings = serde_json::from_value(value).expect("payload");
        assert!(!payload.appearance_provided);

        let saved = store.replace(payload).expect("replace");
        assert_eq!(saved.appearance.preset, AppearancePreset::Paper);
        assert_eq!(saved.appearance.accent, AppearanceAccent::Ice);
        assert_eq!(saved.appearance.density, AppearanceDensity::Compact);
        assert_eq!(saved.appearance.radius, AppearanceRadius::Round);
        assert_eq!(saved.appearance.chat_background, ChatBackground::None);
        // Derived fields follow the preserved section, not the legacy theme.
        assert_eq!(saved.theme, ThemePreference::Light);
        assert!(saved.compact);

        // And the file on disk kept the section too.
        let reopened = SettingsStore::open(dir.path()).settings();
        assert_eq!(reopened.appearance.preset, AppearancePreset::Paper);
        assert_eq!(reopened.appearance.accent, AppearanceAccent::Ice);
    }

    #[test]
    fn the_stage_2_3_profile_is_imported_without_losing_settings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let profile = serde_json::json!({
            "version": 1,
            "nickname": "Bob",
            "selfMuted": true,
            "selfDeafened": false
        });
        std::fs::write(
            dir.path().join(LEGACY_PROFILE_FILE),
            serde_json::to_vec(&profile).expect("json"),
        )
        .expect("write");

        let mut store = SettingsStore::open(dir.path());
        assert_eq!(store.nickname(), "Bob");
        assert!(store.voice_preferences().self_muted);
        assert!(dir.path().join(SETTINGS_FILE).exists());

        // A nickname chosen in the settings window wins over the old profile.
        store.set_nickname("Carol").expect("nickname");
        let reopened = SettingsStore::open(dir.path());
        assert_eq!(reopened.nickname(), "Carol");
    }

    #[test]
    fn an_empty_nickname_is_rejected_and_not_saved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = SettingsStore::open(dir.path());
        let error = store.set_nickname("   ").expect_err("empty nickname");
        assert_eq!(error.code, CoreErrorCode::InvalidRequest);
        assert!(store.nickname().is_empty());
        assert!(!dir.path().join(SETTINGS_FILE).exists());
    }

    #[test]
    fn every_cyrillic_accelerator_is_migrated_to_its_physical_key() {
        assert_eq!(YCUKEN_TO_QWERTY.len(), 33);
        for (cyrillic, latin) in YCUKEN_TO_QWERTY {
            let mut settings = ClientSettings::default();
            settings.voice.hotkeys = vec![HotkeyBinding {
                action: HotkeyAction::CommandPalette,
                accelerator: Some(format!("Ctrl+{cyrillic}")),
            }];
            let settings = settings.sanitized();
            let palette = settings
                .voice
                .hotkeys
                .iter()
                .find(|binding| binding.action == HotkeyAction::CommandPalette);
            let expected = format!("Ctrl+{latin}");
            assert_eq!(
                palette.and_then(|binding| binding.accelerator.as_deref()),
                Some(expected.as_str()),
                "Ctrl+{cyrillic} must become Ctrl+{latin}"
            );
        }
    }

    #[test]
    fn an_old_cyrillic_binding_is_rewritten_on_load() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut value = serde_json::to_value(ClientSettings::default()).expect("json");
        value
            .get_mut("voice")
            .and_then(|voice| voice.get_mut("hotkeys"))
            .and_then(Value::as_array_mut)
            .expect("hotkeys")
            .iter_mut()
            .find(|binding| binding.get("action").and_then(Value::as_str) == Some("commandPalette"))
            .expect("palette binding")
            .as_object_mut()
            .expect("binding object")
            .insert("accelerator".to_owned(), Value::from("Ctrl+Л"));
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            serde_json::to_vec(&value).expect("json"),
        )
        .expect("write");

        let store = SettingsStore::open(dir.path());
        let palette = store
            .settings()
            .voice
            .hotkeys
            .iter()
            .find(|binding| binding.action == HotkeyAction::CommandPalette)
            .and_then(|binding| binding.accelerator.clone());
        assert_eq!(palette.as_deref(), Some("Ctrl+K"));

        // The migration is written back, not repeated on every start.
        let saved: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(SETTINGS_FILE)).expect("read"))
                .expect("saved json");
        let accelerator = saved
            .get("voice")
            .and_then(|voice| voice.get("hotkeys"))
            .and_then(Value::as_array)
            .and_then(|hotkeys| {
                hotkeys
                    .iter()
                    .find(|binding| {
                        binding.get("action").and_then(Value::as_str) == Some("commandPalette")
                    })
                    .and_then(|binding| binding.get("accelerator"))
            })
            .and_then(Value::as_str);
        assert_eq!(accelerator, Some("Ctrl+K"));
    }
}
