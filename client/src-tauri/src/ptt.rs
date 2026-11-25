//! Push-to-talk binding and input status (stage 2.3.1, key picker in 2.4).
//!
//! Stage 2.3 bound push-to-talk to the extra mouse buttons only. Mice without
//! X2, and an input registration that failed, made the mode silently dead. The
//! default binding now accepts both extra buttons; a keyboard key is opt-in
//! only and is chosen in the settings window.
//!
//! The global path is Raw Input (`crates/platform`), not a low-level `WH_*`
//! hook: Vanguard compatibility is mandatory (ADR 0012). A printable key must
//! never be the default — typing it in a game or chat would open the
//! microphone and look suspicious to anti-cheat software.
//!
//! Only single keys are accepted for the global binding. Raw Input reports the
//! key itself; matching modifiers would need `GetAsyncKeyState` polling and is
//! deliberately out of scope (ADR 0012). The window-local hotkeys in the UI
//! still support modifiers.

use std::sync::{Mutex, OnceLock};

use rostalk_platform::{InputEvent, InputHandler, InputHook, MouseButton};
use rostalk_voice::{PttHookState, PttStatus, VoiceHandle};

/// Human-readable default binding shown next to the gate control.
pub const PUSH_TO_TALK_BINDING: &str = "X1/X2";

/// The running Raw Input registration. Dropping it stops the message thread,
/// so a new binding replaces the old one instead of leaving two hooks alive.
fn active_hook() -> &'static Mutex<Option<InputHook>> {
    static HOOK: OnceLock<Mutex<Option<InputHook>>> = OnceLock::new();
    HOOK.get_or_init(|| Mutex::new(None))
}

/// Parsed global binding: the mouse buttons are always captured, the optional
/// scan code is the explicitly chosen keyboard key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Binding {
    scan: Option<u32>,
}

impl Binding {
    /// Parses the accelerator shown in the settings window.
    ///
    /// `None`/empty means "unbound": the global hook still captures X1/X2,
    /// which keeps the stage 2.3 default working after resetting the settings.
    fn parse(accelerator: Option<&str>) -> Self {
        let Some(value) = accelerator else {
            return Self { scan: None };
        };
        let value = migrate_key(value.trim());
        if value.is_empty() || value.eq_ignore_ascii_case(PUSH_TO_TALK_BINDING) {
            return Self { scan: None };
        }
        if matches!(value.as_str(), "X1" | "X2" | "Mouse4" | "Mouse5") {
            return Self { scan: None };
        }
        Self {
            scan: scan_code(&value),
        }
    }

    /// Human-readable label; includes the key when one is bound.
    fn label(self) -> String {
        match self.scan {
            Some(scan) => format!("{PUSH_TO_TALK_BINDING} + {}", key_name(scan)),
            None => PUSH_TO_TALK_BINDING.to_owned(),
        }
    }
}

/// Set-1 make code of a single accelerator key.
///
/// Returns `None` for chords (`Ctrl+K`), unknown names and modifier-only keys:
/// the global hook cannot match modifiers without polling their state. The
/// physical key (scan code) is matched instead of a virtual-key code, so the
/// binding works in every keyboard layout.
fn scan_code(name: &str) -> Option<u32> {
    let upper = name.trim().to_ascii_uppercase();
    if upper.len() == 1 {
        let ch = upper.chars().next()?;
        if ch.is_ascii_alphabetic() || ch.is_ascii_digit() {
            return rostalk_platform::scan_code_for_key_name(&ch.to_string());
        }
    }
    if let Some(number) = upper.strip_prefix('F') {
        if let Ok(index) = number.parse::<u32>() {
            if (1..=24).contains(&index) {
                return rostalk_platform::scan_code_for_key_name(&format!("F{index}"));
            }
        }
    }
    // The picker writes `ArrowUp`; accept the short spelling too.
    let canonical = match upper.as_str() {
        "RETURN" => "Enter",
        "UP" => "ArrowUp",
        "DOWN" => "ArrowDown",
        "LEFT" => "ArrowLeft",
        "RIGHT" => "ArrowRight",
        other => other,
    };
    rostalk_platform::scan_code_for_key_name(canonical)
        .or_else(|| rostalk_platform::scan_code_for_key_name(name.trim()))
}

/// Display name of a scan code, for the status line.
fn key_name(scan: u32) -> String {
    rostalk_platform::key_name_for_scan(scan).map_or_else(
        || format!("scan {scan:#06X}"),
        std::string::ToString::to_string,
    )
}

/// Translates a single ЙЦУКЕН character saved by the old picker to the QWERTY
/// key in the same place: `Л` -> `K` (playtest-1, P4). Other names pass through.
fn migrate_key(name: &str) -> String {
    let mut chars = name.chars();
    let (Some(ch), None) = (chars.next(), chars.next()) else {
        return name.to_owned();
    };
    let lower = ch.to_lowercase().next().unwrap_or(ch);
    match lower {
        'й' => "Q",
        'ц' => "W",
        'у' => "E",
        'к' => "R",
        'е' => "T",
        'н' => "Y",
        'г' => "U",
        'ш' => "I",
        'щ' => "O",
        'з' => "P",
        'х' => "[",
        'ъ' => "]",
        'ф' => "A",
        'ы' => "S",
        'в' => "D",
        'а' => "F",
        'п' => "G",
        'р' => "H",
        'о' => "J",
        'л' => "K",
        'д' => "L",
        'ж' => ";",
        'э' => "'",
        'я' => "Z",
        'ч' => "X",
        'с' => "C",
        'м' => "V",
        'и' => "B",
        'т' => "N",
        'ь' => "M",
        'б' => "Comma",
        'ю' => "Period",
        'ё' => "`",
        _ => return name.to_owned(),
    }
    .to_owned()
}

/// Reports a press (`Some(true)`) or release (`Some(false)`) of a bound input.
///
/// Returns `None` for every other event so the input thread ignores it.
fn push_to_talk_event_for(event: InputEvent, scan: Option<u32>) -> Option<bool> {
    match event {
        InputEvent::Mouse {
            button: MouseButton::X1 | MouseButton::X2,
            down,
        } => Some(down),
        InputEvent::Key { scan: code, down } if Some(code) == scan => Some(down),
        _ => None,
    }
}

/// Installs global Raw Input for the binding and returns the status for the UI.
///
/// A failure is not fatal: the voice engine keeps the voice-activation gate,
/// and the UI shows why push-to-talk is unavailable. Replacing a binding stops
/// the previous registration first.
pub fn install_push_to_talk(voice: &VoiceHandle, accelerator: Option<&str>) -> PttStatus {
    let binding = Binding::parse(accelerator);
    let label = binding.label();
    if !rostalk_platform::input_hook_supported() {
        eprintln!("rostalk: push-to-talk needs the Windows desktop client");
        return PttStatus {
            hook: PttHookState::Unsupported,
            binding: label,
            error: None,
        };
    }

    // Stop the old registration before installing the new one: Raw Input for
    // the mouse cannot be registered twice in the same process.
    if let Ok(mut slot) = active_hook().lock() {
        if let Some(hook) = slot.take() {
            hook.stop();
        }
    }

    let key = binding.scan;
    let voice = voice.clone();
    let handler: InputHandler = std::sync::Arc::new(move |event| {
        if let Some(down) = push_to_talk_event_for(event, key) {
            // The engine only stores a flag; never log the key here.
            let _ = voice.set_push_to_talk(down);
        }
    });
    match rostalk_platform::install_input_hook(handler, key.is_some()) {
        Ok(hook) => {
            eprintln!("rostalk: push-to-talk Raw Input installed ({label})");
            if let Ok(mut slot) = active_hook().lock() {
                *slot = Some(hook);
            }
            PttStatus {
                hook: PttHookState::Active,
                binding: label,
                error: None,
            }
        }
        Err(error) => {
            eprintln!("rostalk: push-to-talk Raw Input is unavailable: {error}");
            PttStatus {
                hook: PttHookState::Unavailable,
                binding: label,
                error: Some(error.to_string()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mouse(button: MouseButton, down: bool) -> InputEvent {
        InputEvent::Mouse { button, down }
    }

    fn key(scan: u32, down: bool) -> InputEvent {
        InputEvent::Key { scan, down }
    }

    #[test]
    fn both_extra_mouse_buttons_work() {
        assert_eq!(
            push_to_talk_event_for(mouse(MouseButton::X1, true), None),
            Some(true)
        );
        assert_eq!(
            push_to_talk_event_for(mouse(MouseButton::X1, false), None),
            Some(false)
        );
        assert_eq!(
            push_to_talk_event_for(mouse(MouseButton::X2, true), None),
            Some(true)
        );
        assert_eq!(
            push_to_talk_event_for(mouse(MouseButton::X2, false), None),
            Some(false)
        );
    }

    #[test]
    fn no_keyboard_key_is_bound_by_default() {
        // `V` used to be a global default. It must not open the gate now.
        // 0x2F is the set-1 scan code of the physical V key.
        assert_eq!(push_to_talk_event_for(key(0x2F, true), None), None);
        assert_eq!(push_to_talk_event_for(key(0x2F, false), None), None);
    }

    #[test]
    fn an_explicit_key_is_honoured() {
        assert_eq!(
            push_to_talk_event_for(key(0x2F, true), Some(0x2F)),
            Some(true)
        );
        assert_eq!(
            push_to_talk_event_for(key(0x2F, false), Some(0x2F)),
            Some(false)
        );
        assert_eq!(push_to_talk_event_for(key(0x2E, true), Some(0x2F)), None);
    }

    #[test]
    fn an_extended_key_matches_only_its_own_scan_code() {
        let arrow_up = rostalk_platform::SCAN_EXTENDED | 0x48;
        // Numpad8 shares make code 48; only E0 tells it from Arrow Up.
        assert_eq!(
            push_to_talk_event_for(key(arrow_up, true), Some(arrow_up)),
            Some(true)
        );
        assert_eq!(
            push_to_talk_event_for(key(0x48, true), Some(arrow_up)),
            None
        );
        assert_eq!(Binding::parse(Some("ArrowUp")).scan, Some(arrow_up));
        assert_eq!(Binding::parse(Some("Numpad8")).scan, Some(0x48));
    }

    #[test]
    fn a_cyrillic_binding_from_an_old_file_is_migrated() {
        // The old picker stored the character: `Л` is on the physical K key.
        let binding = Binding::parse(Some("Л"));
        assert_eq!(binding.scan, Some(0x25));
        assert_eq!(binding.label(), "X1/X2 + K");
        assert_eq!(Binding::parse(Some("ф")).scan, Some(0x1E));
        assert_eq!(Binding::parse(Some("б")).scan, Some(0x33));
    }

    #[test]
    fn unrelated_input_is_ignored() {
        assert_eq!(
            push_to_talk_event_for(mouse(MouseButton::Left, true), None),
            None
        );
        assert_eq!(
            push_to_talk_event_for(mouse(MouseButton::Right, true), None),
            None
        );
        assert_eq!(
            push_to_talk_event_for(mouse(MouseButton::Middle, false), None),
            None
        );
        // `C` is next to `V`: a different key must not open the gate.
        assert_eq!(push_to_talk_event_for(key(0x2E, true), None), None);
    }

    #[test]
    fn the_binding_is_mouse_only_by_default() {
        assert_eq!(PUSH_TO_TALK_BINDING, "X1/X2");
        assert!(!PUSH_TO_TALK_BINDING.contains('V'));
        assert_eq!(Binding::parse(None).label(), "X1/X2");
        assert_eq!(Binding::parse(Some("X1/X2")).label(), "X1/X2");
        assert_eq!(Binding::parse(Some("Mouse5")).label(), "X1/X2");
    }

    #[test]
    fn a_single_key_can_be_bound() {
        let binding = Binding::parse(Some("F8"));
        assert_eq!(binding.scan, Some(0x42));
        assert_eq!(binding.label(), "X1/X2 + F8");
        assert_eq!(Binding::parse(Some("V")).scan, Some(0x2F));
        assert_eq!(Binding::parse(Some("Space")).scan, Some(0x39));
        assert_eq!(Binding::parse(Some("Comma")).scan, Some(0x33));
        assert_eq!(key_name(0x2F), "V");
    }

    #[test]
    fn chords_and_unknown_names_keep_the_mouse_binding() {
        assert_eq!(Binding::parse(Some("Ctrl+Shift+K")).scan, None);
        assert_eq!(Binding::parse(Some("Ctrl")).scan, None);
        assert_eq!(Binding::parse(Some("Shift")).scan, None);
        assert_eq!(Binding::parse(Some("Nonsense")).scan, None);
    }
}
