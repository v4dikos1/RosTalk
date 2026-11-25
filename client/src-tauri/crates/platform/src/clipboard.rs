//! Reading the OS text clipboard.
//!
//! The WebView2 context menu is disabled (stage 2.3.1), so right-click paste in
//! a text field is served by our own small menu. Chromium does not allow
//! `execCommand("paste")`, and the async Clipboard API needs a permission the
//! desktop shell cannot ask for, so the text comes from the OS directly.
//!
//! Only reading is exposed: copy and cut stay inside the WebView
//! (`document.execCommand`), which already works and never touches the
//! clipboard from Rust.

use crate::error::PlatformError;

/// Reads Unicode text from the clipboard.
///
/// Returns an empty string when the clipboard holds no text. The clipboard is
/// a shared, often briefly locked resource, so the call retries for a moment
/// before giving up.
pub fn read_text() -> Result<String, PlatformError> {
    imp::read_text()
}

#[cfg(not(windows))]
mod imp {
    use super::PlatformError;

    pub fn read_text() -> Result<String, PlatformError> {
        // The client ships for Windows; the stub keeps the workspace building.
        Err(PlatformError::Unsupported)
    }
}

#[cfg(windows)]
mod imp {
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    use super::PlatformError;

    /// `CF_UNICODETEXT` from `Win32::System::Ole`/`DataExchange`.
    const CF_UNICODETEXT: u32 = 13;
    /// The clipboard is regularly held for a few milliseconds by Explorer.
    const ATTEMPTS: u32 = 10;
    const RETRY_DELAY: Duration = Duration::from_millis(20);

    pub fn read_text() -> Result<String, PlatformError> {
        for attempt in 0..ATTEMPTS {
            // SAFETY: Win32 clipboard calls on the current thread; every handle
            // is checked before use and the clipboard is closed exactly once.
            unsafe {
                if OpenClipboard(std::ptr::null_mut()) == 0 {
                    std::thread::sleep(RETRY_DELAY);
                    continue;
                }
                let text = if IsClipboardFormatAvailable(CF_UNICODETEXT) != 0 {
                    read_unicode(GetClipboardData(CF_UNICODETEXT))
                } else {
                    Ok(String::new())
                };
                let _ = CloseClipboard();
                return match text {
                    Ok(text) => Ok(text),
                    Err(error) if attempt + 1 < ATTEMPTS => {
                        let _ = error;
                        std::thread::sleep(RETRY_DELAY);
                        continue;
                    }
                    Err(error) => Err(error),
                };
            }
        }
        Err(PlatformError::Io(
            "the clipboard stayed locked by another application".to_owned(),
        ))
    }

    /// Copies a `HGLOBAL` text block into a Rust string.
    ///
    /// # Safety
    /// `handle` must come from `GetClipboardData(CF_UNICODETEXT)` while the
    /// clipboard is open.
    unsafe fn read_unicode(handle: HANDLE) -> Result<String, PlatformError> {
        if handle.is_null() {
            return Err(PlatformError::Io(
                "the clipboard returned no text handle".to_owned(),
            ));
        }
        let global = handle as HGLOBAL;
        let pointer = unsafe { GlobalLock(global) } as *const u16;
        if pointer.is_null() {
            return Err(PlatformError::Io("could not lock the clipboard".to_owned()));
        }
        let bytes = unsafe { GlobalSize(global) };
        let capacity = bytes / std::mem::size_of::<u16>();
        let mut length = 0usize;
        while length < capacity {
            if unsafe { *pointer.add(length) } == 0 {
                break;
            }
            length += 1;
        }
        let text = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(pointer, length) });
        let _ = unsafe { GlobalUnlock(global) };
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "reads the real OS clipboard; run on Windows manually"]
    fn reading_the_clipboard_does_not_panic() {
        // The result depends on the desktop session; only the call shape is
        // checked here.
        let _ = read_text();
    }
}
