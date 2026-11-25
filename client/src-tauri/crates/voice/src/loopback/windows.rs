//! WASAPI process loopback, `EXCLUDE_TARGET_PROCESS_TREE` with our own PID
//! (ADR 0027).
//!
//! The flow follows Microsoft's ApplicationLoopback sample
//! (`LoopbackCapture.cpp`): `ActivateAudioInterfaceAsync` on the virtual
//! process-loopback device with an `AUDIOCLIENT_ACTIVATION_PARAMS` blob, then
//! `IAudioClient::Initialize` in shared loopback mode with
//! `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM` and a format we choose (48 kHz,
//! stereo, 16-bit PCM), then an `IAudioCaptureClient` read loop.
//!
//! `windows-sys` declares the functions, structures and constants but not the
//! COM interfaces, so the four method tables used here are declared below in
//! the order of `audioclient.h` and `mmdeviceapi.h` (cross-checked with the
//! `windows` 0.62.2 crate already in the dependency graph through `cpal`).
//!
//! Anti-cheat: the only process id is `GetCurrentProcessId()`. No process is
//! opened, listed or inspected (section "Античит-гигиена").

use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use ringbuf::traits::Producer;
use ringbuf::HeapProd;
use windows_sys::core::{GUID, HRESULT};
use windows_sys::Win32::Foundation::{E_NOINTERFACE, E_POINTER, S_OK};
use windows_sys::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows_sys::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, BLOB, COINIT_MULTITHREADED};
use windows_sys::Win32::System::Threading::GetCurrentProcessId;
use windows_sys::Win32::System::Variant::VT_BLOB;

use super::{CaptureFlags, STREAM_CHANNELS, STREAM_FRAME};
use crate::error::VoiceError;
use crate::frame::SAMPLE_RATE;
use crate::scheduler::AudioScheduler;

const IID_IUNKNOWN: GUID = GUID::from_u128(0x00000000_0000_0000_c000_000000000046);
const IID_IAGILE_OBJECT: GUID = GUID::from_u128(0x94ea2b94_e9cc_49e0_c0ff_ee64ca8f5b90);
const IID_IAUDIO_CLIENT: GUID = GUID::from_u128(0x1cb9ad4c_dbfa_4c32_b178_c2f568a703b2);
const IID_IAUDIO_CAPTURE_CLIENT: GUID = GUID::from_u128(0xc8adbd64_e71e_48a0_a4de_185c395cd317);
const IID_IACTIVATE_COMPLETION_HANDLER: GUID =
    GUID::from_u128(0x41d949ab_9862_444a_80f6_c261334da5eb);

/// How long the activation may take before the capture gives up.
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(5);
/// Shared-mode buffer of the loopback client, in 100 ns units: 200 ms. The
/// thread drains it every [`POLL`], so it only bounds a stall.
const BUFFER_DURATION: i64 = 2_000_000;
/// Polling interval of the capture thread. The same 2 ms poll the microphone
/// path uses (ADR 0013); the 1 ms system timer is on while it runs.
const POLL: Duration = Duration::from_millis(2);

type QueryInterfaceFn =
    unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT;
type RefCountFn = unsafe extern "system" fn(*mut c_void) -> u32;

#[repr(C)]
struct IUnknownVtbl {
    query_interface: QueryInterfaceFn,
    add_ref: RefCountFn,
    release: RefCountFn,
}

/// `IAudioClient` (audioclient.h), in declaration order.
#[repr(C)]
struct IAudioClientVtbl {
    base: IUnknownVtbl,
    initialize: unsafe extern "system" fn(
        *mut c_void,
        i32,
        u32,
        i64,
        i64,
        *const WAVEFORMATEX,
        *const GUID,
    ) -> HRESULT,
    get_buffer_size: *const c_void,
    get_stream_latency: *const c_void,
    get_current_padding: *const c_void,
    is_format_supported: *const c_void,
    get_mix_format: *const c_void,
    get_device_period: *const c_void,
    start: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    stop: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    reset: *const c_void,
    set_event_handle: *const c_void,
    get_service: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
}

/// `IAudioCaptureClient` (audioclient.h).
#[repr(C)]
struct IAudioCaptureClientVtbl {
    base: IUnknownVtbl,
    get_buffer: unsafe extern "system" fn(
        *mut c_void,
        *mut *mut u8,
        *mut u32,
        *mut u32,
        *mut u64,
        *mut u64,
    ) -> HRESULT,
    release_buffer: unsafe extern "system" fn(*mut c_void, u32) -> HRESULT,
    get_next_packet_size: unsafe extern "system" fn(*mut c_void, *mut u32) -> HRESULT,
}

/// `IActivateAudioInterfaceAsyncOperation` (mmdeviceapi.h).
#[repr(C)]
struct IActivateAudioInterfaceAsyncOperationVtbl {
    base: IUnknownVtbl,
    get_activate_result:
        unsafe extern "system" fn(*mut c_void, *mut HRESULT, *mut *mut c_void) -> HRESULT,
}

/// `IActivateAudioInterfaceCompletionHandler` (mmdeviceapi.h).
#[repr(C)]
struct CompletionHandlerVtbl {
    base: IUnknownVtbl,
    activate_completed: unsafe extern "system" fn(*mut c_void, *mut c_void) -> HRESULT,
}

/// An owned COM interface pointer, released on drop.
struct ComPtr(*mut c_void);

impl ComPtr {
    /// The method table of the interface the pointer was obtained for.
    ///
    /// # Safety
    /// `T` must be the vtable layout of that interface.
    unsafe fn vtbl<T>(&self) -> &T {
        &**(self.0 as *mut *const T)
    }
}

impl Drop for ComPtr {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: every ComPtr holds one reference of a live COM object,
            // and the first three slots of any COM vtable are IUnknown.
            unsafe {
                let vtbl = self.vtbl::<IUnknownVtbl>();
                (vtbl.release)(self.0);
            }
        }
    }
}

/// Our completion handler: one COM object with an agile identity. Windows
/// calls `ActivateCompleted` on an MTA worker thread; the handler only wakes
/// the waiting capture thread.
#[repr(C)]
struct CompletionHandler {
    vtbl: *const CompletionHandlerVtbl,
    refs: AtomicU32,
    done: SyncSender<()>,
}

static COMPLETION_HANDLER_VTBL: CompletionHandlerVtbl = CompletionHandlerVtbl {
    base: IUnknownVtbl {
        query_interface: handler_query_interface,
        add_ref: handler_add_ref,
        release: handler_release,
    },
    activate_completed: handler_activate_completed,
};

unsafe extern "system" fn handler_query_interface(
    this: *mut c_void,
    iid: *const GUID,
    out: *mut *mut c_void,
) -> HRESULT {
    if out.is_null() || iid.is_null() {
        return E_POINTER;
    }
    let iid = &*iid;
    // The handler must be agile (ActivateAudioInterfaceAsync, Remarks): it
    // keeps no thread affinity, so answering IAgileObject is truthful.
    if guid_eq(iid, &IID_IUNKNOWN)
        || guid_eq(iid, &IID_IAGILE_OBJECT)
        || guid_eq(iid, &IID_IACTIVATE_COMPLETION_HANDLER)
    {
        handler_add_ref(this);
        *out = this;
        S_OK
    } else {
        *out = ptr::null_mut();
        E_NOINTERFACE
    }
}

unsafe extern "system" fn handler_add_ref(this: *mut c_void) -> u32 {
    let handler = &*(this as *const CompletionHandler);
    handler.refs.fetch_add(1, Ordering::AcqRel) + 1
}

unsafe extern "system" fn handler_release(this: *mut c_void) -> u32 {
    let handler = &*(this as *const CompletionHandler);
    let left = handler.refs.fetch_sub(1, Ordering::AcqRel) - 1;
    if left == 0 {
        drop(Box::from_raw(this as *mut CompletionHandler));
    }
    left
}

unsafe extern "system" fn handler_activate_completed(
    this: *mut c_void,
    _operation: *mut c_void,
) -> HRESULT {
    let handler = &*(this as *const CompletionHandler);
    // The capture thread reads the result itself; a full or closed channel
    // only means it already stopped waiting.
    let _ = handler.done.try_send(());
    S_OK
}

fn guid_eq(a: &GUID, b: &GUID) -> bool {
    a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
}

fn failed(hr: HRESULT) -> bool {
    hr < 0
}

fn hresult(what: &str, hr: HRESULT) -> String {
    format!("{what} failed (0x{:08X})", hr as u32)
}

/// COM for the current thread, uninitialised on drop.
struct ComApartment;

impl ComApartment {
    fn enter() -> Result<Self, String> {
        // SAFETY: plain COM initialisation of the calling thread.
        let hr = unsafe { CoInitializeEx(ptr::null(), COINIT_MULTITHREADED as u32) };
        if failed(hr) {
            return Err(hresult("CoInitializeEx", hr));
        }
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        // SAFETY: balanced with the successful CoInitializeEx above.
        unsafe { CoUninitialize() };
    }
}

/// The capture format: 48 kHz, stereo, 16-bit PCM. The loopback client has
/// no mix format of its own; `AUTOCONVERTPCM` makes the audio engine convert.
fn capture_format() -> WAVEFORMATEX {
    let block_align = (STREAM_CHANNELS * 2) as u16;
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: STREAM_CHANNELS as u16,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * u32::from(block_align),
        nBlockAlign: block_align,
        wBitsPerSample: 16,
        cbSize: 0,
    }
}

/// Activates and initialises an `IAudioClient` for the process loopback of
/// everything except this process tree. Must run on a thread with COM.
fn activate_client() -> Result<ComPtr, String> {
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                // Our own PID and nothing else (ADR 0027): exclude RosTalk.
                // SAFETY: no preconditions.
                TargetProcessId: unsafe { GetCurrentProcessId() },
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    let variant = PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: PROPVARIANT_0_0 {
                vt: VT_BLOB,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: &params as *const AUDIOCLIENT_ACTIVATION_PARAMS as *mut u8,
                    },
                },
            },
        },
    };

    let (done, completed): (SyncSender<()>, Receiver<()>) = sync_channel(1);
    let handler = Box::into_raw(Box::new(CompletionHandler {
        vtbl: &COMPLETION_HANDLER_VTBL,
        refs: AtomicU32::new(1),
        done,
    }));
    // Our reference to the handler; Windows takes its own until it completes.
    let handler_ref = ComPtr(handler.cast());

    let mut operation: *mut c_void = ptr::null_mut();
    // SAFETY: the device path is a static wide string, the IID and the blob
    // outlive the call (the blob is copied by the activation), the handler
    // is a valid COM object and `operation` receives an owned reference.
    let hr = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IID_IAUDIO_CLIENT,
            &variant,
            handler.cast(),
            &mut operation,
        )
    };
    if failed(hr) {
        return Err(hresult("ActivateAudioInterfaceAsync", hr));
    }
    let operation = ComPtr(operation);
    if operation.0.is_null() {
        return Err("ActivateAudioInterfaceAsync returned no operation".to_owned());
    }
    if completed.recv_timeout(ACTIVATION_TIMEOUT).is_err() {
        return Err("the process loopback activation timed out".to_owned());
    }

    let mut activate_result: HRESULT = S_OK;
    let mut unknown: *mut c_void = ptr::null_mut();
    // SAFETY: the operation completed; the out pointers are valid.
    let hr = unsafe {
        (operation
            .vtbl::<IActivateAudioInterfaceAsyncOperationVtbl>()
            .get_activate_result)(operation.0, &mut activate_result, &mut unknown)
    };
    let unknown = ComPtr(unknown);
    if failed(hr) {
        return Err(hresult("GetActivateResult", hr));
    }
    if failed(activate_result) {
        return Err(hresult("process loopback activation", activate_result));
    }
    if unknown.0.is_null() {
        return Err("process loopback activation returned no interface".to_owned());
    }
    let mut client: *mut c_void = ptr::null_mut();
    // SAFETY: `unknown` is a live IUnknown.
    let hr = unsafe {
        (unknown.vtbl::<IUnknownVtbl>().query_interface)(unknown.0, &IID_IAUDIO_CLIENT, &mut client)
    };
    if failed(hr) || client.is_null() {
        return Err(hresult("QueryInterface(IAudioClient)", hr));
    }
    let client = ComPtr(client);
    drop(handler_ref);

    let format = capture_format();
    // SAFETY: `client` is a live IAudioClient; the format outlives the call.
    let hr = unsafe {
        (client.vtbl::<IAudioClientVtbl>().initialize)(
            client.0,
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            BUFFER_DURATION,
            0,
            &format,
            ptr::null(),
        )
    };
    if failed(hr) {
        return Err(hresult("IAudioClient::Initialize", hr));
    }
    Ok(client)
}

/// Activation and initialisation without starting the stream.
pub(super) fn probe() -> Result<(), String> {
    let thread = std::thread::Builder::new()
        .name("rostalk-stream-audio-probe".to_owned())
        .spawn(|| {
            let _com = ComApartment::enter()?;
            activate_client().map(drop)
        })
        .map_err(|error| format!("start the probe thread: {error}"))?;
    thread
        .join()
        .map_err(|_| "the process loopback probe panicked".to_owned())?
}

/// Starts the capture thread. Returns once the client runs, or with the
/// activation error.
pub(super) fn start(
    producer: HeapProd<i16>,
    flags: Arc<CaptureFlags>,
) -> Result<JoinHandle<()>, VoiceError> {
    let (ready_tx, ready_rx) = sync_channel::<Result<(), String>>(1);
    let thread = std::thread::Builder::new()
        .name("rostalk-stream-audio".to_owned())
        .spawn(move || capture_thread(producer, flags, ready_tx))
        .map_err(|error| VoiceError::Internal(format!("start the stream audio thread: {error}")))?;
    match ready_rx.recv_timeout(ACTIVATION_TIMEOUT + Duration::from_secs(1)) {
        Ok(Ok(())) => Ok(thread),
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(VoiceError::Device(error))
        }
        Err(_) => Err(VoiceError::Device(
            "the stream audio capture did not start".to_owned(),
        )),
    }
}

fn capture_thread(
    mut producer: HeapProd<i16>,
    flags: Arc<CaptureFlags>,
    ready: SyncSender<Result<(), String>>,
) {
    let com = match ComApartment::enter() {
        Ok(com) => com,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let opened = activate_client().and_then(|client| {
        let mut capture: *mut c_void = ptr::null_mut();
        // SAFETY: `client` is an initialised IAudioClient.
        let hr = unsafe {
            (client.vtbl::<IAudioClientVtbl>().get_service)(
                client.0,
                &IID_IAUDIO_CAPTURE_CLIENT,
                &mut capture,
            )
        };
        if failed(hr) || capture.is_null() {
            return Err(hresult("GetService(IAudioCaptureClient)", hr));
        }
        let capture = ComPtr(capture);
        // SAFETY: as above.
        let hr = unsafe { (client.vtbl::<IAudioClientVtbl>().start)(client.0) };
        if failed(hr) {
            return Err(hresult("IAudioClient::Start", hr));
        }
        Ok((client, capture))
    });
    let (client, capture) = match opened {
        Ok(value) => value,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let _ = ready.send(Ok(()));

    // MMCSS and the 1 ms timer, like every other audio thread of the engine.
    let scheduler = AudioScheduler::new();
    let _audio_thread = scheduler.enter_audio_thread();
    let silence = [0i16; STREAM_FRAME];
    // The loop below is the "callback" of this capture: it copies packets
    // into the ring and nothing else — no locks, no allocation, no logging.
    'capture: while !flags.stop.load(Ordering::Relaxed) {
        std::thread::sleep(POLL);
        loop {
            let mut packet = 0u32;
            // SAFETY: `capture` is a live IAudioCaptureClient.
            let hr = unsafe {
                (capture
                    .vtbl::<IAudioCaptureClientVtbl>()
                    .get_next_packet_size)(capture.0, &mut packet)
            };
            if failed(hr) {
                flags.failed.store(true, Ordering::Relaxed);
                break 'capture;
            }
            if packet == 0 {
                break;
            }
            let mut data: *mut u8 = ptr::null_mut();
            let mut frames = 0u32;
            let mut buffer_flags = 0u32;
            // SAFETY: the out pointers are valid; the position pointers may be
            // null (audioclient.h).
            let hr = unsafe {
                (capture.vtbl::<IAudioCaptureClientVtbl>().get_buffer)(
                    capture.0,
                    &mut data,
                    &mut frames,
                    &mut buffer_flags,
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            };
            if failed(hr) {
                flags.failed.store(true, Ordering::Relaxed);
                break 'capture;
            }
            let samples = frames as usize * STREAM_CHANNELS;
            let silent = buffer_flags & (AUDCLNT_BUFFERFLAGS_SILENT as u32) != 0 || data.is_null();
            let mut written = 0usize;
            if silent {
                let mut left = samples;
                while left > 0 {
                    let chunk = left.min(silence.len());
                    let pushed = producer.push_slice(&silence[..chunk]);
                    written += pushed;
                    if pushed < chunk {
                        break;
                    }
                    left -= chunk;
                }
            } else {
                // SAFETY: GetBuffer returned `frames` frames of the 16-bit
                // stereo format requested in Initialize; the buffer stays
                // valid until ReleaseBuffer and is suitably aligned for i16
                // (block-aligned engine buffer).
                let pcm = unsafe { std::slice::from_raw_parts(data as *const i16, samples) };
                written = producer.push_slice(pcm);
            }
            if written < samples {
                flags
                    .dropped
                    .fetch_add((samples - written) as u64, Ordering::Relaxed);
            }
            // SAFETY: releases exactly the frames GetBuffer handed out.
            let hr = unsafe {
                (capture.vtbl::<IAudioCaptureClientVtbl>().release_buffer)(capture.0, frames)
            };
            if failed(hr) {
                flags.failed.store(true, Ordering::Relaxed);
                break 'capture;
            }
        }
    }
    // SAFETY: the client is live; stopping an already failed client is fine.
    unsafe {
        let _ = (client.vtbl::<IAudioClientVtbl>().stop)(client.0);
    }
    drop(capture);
    drop(client);
    drop(com);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ringbuf::traits::Split;

    #[test]
    fn the_requested_format_is_48k_stereo_pcm16() {
        // WAVEFORMATEX is packed: copy the fields out before comparing.
        let format = capture_format();
        let (tag, channels, rate) = (format.wFormatTag, format.nChannels, format.nSamplesPerSec);
        let (align, bytes, bits) = (
            format.nBlockAlign,
            format.nAvgBytesPerSec,
            format.wBitsPerSample,
        );
        assert_eq!(tag, WAVE_FORMAT_PCM as u16);
        assert_eq!(channels, 2);
        assert_eq!(rate, 48_000);
        assert_eq!(align, 4);
        assert_eq!(bytes, 192_000);
        assert_eq!(bits, 16);
    }

    #[test]
    fn the_handler_answers_only_its_own_interfaces() {
        let (done, completed) = sync_channel(1);
        let handler = Box::into_raw(Box::new(CompletionHandler {
            vtbl: &COMPLETION_HANDLER_VTBL,
            refs: AtomicU32::new(1),
            done,
        }));
        let this: *mut c_void = handler.cast();
        unsafe {
            for iid in [
                IID_IUNKNOWN,
                IID_IAGILE_OBJECT,
                IID_IACTIVATE_COMPLETION_HANDLER,
            ] {
                let mut out = ptr::null_mut();
                assert_eq!(handler_query_interface(this, &iid, &mut out), S_OK);
                assert_eq!(out, this);
                handler_release(this);
            }
            let mut out = this;
            assert_eq!(
                handler_query_interface(this, &IID_IAUDIO_CLIENT, &mut out),
                E_NOINTERFACE
            );
            assert!(out.is_null());
            assert_eq!(handler_activate_completed(this, ptr::null_mut()), S_OK);
            assert!(completed.try_recv().is_ok());
            assert_eq!(handler_release(this), 0);
        }
    }

    /// Live check on a real Windows machine: the process loopback activates in
    /// the EXCLUDE mode with our PID and delivers whole stereo frames. Run
    /// with `--ignored` while something plays (stage P15 live run).
    #[test]
    #[ignore = "needs Windows audio; run by hand with --ignored --nocapture"]
    fn the_process_loopback_captures_on_this_machine() {
        use ringbuf::traits::{Consumer, Observer};
        probe().expect("probe");
        let (producer, consumer) = ringbuf::HeapRb::<i16>::new(STREAM_FRAME * 400).split();
        let flags = Arc::new(CaptureFlags::default());
        let thread = start(producer, flags.clone()).expect("start");
        std::thread::sleep(Duration::from_secs(2));
        flags.stop.store(true, Ordering::Relaxed);
        thread.join().expect("join");
        let samples = consumer.occupied_len();
        let peak = consumer.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
        println!(
            "captured {samples} samples in 2 s, peak {peak}, failed={}",
            flags.failed.load(Ordering::Relaxed)
        );
        assert!(!flags.failed.load(Ordering::Relaxed));
        assert_eq!(samples % STREAM_CHANNELS, 0);
    }

    /// Goertzel power of one frequency in the left channel of interleaved
    /// stereo, normalised by length.
    fn tone_power(stereo: &[i16], frequency: f32) -> f64 {
        let omega = std::f64::consts::TAU * f64::from(frequency) / 48_000.0;
        let (mut real, mut imag) = (0.0f64, 0.0f64);
        let mut count = 0usize;
        for (index, sample) in stereo.iter().step_by(STREAM_CHANNELS).enumerate() {
            let phase = omega * index as f64;
            let value = f64::from(*sample) / 32_768.0;
            real += value * phase.cos();
            imag += value * phase.sin();
            count += 1;
        }
        if count == 0 {
            return 0.0;
        }
        (real * real + imag * imag) / (count as f64).powi(2)
    }

    /// The anti-echo property itself (ADR 0027): a 1 kHz tone played by THIS
    /// process through the default output must not appear in the capture,
    /// while a tone of another process (run by hand, e.g. a 440 Hz WAV in
    /// PowerShell's SoundPlayer) does. Prints both powers; asserts only the
    /// exclusion so it also passes when nothing else plays.
    #[test]
    #[ignore = "needs Windows audio; run by hand with --ignored --nocapture"]
    fn own_process_audio_is_excluded_from_the_capture() {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        use ringbuf::traits::{Consumer, Observer};

        let host = cpal::default_host();
        let device = host.default_output_device().expect("output device");
        let supported = device.default_output_config().expect("output config");
        let config = supported.config();
        let channels = usize::from(config.channels);
        let rate = config.sample_rate as f32;
        let mut phase = 0.0f32;
        let stream = device
            .build_output_stream(
                config,
                move |data: &mut [f32], _| {
                    for frame in data.chunks_mut(channels) {
                        let value = (phase * std::f32::consts::TAU).sin() * 0.3;
                        phase = (phase + 1_000.0 / rate) % 1.0;
                        frame.fill(value);
                    }
                },
                |_| {},
                None,
            )
            .expect("output stream (f32 default format)");
        stream.play().expect("play");
        std::thread::sleep(Duration::from_millis(300));

        let (producer, mut consumer) = ringbuf::HeapRb::<i16>::new(STREAM_FRAME * 400).split();
        let flags = Arc::new(CaptureFlags::default());
        let thread = start(producer, flags.clone()).expect("start");
        std::thread::sleep(Duration::from_secs(2));
        flags.stop.store(true, Ordering::Relaxed);
        thread.join().expect("join");
        drop(stream);

        let mut samples = vec![0i16; consumer.occupied_len()];
        consumer.pop_slice(&mut samples);
        let own = tone_power(&samples, 1_000.0);
        let other = tone_power(&samples, 440.0);
        println!(
            "captured {} samples; own 1 kHz power {own:.3e}, foreign 440 Hz power {other:.3e}",
            samples.len()
        );
        // A 0.3 full-scale sine captured would be ~2e-2; require it gone.
        assert!(
            own < 1e-6,
            "RosTalk's own audio leaked into the capture: {own:e}"
        );
    }
}
