//! Diagnostics export (local, never uploaded).
//!
//! The user asks for a file explicitly and picks its location in a native
//! dialog; the page never supplies a path and never receives the log itself.
//! The report carries the version banner, a settings summary that is safe to
//! hand to a developer, and the tail of the local log. Identity, bookmarks,
//! participants, invites, tokens, messages, history and attachment contents
//! are deliberately absent.
//!
//! Clearing the log is the other half of the promise: the files are removed
//! from disk, not just hidden from the export.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rostalk_core::{
    ClientSettings, CoreError, CoreHandle, GateSettings, LocalePreference, PROTOCOL_VERSION,
};
use rostalk_voice::{AudioFormats, DeviceInfo, DeviceList, StreamFormatInfo, VoiceHandle};
use tauri::State;

use crate::logging;

/// Upper bound for the log text inside one export (about 2 MiB).
const MAX_EXPORT_LOG_BYTES: u64 = 2 * 1024 * 1024;

/// Timestamp in both a file-name form and a human form, always UTC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Stamp {
    /// `YYYYMMDD-HHMMSS`, used in the default file name.
    pub file: String,
    /// `YYYY-MM-DD HH:MM:SS UTC`, used in the report.
    pub human: String,
}

impl Stamp {
    /// Current UTC time.
    #[must_use]
    pub fn now() -> Self {
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        Self::from_unix(seconds)
    }

    /// UTC time for a Unix timestamp; separated for tests.
    #[must_use]
    pub fn from_unix(seconds: u64) -> Self {
        let days = i64::try_from(seconds / 86_400).unwrap_or(0);
        let of_day = seconds % 86_400;
        let (year, month, day) = civil_from_days(days);
        let hour = of_day / 3_600;
        let minute = (of_day % 3_600) / 60;
        let second = of_day % 60;
        Self {
            file: format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}"),
            human: format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02} UTC"),
        }
    }
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's
/// `civil_from_days`). Avoids a calendar dependency for a timestamp.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    (year, month as u32, day as u32)
}

/// Labels and on/off words in the user's language.
struct Labels {
    app: &'static str,
    protocol: &'static str,
    os: &'static str,
    webview: &'static str,
    locale: &'static str,
    time: &'static str,
    settings: &'static str,
    theme: &'static str,
    preset: &'static str,
    accent: &'static str,
    density: &'static str,
    input: &'static str,
    output: &'static str,
    format_input: &'static str,
    format_output: &'static str,
    format_default: &'static str,
    system_default: &'static str,
    unknown_device: &'static str,
    gate: &'static str,
    threshold: &'static str,
    noise: &'static str,
    echo: &'static str,
    gain: &'static str,
    economy: &'static str,
    log: &'static str,
    log_enabled: &'static str,
    log_disabled: &'static str,
    log_empty: &'static str,
    on: &'static str,
    off: &'static str,
}

const RU: Labels = Labels {
    app: "Версия приложения",
    protocol: "Версия протокола",
    os: "ОС и архитектура",
    webview: "WebView2",
    locale: "Локаль",
    time: "Время",
    settings: "Настройки (без секретов)",
    theme: "Тема",
    preset: "Пресет",
    accent: "Акцент",
    density: "Плотность",
    input: "Устройство ввода",
    output: "Устройство вывода",
    format_input: "Формат ввода",
    format_output: "Формат вывода",
    format_default: "по умолчанию",
    system_default: "системное по умолчанию",
    unknown_device: "недоступно",
    gate: "Режим передачи",
    threshold: "Порог",
    noise: "Шумоподавление",
    echo: "Эхоподавление",
    gain: "Автогромкость",
    economy: "Экономный режим",
    log: "Журнал",
    log_enabled: "ведётся по согласию пользователя",
    log_disabled: "журнал отключён пользователем",
    log_empty: "файлов журнала нет",
    on: "вкл",
    off: "выкл",
};

const EN: Labels = Labels {
    app: "Application version",
    protocol: "Protocol version",
    os: "OS and architecture",
    webview: "WebView2",
    locale: "Locale",
    time: "Time",
    settings: "Settings (no secrets)",
    theme: "Theme",
    preset: "Preset",
    accent: "Accent",
    density: "Density",
    input: "Input device",
    output: "Output device",
    format_input: "Input format",
    format_output: "Output format",
    format_default: "device default",
    system_default: "system default",
    unknown_device: "unavailable",
    gate: "Transmission mode",
    threshold: "Threshold",
    noise: "Noise suppression",
    echo: "Echo cancellation",
    gain: "Automatic gain",
    economy: "Economy mode",
    log: "Log",
    log_enabled: "kept with the user's consent",
    log_disabled: "diagnostics log disabled by the user",
    log_empty: "no log files",
    on: "on",
    off: "off",
};

fn labels(locale: LocalePreference) -> &'static Labels {
    match locale {
        LocalePreference::Ru => &RU,
        LocalePreference::En => &EN,
    }
}

fn switch(value: bool, labels: &Labels) -> &'static str {
    if value {
        labels.on
    } else {
        labels.off
    }
}

fn device_name(configured: Option<&str>, devices: &[DeviceInfo], labels: &Labels) -> String {
    let Some(id) = configured else {
        return labels.system_default.to_owned();
    };
    devices
        .iter()
        .find(|device| device.id == id)
        .map(|device| device.name.clone())
        .unwrap_or_else(|| labels.unknown_device.to_owned())
}

/// `Input format: 2 ch, 48000 Hz, F32 (device default: 2 ch, ...)`.
///
/// The opened format answers "what does the client actually run with"; the
/// device default answers "what would it run with without a choice" (stage P5:
/// a 7.1 endpoint and its stereo/8-channel difference).
fn format_line(label: &str, format: Option<&StreamFormatInfo>, labels: &Labels) -> String {
    match format {
        Some(info) => format!(
            "{label}: {} ({}: {})",
            info.opened.describe(),
            labels.format_default,
            info.default.describe()
        ),
        None => format!("{label}: {}", labels.unknown_device),
    }
}

fn gate_name(gate: GateSettings) -> String {
    match gate {
        GateSettings::Continuous => "continuous".to_owned(),
        GateSettings::PushToTalk => "pushToTalk".to_owned(),
        GateSettings::VoiceActivation {
            threshold_db,
            hold_ms,
        } => format!("voiceActivation ({threshold_db:.0} dB, hold {hold_ms} ms)"),
    }
}

/// Builds the export text. Pure, so the no-secrets test does not need a window
/// or a log file.
pub(crate) fn build_report(
    settings: &ClientSettings,
    devices: &DeviceList,
    formats: &AudioFormats,
    webview_version: Option<&str>,
    stamp: &Stamp,
    log_enabled: bool,
    log: &logging::LogSnapshot,
) -> String {
    let labels = labels(settings.locale);
    let appearance = &settings.appearance;
    let voice = &settings.voice;
    let mut report = String::new();

    report.push_str("RosTalk diagnostics\n==================\n\n");
    report.push_str(&format!("{}: {}\n", labels.app, env!("CARGO_PKG_VERSION")));
    report.push_str(&format!("{}: {}\n", labels.protocol, PROTOCOL_VERSION));
    report.push_str(&format!(
        "{}: {} {}\n",
        labels.os,
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    report.push_str(&format!(
        "{}: {}\n",
        labels.webview,
        webview_version.unwrap_or("—")
    ));
    report.push_str(&format!("{}: {}\n", labels.locale, settings.locale.tag()));
    report.push_str(&format!("{}: {}\n\n", labels.time, stamp.human));

    report.push_str(&format!("{}\n-------------------\n", labels.settings));
    report.push_str(&format!(
        "{}: {}\n",
        labels.theme,
        match settings.theme {
            rostalk_core::ThemePreference::Dark => "dark",
            rostalk_core::ThemePreference::Light => "light",
        }
    ));
    report.push_str(&format!(
        "{}: {}\n",
        labels.preset,
        format!("{:?}", appearance.preset).to_lowercase()
    ));
    report.push_str(&format!(
        "{}: {}\n",
        labels.accent,
        format!("{:?}", appearance.accent).to_lowercase()
    ));
    report.push_str(&format!(
        "{}: {}\n",
        labels.density,
        format!("{:?}", appearance.density).to_lowercase()
    ));
    report.push_str(&format!(
        "{}: {}\n",
        labels.input,
        device_name(voice.input_device.as_deref(), &devices.inputs, labels)
    ));
    report.push_str(&format!(
        "{}: {}\n",
        labels.output,
        device_name(voice.output_device.as_deref(), &devices.outputs, labels)
    ));
    report.push_str(&format_line(
        labels.format_input,
        formats.input.as_ref(),
        labels,
    ));
    report.push('\n');
    report.push_str(&format_line(
        labels.format_output,
        formats.output.as_ref(),
        labels,
    ));
    report.push('\n');
    report.push_str(&format!("{}: {}\n", labels.gate, gate_name(voice.gate)));
    if let GateSettings::VoiceActivation { threshold_db, .. } = voice.gate {
        report.push_str(&format!("{}: {threshold_db:.0} dB\n", labels.threshold));
    }
    report.push_str(&format!(
        "{}: {}\n",
        labels.noise,
        match voice.processing.noise_model {
            rostalk_core::NoiseSuppressor::Off => labels.off.to_owned(),
            rostalk_core::NoiseSuppressor::WebRtc => "webRtc".to_owned(),
            rostalk_core::NoiseSuppressor::RnNoise => "rnNoise".to_owned(),
            rostalk_core::NoiseSuppressor::DeepFilter => "deepFilter".to_owned(),
        }
    ));
    report.push_str(&format!(
        "{}: {}, {}: {}, {}: {}\n",
        labels.echo,
        switch(voice.processing.echo_cancellation, labels),
        labels.gain,
        switch(voice.processing.gain_control, labels),
        labels.economy,
        switch(settings.economy_mode, labels)
    ));

    report.push_str(&format!(
        "\n{}: {}\n-------------------\n",
        labels.log,
        if log_enabled {
            labels.log_enabled
        } else {
            labels.log_disabled
        }
    ));
    if log.files == 0 {
        report.push_str(labels.log_empty);
        report.push('\n');
    } else {
        report.push_str(&log.text);
    }
    report
}

/// Default file name offered by the save dialog.
fn default_file_name(stamp: &Stamp) -> String {
    format!("rostalk-diagnostics-{}.log", stamp.file)
}

/// Saves one report. `None` when the user cancels the dialog.
#[tauri::command]
#[specta::specta]
pub async fn export_diagnostics(
    core: State<'_, Arc<CoreHandle>>,
    voice: State<'_, VoiceHandle>,
) -> Result<Option<String>, CoreError> {
    let settings = core.settings();
    let devices = voice.devices();
    let formats = voice.formats();
    let stamp = Stamp::now();
    let name = default_file_name(&stamp);
    let picked = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .add_filter("RosTalk diagnostics", &["log"])
            .set_file_name(name)
            .save_file()
    })
    .await
    .ok()
    .flatten();
    let Some(path) = picked else {
        return Ok(None);
    };

    let webview = tauri::webview_version().ok();
    let report = build_report(
        &settings,
        &devices,
        &formats,
        webview.as_deref(),
        &stamp,
        logging::is_enabled(),
        &logging::read_recent(MAX_EXPORT_LOG_BYTES),
    );
    std::fs::write(&path, report)
        .map_err(|error| CoreError::internal(format!("write the diagnostics file: {error}")))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Removes `rostalk.log` and `rostalk.log.1`.
#[tauri::command]
#[specta::specta]
pub fn clear_diagnostics() -> Result<(), CoreError> {
    logging::clear()
        .map_err(|error| CoreError::internal(format!("clear the diagnostics log: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rostalk_core::VoiceSettings;
    use rostalk_voice::DeviceList;

    fn devices() -> DeviceList {
        DeviceList {
            inputs: vec![DeviceInfo {
                id: "mic-1".to_owned(),
                name: "Studio Microphone".to_owned(),
                is_default: true,
                channels: 1,
                sample_rate: 48_000,
                sample_format: "F32".to_owned(),
            }],
            outputs: vec![DeviceInfo {
                id: "out-1".to_owned(),
                name: "Headphones".to_owned(),
                is_default: true,
                channels: 2,
                sample_rate: 48_000,
                sample_format: "F32".to_owned(),
            }],
            default_input: Some("mic-1".to_owned()),
            default_output: Some("out-1".to_owned()),
        }
    }

    fn settings_with_secrets() -> ClientSettings {
        let mut settings = ClientSettings::default();
        // The nickname of a peer and the participant key are private; a test
        // token and password make a leak obvious.
        settings.nickname = "PeerName-Secret hunter2".to_owned();
        settings.participants = vec![rostalk_core::ParticipantSettings {
            key: "server-secret:42 Bearer secret-token".to_owned(),
            volume: 100,
            muted: false,
        }];
        settings.default_channel_id = Some(42);
        settings.voice = VoiceSettings {
            input_device: Some("mic-1".to_owned()),
            output_device: Some("out-1".to_owned()),
            ..VoiceSettings::default()
        };
        settings
    }

    fn formats() -> AudioFormats {
        AudioFormats {
            input: Some(StreamFormatInfo {
                opened: rostalk_voice::OpenFormat {
                    channels: 1,
                    sample_rate: 48_000,
                    sample_format: "F32".to_owned(),
                },
                default: rostalk_voice::OpenFormat {
                    channels: 1,
                    sample_rate: 48_000,
                    sample_format: "F32".to_owned(),
                },
            }),
            output: Some(StreamFormatInfo {
                opened: rostalk_voice::OpenFormat {
                    channels: 8,
                    sample_rate: 48_000,
                    sample_format: "F32".to_owned(),
                },
                default: rostalk_voice::OpenFormat {
                    channels: 8,
                    sample_rate: 44_100,
                    sample_format: "I16".to_owned(),
                },
            }),
        }
    }

    #[test]
    fn the_report_has_the_version_and_the_log_but_no_secrets() {
        let settings = settings_with_secrets();
        let stamp = Stamp::from_unix(1_700_000_000);
        let log = logging::LogSnapshot {
            text: "--- rostalk.log ---\n[  1.000s] INFO  voice: stream rebuilt\n".to_owned(),
            files: 1,
            truncated: false,
        };
        let report = build_report(
            &settings,
            &devices(),
            &formats(),
            Some("120.0.2210.144"),
            &stamp,
            true,
            &log,
        );

        assert!(report.contains(env!("CARGO_PKG_VERSION")));
        assert!(report.contains("120.0.2210.144"));
        assert!(report.contains("Studio Microphone"));
        assert!(report.contains("Headphones"));
        assert!(report.contains("stream rebuilt"));
        assert!(report.contains("2023-11-14 22:13:20 UTC"));
        assert!(report.contains("voiceActivation"));
        // Stage P5: the opened output format and the device default are part of
        // the report, so a 7.1 report shows what the client actually opened.
        assert!(report
            .contains("Формат вывода: 8 ch, 48000 Hz, F32 (по умолчанию: 8 ch, 44100 Hz, I16)"));
        assert!(report.contains("Формат ввода: 1 ch, 48000 Hz, F32"));

        // Identity, nicknames, participant keys, tokens and messages never
        // reach the report, even when they sit in the settings object.
        for secret in [
            "PeerName-Secret",
            "server-secret",
            "secret-token",
            "hunter2",
            "Bearer ",
        ] {
            assert!(!report.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn a_report_without_an_opened_device_says_the_format_is_unavailable() {
        let report = build_report(
            &ClientSettings::default(),
            &devices(),
            &AudioFormats::default(),
            None,
            &Stamp::from_unix(0),
            false,
            &logging::LogSnapshot::default(),
        );
        assert!(report.contains("Формат вывода: недоступно"));
        assert!(report.contains("Формат ввода: недоступно"));
    }

    #[test]
    fn a_disabled_log_says_so_and_still_exports() {
        let settings = ClientSettings::default();
        let stamp = Stamp::from_unix(0);
        let report = build_report(
            &settings,
            &devices(),
            &AudioFormats::default(),
            None,
            &stamp,
            false,
            &logging::LogSnapshot::default(),
        );
        assert!(report.contains("журнал отключён пользователем"));
        assert!(report.contains("файлов журнала нет"));
        assert!(report.contains("1970-01-01 00:00:00 UTC"));
    }

    #[test]
    fn the_timestamp_handles_a_leap_day() {
        // 2024-02-29T12:34:56Z.
        let stamp = Stamp::from_unix(1_709_210_096);
        assert_eq!(stamp.file, "20240229-123456");
        assert_eq!(stamp.human, "2024-02-29 12:34:56 UTC");
    }

    #[test]
    fn a_missing_device_does_not_echo_the_stored_identifier() {
        let mut settings = settings_with_secrets();
        settings.voice.input_device = Some("secret-token-device".to_owned());
        let report = build_report(
            &settings,
            &devices(),
            &AudioFormats::default(),
            None,
            &Stamp::from_unix(0),
            false,
            &logging::LogSnapshot::default(),
        );
        assert!(!report.contains("secret-token-device"));
        assert!(report.contains("недоступно"));
    }
}
