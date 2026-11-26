//! Debug-only WGC picker/capture probe for the native stream path (stage P16).
//!
//! Opens the system picker (window or monitor), captures the chosen item for a
//! few seconds and prints size, cursor/border state and the delivered frame
//! count. It never connects to a server and never publishes; use it to verify
//! source selection and the capture layer on a machine without a dev server.
//!
//!   cargo run -p rostalk-voice --example native_capture_probe
#![cfg(windows)]
// The release build only carries the "debug-only" stub; the Win32 imports and
// the owner window belong to the debug path.
#![allow(dead_code, unused_imports)]

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, SetForegroundWindow,
    ShowWindow, CW_USEDEFAULT, SW_SHOW, WINDOW_EX_STYLE, WNDCLASSW, WS_OVERLAPPEDWINDOW,
    WS_VISIBLE,
};

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// The product passes the Tauri main window; the probe needs some owner so the
/// picker has a UI thread to attach to.
fn owner_window() -> windows::core::Result<HWND> {
    unsafe {
        let instance = GetModuleHandleW(None)?;
        let class = w!("RostalkNativeCaptureProbe");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: instance.into(),
            lpszClassName: class,
            ..Default::default()
        };
        RegisterClassW(&wc);
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class,
            w!("RosTalk native capture probe"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            320,
            120,
            None,
            None,
            Some(instance.into()),
            None,
        )
    }
}

#[cfg(debug_assertions)]
fn main() {
    let owner = match owner_window() {
        Ok(hwnd) => hwnd,
        Err(error) => {
            eprintln!("could not create the picker owner window: {error}");
            std::process::exit(1);
        }
    };
    unsafe {
        let _ = ShowWindow(owner, SW_SHOW);
        let _ = SetForegroundWindow(owner);
    }
    // Let the owner window paint before the system picker is attached.
    std::thread::sleep(std::time::Duration::from_millis(500));
    let result = rostalk_voice::native_stream::probe_capture(owner.0 as isize, 10);
    unsafe {
        let _ = DestroyWindow(owner);
    }
    match result {
        Ok(report) => {
            println!("{report:#?}");
        }
        Err(error) => {
            eprintln!("native capture probe: {}", error.user_message());
            std::process::exit(1);
        }
    }
}

#[cfg(not(debug_assertions))]
fn main() {
    eprintln!("native_capture_probe is a debug-only example: run it without --release");
    std::process::exit(1);
}
