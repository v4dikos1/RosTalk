//! Global input for push-to-talk, mute and deafen (stages 2.3.1, 2.4, P24).
//!
//! The only global path is Raw Input in `crates/platform` (ADR 0012): it
//! delivers keys and mouse buttons while another window — a game — is in front,
//! does not swallow them and needs no hook, injection or driver.
//!
//! Push-to-talk is a hold: the gate opens on the first bound input and closes
//! when every bound input is released. Mute and deafen are toggles: one action
//! per deliberate press, so a held key and its auto-repeat toggle once. A lost
//! device releases only that device's held inputs instead of leaving the
//! microphone open or clearing another mouse's state.
//!
//! Modifier combinations (`Ctrl+Shift+M`) are matched from the same Raw Input
//! make/break reports: the router counts the scancodes of Ctrl, Shift, Alt and
//! Meta that are currently down. It never polls `GetAsyncKeyState`.
//!
//! Background keyboard capture is an explicit choice (ADR 0012): a single key
//! or mouse button is global by itself, while a combination needs
//! `backgroundHotkeys` in the settings. That keeps a fresh install mouse-only.
//! Push-to-talk, mute and deafen are independent: an invalid push-to-talk
//! binding does not stop the valid toggles from registering.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use rostalk_platform::{DeviceId, InputEvent, InputHandler, InputHook, MouseButton};
use rostalk_voice::{GlobalInputStatus, PttHookState, PttStatus, VoiceHandle};

/// Human-readable default binding shown next to the gate control.
pub const PUSH_TO_TALK_BINDING: &str = "X1/X2";

/// A global action that is not a hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlobalAction {
    ToggleMute,
    ToggleDeafen,
}

/// Receives the global toggle actions on the input thread.
///
/// The sink must return immediately; the application queues the server request
/// and never blocks the message loop.
pub type ToggleSink = Arc<dyn Fn(GlobalAction) + Send + Sync>;

/// Global bindings from the settings, as configured by the user.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GlobalConfig {
    pub push_to_talk: Option<String>,
    pub toggle_mute: Option<String>,
    pub toggle_deafen: Option<String>,
    /// The user allowed modifier combinations to be captured in the
    /// background (ADR 0012). Off by default: a fresh install stays mouse-only.
    pub background_hotkeys: bool,
}

/// What the registration delivers, for the UI.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InstallResult {
    pub ptt: PttStatus,
    pub global: GlobalInputStatus,
}

/// The running Raw Input registration. Dropping it stops the message thread,
/// so a new binding replaces the old one instead of leaving two hooks alive.
fn active_hook() -> &'static Mutex<Option<InputHook>> {
    static HOOK: OnceLock<Mutex<Option<InputHook>>> = OnceLock::new();
    HOOK.get_or_init(|| Mutex::new(None))
}

/// One physical input a binding can match. Scan codes are layout-independent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Physical {
    Key(u32),
    Mouse(MouseButton),
}

/// Modifier keys a binding requires.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Modifiers {
    ctrl: bool,
    shift: bool,
    alt: bool,
    meta: bool,
}

impl Modifiers {
    fn any(self) -> bool {
        self.ctrl || self.shift || self.alt || self.meta
    }

    /// True when every required modifier is currently down. Other modifiers
    /// do not cancel a hold; releasing a required one does.
    fn satisfied_by(self, current: Self) -> bool {
        (!self.ctrl || current.ctrl)
            && (!self.shift || current.shift)
            && (!self.alt || current.alt)
            && (!self.meta || current.meta)
    }

    /// True when exactly these modifiers are down, for a one-shot toggle.
    fn exactly(self, current: Self) -> bool {
        self == current
    }

    fn label(self) -> String {
        let mut parts = Vec::new();
        if self.ctrl {
            parts.push("Ctrl");
        }
        if self.shift {
            parts.push("Shift");
        }
        if self.alt {
            parts.push("Alt");
        }
        if self.meta {
            parts.push("Meta");
        }
        parts.join("+")
    }
}

/// One physical input plus the modifiers it requires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Trigger {
    physical: Physical,
    modifiers: Modifiers,
}

impl Trigger {
    fn key_label(&self) -> String {
        match self.physical {
            Physical::Key(scan) => {
                let key = key_name(scan);
                if self.modifiers.any() {
                    format!("{}+{key}", self.modifiers.label())
                } else {
                    key
                }
            }
            Physical::Mouse(button) => {
                let name = mouse_name(button);
                if self.modifiers.any() {
                    format!("{}+{name}", self.modifiers.label())
                } else {
                    name
                }
            }
        }
    }
}

/// Parsed push-to-talk binding: the main inputs that open the gate.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PttBinding {
    triggers: Vec<Trigger>,
    label: String,
}

impl PttBinding {
    fn trigger_for(&self, physical: Physical) -> Option<Trigger> {
        self.triggers
            .iter()
            .copied()
            .find(|trigger| trigger.physical == physical)
    }
}

/// Builds a push-to-talk binding from the side buttons and an optional key.
fn ptt_from_inputs(
    buttons: &[MouseButton],
    key: Option<Trigger>,
    claimed_buttons: &[MouseButton],
) -> Result<PttBinding, String> {
    let buttons: Vec<MouseButton> = buttons
        .iter()
        .copied()
        .filter(|button| !claimed_buttons.contains(button))
        .collect();
    if buttons.is_empty() && key.is_none() {
        return Err("no push-to-talk input is left: another action owns it".to_owned());
    }
    let mut triggers: Vec<Trigger> = buttons
        .iter()
        .map(|button| Trigger {
            physical: Physical::Mouse(*button),
            modifiers: Modifiers::default(),
        })
        .collect();
    if let Some(key) = key {
        triggers.push(key);
    }
    let button_label = match buttons.as_slice() {
        [] => String::new(),
        [MouseButton::X1, MouseButton::X2] => PUSH_TO_TALK_BINDING.to_owned(),
        [MouseButton::X1] => "X1".to_owned(),
        [MouseButton::X2] => "X2".to_owned(),
        _ => buttons
            .iter()
            .copied()
            .map(mouse_name)
            .collect::<Vec<_>>()
            .join("/"),
    };
    let key_label = key.map(|trigger| trigger.key_label()).unwrap_or_default();
    let label = match (button_label.is_empty(), key_label.is_empty()) {
        (true, true) => return Err("no push-to-talk input is left".to_owned()),
        (true, false) => key_label,
        (false, true) => button_label,
        (false, false) => format!("{button_label} + {key_label}"),
    };
    Ok(PttBinding { triggers, label })
}

fn mouse_name(button: MouseButton) -> String {
    match button {
        MouseButton::Left => "Mouse1".to_owned(),
        MouseButton::Right => "Mouse2".to_owned(),
        MouseButton::Middle => "Mouse3".to_owned(),
        MouseButton::X1 => "X1".to_owned(),
        MouseButton::X2 => "X2".to_owned(),
    }
}

fn single_mouse(value: &str) -> Option<MouseButton> {
    match value {
        "X1" | "Mouse4" => Some(MouseButton::X1),
        "X2" | "Mouse5" => Some(MouseButton::X2),
        _ => None,
    }
}

/// Set-1 make code of a single accelerator key.
///
/// Returns `None` for chords (`Ctrl+K`), unknown names and modifier-only keys.
/// The physical key (scan code) is matched instead of a virtual-key code, so
/// the binding works in every keyboard layout.
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

/// Splits `Ctrl+Shift+M` into modifiers and the key part.
fn split_accelerator(value: &str) -> Result<(Modifiers, &str), String> {
    let parts: Vec<&str> = value.split('+').collect();
    let (modifier_parts, key) = parts.split_at(parts.len().saturating_sub(1));
    let key = key.first().map_or("", |part| part.trim());
    if key.is_empty() {
        return Err(format!("{value} has no key"));
    }
    let mut modifiers = Modifiers::default();
    for part in modifier_parts {
        match part.trim().to_ascii_lowercase().as_str() {
            "ctrl" | "control" => modifiers.ctrl = true,
            "shift" => modifiers.shift = true,
            "alt" => modifiers.alt = true,
            "meta" | "win" => modifiers.meta = true,
            "" => return Err(format!("{value} has an empty modifier")),
            other => return Err(format!("unknown modifier {other}")),
        }
    }
    Ok((modifiers, key))
}

/// Parses one accelerator into a trigger.
///
/// `background` allows a combination; a single key or mouse button does not
/// need it. A combination without the opt-in stays window-local (ADR 0012).
fn parse_trigger(value: &str, background: bool) -> Result<Trigger, String> {
    let (modifiers, key) = split_accelerator(value)?;
    if modifiers.any() && !background {
        return Err(format!(
            "{value} is a background combination; enable it in the keys settings"
        ));
    }
    let physical = if let Some(button) = single_mouse(key) {
        Physical::Mouse(button)
    } else {
        match scan_code(key) {
            Some(scan) => Physical::Key(scan),
            None => return Err(format!("{value} is not a supported key")),
        }
    };
    Ok(Trigger {
        physical,
        modifiers,
    })
}

/// A toggle accelerator: unbound, global, or window-local.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TogglePlan {
    Unbound,
    Global(Trigger),
    LocalOnly,
}

fn plan_toggle(accelerator: Option<&str>, background: bool) -> TogglePlan {
    let Some(value) = accelerator else {
        return TogglePlan::Unbound;
    };
    let value = migrate_key(value.trim());
    if value.is_empty() {
        return TogglePlan::Unbound;
    }
    if value.eq_ignore_ascii_case(PUSH_TO_TALK_BINDING) {
        // A pair is not one toggle trigger.
        return TogglePlan::LocalOnly;
    }
    match parse_trigger(&value, background) {
        Ok(trigger) => TogglePlan::Global(trigger),
        Err(_) => TogglePlan::LocalOnly,
    }
}

/// Parses the push-to-talk accelerator.
///
/// A single keyboard key keeps the side buttons as an additional binding, as
/// the stage 2.3 default promised. Side buttons claimed explicitly by an
/// unmodified mute/deafen toggle are left to that action: an explicit binding
/// wins over an implicit default.
fn parse_ptt(
    accelerator: Option<&str>,
    background: bool,
    claimed_buttons: &[MouseButton],
) -> Result<PttBinding, String> {
    let Some(value) = accelerator else {
        return ptt_from_inputs(&[MouseButton::X1, MouseButton::X2], None, claimed_buttons);
    };
    let value = migrate_key(value.trim());
    if value.is_empty() || value.eq_ignore_ascii_case(PUSH_TO_TALK_BINDING) {
        return ptt_from_inputs(&[MouseButton::X1, MouseButton::X2], None, claimed_buttons);
    }
    let (modifiers, key) = split_accelerator(&value)?;
    if modifiers.any() && !background {
        return Err(format!(
            "{value} is a background combination; enable it in the keys settings"
        ));
    }
    // A single side button is its own binding; the pair stays the default.
    if let Some(button) = single_mouse(key) {
        let trigger = Trigger {
            physical: Physical::Mouse(button),
            modifiers,
        };
        return Ok(PttBinding {
            label: trigger.key_label(),
            triggers: vec![trigger],
        });
    }
    let scan = scan_code(key).ok_or_else(|| format!("{value} is not a supported key"))?;
    let key_trigger = Trigger {
        physical: Physical::Key(scan),
        modifiers,
    };
    ptt_from_inputs(
        &[MouseButton::X1, MouseButton::X2],
        Some(key_trigger),
        claimed_buttons,
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

/// Builds the install plan: independent PTT and toggle availability.
#[derive(Debug, Clone)]
struct Plan {
    ptt: Result<PttBinding, String>,
    toggles: Vec<(Trigger, GlobalAction)>,
    capture_keyboard: bool,
}

fn build_plan(config: &GlobalConfig) -> Plan {
    let background = config.background_hotkeys;
    let mute = plan_toggle(config.toggle_mute.as_deref(), background);
    let deafen = plan_toggle(config.toggle_deafen.as_deref(), background);
    for (plan, name) in [(mute, "mute"), (deafen, "deafen")] {
        if plan == TogglePlan::LocalOnly {
            log::info!("{name} stays window-local: enable background combinations or use a single key/button");
        }
    }
    // Only an unmodified explicit mouse toggle reclaims a side button from the
    // implicit push-to-talk pair; a modifier chord is a different input.
    let mut claimed = Vec::new();
    for plan in [mute, deafen] {
        if let TogglePlan::Global(trigger) = plan {
            if let Physical::Mouse(button) = trigger.physical {
                if !trigger.modifiers.any() {
                    claimed.push(button);
                }
            }
        }
    }
    let ptt = parse_ptt(config.push_to_talk.as_deref(), background, &claimed);
    let mut toggles = Vec::new();
    for (plan, action) in [
        (mute, GlobalAction::ToggleMute),
        (deafen, GlobalAction::ToggleDeafen),
    ] {
        if let TogglePlan::Global(trigger) = plan {
            toggles.push((trigger, action));
        }
    }
    let key_trigger = ptt.as_ref().is_ok_and(|binding| {
        binding
            .triggers
            .iter()
            .any(|trigger| matches!(trigger.physical, Physical::Key(_)))
    }) || toggles
        .iter()
        .any(|(trigger, _)| matches!(trigger.physical, Physical::Key(_)));
    // A mouse chord still needs the modifier state, which only arrives when
    // the keyboard usage is registered. Such a binding is explicit too.
    let modifier_trigger = ptt.as_ref().is_ok_and(|binding| {
        binding
            .triggers
            .iter()
            .any(|trigger| trigger.modifiers.any())
    }) || toggles.iter().any(|(trigger, _)| trigger.modifiers.any());
    Plan {
        ptt,
        toggles,
        capture_keyboard: key_trigger || modifier_trigger,
    }
}

/// Scan codes of modifier keys (set 1, `E0`-prefixed ones include
/// [`rostalk_platform::SCAN_EXTENDED`]).
const KEY_CTRL_LEFT: u32 = 0x1D;
const KEY_CTRL_RIGHT: u32 = rostalk_platform::SCAN_EXTENDED | 0x1D;
const KEY_SHIFT_LEFT: u32 = 0x2A;
const KEY_SHIFT_RIGHT: u32 = 0x36;
const KEY_ALT_LEFT: u32 = 0x38;
const KEY_ALT_RIGHT: u32 = rostalk_platform::SCAN_EXTENDED | 0x38;
const KEY_META_LEFT: u32 = rostalk_platform::SCAN_EXTENDED | 0x5B;
const KEY_META_RIGHT: u32 = rostalk_platform::SCAN_EXTENDED | 0x5C;

/// Scan code of a modifier key -> its bit.
fn modifier_bit(scan: u32) -> Option<Modifiers> {
    match scan {
        KEY_CTRL_LEFT | KEY_CTRL_RIGHT => Some(Modifiers {
            ctrl: true,
            ..Modifiers::default()
        }),
        KEY_SHIFT_LEFT | KEY_SHIFT_RIGHT => Some(Modifiers {
            shift: true,
            ..Modifiers::default()
        }),
        KEY_ALT_LEFT | KEY_ALT_RIGHT => Some(Modifiers {
            alt: true,
            ..Modifiers::default()
        }),
        KEY_META_LEFT | KEY_META_RIGHT => Some(Modifiers {
            meta: true,
            ..Modifiers::default()
        }),
        _ => None,
    }
}

/// One physical input on one device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct InputId {
    device: DeviceId,
    physical: Physical,
}

/// Per-registration state on the Raw Input message thread.
struct Router {
    /// `None` in unit tests: the state machine is tested without an engine.
    voice: Option<VoiceHandle>,
    ptt: Option<PttBinding>,
    toggles: Vec<(Trigger, GlobalAction)>,
    on_toggle: ToggleSink,
    /// Bound inputs currently held, with the modifiers each one requires.
    held: HashMap<InputId, Modifiers>,
    /// Every physical input currently down, for one action per press.
    pressed: HashSet<InputId>,
    /// Modifier keys currently down, per device, so removing one keyboard does
    /// not release a modifier held on another.
    modifier_keys: HashSet<(DeviceId, u32)>,
    open: bool,
}

impl Router {
    fn new(
        voice: Option<VoiceHandle>,
        ptt: Option<PttBinding>,
        toggles: Vec<(Trigger, GlobalAction)>,
        on_toggle: ToggleSink,
    ) -> Self {
        Self {
            voice,
            ptt,
            toggles,
            on_toggle,
            held: HashMap::new(),
            pressed: HashSet::new(),
            modifier_keys: HashSet::new(),
            open: false,
        }
    }

    fn handle(&mut self, event: InputEvent) {
        match event {
            InputEvent::DeviceRemoved { device } => {
                // Only this device's state is gone. Another mouse that is still
                // held must keep push-to-talk open and its auto-repeat
                // suppressed.
                self.modifier_keys.retain(|(owner, _)| *owner != device);
                self.pressed.retain(|id| id.device != device);
                self.held.retain(|id, _| id.device != device);
                // A modifier that was held only on the removed device is gone,
                // so a surviving main key's hold is now invalid. Prune it like
                // a normal modifier release: otherwise pressing the modifier
                // again on another device would reopen PTT without a new
                // main-key make.
                self.prune_invalid_holds();
                self.recompute_ptt();
            }
            InputEvent::Key { device, scan, down } => {
                if modifier_bit(scan).is_some() {
                    if down {
                        self.modifier_keys.insert((device, scan));
                    } else {
                        self.modifier_keys.remove(&(device, scan));
                    }
                    // A hold is only valid while every modifier it requires is
                    // still down. Releasing one invalidates the hold, so
                    // pressing the modifier again cannot reopen PTT without a
                    // new main-key make.
                    self.prune_invalid_holds();
                }
                self.on_physical(
                    InputId {
                        device,
                        physical: Physical::Key(scan),
                    },
                    down,
                );
            }
            InputEvent::Mouse {
                device,
                button,
                down,
            } => self.on_physical(
                InputId {
                    device,
                    physical: Physical::Mouse(button),
                },
                down,
            ),
        }
    }

    fn on_physical(&mut self, id: InputId, down: bool) {
        if down {
            let first = self.pressed.insert(id);
            let current = self.current_modifiers();
            // Only the first make of the main key may start a hold. A raw
            // auto-repeat after the user presses Ctrl/Shift later must not turn
            // ordinary typing into PTT, and it cannot revive a hold that a
            // modifier release invalidated.
            if first {
                if let Some(trigger) = self
                    .ptt
                    .as_ref()
                    .and_then(|ptt| ptt.trigger_for(id.physical))
                {
                    if trigger.modifiers.satisfied_by(current) {
                        self.held.insert(id, trigger.modifiers);
                    }
                }
            }
            self.recompute_ptt();
            // Auto-repeat sends more down reports while the input is held; only
            // the first one is a deliberate press.
            if first {
                if let Some((_, action)) = self.toggles.iter().find(|(trigger, _)| {
                    trigger.physical == id.physical && trigger.modifiers.exactly(current)
                }) {
                    (self.on_toggle)(*action);
                }
            }
        } else {
            self.pressed.remove(&id);
            self.held.remove(&id);
            self.recompute_ptt();
        }
    }

    /// Drops holds whose required modifiers are no longer held.
    fn prune_invalid_holds(&mut self) {
        let current = self.current_modifiers();
        self.held
            .retain(|_, required| required.satisfied_by(current));
    }

    fn current_modifiers(&self) -> Modifiers {
        let mut current = Modifiers::default();
        for (_, scan) in &self.modifier_keys {
            if let Some(bit) = modifier_bit(*scan) {
                current.ctrl |= bit.ctrl;
                current.shift |= bit.shift;
                current.alt |= bit.alt;
                current.meta |= bit.meta;
            }
        }
        current
    }

    fn recompute_ptt(&mut self) {
        if self.ptt.is_none() {
            self.set_open(false);
            return;
        }
        let current = self.current_modifiers();
        let active = self
            .held
            .values()
            .any(|required| required.satisfied_by(current));
        self.set_open(active);
    }

    fn set_open(&mut self, open: bool) {
        if open == self.open {
            return;
        }
        self.open = open;
        // The engine only stores a flag; never log the key here.
        if let Some(voice) = &self.voice {
            let _ = voice.set_push_to_talk(open);
        }
    }
}

/// Builds the router config from the settings and installs Raw Input.
///
/// A failure is not fatal: the voice engine keeps the voice-activation gate,
/// and the UI shows why push-to-talk is unavailable. Replacing a binding stops
/// the previous registration first and closes the gate, so a button held across
/// the change cannot stick.
pub fn install_global_input(
    voice: &VoiceHandle,
    config: &GlobalConfig,
    on_toggle: ToggleSink,
) -> InstallResult {
    // Stop the old registration before installing the new one: Raw Input for
    // the mouse cannot be registered twice in the same process.
    if let Ok(mut slot) = active_hook().lock() {
        if let Some(hook) = slot.take() {
            hook.stop();
        }
    }
    // A held button from the previous binding must not leave the gate open.
    let _ = voice.set_push_to_talk(false);

    if !rostalk_platform::input_hook_supported() {
        log::warn!("push-to-talk needs the Windows desktop client");
        return InstallResult {
            ptt: PttStatus {
                hook: PttHookState::Unsupported,
                binding: PUSH_TO_TALK_BINDING.to_owned(),
                error: None,
            },
            global: GlobalInputStatus::default(),
        };
    }

    let plan = build_plan(config);
    let ptt_ok = plan.ptt.is_ok();
    let mute = plan
        .toggles
        .iter()
        .any(|(_, action)| *action == GlobalAction::ToggleMute);
    let deafen = plan
        .toggles
        .iter()
        .any(|(_, action)| *action == GlobalAction::ToggleDeafen);
    let any_valid = ptt_ok || mute || deafen;
    let ptt_binding = match &plan.ptt {
        Ok(binding) => binding.label.clone(),
        Err(_) => config.push_to_talk.clone().unwrap_or_default(),
    };
    let ptt_error = plan.ptt.as_ref().err().cloned();

    if !any_valid {
        let error = ptt_error
            .unwrap_or_else(|| "no global push-to-talk, mute or deafen binding is usable".into());
        log::warn!("global input is not installed: {error}");
        return InstallResult {
            ptt: PttStatus {
                hook: PttHookState::Unavailable,
                binding: ptt_binding,
                error: Some(error),
            },
            global: GlobalInputStatus::default(),
        };
    }

    let ptt_routing = plan.ptt.clone().ok();
    let router = Arc::new(Mutex::new(Router::new(
        Some(voice.clone()),
        ptt_routing,
        plan.toggles.clone(),
        on_toggle,
    )));
    let handler: InputHandler = Arc::new(move |event| {
        if let Ok(mut router) = router.lock() {
            router.handle(event);
        }
    });
    match rostalk_platform::install_input_hook(handler, plan.capture_keyboard) {
        Ok(hook) => {
            log::info!(
                "global input installed: push-to-talk {} ({ptt_binding}), mute {}, deafen {}, keyboard captured: {}",
                if ptt_ok { "on" } else { "unavailable" },
                if mute { "on" } else { "off" },
                if deafen { "on" } else { "off" },
                plan.capture_keyboard
            );
            if let Ok(mut slot) = active_hook().lock() {
                *slot = Some(hook);
            }
            let global = GlobalInputStatus {
                registered: true,
                keyboard_captured: plan.capture_keyboard,
                push_to_talk: ptt_ok,
                toggle_mute: mute,
                toggle_deafen: deafen,
            };
            InstallResult {
                ptt: PttStatus {
                    hook: if ptt_ok {
                        PttHookState::Active
                    } else {
                        PttHookState::Unavailable
                    },
                    binding: ptt_binding,
                    error: ptt_error,
                },
                global,
            }
        }
        Err(error) => {
            log::warn!("global input is unavailable: {error}");
            InstallResult {
                ptt: PttStatus {
                    hook: PttHookState::Unavailable,
                    binding: ptt_binding,
                    error: Some(error.to_string()),
                },
                global: GlobalInputStatus::default(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    const DEVICE_A: DeviceId = 1;
    const DEVICE_B: DeviceId = 2;
    const DEVICE_C: DeviceId = 3;

    fn mouse(device: DeviceId, button: MouseButton, down: bool) -> InputEvent {
        InputEvent::Mouse {
            device,
            button,
            down,
        }
    }

    fn key(device: DeviceId, scan: u32, down: bool) -> InputEvent {
        InputEvent::Key { device, scan, down }
    }

    fn ctrl(device: DeviceId, down: bool) -> InputEvent {
        key(device, 0x1D, down)
    }

    fn shift(device: DeviceId, down: bool) -> InputEvent {
        key(device, 0x2A, down)
    }

    fn router(
        ptt: Option<&str>,
        mute: Option<&str>,
        deafen: Option<&str>,
        background: bool,
    ) -> (Router, Arc<StdMutex<Vec<GlobalAction>>>) {
        let actions = Arc::new(StdMutex::new(Vec::new()));
        let sink_actions = actions.clone();
        let sink: ToggleSink = Arc::new(move |action| {
            sink_actions.lock().expect("actions").push(action);
        });
        let config = GlobalConfig {
            push_to_talk: ptt.map(str::to_owned),
            toggle_mute: mute.map(str::to_owned),
            toggle_deafen: deafen.map(str::to_owned),
            background_hotkeys: background,
        };
        let plan = build_plan(&config);
        let ptt = plan.ptt.expect("ptt binding");
        (Router::new(None, Some(ptt), plan.toggles, sink), actions)
    }

    #[test]
    fn the_default_push_to_talk_binding_is_the_side_button_pair() {
        let binding = parse_ptt(None, false, &[]).expect("default");
        assert_eq!(binding.label, "X1/X2");
        assert_eq!(binding.triggers.len(), 2);
        assert_eq!(
            parse_ptt(Some("X1/X2"), false, &[]).expect("pair").label,
            "X1/X2"
        );
    }

    #[test]
    fn a_single_side_button_is_its_own_binding() {
        assert_eq!(
            parse_ptt(Some("Mouse4"), false, &[]).expect("x1").label,
            "X1"
        );
        assert_eq!(
            parse_ptt(Some("Mouse5"), false, &[]).expect("x2").label,
            "X2"
        );
        assert_eq!(
            parse_ptt(Some("X2"), false, &[])
                .expect("x2")
                .triggers
                .len(),
            1
        );
    }

    #[test]
    fn a_keyboard_key_keeps_the_side_buttons_it_does_not_share() {
        let binding = parse_ptt(Some("V"), false, &[]).expect("key");
        assert_eq!(binding.label, "X1/X2 + V");
        let binding = parse_ptt(Some("V"), false, &[MouseButton::X1]).expect("key");
        assert_eq!(binding.label, "X2 + V");
    }

    #[test]
    fn a_cyrillic_binding_from_an_old_file_is_migrated() {
        let binding = parse_ptt(Some("Л"), false, &[]).expect("cyrillic");
        assert_eq!(binding.label, "X1/X2 + K");
    }

    #[test]
    fn combinations_need_the_explicit_background_opt_in() {
        let error = parse_ptt(Some("Ctrl+Shift+K"), false, &[]).expect_err("chord");
        assert!(error.contains("background combination"), "{error}");
        let binding = parse_ptt(Some("Ctrl+Shift+K"), true, &[]).expect("chord");
        assert_eq!(binding.label, "X1/X2 + Ctrl+Shift+K");
        let trigger = binding
            .triggers
            .iter()
            .find(|trigger| matches!(trigger.physical, Physical::Key(_)))
            .expect("key trigger");
        assert!(trigger.modifiers.ctrl && trigger.modifiers.shift);
    }

    #[test]
    fn a_mouse_chord_captures_the_keyboard_for_its_modifiers() {
        let config = GlobalConfig {
            push_to_talk: Some("Ctrl+Mouse4".to_owned()),
            ..GlobalConfig::default()
        };
        let plan = build_plan(&GlobalConfig {
            background_hotkeys: true,
            ..config
        });
        assert!(plan.ptt.is_ok());
        assert!(plan.capture_keyboard, "Ctrl must be tracked");
    }

    #[test]
    fn a_pair_is_not_one_toggle_trigger() {
        assert_eq!(plan_toggle(Some("X1/X2"), true), TogglePlan::LocalOnly);
        assert_eq!(
            plan_toggle(Some("Mouse4"), false),
            TogglePlan::Global(Trigger {
                physical: Physical::Mouse(MouseButton::X1),
                modifiers: Modifiers::default(),
            })
        );
        assert_eq!(
            plan_toggle(Some("F8"), false),
            TogglePlan::Global(Trigger {
                physical: Physical::Key(0x42),
                modifiers: Modifiers::default(),
            })
        );
        assert_eq!(
            plan_toggle(Some("Ctrl+Shift+M"), false),
            TogglePlan::LocalOnly
        );
    }

    #[test]
    fn an_invalid_ptt_does_not_disable_the_valid_toggles() {
        let config = GlobalConfig {
            push_to_talk: Some("Ctrl+Shift+K".to_owned()),
            toggle_mute: Some("X1".to_owned()),
            toggle_deafen: Some("X2".to_owned()),
            background_hotkeys: false,
        };
        let plan = build_plan(&config);
        assert!(plan.ptt.is_err());
        assert_eq!(plan.toggles.len(), 2);
        // The invalid PTT combination must not enable background keyboard
        // capture; only the valid mouse toggles are registered.
        assert!(!plan.capture_keyboard);
    }

    #[test]
    fn push_to_talk_opens_on_the_first_press_and_closes_after_the_last_release() {
        let (mut router, _) = router(None, None, None, false);
        router.handle(mouse(DEVICE_A, MouseButton::X1, true));
        assert!(router.open);
        router.handle(mouse(DEVICE_A, MouseButton::X2, true));
        assert!(router.open);
        router.handle(mouse(DEVICE_A, MouseButton::X1, false));
        assert!(router.open, "X2 is still held");
        router.handle(mouse(DEVICE_A, MouseButton::X2, false));
        assert!(!router.open);
    }

    #[test]
    fn auto_repeat_does_not_close_or_reopen_push_to_talk() {
        let (mut router, _) = router(None, None, None, false);
        router.handle(mouse(DEVICE_A, MouseButton::X1, true));
        router.handle(mouse(DEVICE_A, MouseButton::X1, true));
        assert!(router.open);
        router.handle(mouse(DEVICE_A, MouseButton::X1, false));
        assert!(!router.open);
    }

    #[test]
    fn a_keyboard_binding_is_additive_with_the_side_buttons() {
        let (mut router, _) = router(Some("F8"), None, None, false);
        router.handle(key(DEVICE_A, 0x42, true));
        assert!(router.open);
        router.handle(key(DEVICE_A, 0x42, false));
        assert!(!router.open);
        router.handle(mouse(DEVICE_A, MouseButton::X2, true));
        assert!(router.open);
        router.handle(mouse(DEVICE_A, MouseButton::X2, false));
        assert!(!router.open);
    }

    #[test]
    fn a_modifier_chord_holds_until_a_required_modifier_is_released() {
        let (mut router, _) = router(Some("Ctrl+Shift+K"), None, None, true);
        router.handle(ctrl(DEVICE_A, true));
        router.handle(shift(DEVICE_A, true));
        router.handle(key(DEVICE_A, 0x25, true));
        assert!(router.open);
        // Releasing Shift is releasing an element of the PTT chord.
        router.handle(shift(DEVICE_A, false));
        assert!(!router.open);
        // The hold was invalidated: pressing Shift again without a new K make
        // must not reopen PTT.
        router.handle(shift(DEVICE_A, true));
        assert!(!router.open);
        // Even an auto-repeat of K does not revive it.
        router.handle(key(DEVICE_A, 0x25, true));
        assert!(!router.open);
        router.handle(key(DEVICE_A, 0x25, false));
        // A deliberate new K make with both modifiers opens it again.
        router.handle(key(DEVICE_A, 0x25, true));
        assert!(router.open);
    }

    #[test]
    fn an_auto_repeat_after_modifiers_does_not_open_push_to_talk() {
        let (mut router, _) = router(Some("Ctrl+K"), None, None, true);
        // Typing K first: the first make has no modifiers, so no hold exists.
        router.handle(key(DEVICE_A, 0x25, true));
        assert!(!router.open);
        router.handle(ctrl(DEVICE_A, true));
        assert!(!router.open);
        // The raw auto-repeat of K is not a new make and must not create a
        // hold just because Ctrl is down now.
        router.handle(key(DEVICE_A, 0x25, true));
        router.handle(key(DEVICE_A, 0x25, true));
        assert!(!router.open);
        router.handle(ctrl(DEVICE_A, false));
        router.handle(ctrl(DEVICE_A, true));
        router.handle(key(DEVICE_A, 0x25, true));
        assert!(!router.open);
        router.handle(key(DEVICE_A, 0x25, false));
        // A real new K make with Ctrl held opens the gate.
        router.handle(key(DEVICE_A, 0x25, true));
        assert!(router.open);
    }

    #[test]
    fn repeated_modifier_makes_do_not_change_an_existing_hold() {
        let (mut router, _) = router(Some("Ctrl+Shift+K"), None, None, true);
        router.handle(ctrl(DEVICE_A, true));
        router.handle(ctrl(DEVICE_A, true)); // raw auto-repeat
        router.handle(shift(DEVICE_A, true));
        router.handle(shift(DEVICE_A, true)); // raw auto-repeat
        router.handle(key(DEVICE_A, 0x25, true));
        assert!(router.open);
        // Releasing and re-pressing a modifier requires a new main make.
        router.handle(shift(DEVICE_A, false));
        assert!(!router.open);
        router.handle(shift(DEVICE_A, true));
        router.handle(shift(DEVICE_A, true)); // raw auto-repeat
        assert!(!router.open);
        router.handle(key(DEVICE_A, 0x25, false));
        router.handle(key(DEVICE_A, 0x25, true));
        assert!(router.open);
    }

    #[test]
    fn a_combination_does_not_open_when_the_key_comes_first() {
        let (mut router, _) = router(Some("Ctrl+K"), None, None, true);
        router.handle(key(DEVICE_A, 0x25, true));
        assert!(!router.open);
        // The chord is completed only after the key was already down.
        router.handle(ctrl(DEVICE_A, true));
        assert!(!router.open, "typing K must not turn into PTT later");
        router.handle(key(DEVICE_A, 0x25, false));
        router.handle(ctrl(DEVICE_A, false));
        // A deliberate chord press does open it.
        router.handle(ctrl(DEVICE_A, true));
        router.handle(key(DEVICE_A, 0x25, true));
        assert!(router.open);
    }

    #[test]
    fn mute_toggles_once_per_deliberate_press() {
        let (mut router, actions) = router(None, Some("F8"), None, false);
        router.handle(key(DEVICE_A, 0x42, true));
        router.handle(key(DEVICE_A, 0x42, true)); // auto-repeat
        router.handle(key(DEVICE_A, 0x42, true));
        assert_eq!(
            *actions.lock().expect("actions"),
            vec![GlobalAction::ToggleMute]
        );
        router.handle(key(DEVICE_A, 0x42, false));
        router.handle(key(DEVICE_A, 0x42, true));
        assert_eq!(
            *actions.lock().expect("actions"),
            vec![GlobalAction::ToggleMute, GlobalAction::ToggleMute]
        );
    }

    #[test]
    fn a_modifier_toggle_fires_only_with_the_exact_modifiers() {
        let (mut router, actions) = router(None, Some("Ctrl+Shift+M"), None, true);
        router.handle(ctrl(DEVICE_A, true));
        router.handle(key(DEVICE_A, 0x32, true));
        assert!(actions.lock().expect("actions").is_empty());
        router.handle(key(DEVICE_A, 0x32, false));
        router.handle(shift(DEVICE_A, true));
        router.handle(key(DEVICE_A, 0x32, true));
        assert_eq!(
            *actions.lock().expect("actions"),
            vec![GlobalAction::ToggleMute]
        );
        router.handle(key(DEVICE_A, 0x32, true)); // auto-repeat
        assert_eq!(actions.lock().expect("actions").len(), 1);
    }

    #[test]
    fn a_mouse_toggle_fires_once_and_shares_no_button_with_push_to_talk() {
        let (mut router, actions) = router(None, Some("Mouse4"), None, false);
        assert_eq!(router.ptt.as_ref().expect("ptt").label, "X2");
        router.handle(mouse(DEVICE_A, MouseButton::X1, true));
        router.handle(mouse(DEVICE_A, MouseButton::X1, true));
        assert_eq!(
            *actions.lock().expect("actions"),
            vec![GlobalAction::ToggleMute]
        );
        assert!(!router.open, "X1 belongs to mute now");
        router.handle(mouse(DEVICE_A, MouseButton::X1, false));
        router.handle(mouse(DEVICE_A, MouseButton::X2, true));
        assert!(router.open);
    }

    #[test]
    fn removing_one_device_keeps_another_devices_hold_and_press() {
        let (mut router, actions) = router(None, Some("Mouse4"), None, false);
        router.handle(mouse(DEVICE_A, MouseButton::X1, true));
        router.handle(mouse(DEVICE_A, MouseButton::X2, true));
        assert!(router.open);
        // Mouse B disappears while mouse A still holds X1 (mute) and X2 (PTT).
        router.handle(InputEvent::DeviceRemoved { device: DEVICE_B });
        assert!(router.open, "the other mouse still holds X2");
        // Auto-repeat from mouse A must not toggle mute again.
        router.handle(mouse(DEVICE_A, MouseButton::X1, true));
        assert_eq!(actions.lock().expect("actions").len(), 1);
        // Removing the mouse that holds the input releases only that mouse.
        router.handle(InputEvent::DeviceRemoved { device: DEVICE_A });
        assert!(!router.open);
    }

    #[test]
    fn modifiers_from_another_keyboard_are_tracked_per_device() {
        let (mut router, _) = router(Some("Ctrl+K"), None, None, true);
        router.handle(ctrl(DEVICE_A, true));
        router.handle(key(DEVICE_A, 0x25, true));
        assert!(router.open);
        // Removing the other keyboard must not clear Ctrl held on A.
        router.handle(InputEvent::DeviceRemoved { device: DEVICE_B });
        assert!(router.open);
        router.handle(InputEvent::DeviceRemoved { device: DEVICE_A });
        assert!(!router.open);
    }

    #[test]
    fn removing_a_modifier_device_invalidates_the_chord() {
        let (mut router, _) = router(Some("Ctrl+K"), None, None, true);
        // Ctrl is held on keyboard A, the PTT key on keyboard B.
        router.handle(ctrl(DEVICE_A, true));
        router.handle(key(DEVICE_B, 0x25, true));
        assert!(router.open);
        // Keyboard A disappears: its Ctrl is gone, so the hold is invalid.
        router.handle(InputEvent::DeviceRemoved { device: DEVICE_A });
        assert!(!router.open, "the removed device held the required Ctrl");
        // Pressing Ctrl on another keyboard while K is still held must not
        // revive the cancelled chord.
        router.handle(ctrl(DEVICE_C, true));
        assert!(!router.open);
        // The raw auto-repeat of K is not a new make either.
        router.handle(key(DEVICE_B, 0x25, true));
        assert!(!router.open);
        // A deliberate release and new K make with Ctrl held opens it again.
        router.handle(key(DEVICE_B, 0x25, false));
        router.handle(key(DEVICE_B, 0x25, true));
        assert!(router.open);
    }

    #[test]
    fn removing_one_device_keeps_a_chord_modifier_on_another_device() {
        let (mut router, _) = router(Some("Ctrl+K"), None, None, true);
        router.handle(ctrl(DEVICE_A, true));
        router.handle(ctrl(DEVICE_C, true));
        router.handle(key(DEVICE_B, 0x25, true));
        assert!(router.open);
        // Ctrl is still down on C after A disappears, so the hold survives.
        router.handle(InputEvent::DeviceRemoved { device: DEVICE_A });
        assert!(router.open);
        // Releasing the last Ctrl invalidates it, as a normal release would.
        router.handle(ctrl(DEVICE_C, false));
        assert!(!router.open);
        // Re-pressing Ctrl without a new K make stays closed.
        router.handle(ctrl(DEVICE_C, true));
        assert!(!router.open);
    }

    #[test]
    fn the_binding_is_mouse_only_by_default() {
        assert_eq!(PUSH_TO_TALK_BINDING, "X1/X2");
        assert!(!PUSH_TO_TALK_BINDING.contains('V'));
        let plan = build_plan(&GlobalConfig::default());
        assert!(!plan.capture_keyboard);
        assert!(plan.ptt.is_ok());
        assert!(plan.toggles.is_empty());
    }

    #[test]
    fn unrelated_input_is_ignored() {
        let (mut router, actions) = router(None, None, None, false);
        router.handle(mouse(DEVICE_A, MouseButton::Left, true));
        router.handle(mouse(DEVICE_A, MouseButton::Right, true));
        router.handle(key(DEVICE_A, 0x2E, true)); // C
        assert!(!router.open);
        assert!(actions.lock().expect("actions").is_empty());
    }

    #[test]
    fn extended_keys_match_only_their_own_scan_code() {
        let arrow_up = rostalk_platform::SCAN_EXTENDED | 0x48;
        let binding = parse_ptt(Some("ArrowUp"), false, &[]).expect("arrow");
        assert!(binding
            .triggers
            .iter()
            .any(|trigger| trigger.physical == Physical::Key(arrow_up)));
        assert!(!binding
            .triggers
            .iter()
            .any(|trigger| trigger.physical == Physical::Key(0x48)));
    }
}
