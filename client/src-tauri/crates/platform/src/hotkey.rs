//! Global input for push-to-talk.
//!
//! Design 5.2 needs push-to-talk in full-screen games without swallowing the
//! key. The first implementation used low-level `WH_*` hooks. Hooks see every
//! key in every process and anti-cheat software may block or flag them, so
//! ADR 0012 makes Raw Input the only global path:
//!
//! - `RegisterRawInputDevices` with `RIDEV_INPUTSINK | RIDEV_DEVNOTIFY` on a
//!   message-only window;
//! - keyboard and mouse buttons arrive as `WM_INPUT` while the app is in the
//!   background;
//! - no low-level hook installation, no injection, no memory reads, no driver,
//!   no elevation — the same API a game itself uses for input.
//!
//! One hook per process at a time: changing the binding stops the previous
//! registration and installs the new one, and the engine decides whether an
//! event opens push-to-talk or toggles mute by checking the reported events.

use std::sync::{Arc, Mutex};

use crate::error::PlatformError;

/// A key or mouse button press observed by the system.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputEvent {
    /// A keyboard key changed state, identified by its physical position.
    ///
    /// `scan` is the set-1 make code from `RAWKEYBOARD.MakeCode`, with
    /// [`SCAN_EXTENDED`] set when the report carried the `E0` prefix. A scan
    /// code does not depend on the active layout: the key that produces `Л`
    /// in the Russian layout is the same `K` key Raw Input reports here.
    Key {
        /// Raw Input device handle (`RAWINPUTHEADER.hDevice`).
        ///
        /// Process-local and opaque: it lets a listener keep held state per
        /// device, so removing one mouse does not release a button held on
        /// another.
        device: DeviceId,
        /// Set-1 make code, see [`scan_code_for_code_name`].
        scan: u32,
        /// True on press, false on release.
        down: bool,
    },
    /// A mouse button changed state.
    Mouse {
        /// Raw Input device handle (`RAWINPUTHEADER.hDevice`).
        device: DeviceId,
        /// Which button.
        button: MouseButton,
        /// True on press, false on release.
        down: bool,
    },
    /// Windows reported that an input device was removed.
    ///
    /// The device that held a bound key or button can disappear before the
    /// release report arrives (a wireless mouse switched off, a controller
    /// unplugged). A listener must drop the held state of this device only,
    /// otherwise push-to-talk stays open until the next press.
    DeviceRemoved {
        /// Raw Input device handle that disappeared.
        device: DeviceId,
    },
}

/// Opaque process-local Raw Input device handle.
pub type DeviceId = isize;

/// Mouse buttons Raw Input reports to the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
    /// The first extra button (usually "back").
    X1,
    /// The second extra button (usually "forward").
    X2,
}

/// Receives input events from the system.
pub type InputHandler = Arc<dyn Fn(InputEvent) + Send + Sync>;

/// A running input registration. Dropping it unregisters Raw Input and stops
/// the message thread.
pub struct InputHook {
    stop: Option<Box<dyn FnOnce() + Send + Sync>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl InputHook {
    /// Stops the hook explicitly; dropping does the same.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if let Some(stop) = self.stop.take() {
            stop();
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        // The handler must go away with the registration. `install` treats a
        // present handler as "a registration is already running", so keeping it
        // here made every later binding change fail with "only one global input
        // registration is supported".
        clear_handler();
    }
}

impl Drop for InputHook {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The active handler, if a registration is running.
///
/// Raw Input is installed and stopped one binding at a time (the engine rebinds
/// push-to-talk and the global toggles together), so a plain slot is enough.
static HANDLER: Mutex<Option<InputHandler>> = Mutex::new(None);

/// Replaces the handler for the next registration.
///
/// Fails while a registration is still alive: two message threads would each
/// receive every Raw Input report for the same process.
fn set_handler(handler: InputHandler) -> Result<(), PlatformError> {
    let mut slot = HANDLER
        .lock()
        .map_err(|_| PlatformError::InputHook("the input handler lock is poisoned".into()))?;
    if slot.is_some() {
        return Err(PlatformError::InputHook(
            "only one global input registration is supported".into(),
        ));
    }
    *slot = Some(handler);
    Ok(())
}

/// Releases the handler after the message thread has stopped.
fn clear_handler() {
    if let Ok(mut slot) = HANDLER.lock() {
        *slot = None;
    }
}

/// Installs the global Raw Input registration.
///
/// `capture_keyboard` registers the keyboard usage in addition to the mouse.
/// The client keeps it `false` unless a keyboard binding is explicitly
/// configured: capturing every key in the background without need looks like a
/// keylogger and is exactly what ADR 0012 avoids. Mouse X1/X2 are always
/// registered because they are the default push-to-talk binding.
///
/// The handler is called on the message thread and must return quickly; the
/// voice engine only stores a boolean there.
pub fn install(handler: InputHandler, capture_keyboard: bool) -> Result<InputHook, PlatformError> {
    imp::install(handler, capture_keyboard)
}

/// True when this build has real global input.
#[must_use]
pub fn is_supported() -> bool {
    cfg!(windows)
}

/// Marker for a key whose Raw Input report carried the `E0` prefix.
///
/// `RAWKEYBOARD.MakeCode` is a single byte, and several physical keys share it
/// with the numeric keypad: `Home` is `E0 47`, `Numpad7` is `47`. Folding the
/// prefix into the high bits keeps one integer per physical key.
pub const SCAN_EXTENDED: u32 = 0xE000;

/// Physical keys RosTalk can bind: `(KeyboardEvent.code, accelerator name,
/// set-1 make code)`.
///
/// The names are the canonical spellings the settings store already uses
/// (`A`, `F8`, `Comma`, `ArrowUp`). The table is the contract between the UI and
/// the global Raw Input path (playtest-1, P4): both sides match the physical
/// key, so `Ctrl+K` works on the same button in every layout. A new key is
/// added here together with the UI table.
///
/// Scan codes are from the Microsoft "Keyboard Scan Code Specification", set 1;
/// `E0`-prefixed keys carry [`SCAN_EXTENDED`].
const SCAN_TABLE: &[(&str, &str, u32)] = &[
    // Letters.
    ("KeyA", "A", 0x1E),
    ("KeyB", "B", 0x30),
    ("KeyC", "C", 0x2E),
    ("KeyD", "D", 0x20),
    ("KeyE", "E", 0x12),
    ("KeyF", "F", 0x21),
    ("KeyG", "G", 0x22),
    ("KeyH", "H", 0x23),
    ("KeyI", "I", 0x17),
    ("KeyJ", "J", 0x24),
    ("KeyK", "K", 0x25),
    ("KeyL", "L", 0x26),
    ("KeyM", "M", 0x32),
    ("KeyN", "N", 0x31),
    ("KeyO", "O", 0x18),
    ("KeyP", "P", 0x19),
    ("KeyQ", "Q", 0x10),
    ("KeyR", "R", 0x13),
    ("KeyS", "S", 0x1F),
    ("KeyT", "T", 0x14),
    ("KeyU", "U", 0x16),
    ("KeyV", "V", 0x2F),
    ("KeyW", "W", 0x11),
    ("KeyX", "X", 0x2D),
    ("KeyY", "Y", 0x15),
    ("KeyZ", "Z", 0x2C),
    // Top-row digits.
    ("Digit1", "1", 0x02),
    ("Digit2", "2", 0x03),
    ("Digit3", "3", 0x04),
    ("Digit4", "4", 0x05),
    ("Digit5", "5", 0x06),
    ("Digit6", "6", 0x07),
    ("Digit7", "7", 0x08),
    ("Digit8", "8", 0x09),
    ("Digit9", "9", 0x0A),
    ("Digit0", "0", 0x0B),
    // Function keys; F13-F24 are extended.
    ("F1", "F1", 0x3B),
    ("F2", "F2", 0x3C),
    ("F3", "F3", 0x3D),
    ("F4", "F4", 0x3E),
    ("F5", "F5", 0x3F),
    ("F6", "F6", 0x40),
    ("F7", "F7", 0x41),
    ("F8", "F8", 0x42),
    ("F9", "F9", 0x43),
    ("F10", "F10", 0x44),
    ("F11", "F11", 0x57),
    ("F12", "F12", 0x58),
    ("F13", "F13", SCAN_EXTENDED | 0x64),
    ("F14", "F14", SCAN_EXTENDED | 0x65),
    ("F15", "F15", SCAN_EXTENDED | 0x66),
    ("F16", "F16", SCAN_EXTENDED | 0x67),
    ("F17", "F17", SCAN_EXTENDED | 0x68),
    ("F18", "F18", SCAN_EXTENDED | 0x69),
    ("F19", "F19", SCAN_EXTENDED | 0x6A),
    ("F20", "F20", SCAN_EXTENDED | 0x6B),
    ("F21", "F21", SCAN_EXTENDED | 0x6C),
    ("F22", "F22", SCAN_EXTENDED | 0x6D),
    ("F23", "F23", SCAN_EXTENDED | 0x6E),
    ("F24", "F24", SCAN_EXTENDED | 0x6F),
    // Character keys; the names match the canonical accelerators.
    ("Backquote", "`", 0x29),
    ("Minus", "-", 0x0C),
    ("Equal", "=", 0x0D),
    ("BracketLeft", "[", 0x1A),
    ("BracketRight", "]", 0x1B),
    ("Backslash", "\\", 0x2B),
    ("Semicolon", ";", 0x27),
    ("Quote", "'", 0x28),
    ("Comma", "Comma", 0x33),
    ("Period", "Period", 0x34),
    ("Slash", "/", 0x35),
    ("Space", "Space", 0x39),
    // Control and navigation keys.
    ("Escape", "Escape", 0x01),
    ("Tab", "Tab", 0x0F),
    ("Backspace", "Backspace", 0x0E),
    ("Enter", "Enter", 0x1C),
    ("CapsLock", "CapsLock", 0x3A),
    ("NumLock", "NumLock", 0x45),
    ("ScrollLock", "ScrollLock", 0x46),
    ("PrintScreen", "PrintScreen", SCAN_EXTENDED | 0x37),
    ("Insert", "Insert", SCAN_EXTENDED | 0x52),
    ("Delete", "Delete", SCAN_EXTENDED | 0x53),
    ("Home", "Home", SCAN_EXTENDED | 0x47),
    ("End", "End", SCAN_EXTENDED | 0x4F),
    ("PageUp", "PageUp", SCAN_EXTENDED | 0x49),
    ("PageDown", "PageDown", SCAN_EXTENDED | 0x51),
    ("ArrowUp", "ArrowUp", SCAN_EXTENDED | 0x48),
    ("ArrowDown", "ArrowDown", SCAN_EXTENDED | 0x50),
    ("ArrowLeft", "ArrowLeft", SCAN_EXTENDED | 0x4B),
    ("ArrowRight", "ArrowRight", SCAN_EXTENDED | 0x4D),
    ("ContextMenu", "ContextMenu", SCAN_EXTENDED | 0x5D),
    // Numeric keypad. It shares make codes with the navigation keys, so the
    // extended marker is what keeps the two apart.
    ("Numpad0", "Numpad0", 0x52),
    ("Numpad1", "Numpad1", 0x4F),
    ("Numpad2", "Numpad2", 0x50),
    ("Numpad3", "Numpad3", 0x51),
    ("Numpad4", "Numpad4", 0x4B),
    ("Numpad5", "Numpad5", 0x4C),
    ("Numpad6", "Numpad6", 0x4D),
    ("Numpad7", "Numpad7", 0x47),
    ("Numpad8", "Numpad8", 0x48),
    ("Numpad9", "Numpad9", 0x49),
    ("NumpadMultiply", "NumpadMultiply", 0x37),
    ("NumpadSubtract", "NumpadSubtract", 0x4A),
    ("NumpadAdd", "NumpadAdd", 0x4E),
    ("NumpadDecimal", "NumpadDecimal", 0x53),
    ("NumpadDivide", "NumpadDivide", SCAN_EXTENDED | 0x35),
    ("NumpadEnter", "NumpadEnter", SCAN_EXTENDED | 0x1C),
];

/// Set-1 make code of a physical key named like `KeyboardEvent.code`.
#[must_use]
pub fn scan_code_for_code_name(code: &str) -> Option<u32> {
    SCAN_TABLE
        .iter()
        .find(|(name, _, _)| *name == code)
        .map(|(_, _, scan)| *scan)
}

/// Set-1 make code of a canonical accelerator key (`K`, `F8`, `Comma`).
#[must_use]
pub fn scan_code_for_key_name(key: &str) -> Option<u32> {
    let key = key.trim();
    SCAN_TABLE
        .iter()
        .find(|(_, name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, _, scan)| *scan)
}

/// `KeyboardEvent.code` of a set-1 make code, for tests and diagnostics.
#[must_use]
pub fn code_name_for_scan(scan: u32) -> Option<&'static str> {
    SCAN_TABLE
        .iter()
        .find(|(_, _, value)| *value == scan)
        .map(|(code, _, _)| *code)
}

/// Canonical accelerator key of a set-1 make code.
#[must_use]
pub fn key_name_for_scan(scan: u32) -> Option<&'static str> {
    SCAN_TABLE
        .iter()
        .find(|(_, _, value)| *value == scan)
        .map(|(_, name, _)| *name)
}

/// `RAWKEYBOARD.Flags` bit: the key was released.
const RI_KEY_BREAK: u16 = 0x01;
/// `RAWKEYBOARD.Flags` bit: the report carried the `E0` prefix.
const RI_KEY_E0: u16 = 0x02;
/// `RAWKEYBOARD.Flags` bit: the report carried the `E1` prefix.
const RI_KEY_E1: u16 = 0x04;
/// `RAWKEYBOARD.MakeCode` of a fake key event that carries no real key.
const MAKE_CODE_NONE: u16 = 0xFF;

/// Scan code of one `RAWKEYBOARD` report, or `None` for a report that carries
/// no bindable physical key.
///
/// `E1` marks `Pause`/`Break` (a multi-byte sequence); treating its make code
/// as `NumLock` would fire the wrong binding, so such reports are dropped. The
/// release bit does not change the identity of the key.
fn keyboard_scan(make_code: u16, flags: u16) -> Option<u32> {
    if make_code == 0 || make_code == MAKE_CODE_NONE || flags & RI_KEY_E1 != 0 {
        return None;
    }
    let mut scan = u32::from(make_code);
    if flags & RI_KEY_E0 != 0 {
        scan |= SCAN_EXTENDED;
    }
    Some(scan)
}

/// True when the report is a key release.
fn keyboard_released(flags: u16) -> bool {
    flags & RI_KEY_BREAK != 0
}

// Raw Input mouse button flags from `winuser.h`. Kept here instead of
// `windows-sys` because the generated bindings do not export the `RI_*`
// constants. The values are part of the Win32 ABI and never change.
const RI_MOUSE_LEFT_BUTTON_DOWN: u16 = 0x0001;
const RI_MOUSE_LEFT_BUTTON_UP: u16 = 0x0002;
const RI_MOUSE_RIGHT_BUTTON_DOWN: u16 = 0x0004;
const RI_MOUSE_RIGHT_BUTTON_UP: u16 = 0x0008;
const RI_MOUSE_MIDDLE_BUTTON_DOWN: u16 = 0x0010;
const RI_MOUSE_MIDDLE_BUTTON_UP: u16 = 0x0020;
const RI_MOUSE_BUTTON_4_DOWN: u16 = 0x0040;
const RI_MOUSE_BUTTON_4_UP: u16 = 0x0080;
const RI_MOUSE_BUTTON_5_DOWN: u16 = 0x0100;
const RI_MOUSE_BUTTON_5_UP: u16 = 0x0200;

/// Every button flag Raw Input can report, in a fixed order.
///
/// A single `WM_INPUT` can carry a chord (for example both extra buttons), so
/// the callback walks the whole table instead of matching one value.
const MOUSE_BUTTON_FLAGS: [(u16, MouseButton, bool); 10] = [
    (RI_MOUSE_LEFT_BUTTON_DOWN, MouseButton::Left, true),
    (RI_MOUSE_LEFT_BUTTON_UP, MouseButton::Left, false),
    (RI_MOUSE_RIGHT_BUTTON_DOWN, MouseButton::Right, true),
    (RI_MOUSE_RIGHT_BUTTON_UP, MouseButton::Right, false),
    (RI_MOUSE_MIDDLE_BUTTON_DOWN, MouseButton::Middle, true),
    (RI_MOUSE_MIDDLE_BUTTON_UP, MouseButton::Middle, false),
    (RI_MOUSE_BUTTON_4_DOWN, MouseButton::X1, true),
    (RI_MOUSE_BUTTON_4_UP, MouseButton::X1, false),
    (RI_MOUSE_BUTTON_5_DOWN, MouseButton::X2, true),
    (RI_MOUSE_BUTTON_5_UP, MouseButton::X2, false),
];

/// Turns the `usButtonFlags` of one Raw Input mouse report into events.
///
/// Pure and allocation-free, so the Win32 callback stays a thin wrapper and
/// the mapping is covered by unit tests on every platform.
fn mouse_events(flags: u16) -> impl Iterator<Item = (MouseButton, bool)> {
    MOUSE_BUTTON_FLAGS
        .iter()
        .filter(move |(flag, _, _)| flags & *flag != 0)
        .map(|(_, button, down)| (*button, *down))
}

#[cfg(not(windows))]
mod imp {
    use super::{set_handler, InputHandler, InputHook, PlatformError};

    /// Stub for platforms the MVP does not ship on (design 1). The app still
    /// compiles and runs; push-to-talk is simply unavailable.
    pub fn install(
        handler: InputHandler,
        _capture_keyboard: bool,
    ) -> Result<InputHook, PlatformError> {
        set_handler(handler)?;
        Ok(InputHook {
            stop: None,
            thread: None,
        })
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::mpsc;

    use windows_sys::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::{
        GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE,
        RAWINPUTHEADER, RIDEV_DEVNOTIFY, RIDEV_INPUTSINK, RIDEV_REMOVE, RID_INPUT,
        RIM_TYPEKEYBOARD, RIM_TYPEMOUSE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        PostThreadMessageW, RegisterClassW, TranslateMessage, UnregisterClassW, HWND_MESSAGE, MSG,
        WM_INPUT, WM_QUIT, WNDCLASSW,
    };

    use super::{
        keyboard_released, keyboard_scan, mouse_events, set_handler, DeviceId, InputEvent,
        InputHandler, InputHook, PlatformError,
    };

    /// `WM_INPUT_DEVICE_CHANGE`: a HID device arrived or was removed.
    const WM_INPUT_DEVICE_CHANGE: u32 = 0x00FE;
    /// `GIDC_REMOVAL` in the `wparam` of `WM_INPUT_DEVICE_CHANGE`.
    const GIDC_REMOVAL: usize = 1;

    /// HID usage page 1 ("generic desktop controls").
    const HID_USAGE_PAGE_GENERIC: u16 = 0x01;
    /// HID usage 2: mouse.
    const HID_USAGE_MOUSE: u16 = 0x02;
    /// HID usage 6: keyboard.
    const HID_USAGE_KEYBOARD: u16 = 0x06;

    /// The only capture flags the anti-cheat white list permits: background
    /// delivery plus device-change notifications. `RIDEV_NOLEGACY`,
    /// `RIDEV_CAPTUREMOUSE`, `RIDEV_NOHOTKEYS` and `RIDEV_APPKEYS` never
    /// appear here because they suppress or capture input.
    const CAPTURE_FLAGS: u32 = RIDEV_INPUTSINK | RIDEV_DEVNOTIFY;

    /// Builds a `RAWINPUTDEVICE` for one generic-desktop usage.
    fn raw_device(usage: u16, flags: u32, target: HWND) -> RAWINPUTDEVICE {
        RAWINPUTDEVICE {
            usUsagePage: HID_USAGE_PAGE_GENERIC,
            usUsage: usage,
            dwFlags: flags,
            hwndTarget: target,
        }
    }

    static MESSAGE_THREAD: AtomicIsize = AtomicIsize::new(0);

    /// Registers Raw Input on a dedicated thread with a message-only window.
    pub fn install(
        handler: InputHandler,
        capture_keyboard: bool,
    ) -> Result<InputHook, PlatformError> {
        set_handler(handler)?;

        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let thread = match std::thread::Builder::new()
            .name("rostalk-input-raw".to_owned())
            .spawn(move || input_thread(ready_tx, capture_keyboard))
        {
            Ok(thread) => thread,
            Err(error) => {
                super::clear_handler();
                return Err(PlatformError::InputHook(format!(
                    "start input thread: {error}"
                )));
            }
        };

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(InputHook {
                stop: Some(Box::new(|| {
                    let id = MESSAGE_THREAD.load(Ordering::SeqCst);
                    if id != 0 {
                        // SAFETY: posting WM_QUIT to our own input thread stops
                        // its message loop; the thread then unregisters Raw
                        // Input and destroys its window.
                        unsafe {
                            PostThreadMessageW(id as u32, WM_QUIT, 0, 0);
                        }
                    }
                })),
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                super::clear_handler();
                Err(PlatformError::InputHook(error))
            }
            Err(_) => {
                let _ = thread.join();
                super::clear_handler();
                Err(PlatformError::InputHook(
                    "the input thread stopped before reporting".into(),
                ))
            }
        }
    }

    fn input_thread(ready: mpsc::Sender<Result<(), String>>, capture_keyboard: bool) {
        // SAFETY: Win32 calls on the current thread with plain constants.
        unsafe {
            MESSAGE_THREAD.store(i64::from(GetCurrentThreadId()) as isize, Ordering::SeqCst);
            let module = GetModuleHandleW(std::ptr::null());
            let class_name: Vec<u16> = "RosTalkRawInputPtt\0".encode_utf16().collect();

            let mut class: WNDCLASSW = std::mem::zeroed();
            class.lpfnWndProc = Some(window_proc);
            class.hInstance = module as HINSTANCE;
            class.lpszClassName = class_name.as_ptr();
            if RegisterClassW(&class) == 0 {
                let _ = ready.send(Err(format!(
                    "RegisterClassW failed: {}",
                    std::io::Error::last_os_error()
                )));
                MESSAGE_THREAD.store(0, Ordering::SeqCst);
                return;
            }

            // Message-only window: no UI, but it can receive WM_INPUT while
            // another application (the game) is in the foreground.
            let window = CreateWindowExW(
                0,
                class_name.as_ptr(),
                class_name.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                module as HINSTANCE,
                std::ptr::null(),
            );
            if window.is_null() {
                UnregisterClassW(class_name.as_ptr(), module as HINSTANCE);
                let _ = ready.send(Err(format!(
                    "CreateWindowExW failed: {}",
                    std::io::Error::last_os_error()
                )));
                MESSAGE_THREAD.store(0, Ordering::SeqCst);
                return;
            }

            // Mouse X1/X2 are the default PTT binding and are always
            // registered. The keyboard is registered only when an explicit
            // key is configured: background capture of every key without need
            // is what ADR 0012 avoids.
            let mut devices = Vec::with_capacity(2);
            if capture_keyboard {
                devices.push(raw_device(HID_USAGE_KEYBOARD, CAPTURE_FLAGS, window));
            }
            devices.push(raw_device(HID_USAGE_MOUSE, CAPTURE_FLAGS, window));
            let registered = RegisterRawInputDevices(
                devices.as_ptr(),
                devices.len() as u32,
                std::mem::size_of::<RAWINPUTDEVICE>() as u32,
            );
            if registered == 0 {
                let error = std::io::Error::last_os_error();
                DestroyWindow(window);
                UnregisterClassW(class_name.as_ptr(), module as HINSTANCE);
                let _ = ready.send(Err(format!("RegisterRawInputDevices failed: {error}")));
                MESSAGE_THREAD.store(0, Ordering::SeqCst);
                return;
            }
            let _ = ready.send(Ok(()));

            let mut message: MSG = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }

            // RIDEV_REMOVE detaches the window before it is destroyed, so a
            // later install in the same process starts clean.
            let mut remove = Vec::with_capacity(2);
            if capture_keyboard {
                remove.push(raw_device(
                    HID_USAGE_KEYBOARD,
                    RIDEV_REMOVE,
                    std::ptr::null_mut(),
                ));
            }
            remove.push(raw_device(
                HID_USAGE_MOUSE,
                RIDEV_REMOVE,
                std::ptr::null_mut(),
            ));
            RegisterRawInputDevices(
                remove.as_ptr(),
                remove.len() as u32,
                std::mem::size_of::<RAWINPUTDEVICE>() as u32,
            );
            DestroyWindow(window);
            UnregisterClassW(class_name.as_ptr(), module as HINSTANCE);
            MESSAGE_THREAD.store(0, Ordering::SeqCst);
        }
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_INPUT {
            // SAFETY: WM_INPUT carries an HRAWINPUT in lparam.
            unsafe { handle_raw_input(lparam) };
        } else if message == WM_INPUT_DEVICE_CHANGE && wparam == GIDC_REMOVAL {
            // The release report of a held key or button never arrives after
            // the device is gone. Tell the listener which device disappeared
            // so it can release exactly that device's state.
            dispatch(InputEvent::DeviceRemoved {
                device: lparam as DeviceId,
            });
        }
        // DefWindowProc performs the Raw Input buffer cleanup the API requires.
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    unsafe fn handle_raw_input(lparam: LPARAM) {
        let mut raw = RAWINPUT::default();
        let mut size = std::mem::size_of::<RAWINPUT>() as u32;
        let header_size = std::mem::size_of::<RAWINPUTHEADER>() as u32;
        // SAFETY: `raw` is a valid writable RAWINPUT buffer and its size is
        // passed in `size`; lparam is the HRAWINPUT from WM_INPUT.
        let read = unsafe {
            GetRawInputData(
                lparam as HRAWINPUT,
                RID_INPUT,
                (&mut raw as *mut RAWINPUT).cast(),
                &mut size,
                header_size,
            )
        };
        if read == u32::MAX || read == 0 {
            return;
        }
        let device = raw.header.hDevice as DeviceId;

        match raw.header.dwType {
            RIM_TYPEKEYBOARD => {
                // SAFETY: the header says the union holds a keyboard report.
                let keyboard = unsafe { raw.data.keyboard };
                // Match the physical key: `MakeCode` is the set-1 scan code and
                // `E0` tells the keypad/navigation pair apart. `VKey` (and
                // especially the produced character) changes with the layout,
                // which is exactly the playtest-1 bug.
                let Some(scan) = keyboard_scan(keyboard.MakeCode, keyboard.Flags) else {
                    return;
                };
                let down = !keyboard_released(keyboard.Flags);
                dispatch(InputEvent::Key { device, scan, down });
            }
            RIM_TYPEMOUSE => {
                // SAFETY: the header says the union holds a mouse report.
                let mouse = unsafe { raw.data.mouse };
                // SAFETY: `usButtonFlags` overlays the low word of `ulButtons`.
                let flags = unsafe { mouse.Anonymous.Anonymous.usButtonFlags };
                for (button, down) in mouse_events(flags) {
                    dispatch(InputEvent::Mouse {
                        device,
                        button,
                        down,
                    });
                }
            }
            _ => {}
        }
    }

    fn dispatch(event: InputEvent) {
        if let Ok(slot) = super::HANDLER.lock() {
            if let Some(handler) = slot.as_ref() {
                handler(event);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_platform_reports_no_hook() {
        // On Windows this is true, elsewhere the stub is installed.
        let _ = is_supported();
    }

    #[test]
    fn event_shapes_are_constructible() {
        let key = InputEvent::Key {
            device: 1,
            scan: 0x25,
            down: true,
        };
        let mouse = InputEvent::Mouse {
            device: 2,
            button: MouseButton::X2,
            down: false,
        };
        assert_ne!(key, mouse);
    }

    #[test]
    fn letters_digits_and_function_keys_have_set_one_scan_codes() {
        // Spot checks across the table; the loops below cover all rows.
        assert_eq!(scan_code_for_code_name("KeyA"), Some(0x1E));
        assert_eq!(scan_code_for_code_name("KeyK"), Some(0x25));
        assert_eq!(scan_code_for_code_name("KeyZ"), Some(0x2C));
        assert_eq!(scan_code_for_code_name("Digit1"), Some(0x02));
        assert_eq!(scan_code_for_code_name("Digit0"), Some(0x0B));
        assert_eq!(scan_code_for_code_name("F1"), Some(0x3B));
        assert_eq!(scan_code_for_code_name("F12"), Some(0x58));
        // F13-F24 are extended keys.
        assert_eq!(scan_code_for_code_name("F13"), Some(SCAN_EXTENDED | 0x64));
        assert_eq!(scan_code_for_code_name("F24"), Some(SCAN_EXTENDED | 0x6F));
    }

    #[test]
    fn punctuation_and_navigation_keys_are_extended_where_windows_is() {
        assert_eq!(scan_code_for_code_name("Comma"), Some(0x33));
        assert_eq!(scan_code_for_code_name("Period"), Some(0x34));
        assert_eq!(scan_code_for_code_name("Semicolon"), Some(0x27));
        assert_eq!(scan_code_for_code_name("Space"), Some(0x39));
        assert_eq!(scan_code_for_code_name("Enter"), Some(0x1C));
        assert_eq!(
            scan_code_for_code_name("NumpadEnter"),
            Some(SCAN_EXTENDED | 0x1C)
        );
        // Home and Numpad7 share make code 47; only E0 tells them apart.
        assert_eq!(scan_code_for_code_name("Home"), Some(SCAN_EXTENDED | 0x47));
        assert_eq!(scan_code_for_code_name("Numpad7"), Some(0x47));
        assert_eq!(
            scan_code_for_code_name("ArrowUp"),
            Some(SCAN_EXTENDED | 0x48)
        );
        assert_eq!(
            scan_code_for_code_name("Delete"),
            Some(SCAN_EXTENDED | 0x53)
        );
    }

    #[test]
    fn the_scan_table_is_a_bijection() {
        use std::collections::HashSet;

        let mut codes = HashSet::new();
        let mut keys = HashSet::new();
        let mut scans = HashSet::new();
        for (code, key, scan) in SCAN_TABLE {
            assert!(codes.insert(*code), "duplicate KeyboardEvent.code {code}");
            assert!(keys.insert(*key), "duplicate accelerator name {key}");
            assert!(scans.insert(*scan), "duplicate scan code {scan:#06X}");
            assert_eq!(scan_code_for_code_name(code), Some(*scan));
            assert_eq!(scan_code_for_key_name(key), Some(*scan));
            assert_eq!(code_name_for_scan(*scan), Some(*code));
            assert_eq!(key_name_for_scan(*scan), Some(*key));
        }
        assert_eq!(SCAN_TABLE.len(), 107);
        assert_eq!(scan_code_for_code_name("Unknown"), None);
        assert_eq!(scan_code_for_key_name("Unknown"), None);
    }

    #[test]
    fn every_letter_and_digit_round_trips() {
        for letter in 'A'..='Z' {
            let code = format!("Key{letter}");
            let scan = scan_code_for_code_name(&code).expect("letter scan code");
            let expected = letter.to_string();
            assert_eq!(key_name_for_scan(scan), Some(expected.as_str()));
        }
        for digit in '0'..='9' {
            let code = format!("Digit{digit}");
            assert!(scan_code_for_code_name(&code).is_some(), "{code}");
        }
    }

    #[test]
    fn a_keyboard_report_becomes_a_physical_scan_code() {
        // `K` with no prefix; the release bit must not change the key.
        assert_eq!(keyboard_scan(0x25, 0), Some(0x25));
        assert_eq!(keyboard_scan(0x25, RI_KEY_BREAK), Some(0x25));
        assert!(keyboard_released(RI_KEY_BREAK));
        assert!(!keyboard_released(0));
        // Arrow Up is `E0 48`, Numpad8 is a bare `48`.
        assert_eq!(keyboard_scan(0x48, RI_KEY_E0), Some(SCAN_EXTENDED | 0x48));
        assert_eq!(keyboard_scan(0x48, 0), Some(0x48));
        // Pause is an `E1` sequence: its make code must not read as NumLock.
        assert_eq!(keyboard_scan(0x45, RI_KEY_E1), None);
        assert_eq!(keyboard_scan(0, 0), None);
        assert_eq!(keyboard_scan(MAKE_CODE_NONE, 0), None);
    }

    #[test]
    fn extra_mouse_buttons_are_mapped() {
        // X1 (button 4) press and release.
        assert_eq!(
            mouse_events(RI_MOUSE_BUTTON_4_DOWN).collect::<Vec<_>>(),
            vec![(MouseButton::X1, true)]
        );
        assert_eq!(
            mouse_events(RI_MOUSE_BUTTON_4_UP).collect::<Vec<_>>(),
            vec![(MouseButton::X1, false)]
        );
        // X2 (button 5) press and release.
        assert_eq!(
            mouse_events(RI_MOUSE_BUTTON_5_DOWN).collect::<Vec<_>>(),
            vec![(MouseButton::X2, true)]
        );
        assert_eq!(
            mouse_events(RI_MOUSE_BUTTON_5_UP).collect::<Vec<_>>(),
            vec![(MouseButton::X2, false)]
        );
    }

    #[test]
    fn ordinary_buttons_and_empty_reports_are_mapped() {
        assert_eq!(
            mouse_events(RI_MOUSE_LEFT_BUTTON_DOWN).collect::<Vec<_>>(),
            vec![(MouseButton::Left, true)]
        );
        assert_eq!(
            mouse_events(RI_MOUSE_RIGHT_BUTTON_UP).collect::<Vec<_>>(),
            vec![(MouseButton::Right, false)]
        );
        assert!(mouse_events(0).next().is_none());
        // Movement alone carries no button flag.
        assert!(mouse_events(0x0800).next().is_none());
    }

    #[test]
    fn the_global_path_is_raw_input_not_a_hook() {
        // Regression guard for ADR 0012: Vanguard compatibility is mandatory,
        // so a low-level hook must not come back. `concat!` keeps the banned
        // names out of this source file as contiguous text.
        let source = include_str!("hotkey.rs");
        let banned = [
            concat!("SetWindows", "HookEx"),
            concat!("WH_KEYBOARD", "_LL"),
            concat!("WH_MOUSE", "_LL"),
        ];
        for name in banned {
            assert!(!source.contains(name), "unexpected hook API: {name}");
        }
        assert!(source.contains(concat!("RegisterRawInput", "Devices")));
        assert!(source.contains(concat!("RIDEV_", "INPUTSINK")));
    }

    #[test]
    #[ignore = "registers real Raw Input; run on Windows manually"]
    fn raw_input_registers_and_stops() {
        let _serial = raw_input_test_lock();
        let hook = install(std::sync::Arc::new(|_| {}), true).expect("install raw input");
        drop(hook);
    }

    #[test]
    #[ignore = "registers real Raw Input; run on Windows manually"]
    fn raw_input_can_be_reinstalled_with_another_binding() {
        let _serial = raw_input_test_lock();
        // Changing the push-to-talk binding stops the first registration and
        // installs a second one in the same process (stage P24).
        let first = install(std::sync::Arc::new(|_| {}), false).expect("first install");
        drop(first);
        let second = install(std::sync::Arc::new(|_| {}), true).expect("second install");
        drop(second);
        let third = install(std::sync::Arc::new(|_| {}), false).expect("third install");
        drop(third);
    }

    /// Raw Input is one registration per process; the ignored tests run in
    /// parallel threads of one test binary, so they take turns.
    fn raw_input_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
