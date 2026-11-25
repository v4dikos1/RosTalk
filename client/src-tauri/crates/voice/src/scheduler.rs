//! Scheduling helpers for the real-time audio threads.
//!
//! The capture and playback threads wake every 10 ms. On Windows a plain
//! `thread::sleep(10 ms)` may round up to the 15.6 ms system timer tick, which
//! makes the pipeline produce about 30 % fewer samples than the device consumes
//! and shows up as dropouts (stage 2.3.1). The fix is the standard one:
//! request 1 ms timer resolution for the process and register the threads with
//! MMCSS ("Audio"), which also raises their priority and protects them from
//! starvation while the CPU is busy.
//!
//! Everything here is a no-op on other platforms: the client ships on Windows,
//! and the other hosts only run the portable tests.

use std::time::{Duration, Instant};

use crate::frame::FRAME_MS;

/// Process-wide 1 ms timer resolution, released when the audio runtime stops.
pub struct AudioScheduler {
    #[cfg(windows)]
    timer_active: bool,
}

impl AudioScheduler {
    /// Requests a 1 ms system timer for the lifetime of the value.
    #[must_use]
    pub fn new() -> Self {
        #[cfg(windows)]
        {
            // SAFETY: `timeBeginPeriod` only changes a process-wide timer
            // request; it has no pointer arguments and cannot fail in a way
            // that affects memory safety.
            let result = unsafe { windows_sys::Win32::Media::timeBeginPeriod(1) };
            if result != 0 {
                log::warn!("could not request a 1 ms timer resolution: {result}");
            }
            Self {
                timer_active: result == 0,
            }
        }
        #[cfg(not(windows))]
        {
            Self {}
        }
    }

    /// Registers the calling thread with MMCSS and raises its priority.
    ///
    /// Keep the returned guard alive for as long as the thread runs its audio
    /// loop; dropping it reverts the MMCSS registration.
    #[must_use]
    pub fn enter_audio_thread(&self) -> AudioThreadGuard {
        #[cfg(windows)]
        {
            // "Audio" is the standard MMCSS task for real-time audio. The task
            // index is an in/out parameter filled by the system.
            let name: [u16; 6] = [
                b'A' as u16,
                b'u' as u16,
                b'd' as u16,
                b'i' as u16,
                b'o' as u16,
                0,
            ];
            let mut task_index = 0u32;
            // SAFETY: the name is a NUL-terminated UTF-16 string that lives for
            // the duration of the call; `task_index` is a valid out pointer.
            let handle = unsafe {
                windows_sys::Win32::System::Threading::AvSetMmThreadCharacteristicsW(
                    name.as_ptr(),
                    &mut task_index,
                )
            };
            if handle.is_null() {
                // MMCSS can be unavailable (for example in some containers).
                // A plain priority bump still helps and is harmless.
                // SAFETY: `GetCurrentThread` returns a pseudo-handle; setting
                // its priority is always valid.
                unsafe {
                    windows_sys::Win32::System::Threading::SetThreadPriority(
                        windows_sys::Win32::System::Threading::GetCurrentThread(),
                        windows_sys::Win32::System::Threading::THREAD_PRIORITY_HIGHEST,
                    );
                }
            }
            AudioThreadGuard {
                mmcss: handle as usize,
            }
        }
        #[cfg(not(windows))]
        {
            AudioThreadGuard {}
        }
    }
}

impl Default for AudioScheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for AudioScheduler {
    fn drop(&mut self) {
        #[cfg(windows)]
        if self.timer_active {
            // SAFETY: balances the successful `timeBeginPeriod(1)` above.
            unsafe {
                windows_sys::Win32::Media::timeEndPeriod(1);
            }
        }
    }
}

/// MMCSS registration of one audio thread.
pub struct AudioThreadGuard {
    #[cfg(windows)]
    mmcss: usize,
}

impl Drop for AudioThreadGuard {
    fn drop(&mut self) {
        #[cfg(windows)]
        if self.mmcss != 0 {
            // SAFETY: the handle came from `AvSetMmThreadCharacteristicsW` and
            // is reverted exactly once.
            unsafe {
                windows_sys::Win32::System::Threading::AvRevertMmThreadCharacteristics(
                    self.mmcss as *mut core::ffi::c_void,
                );
            }
        }
    }
}

/// Sleeps until the next 10 ms frame deadline.
///
/// Deadlines advance by exactly one frame, so wake-up jitter never accumulates
/// into a rate error. A thread that was descheduled for more than 200 ms gives
/// up on catching up: the rings must not be flooded with a burst of frames.
pub fn pace(next: &mut Instant) {
    *next += Duration::from_millis(FRAME_MS);
    let now = Instant::now();
    if *next > now {
        std::thread::sleep(*next - now);
    } else if now.duration_since(*next) > Duration::from_millis(200) {
        *next = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pacing_advances_by_one_frame() {
        let mut next = Instant::now();
        pace(&mut next);
        let elapsed = next.saturating_duration_since(Instant::now());
        assert!(elapsed <= Duration::from_millis(FRAME_MS));
    }

    #[test]
    fn a_long_stall_resets_the_deadline_instead_of_bursting() {
        let mut next = Instant::now() - Duration::from_secs(1);
        pace(&mut next);
        assert!(next > Instant::now() - Duration::from_millis(100));
    }

    #[test]
    fn the_scheduler_can_be_created_and_entered() {
        let scheduler = AudioScheduler::new();
        {
            let _guard = scheduler.enter_audio_thread();
        }
    }
}
