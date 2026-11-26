//! Optional native screen capture and publishing (stage P16).
//!
//! This is the reversible native path: Windows.Graphics.Capture through the
//! system picker, BGRA -> I420 on the CPU, and a normal `screen_share` track in
//! the existing stream room with the pinned `livekit`/libwebrtc build. The
//! encoder is forced to software and the track uses VP8 simulcast, so no
//! NVIDIA/NVENC, hardware MFT or discrete GPU is required.
//!
//! It is Windows-only and off by default in the UI. The WebView2 stream path
//! stays untouched; the UI chooses this path only when the user explicitly
//! asks for it and falls back only through a separate explicit action.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Presets the native software path implements. The heavy WebView2 presets
/// (1080p60 and "source") stay available in the WebView2 mode and are not
/// silently downgraded here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum NativePreset {
    #[serde(rename = "720p30")]
    P720,
    #[serde(rename = "1080p30")]
    P1080,
}

impl NativePreset {
    /// Parses the UI/preset string. Unknown or heavy presets are rejected so
    /// the caller can explain the limitation instead of silently changing it.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "720p30" => Some(Self::P720),
            "1080p30" => Some(Self::P1080),
            _ => None,
        }
    }

    /// String form used by the IPC/state surface.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::P720 => "720p30",
            Self::P1080 => "1080p30",
        }
    }

    /// Source size, target framerate, top bitrate and the simulcast layers
    /// below the full one (ADR 0031/P14).
    #[must_use]
    pub fn spec(self) -> NativePresetSpec {
        match self {
            Self::P720 => NativePresetSpec {
                width: 1280,
                height: 720,
                fps: 30,
                bitrate: 2_500_000,
                layers: vec![(320, 180, 150_000)],
            },
            Self::P1080 => NativePresetSpec {
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate: 6_000_000,
                layers: vec![(640, 360, 450_000), (1280, 720, 1_700_000)],
            },
        }
    }
}

/// What one preset publishes.
#[derive(Debug, Clone)]
pub struct NativePresetSpec {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u64,
    /// `(width, height, max bitrate)` of every layer below the full one.
    pub layers: Vec<(u32, u32, u64)>,
}

/// Whether this machine can run the native path. No hardware-encoder probe is
/// involved: the reason is only the OS capture API, the cursor property and
/// D3D11.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NativeStreamSupport {
    pub supported: bool,
    /// `IsCursorCaptureEnabled` exists (Windows 10 2004+). Without it the
    /// native path cannot keep the system cursor out of the frame.
    pub cursor_capture_available: bool,
    /// `GraphicsCaptureAccess`/`IsBorderRequired` exists (Windows 11 22000+).
    /// Without it the capture border stays, which the UI must explain.
    pub border_api_available: bool,
    /// Human-readable, token-free reason when `supported` is false.
    pub reason: Option<String>,
}

/// One immutable publish configuration. Contains the media token, so it has no
/// `Debug`/`Serialize`: it never reaches the UI or a log.
#[derive(Clone)]
pub struct NativeStreamConfig {
    pub gateway: String,
    pub fingerprint: String,
    pub token: String,
    pub room: String,
    pub preset: NativePreset,
    /// Tauri main window handle used as the picker owner.
    pub owner_hwnd: isize,
}

/// Events the UI mirrors. They are token-free and safe to log.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NativeStreamEvent {
    /// The system picker is open; no capture has started.
    Picking,
    /// A source was chosen and the track is published.
    Publishing {
        preset: String,
        cursor_disabled: bool,
        border_removed: bool,
    },
    /// The user cancelled the system picker. No capture and no room were
    /// created; the UI must not silently switch to WebView2.
    Cancelled,
    /// The connection dropped and the publisher is retrying.
    Reconnecting,
    /// The capture ended without an error (selected window closed, or stop).
    Ended { reason: String },
    /// The publisher failed. `code` is stable for the UI; the message contains
    /// no token or URL.
    Error { code: String, message: String },
    /// Stop completed.
    Stopped,
}

/// One simulcast sender's cumulative RTP counters. Token-free.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NativeStreamLayerStats {
    pub rid: String,
    pub width: u32,
    pub height: u32,
    pub frames_encoded: u64,
    pub frames_sent: u64,
    pub packets_sent: u64,
    pub bytes_sent: u64,
    pub frames_per_second: f64,
}

/// Token-free counters for the live pipeline: WGC acquisition/storage, frames
/// fed to libwebrtc and the cumulative outbound RTP of every simulcast layer.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NativeStreamStats {
    pub wgc_acquired: u64,
    pub wgc_stored: u64,
    pub fed_frames: u64,
    pub encoded_frames: u64,
    pub sent_frames: u64,
    pub packets_sent: u64,
    pub sent_bytes: u64,
    pub layers: Vec<NativeStreamLayerStats>,
}

/// Shared counters updated by the capture callback, the feeder and the room
/// stats poller. The UI only reads the snapshot; none of it carries a token.
#[derive(Debug, Default)]
pub struct NativeStreamCounters {
    wgc_acquired: AtomicU64,
    wgc_stored: AtomicU64,
    fed_frames: AtomicU64,
    encoded_frames: AtomicU64,
    sent_frames: AtomicU64,
    packets_sent: AtomicU64,
    sent_bytes: AtomicU64,
    layers: Mutex<Vec<NativeStreamLayerStats>>,
}

impl NativeStreamCounters {
    pub fn acquired(&self) {
        self.wgc_acquired.fetch_add(1, Ordering::Relaxed);
    }

    pub fn stored(&self) {
        self.wgc_stored.fetch_add(1, Ordering::Relaxed);
    }

    pub fn fed(&self) {
        self.fed_frames.fetch_add(1, Ordering::Relaxed);
    }

    /// Replaces the sender totals with the latest cumulative RTP sample.
    #[allow(clippy::too_many_arguments)]
    pub fn set_rtp(
        &self,
        layers: Vec<NativeStreamLayerStats>,
        encoded_frames: u64,
        sent_frames: u64,
        packets_sent: u64,
        sent_bytes: u64,
    ) {
        self.encoded_frames.store(encoded_frames, Ordering::Relaxed);
        self.sent_frames.store(sent_frames, Ordering::Relaxed);
        self.packets_sent.store(packets_sent, Ordering::Relaxed);
        self.sent_bytes.store(sent_bytes, Ordering::Relaxed);
        if let Ok(mut current) = self.layers.lock() {
            *current = layers;
        }
    }

    #[must_use]
    pub fn snapshot(&self) -> NativeStreamStats {
        NativeStreamStats {
            wgc_acquired: self.wgc_acquired.load(Ordering::Relaxed),
            wgc_stored: self.wgc_stored.load(Ordering::Relaxed),
            fed_frames: self.fed_frames.load(Ordering::Relaxed),
            encoded_frames: self.encoded_frames.load(Ordering::Relaxed),
            sent_frames: self.sent_frames.load(Ordering::Relaxed),
            packets_sent: self.packets_sent.load(Ordering::Relaxed),
            sent_bytes: self.sent_bytes.load(Ordering::Relaxed),
            layers: self
                .layers
                .lock()
                .map(|value| value.clone())
                .unwrap_or_default(),
        }
    }
}

/// A live native publisher. Dropping it stops the worker.
pub struct NativeStreamHandle {
    commands: tokio::sync::mpsc::UnboundedSender<Command>,
    /// Shared with the worker and the manager. Setting it is synchronous, so a
    /// modal system picker observes a stop even while the command channel is
    /// not polled.
    cancel: Arc<AtomicBool>,
    counters: Arc<NativeStreamCounters>,
}

impl NativeStreamHandle {
    /// Requests a clean stop. The worker closes the capture, unpublishes and
    /// disconnects; the event sink receives `Stopped`.
    pub fn stop(&self) {
        // Set the flag first: the picker and the WinRT operations poll it, and
        // only then give the worker the ordered command.
        self.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = self.commands.send(Command::Stop);
    }

    /// Replaces the token used for a future reconnect. The manager calls this
    /// before the short-lived stream token expires.
    pub fn update_credentials(&self, token: String) {
        let _ = self.commands.send(Command::Token(token));
    }

    #[must_use]
    pub fn stats(&self) -> NativeStreamStats {
        self.counters.snapshot()
    }
}

impl Drop for NativeStreamHandle {
    fn drop(&mut self) {
        // Do not join: the worker may be blocked in the modal OS picker, and
        // the app is exiting. A normal Stop command completes long before.
        self.stop();
    }
}

#[derive(Debug)]
enum Command {
    Stop,
    Token(String),
}

/// Starts the native path on a dedicated thread. Returns immediately; the
/// system picker and the room run on that thread and report through `sink`.
///
/// `cancel` is shared with the caller. Setting it before or during the picker
/// closes the WinRT operation and prevents the capture session from starting;
/// the worker reports `Stopped` instead of publishing.
#[cfg(windows)]
pub fn start(
    config: NativeStreamConfig,
    sink: Arc<dyn Fn(NativeStreamEvent) + Send + Sync>,
    cancel: Arc<AtomicBool>,
) -> Result<NativeStreamHandle, crate::VoiceError> {
    windows_impl::start(config, sink, cancel)
}

/// Reports whether the native path can run here. Cheap and safe to call from a
/// settings/dialog open; no capture or picker is started.
#[must_use]
#[cfg(windows)]
pub fn support() -> NativeStreamSupport {
    windows_impl::support()
}

/// Debug-only source picker/capture probe (no room, no token). Used by the
/// reproducible capture check: the user chooses a window or monitor, the
/// probe reports size, cursor/border state and the number of delivered frames.
#[cfg(all(windows, debug_assertions))]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CaptureProbe {
    pub item_name: String,
    pub width: i32,
    pub height: i32,
    pub cursor_disabled: bool,
    pub border_removed: bool,
    pub frames: u64,
    pub seconds: f64,
}

#[cfg(all(windows, debug_assertions))]
pub fn probe_capture(owner_hwnd: isize, seconds: u64) -> Result<CaptureProbe, crate::VoiceError> {
    windows_impl::probe_capture(owner_hwnd, seconds)
}

#[cfg(not(windows))]
#[must_use]
pub fn support() -> NativeStreamSupport {
    NativeStreamSupport {
        supported: false,
        cursor_capture_available: false,
        border_api_available: false,
        reason: Some("native capture is Windows-only".to_owned()),
    }
}

#[cfg(not(windows))]
pub fn start(
    _config: NativeStreamConfig,
    _sink: Arc<dyn Fn(NativeStreamEvent) + Send + Sync>,
    _cancel: Arc<AtomicBool>,
) -> Result<NativeStreamHandle, crate::VoiceError> {
    Err(crate::VoiceError::Media(
        "native capture is Windows-only".to_owned(),
    ))
}

/// Where a source frame lands inside the fixed preset frame. Both sizes are
/// even because I420 chroma is subsampled by two; the offsets are even too.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FittedFrame {
    width: u32,
    height: u32,
    x: u32,
    y: u32,
}

/// Fits `source_width`x`source_height` into `frame_width`x`frame_height`
/// without changing the source aspect ratio, and centres it. The remaining
/// area is black (letterbox/pillarbox), so a 4:3 window is not stretched to
/// 16:9 and an ultrawide monitor keeps its proportions.
#[cfg(any(windows, test))]
fn fit_preserving_aspect(
    source_width: u32,
    source_height: u32,
    frame_width: u32,
    frame_height: u32,
) -> FittedFrame {
    let source_width = source_width.max(1) as u64;
    let source_height = source_height.max(1) as u64;
    let frame_width = frame_width.max(2);
    let frame_height = frame_height.max(2);
    // Width is the limiting side when frame_w / source_w <= frame_h / source_h.
    let (width, height) =
        if frame_width as u64 * source_height <= frame_height as u64 * source_width {
            let width = frame_width & !1;
            let height = round_even(source_height, width as u64, source_width);
            (width, height.min(frame_height & !1))
        } else {
            let height = frame_height & !1;
            let width = round_even(source_width, height as u64, source_height);
            (width.min(frame_width & !1), height)
        };
    let width = width.max(2);
    let height = height.max(2);
    FittedFrame {
        width,
        height,
        x: ((frame_width - width) / 2) & !1,
        y: ((frame_height - height) / 2) & !1,
    }
}

/// `value * scale / base`, rounded to the nearest even number.
#[cfg(any(windows, test))]
fn round_even(value: u64, scale: u64, base: u64) -> u32 {
    let scaled = (value * scale + base / 2) / base;
    ((scaled & !1).max(2)) as u32
}

#[cfg(any(windows, test))]
fn is_cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(std::sync::atomic::Ordering::SeqCst)
}

#[cfg(windows)]
mod windows_impl {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use livekit::options::{
        DegradationPreference, TrackPublishOptions, VideoCodec, VideoEncoderBackend, VideoEncoding,
        VideoPreset,
    };
    use livekit::prelude::{
        LocalTrack, LocalVideoTrack, Room, RoomEvent, RoomOptions, TrackSource,
    };
    use livekit::webrtc::native::yuv_helper;
    use livekit::webrtc::stats::RtcStats;
    use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
    use livekit::webrtc::video_source::native::NativeVideoSource;
    use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
    use tokio::sync::{mpsc, watch};
    use windows::core::{Interface, HSTRING};
    use windows::Foundation::Metadata::ApiInformation;
    use windows::Foundation::TypedEventHandler;
    use windows::Graphics::Capture::{
        Direct3D11CaptureFramePool, GraphicsCaptureAccess, GraphicsCaptureAccessKind,
        GraphicsCaptureItem, GraphicsCapturePicker, GraphicsCaptureSession,
    };
    use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
    use windows::Graphics::DirectX::DirectXPixelFormat;
    use windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus;
    use windows::Win32::Foundation::{HMODULE, HWND};
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
        D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
        D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::WinRT::Direct3D11::{
        CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
    };
    use windows::Win32::UI::Shell::IInitializeWithWindow;
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
    };
    use windows_future::{AsyncStatus, IAsyncInfo, IAsyncOperation};

    use super::{
        is_cancelled, Command, NativePreset, NativeStreamConfig, NativeStreamEvent,
        NativeStreamHandle,
    };
    use crate::VoiceError;

    struct ComApartment;

    impl ComApartment {
        fn init() -> Result<Self, VoiceError> {
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            if hr.is_err() {
                return Err(VoiceError::Media(
                    "could not initialise the Windows COM apartment".to_owned(),
                ));
            }
            Ok(Self)
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    #[must_use]
    pub fn support() -> super::NativeStreamSupport {
        // The probe runs on a Tauri worker thread; WinRT needs an apartment.
        // If the thread already has a different one, proceed anyway: the
        // static calls still work in an existing MTA/STA.
        let _com = ComApartment::init().ok();
        let wgc = GraphicsCaptureSession::IsSupported().unwrap_or(false);
        let cursor = ApiInformation::IsPropertyPresent(
            &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
            &HSTRING::from("IsCursorCaptureEnabled"),
        )
        .unwrap_or(false);
        let border = ApiInformation::IsTypePresent(&HSTRING::from(
            "Windows.Graphics.Capture.GraphicsCaptureAccess",
        ))
        .unwrap_or(false)
            && ApiInformation::IsPropertyPresent(
                &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
                &HSTRING::from("IsBorderRequired"),
            )
            .unwrap_or(false);
        let d3d = create_d3d_device().is_ok();
        let reason = if !wgc {
            Some("Windows.Graphics.Capture is not available on this system".to_owned())
        } else if !cursor {
            Some(
                "Windows 10 2004 (build 19041) or newer is required to keep the system cursor \
                 out of the frame"
                    .to_owned(),
            )
        } else if !d3d {
            Some("a D3D11 device is required for native capture".to_owned())
        } else {
            None
        };
        super::NativeStreamSupport {
            supported: reason.is_none(),
            cursor_capture_available: cursor,
            border_api_available: border,
            reason,
        }
    }

    pub fn start(
        config: NativeStreamConfig,
        sink: Arc<dyn Fn(NativeStreamEvent) + Send + Sync>,
        cancel: Arc<AtomicBool>,
    ) -> Result<NativeStreamHandle, VoiceError> {
        let support = support();
        if !support.supported {
            return Err(VoiceError::Media(
                support
                    .reason
                    .unwrap_or_else(|| "native capture is unavailable".to_owned()),
            ));
        }
        let (commands, command_rx) = mpsc::unbounded_channel();
        let worker_cancel = cancel.clone();
        let counters = Arc::new(super::NativeStreamCounters::default());
        let worker_counters = counters.clone();
        let _thread = std::thread::Builder::new()
            .name("rostalk-native-capture".to_owned())
            .spawn(move || worker(config, command_rx, sink, worker_cancel, worker_counters))
            .map_err(|error| {
                VoiceError::Media(format!("could not start native capture: {error}"))
            })?;
        Ok(NativeStreamHandle {
            commands,
            cancel,
            counters,
        })
    }

    /// Debug-only picker/capture probe: no room and no token.
    #[cfg(debug_assertions)]
    pub fn probe_capture(
        owner_hwnd: isize,
        seconds: u64,
    ) -> Result<super::CaptureProbe, VoiceError> {
        let _com = ComApartment::init()?;
        let sink: Arc<dyn Fn(NativeStreamEvent) + Send + Sync> = Arc::new(|_| {});
        let cancel = AtomicBool::new(false);
        let item = match pick_item(owner_hwnd, &sink, &cancel) {
            PickResult::Item(item) => item,
            PickResult::UserCancelled | PickResult::Stopped => {
                return Err(VoiceError::Media(
                    "the source picker was cancelled".to_owned(),
                ));
            }
            PickResult::Failed => {
                return Err(VoiceError::Media("the source picker failed".to_owned()));
            }
        };
        let (device, context) = create_d3d_device().map_err(VoiceError::Media)?;
        let counters = Arc::new(super::NativeStreamCounters::default());
        let capture = start_capture(&item, &device, &context, &cancel, counters)
            .map_err(VoiceError::Media)?;
        let size = item
            .Size()
            .map_err(|error| VoiceError::Media(error.to_string()))?;
        let name = item
            .DisplayName()
            .map(|value| value.to_string())
            .unwrap_or_default();
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(seconds) {
            if capture.closed.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(super::CaptureProbe {
            item_name: name,
            width: size.Width,
            height: size.Height,
            cursor_disabled: capture.cursor_disabled,
            border_removed: capture.border_removed,
            frames: capture.frames.load(Ordering::Relaxed),
            seconds: started.elapsed().as_secs_f64(),
        })
    }

    /// The capture object and its CPU frame slot. Kept on the worker thread.
    struct Capture {
        session: GraphicsCaptureSession,
        pool: Direct3D11CaptureFramePool,
        _item: GraphicsCaptureItem,
        latest: Arc<Mutex<Option<CpuFrame>>>,
        #[allow(dead_code)]
        frames: Arc<AtomicU64>,
        counters: Arc<super::NativeStreamCounters>,
        cursor_disabled: bool,
        border_removed: bool,
        closed: Arc<AtomicBool>,
    }

    impl Drop for Capture {
        fn drop(&mut self) {
            let _ = self.session.Close();
            let _ = self.pool.Close();
        }
    }

    struct CpuFrame {
        width: u32,
        height: u32,
        bgra: Vec<u8>,
    }

    fn worker(
        config: NativeStreamConfig,
        mut commands: mpsc::UnboundedReceiver<Command>,
        sink: Arc<dyn Fn(NativeStreamEvent) + Send + Sync>,
        cancel: Arc<AtomicBool>,
        counters: Arc<super::NativeStreamCounters>,
    ) {
        let _com = match ComApartment::init() {
            Ok(com) => com,
            Err(error) => {
                sink(NativeStreamEvent::Error {
                    code: "com".to_owned(),
                    message: error.user_message(),
                });
                return;
            }
        };
        if is_cancelled(&cancel) {
            sink(NativeStreamEvent::Stopped);
            return;
        }
        let item = match pick_item(config.owner_hwnd, &sink, &cancel) {
            PickResult::Item(item) => item,
            PickResult::UserCancelled => {
                sink(NativeStreamEvent::Cancelled);
                return;
            }
            PickResult::Stopped => {
                sink(NativeStreamEvent::Stopped);
                return;
            }
            PickResult::Failed => return,
        };
        // A stop can arrive after the picker returned an item but before the
        // capture session exists. Check right before every step that could
        // create one, so a queued Stop never lets capture start afterwards.
        if is_cancelled(&cancel) {
            sink(NativeStreamEvent::Stopped);
            return;
        }
        let (device, context) = match create_d3d_device() {
            Ok(pair) => pair,
            Err(error) => {
                sink(NativeStreamEvent::Error {
                    code: "d3d11".to_owned(),
                    message: error,
                });
                return;
            }
        };
        if is_cancelled(&cancel) {
            sink(NativeStreamEvent::Stopped);
            return;
        }
        let capture = match start_capture(&item, &device, &context, &cancel, counters) {
            Ok(capture) => capture,
            Err(error) => {
                if is_cancelled(&cancel) {
                    sink(NativeStreamEvent::Stopped);
                } else {
                    sink(NativeStreamEvent::Error {
                        code: "capture".to_owned(),
                        message: error,
                    });
                }
                return;
            }
        };
        if is_cancelled(&cancel) {
            drop(capture);
            sink(NativeStreamEvent::Stopped);
            return;
        }

        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                sink(NativeStreamEvent::Error {
                    code: "runtime".to_owned(),
                    message: format!("could not start the media runtime: {error}"),
                });
                return;
            }
        };
        runtime.block_on(supervise(config, capture, &mut commands, sink, cancel));
    }

    async fn supervise(
        config: NativeStreamConfig,
        capture: Capture,
        commands: &mut mpsc::UnboundedReceiver<Command>,
        sink: Arc<dyn Fn(NativeStreamEvent) + Send + Sync>,
        cancel: Arc<AtomicBool>,
    ) {
        let (token_tx, token_rx) = watch::channel(config.token.clone());
        let (stop_tx, stop_rx) = watch::channel(false);
        let (source_tx, source_rx) = watch::channel(None::<NativeVideoSource>);
        let failed = Arc::new(AtomicBool::new(false));

        // The picker can stay open longer than one 60-second token. Token
        // updates queued while it was open must be used before the first
        // connect, and a Stop must not publish.
        let mut stop_before_start = is_cancelled(&cancel);
        while let Ok(command) = commands.try_recv() {
            match command {
                Command::Token(token) => {
                    let _ = token_tx.send(token);
                }
                Command::Stop => stop_before_start = true,
            }
        }
        if stop_before_start || is_cancelled(&cancel) {
            drop(capture);
            sink(NativeStreamEvent::Stopped);
            return;
        }

        let feeder = tokio::spawn(feed(
            capture.latest.clone(),
            source_rx,
            stop_rx.clone(),
            config.preset,
            capture.counters.clone(),
        ));
        let publisher = tokio::spawn(publish(
            config.gateway.clone(),
            config.fingerprint.clone(),
            config.preset,
            capture.cursor_disabled,
            capture.border_removed,
            token_rx,
            stop_rx.clone(),
            source_tx,
            failed.clone(),
            sink.clone(),
            capture.counters.clone(),
        ));

        let mut ended = None;
        loop {
            tokio::select! {
                command = commands.recv() => {
                    match command {
                        Some(Command::Stop) | None => break,
                        Some(Command::Token(token)) => {
                            let _ = token_tx.send(token);
                        }
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(200)) => {
                    if is_cancelled(&cancel) {
                        break;
                    }
                    if capture.closed.load(Ordering::Relaxed) {
                        ended = Some("sourceClosed".to_owned());
                        break;
                    }
                    if failed.load(Ordering::Relaxed) {
                        break;
                    }
                }
            }
        }
        let _ = stop_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(3), feeder).await;
        let _ = tokio::time::timeout(Duration::from_secs(3), publisher).await;
        drop(capture);
        if failed.load(Ordering::Relaxed) {
            return;
        }
        match ended {
            Some(reason) => sink(NativeStreamEvent::Ended { reason }),
            None => sink(NativeStreamEvent::Stopped),
        }
    }

    /// WGC only calls `FrameArrived` when the captured surface changes. A
    /// static window therefore yields one frame and then silence; re-feeding
    /// the last frame at this rate keeps the track (and the viewer's last
    /// picture) alive without paying for 30 identical frames per second.
    const STATIC_FRAME_KEEPALIVE: Duration = Duration::from_secs(1);

    /// Picks the frame for one paced tick: a freshly captured frame wins;
    /// otherwise the last frame is reused once per keepalive interval.
    fn take_feed_frame(
        latest: &Mutex<Option<CpuFrame>>,
        last: &mut Option<(u32, u32, Arc<Vec<u8>>)>,
        last_fed: &mut Instant,
        now: Instant,
    ) -> Option<(u32, u32, Arc<Vec<u8>>)> {
        if let Some(frame) = latest.lock().ok().and_then(|mut slot| slot.take()) {
            let bgra = Arc::new(frame.bgra);
            *last = Some((frame.width, frame.height, bgra.clone()));
            *last_fed = now;
            return Some((frame.width, frame.height, bgra));
        }
        let (width, height, bgra) = last.as_ref()?;
        if now.duration_since(*last_fed) < STATIC_FRAME_KEEPALIVE {
            return None;
        }
        *last_fed = now;
        Some((*width, *height, bgra.clone()))
    }

    async fn feed(
        latest: Arc<Mutex<Option<CpuFrame>>>,
        source_rx: watch::Receiver<Option<NativeVideoSource>>,
        mut stop_rx: watch::Receiver<bool>,
        preset: NativePreset,
        counters: Arc<super::NativeStreamCounters>,
    ) {
        let spec = preset.spec();
        let mut interval =
            tokio::time::interval(Duration::from_micros(1_000_000 / u64::from(spec.fps)));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let started = Instant::now();
        let mut last: Option<(u32, u32, Arc<Vec<u8>>)> = None;
        let mut last_fed = started;
        loop {
            tokio::select! {
                _ = interval.tick() => {}
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        return;
                    }
                    continue;
                }
            }
            if *stop_rx.borrow() {
                return;
            }
            let Some(source) = source_rx.borrow().clone() else {
                continue;
            };
            let Some((width, height, bgra)) =
                take_feed_frame(&latest, &mut last, &mut last_fed, Instant::now())
            else {
                continue;
            };
            let mut i420 = I420Buffer::new(width, height);
            let (stride_y, stride_u, stride_v) = i420.strides();
            {
                let (y, u, v) = i420.data_mut();
                yuv_helper::argb_to_i420(
                    bgra.as_slice(),
                    width * 4,
                    y,
                    stride_y,
                    u,
                    stride_u,
                    v,
                    stride_v,
                    width as i32,
                    height as i32,
                );
            }
            // The source keeps its proportions: 4:3, ultrawide and 4K are
            // fitted into the preset frame and letterboxed, never stretched to
            // 16:9. The published track keeps the preset size, so the P14
            // simulcast layers stay valid.
            let buffer = fit_frame(i420, width, height, spec.width, spec.height);
            let frame = VideoFrame {
                rotation: VideoRotation::VideoRotation0,
                timestamp_us: started.elapsed().as_micros() as i64,
                frame_metadata: None,
                buffer,
            };
            let _ = source.capture_frame(&frame);
            counters.fed();
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn publish(
        gateway: String,
        fingerprint: String,
        preset: NativePreset,
        cursor_disabled: bool,
        border_removed: bool,
        mut token_rx: watch::Receiver<String>,
        mut stop_rx: watch::Receiver<bool>,
        source_tx: watch::Sender<Option<NativeVideoSource>>,
        failed: Arc<AtomicBool>,
        sink: Arc<dyn Fn(NativeStreamEvent) + Send + Sync>,
        counters: Arc<super::NativeStreamCounters>,
    ) {
        let proxy = match crate::signalling::SignallingProxy::start(&gateway, &fingerprint).await {
            Ok(proxy) => proxy,
            Err(error) => {
                failed.store(true, Ordering::Relaxed);
                sink(NativeStreamEvent::Error {
                    code: "signalling".to_owned(),
                    message: error.user_message(),
                });
                return;
            }
        };
        let spec = preset.spec();
        let mut backoff = Duration::from_secs(1);
        let mut first = true;
        loop {
            if *stop_rx.borrow() {
                return;
            }
            let token = token_rx.borrow().clone();
            let mut options = RoomOptions::default();
            options.auto_subscribe = false;
            let attempt = tokio::time::timeout(
                Duration::from_secs(15),
                Room::connect(proxy.local_url(), &token, options),
            )
            .await;
            let (room, mut events) = match attempt {
                Ok(Ok(pair)) => pair,
                Ok(Err(_)) => {
                    // The error text can carry connection details; keep the
                    // log token-free.
                    log::warn!("native stream connect failed");
                    if first {
                        failed.store(true, Ordering::Relaxed);
                        sink(NativeStreamEvent::Error {
                            code: "signalling".to_owned(),
                            message: "could not join the stream room".to_owned(),
                        });
                        return;
                    }
                    if !wait_backoff(&mut stop_rx, backoff).await {
                        return;
                    }
                    backoff = (backoff * 2).min(Duration::from_secs(15));
                    continue;
                }
                Err(_) => {
                    if first {
                        failed.store(true, Ordering::Relaxed);
                        sink(NativeStreamEvent::Error {
                            code: "signalling".to_owned(),
                            message: "the stream room did not answer in time".to_owned(),
                        });
                        return;
                    }
                    if !wait_backoff(&mut stop_rx, backoff).await {
                        return;
                    }
                    backoff = (backoff * 2).min(Duration::from_secs(15));
                    continue;
                }
            };
            let source = NativeVideoSource::new(
                VideoResolution {
                    width: spec.width,
                    height: spec.height,
                },
                true,
            );
            let track = LocalVideoTrack::create_video_track(
                "screen",
                RtcVideoSource::Native(source.clone()),
            );
            let publish_options = TrackPublishOptions {
                video_encoding: Some(VideoEncoding {
                    max_bitrate: spec.bitrate,
                    max_framerate: f64::from(spec.fps),
                }),
                video_codec: VideoCodec::VP8,
                simulcast: true,
                simulcast_layers: Some(
                    spec.layers
                        .iter()
                        .map(|(width, height, bitrate)| VideoPreset {
                            width: *width,
                            height: *height,
                            encoding: VideoEncoding {
                                max_bitrate: *bitrate,
                                max_framerate: f64::from(spec.fps),
                            },
                        })
                        .collect(),
                ),
                source: TrackSource::Screenshare,
                video_encoder: VideoEncoderBackend::Software,
                degradation_preference: Some(DegradationPreference::MaintainResolution),
                ..Default::default()
            };
            if let Err(_error) = room
                .local_participant()
                .publish_track(LocalTrack::Video(track), publish_options)
                .await
            {
                log::warn!("native stream publish failed");
                let _ = room.close().await;
                if first {
                    failed.store(true, Ordering::Relaxed);
                    sink(NativeStreamEvent::Error {
                        code: "publish".to_owned(),
                        message: "the server rejected the screen-share track".to_owned(),
                    });
                    return;
                }
                if !wait_backoff(&mut stop_rx, backoff).await {
                    return;
                }
                backoff = (backoff * 2).min(Duration::from_secs(15));
                continue;
            }
            first = false;
            backoff = Duration::from_secs(1);
            let _ = source_tx.send(Some(source));
            sink(NativeStreamEvent::Publishing {
                preset: preset.as_str().to_owned(),
                cursor_disabled,
                border_removed,
            });
            // The room is up; this arm only ends on a real disconnect or stop.
            let mut lost = false;
            let mut stats_interval = tokio::time::interval(Duration::from_secs(1));
            loop {
                tokio::select! {
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() {
                            break;
                        }
                    }
                    event = events.recv() => {
                        match event {
                            Some(RoomEvent::Disconnected { .. }) | None => {
                                lost = true;
                                break;
                            }
                            _ => {}
                        }
                    }
                    _ = token_rx.changed() => {
                        // Keep the connection; the new token is used on the
                        // next reconnect.
                    }
                    _ = stats_interval.tick() => {
                        if let Ok(stats) = room.get_stats().await {
                            update_sender_stats(&counters, &stats.publisher_stats);
                        }
                    }
                }
            }
            let _ = source_tx.send(None);
            let _ = tokio::time::timeout(Duration::from_secs(2), room.close()).await;
            if *stop_rx.borrow() {
                return;
            }
            if lost {
                sink(NativeStreamEvent::Reconnecting);
                if !wait_backoff(&mut stop_rx, backoff).await {
                    return;
                }
                backoff = (backoff * 2).min(Duration::from_secs(15));
            }
        }
    }

    async fn wait_backoff(stop: &mut watch::Receiver<bool>, delay: Duration) -> bool {
        tokio::select! {
            _ = tokio::time::sleep(delay) => true,
            _ = stop.changed() => !*stop.borrow(),
        }
    }

    /// Turns the cumulative outbound RTP entries into the token-free counters.
    /// The native room publishes one video track, so every video outbound entry
    /// is a simulcast layer of that track.
    fn update_sender_stats(counters: &super::NativeStreamCounters, stats: &[RtcStats]) {
        let mut layers = Vec::new();
        let mut encoded = 0u64;
        let mut sent = 0u64;
        let mut packets = 0u64;
        let mut bytes = 0u64;
        for item in stats {
            let RtcStats::OutboundRtp(out) = item else {
                continue;
            };
            if out.stream.kind != "video" {
                continue;
            }
            layers.push(super::NativeStreamLayerStats {
                rid: out.outbound.rid.clone(),
                width: out.outbound.frame_width,
                height: out.outbound.frame_height,
                frames_encoded: u64::from(out.outbound.frames_encoded),
                frames_sent: u64::from(out.outbound.frames_sent),
                packets_sent: out.sent.packets_sent,
                bytes_sent: out.sent.bytes_sent,
                frames_per_second: out.outbound.frames_per_second,
            });
            encoded += u64::from(out.outbound.frames_encoded);
            sent += u64::from(out.outbound.frames_sent);
            packets += out.sent.packets_sent;
            bytes += out.sent.bytes_sent;
        }
        layers.sort_by_key(|layer| (layer.width, layer.height));
        counters.set_rtp(layers, encoded, sent, packets, bytes);
    }

    /// Fits the capture frame into the preset frame while keeping the source
    /// aspect ratio. Black bars fill the rest; the track size and the simulcast
    /// layers do not change.
    fn fit_frame(
        mut source: I420Buffer,
        source_width: u32,
        source_height: u32,
        frame_width: u32,
        frame_height: u32,
    ) -> I420Buffer {
        let fit =
            super::fit_preserving_aspect(source_width, source_height, frame_width, frame_height);
        let scaled = if (fit.width, fit.height) == (source_width, source_height) {
            source
        } else {
            source.scale(fit.width as i32, fit.height as i32)
        };
        if (fit.width, fit.height) == (frame_width, frame_height) {
            return scaled;
        }
        let mut canvas = I420Buffer::new_black(frame_width, frame_height);
        blit(&scaled, &mut canvas, fit.width, fit.height, fit.x, fit.y);
        canvas
    }

    fn blit(
        source: &I420Buffer,
        destination: &mut I420Buffer,
        width: u32,
        height: u32,
        x: u32,
        y: u32,
    ) {
        let (stride_y, stride_u, stride_v) = source.strides();
        let (dst_stride_y, dst_stride_u, dst_stride_v) = destination.strides();
        let (source_y, source_u, source_v) = source.data();
        let (destination_y, destination_u, destination_v) = destination.data_mut();
        copy_plane(
            source_y,
            stride_y,
            destination_y,
            dst_stride_y,
            width,
            height,
            x,
            y,
        );
        let chroma_width = width / 2;
        let chroma_height = height / 2;
        copy_plane(
            source_u,
            stride_u,
            destination_u,
            dst_stride_u,
            chroma_width,
            chroma_height,
            x / 2,
            y / 2,
        );
        copy_plane(
            source_v,
            stride_v,
            destination_v,
            dst_stride_v,
            chroma_width,
            chroma_height,
            x / 2,
            y / 2,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn copy_plane(
        source: &[u8],
        source_stride: u32,
        destination: &mut [u8],
        destination_stride: u32,
        width: u32,
        height: u32,
        x: u32,
        y: u32,
    ) {
        let width = width as usize;
        let source_stride = source_stride as usize;
        let destination_stride = destination_stride as usize;
        let x = x as usize;
        let y = y as usize;
        for row in 0..height as usize {
            let source_start = row * source_stride;
            let destination_start = (y + row) * destination_stride + x;
            if source_start + width <= source.len()
                && destination_start + width <= destination.len()
            {
                destination[destination_start..destination_start + width]
                    .copy_from_slice(&source[source_start..source_start + width]);
            }
        }
    }

    /// Result of the modal picker. A stop is distinct from the user cancelling
    /// the picker: the first is our own `Stopped`, the second `Cancelled`.
    enum PickResult {
        Item(GraphicsCaptureItem),
        UserCancelled,
        Stopped,
        Failed,
    }

    fn pick_item(
        owner: isize,
        sink: &Arc<dyn Fn(NativeStreamEvent) + Send + Sync>,
        cancel: &AtomicBool,
    ) -> PickResult {
        if super::is_cancelled(cancel) {
            return PickResult::Stopped;
        }
        sink(NativeStreamEvent::Picking);
        let picker = match GraphicsCapturePicker::new() {
            Ok(picker) => picker,
            Err(error) => {
                sink(NativeStreamEvent::Error {
                    code: "picker".to_owned(),
                    message: format!("could not open the system picker: {error}"),
                });
                return PickResult::Failed;
            }
        };
        if owner != 0 {
            let init: Result<IInitializeWithWindow, _> = picker.cast();
            match init {
                Ok(init) => {
                    if let Err(error) = unsafe { init.Initialize(HWND(owner as *mut _)) } {
                        sink(NativeStreamEvent::Error {
                            code: "picker".to_owned(),
                            message: format!("could not attach the picker to the window: {error}"),
                        });
                        return PickResult::Failed;
                    }
                }
                Err(error) => {
                    sink(NativeStreamEvent::Error {
                        code: "picker".to_owned(),
                        message: format!("the system picker is unavailable: {error}"),
                    });
                    return PickResult::Failed;
                }
            }
        }
        let operation = match picker.PickSingleItemAsync() {
            Ok(operation) => operation,
            Err(error) => {
                sink(NativeStreamEvent::Error {
                    code: "picker".to_owned(),
                    message: format!("could not open the system picker: {error}"),
                });
                return PickResult::Failed;
            }
        };
        match pump_until_done(&operation, Some(cancel)) {
            PumpOutcome::Done(item) => {
                if super::is_cancelled(cancel) {
                    // The user chose a source, but a stop landed in the same
                    // instant. The item is dropped without creating a capture.
                    PickResult::Stopped
                } else {
                    PickResult::Item(item)
                }
            }
            PumpOutcome::Cancelled => PickResult::Stopped,
            PumpOutcome::Failed(error) => {
                if super::is_cancelled(cancel) {
                    PickResult::Stopped
                } else {
                    eprintln!("system picker returned no item: {error}");
                    PickResult::UserCancelled
                }
            }
        }
    }

    enum PumpOutcome<T> {
        Done(T),
        Cancelled,
        Failed(String),
    }

    fn pump_until_done<T: windows::core::RuntimeType + 'static>(
        operation: &IAsyncOperation<T>,
        cancel: Option<&AtomicBool>,
    ) -> PumpOutcome<T> {
        let info: IAsyncInfo = match operation.cast() {
            Ok(info) => info,
            Err(error) => return PumpOutcome::Failed(error.to_string()),
        };
        loop {
            let status = match info.Status() {
                Ok(status) => status,
                Err(error) => return PumpOutcome::Failed(error.to_string()),
            };
            if status != AsyncStatus::Started {
                break;
            }
            if cancel.is_some_and(super::is_cancelled) {
                // Documented cancellation of the WinRT operation. Wait until it
                // leaves `Started`, so a late picker result cannot be observed
                // after the stop.
                let _ = info.Cancel();
                let deadline = Instant::now() + Duration::from_millis(500);
                while Instant::now() < deadline {
                    match info.Status() {
                        Ok(AsyncStatus::Started) => {}
                        _ => break,
                    }
                    pump_messages();
                    std::thread::sleep(Duration::from_millis(5));
                }
                return PumpOutcome::Cancelled;
            }
            pump_messages();
            std::thread::sleep(Duration::from_millis(5));
        }
        match operation.GetResults() {
            Ok(value) => PumpOutcome::Done(value),
            Err(error) => {
                if cancel.is_some_and(super::is_cancelled) {
                    PumpOutcome::Cancelled
                } else {
                    PumpOutcome::Failed(error.to_string())
                }
            }
        }
    }

    fn pump_messages() {
        unsafe {
            let mut message = MSG::default();
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }

    fn create_d3d_device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
        let mut device = None;
        let mut context = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(|error| format!("D3D11CreateDevice failed: {error}"))?;
        }
        Ok((
            device.ok_or_else(|| "no D3D11 device".to_owned())?,
            context.ok_or_else(|| "no D3D11 context".to_owned())?,
        ))
    }

    fn start_capture(
        item: &GraphicsCaptureItem,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        cancel: &AtomicBool,
        counters: Arc<super::NativeStreamCounters>,
    ) -> Result<Capture, String> {
        let dxgi: IDXGIDevice = device.cast().map_err(|error| error.to_string())?;
        let winrt_device: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
            .map_err(|error| error.to_string())?
            .cast()
            .map_err(|error| error.to_string())?;
        let size = item.Size().map_err(|error| error.to_string())?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &winrt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        )
        .map_err(|error| error.to_string())?;
        let session = pool
            .CreateCaptureSession(item)
            .map_err(|error| error.to_string())?;

        let mut cursor_disabled = false;
        if session.SetIsCursorCaptureEnabled(false).is_ok() {
            cursor_disabled = session
                .IsCursorCaptureEnabled()
                .map(|enabled| !enabled)
                .unwrap_or(false);
        }
        if !cursor_disabled {
            // The whole point of this path is the system cursor staying out of
            // the frame. Never publish a cursor-visible track on a build where
            // the documented property did not take effect.
            let _ = session.Close();
            let _ = pool.Close();
            return Err("the system cursor could not be hidden".to_owned());
        }
        let mut border_removed = false;
        if ApiInformation::IsTypePresent(&HSTRING::from(
            "Windows.Graphics.Capture.GraphicsCaptureAccess",
        ))
        .unwrap_or(false)
        {
            if let Ok(operation) =
                GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless)
            {
                match pump_until_done(&operation, Some(cancel)) {
                    PumpOutcome::Done(status) => {
                        if status == AppCapabilityAccessStatus::Allowed
                            && session.SetIsBorderRequired(false).is_ok()
                        {
                            border_removed = !session.IsBorderRequired().unwrap_or(true);
                        }
                    }
                    PumpOutcome::Cancelled => return Err("cancelled".to_owned()),
                    PumpOutcome::Failed(_) => {}
                }
            }
        }

        let latest: Arc<Mutex<Option<CpuFrame>>> = Arc::new(Mutex::new(None));
        let frames = Arc::new(AtomicU64::new(0));
        let staging: Arc<Mutex<Option<(ID3D11Texture2D, u32, u32)>>> = Arc::new(Mutex::new(None));
        let pool_size = Arc::new(Mutex::new((size.Width, size.Height)));
        {
            let latest = latest.clone();
            let frames = frames.clone();
            let staging = staging.clone();
            let pool_size = pool_size.clone();
            let device = device.clone();
            let context = context.clone();
            let frame_counters = counters.clone();
            let winrt_device = windows::core::AgileReference::new(&winrt_device)
                .map_err(|error| error.to_string())?;
            pool.FrameArrived(&TypedEventHandler::<
                Direct3D11CaptureFramePool,
                windows::core::IInspectable,
            >::new(move |sender, _| {
                let pool = sender.ok()?;
                let frame = match pool.TryGetNextFrame() {
                    Ok(frame) => frame,
                    Err(_) => return Ok(()),
                };
                frame_counters.acquired();
                // A captured window can be resized while the stream is running.
                // The frame pool must be recreated for the new content size,
                // otherwise WGC keeps delivering the old geometry. Drop this
                // frame and continue with the next one at the new size.
                let content = match frame.ContentSize() {
                    Ok(content) => content,
                    Err(_) => {
                        let _ = frame.Close();
                        return Ok(());
                    }
                };
                let resized = match pool_size.lock() {
                    Ok(current) => current.0 != content.Width || current.1 != content.Height,
                    Err(_) => false,
                };
                if resized && content.Width > 0 && content.Height > 0 {
                    let _ = frame.Close();
                    if let Ok(device) = winrt_device.resolve() {
                        if pool
                            .Recreate(
                                &device,
                                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                                2,
                                content,
                            )
                            .is_ok()
                        {
                            if let Ok(mut current) = pool_size.lock() {
                                *current = (content.Width, content.Height);
                            }
                        }
                    }
                    return Ok(());
                }
                let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
                let texture: ID3D11Texture2D = unsafe { access.GetInterface()? };
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                unsafe { texture.GetDesc(&mut desc) };
                let (width, height) = (desc.Width, desc.Height);
                let mut st = staging.lock().map_err(|_| windows::core::Error::empty())?;
                let need_new = match st.as_ref() {
                    Some((_, w, h)) => *w != width || *h != height,
                    None => true,
                };
                if need_new {
                    let sdesc = D3D11_TEXTURE2D_DESC {
                        Usage: D3D11_USAGE_STAGING,
                        BindFlags: 0,
                        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                        MiscFlags: 0,
                        ..desc
                    };
                    let mut texture = None;
                    unsafe { device.CreateTexture2D(&sdesc, None, Some(&mut texture))? };
                    *st = texture.map(|texture| (texture, width, height));
                }
                let Some((staging_texture, _, _)) = st.as_ref() else {
                    return Ok(());
                };
                unsafe { context.CopyResource(staging_texture, &texture) };
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                unsafe { context.Map(staging_texture, 0, D3D11_MAP_READ, 0, Some(&mut mapped))? };
                let row = (width * 4) as usize;
                let mut buffer = vec![0u8; row * height as usize];
                unsafe {
                    let source = mapped.pData as *const u8;
                    for y in 0..height as usize {
                        std::ptr::copy_nonoverlapping(
                            source.add(y * mapped.RowPitch as usize),
                            buffer.as_mut_ptr().add(y * row),
                            row,
                        );
                    }
                    context.Unmap(staging_texture, 0);
                }
                drop(st);
                let _ = frame.Close();
                if let Ok(mut latest) = latest.lock() {
                    *latest = Some(CpuFrame {
                        width,
                        height,
                        bgra: buffer,
                    });
                }
                frame_counters.stored();
                frames.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }))
            .map_err(|error| error.to_string())?;
        }

        let closed = Arc::new(AtomicBool::new(false));
        {
            let closed = closed.clone();
            item.Closed(&TypedEventHandler::<
                GraphicsCaptureItem,
                windows::core::IInspectable,
            >::new(move |_, _| {
                closed.store(true, Ordering::Relaxed);
                Ok(())
            }))
            .map_err(|error| error.to_string())?;
        }

        if super::is_cancelled(cancel) {
            return Err("cancelled".to_owned());
        }
        session.StartCapture().map_err(|error| error.to_string())?;
        Ok(Capture {
            session,
            pool,
            _item: item.clone(),
            latest,
            frames,
            counters,
            cursor_disabled,
            border_removed,
            closed,
        })
    }

    #[cfg(test)]
    mod feed_tests {
        use super::*;

        fn frame(width: u32, height: u32, value: u8) -> CpuFrame {
            CpuFrame {
                width,
                height,
                bgra: vec![value; (width * height * 4) as usize],
            }
        }

        #[test]
        fn a_static_source_is_reused_once_per_keepalive() {
            let latest = Mutex::new(Some(frame(2, 1, 7)));
            let mut last = None;
            let mut last_fed = Instant::now();
            let start = last_fed;

            let fresh = take_feed_frame(&latest, &mut last, &mut last_fed, start)
                .expect("the first frame is fed");
            assert_eq!((fresh.0, fresh.1), (2, 1));
            assert!(fresh.2.iter().all(|byte| *byte == 7));

            // No new WGC frame, and the keepalive is not due yet.
            assert!(take_feed_frame(
                &latest,
                &mut last,
                &mut last_fed,
                start + Duration::from_millis(500),
            )
            .is_none());

            // One second after the last fed frame the cached frame is reused.
            let reused = take_feed_frame(
                &latest,
                &mut last,
                &mut last_fed,
                start + STATIC_FRAME_KEEPALIVE,
            )
            .expect("the static frame is reused");
            assert_eq!((reused.0, reused.1), (2, 1));
            assert!(reused.2.iter().all(|byte| *byte == 7));

            // A fresh capture wins immediately and resets the timer.
            *latest.lock().unwrap() = Some(frame(2, 1, 9));
            let fresh = take_feed_frame(
                &latest,
                &mut last,
                &mut last_fed,
                start + STATIC_FRAME_KEEPALIVE + Duration::from_millis(1),
            )
            .expect("the fresh frame is fed");
            assert!(fresh.2.iter().all(|byte| *byte == 9));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_presets_keep_the_adr_0031_layers() {
        let hd = NativePreset::P720.spec();
        assert_eq!((hd.width, hd.height, hd.fps), (1280, 720, 30));
        assert_eq!(hd.layers, vec![(320, 180, 150_000)]);
        assert_eq!(hd.bitrate, 2_500_000);

        let full = NativePreset::P1080.spec();
        assert_eq!((full.width, full.height, full.fps), (1920, 1080, 30));
        assert_eq!(
            full.layers,
            vec![(640, 360, 450_000), (1280, 720, 1_700_000)]
        );
        assert_eq!(full.bitrate, 6_000_000);
    }

    #[test]
    fn heavy_webview_presets_are_not_silently_accepted() {
        assert_eq!(NativePreset::parse("720p30"), Some(NativePreset::P720));
        assert_eq!(NativePreset::parse("1080p30"), Some(NativePreset::P1080));
        assert_eq!(NativePreset::parse("1080p60"), None);
        assert_eq!(NativePreset::parse("source"), None);
    }

    #[test]
    fn support_probe_is_safe_to_call_here() {
        let support = support();
        eprintln!("native capture support: {support:?}");
        if support.supported {
            assert!(support.cursor_capture_available);
        }
    }

    #[test]
    fn fitting_preserves_the_source_aspect_ratio() {
        // 4:3 window inside 1080p: pillarbox, not a 16:9 stretch.
        assert_eq!(
            fit_preserving_aspect(1024, 768, 1920, 1080),
            FittedFrame {
                width: 1440,
                height: 1080,
                x: 240,
                y: 0,
            }
        );
        // 21:9 monitor: letterbox top and bottom.
        assert_eq!(
            fit_preserving_aspect(3440, 1440, 1920, 1080),
            FittedFrame {
                width: 1920,
                height: 804,
                x: 0,
                y: 138,
            }
        );
        // 4K 16:9 fills the 1080p frame exactly.
        assert_eq!(
            fit_preserving_aspect(3840, 2160, 1920, 1080),
            FittedFrame {
                width: 1920,
                height: 1080,
                x: 0,
                y: 0,
            }
        );
        // 4:3 window inside 720p.
        assert_eq!(
            fit_preserving_aspect(800, 600, 1280, 720),
            FittedFrame {
                width: 960,
                height: 720,
                x: 160,
                y: 0,
            }
        );
        // Portrait source: the frame is not rotated or stretched.
        assert_eq!(
            fit_preserving_aspect(720, 1280, 1920, 1080),
            FittedFrame {
                width: 608,
                height: 1080,
                x: 656,
                y: 0,
            }
        );
        assert_eq!(
            fit_preserving_aspect(1280, 720, 1280, 720),
            FittedFrame {
                width: 1280,
                height: 720,
                x: 0,
                y: 0,
            }
        );
    }
}
