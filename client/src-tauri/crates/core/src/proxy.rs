//! Loopback HTTP proxy for the chat endpoints (stage 4.1, design 4.3).
//!
//! The WebView cannot accept the server's pinned self-signed certificate, and
//! it must never hold the control-plane session token. This proxy listens on
//! `127.0.0.1:<random port>`, requires a random per-process token on every
//! request and forwards history, uploads and attachment reads over a TLS
//! connection pinned to the leaf fingerprint from the active invite link.
//!
//! Chat, avatar and New Year event routes are explicitly allowlisted. There is no
//! generic forwarder, so a page script cannot turn the proxy into an open
//! client for the server. The token and the session token are never logged.
//! Another user's avatar can only be read: the former cross-user reset route
//! is gone on both the server and the proxy (stage P27).
//!
//! Attachment reads are the one route a page may call with the token in the
//! query string: an `<img src>` or a `<video src>` cannot set a header. Because
//! such a URL ends up in the DOM and in `location.search`, responses keep a
//! script-blocking CSP. Otherwise an uploaded `.html` file would run in a
//! loopback origin with the proxy token, which would turn a document the user
//! merely opened into a chat-history and LAN reader.
//!
//! Bodies are streamed in both directions (stage P3): a 25 MiB video is never
//! collected into a `Vec`. Timeouts are idle timeouts — the clock restarts on
//! every chunk — so a slow but live upload or video seek is not killed by one
//! fixed deadline. `Range` is passed through so `<video>` can seek.

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::{Bytes, BytesMut};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::body::{Frame, Incoming};
use hyper::header::{
    HeaderValue, ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, OnceCell};
use tokio_rustls::TlsConnector;

use crate::error::CoreError;
use crate::link::InviteLink;
use crate::tls;

/// Upper bound for one connection or TLS handshake.
const IO_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a body may stay silent before the transfer is considered dead. A
/// slow network keeps resetting it on every received chunk, so a 25 MiB file
/// over a few hundred kbit/s is fine; a stalled connection is not.
const IDLE_TIMEOUT: Duration = Duration::from_secs(20);
/// How much of a body a single channel slot may carry. Bounded so one slow
/// reader cannot make the proxy buffer a whole video in memory.
const BODY_CHUNK: usize = 64 * 1024;
/// Channel depth between the TLS pump and hyper. This is the real memory bound
/// for a response: eight chunks, not the whole file.
const BODY_CHANNEL: usize = 8;
/// Used when the server did not send a limit (older server, no snapshot).
const DEFAULT_MAX_UPLOAD: u64 = 25 << 20;
/// Largest avatar body the proxy accepts or caches. The server enforces the
/// same 4 MiB limit and answers with a re-encoded 256x256 picture.
const AVATAR_MAX_BYTES: u64 = 4 << 20;
/// An avatar response is tiny; anything larger is not a picture we cache.
const AVATAR_CACHE_BODY_LIMIT: usize = 2 << 20;
/// Avatar cache bounds. Bytes are content-addressed, so entries never go stale
/// while the session and the server stay the same; the TTL only stops an
/// unbounded old picture set from living forever.
const AVATAR_CACHE_ENTRIES: usize = 256;
const AVATAR_CACHE_BYTES: usize = 32 << 20;
const AVATAR_CACHE_TTL: Duration = Duration::from_secs(3600);
const EVENT_PREFIX: &str = "/events/new-year";
const EVENT_SMALL_BODY_LIMIT: usize = 256;
const EVENT_LAYOUT_BODY_LIMIT: usize = 4096;
const EVENT_RESPONSE_LIMIT: usize = 32 * 1024;
const EVENT_SUPPORT_LIMIT: usize = 256;

/// Streaming response body fed by one TLS pump task.
type ProxyBody = BoxBody<Bytes, io::Error>;

/// A running loopback proxy.
pub struct ChatProxy {
    addr: SocketAddr,
    token: String,
    shutdown: Option<oneshot::Sender<()>>,
}

impl ChatProxy {
    /// Starts the proxy for one authenticated session.
    ///
    /// `fingerprint` is the SHA-256 of the TLS leaf this session used; every
    /// forwarded request pins exactly that certificate. `session_token` is the
    /// bearer token from `Welcome`; it is only sent over TLS, never to the
    /// page. `max_upload` is the server's own attachment limit: the proxy
    /// refuses a larger body instead of buffering it.
    pub async fn start(
        link: InviteLink,
        fingerprint: [u8; 32],
        session_token: String,
        max_upload: u64,
    ) -> Result<Self, CoreError> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|err| CoreError::internal(format!("could not start the chat proxy: {err}")))?;
        let addr = listener.local_addr().map_err(|err| {
            CoreError::internal(format!("could not read the chat proxy address: {err}"))
        })?;
        let token = random_token()?;
        let (shutdown, mut stopped) = oneshot::channel::<()>();
        let state = Arc::new(ProxyState {
            link,
            fingerprint,
            session_token,
            token: token.clone(),
            max_upload: max_upload.max(1),
            avatars: Mutex::new(AvatarCache::default()),
            new_year_support: OnceCell::new(),
        });

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _peer)) = accepted else { break };
                        let state = state.clone();
                        tokio::spawn(async move {
                            let io = TokioIo::new(stream);
                            let service = service_fn(move |request| {
                                handle(request, state.clone())
                            });
                            // HTTP/1.1 with keep-alive; each connection is
                            // short-lived and belongs to one page request.
                            let _ = http1::Builder::new()
                                .serve_connection(io, service)
                                .await;
                        });
                    }
                }
            }
        });

        Ok(Self {
            addr,
            token,
            shutdown: Some(shutdown),
        })
    }

    /// `http://127.0.0.1:<port>` base URL for the WebView.
    #[must_use]
    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Per-process token the page must send in `X-RosTalk-Proxy-Token`.
    #[must_use]
    pub fn token(&self) -> &str {
        &self.token
    }
}

impl Drop for ChatProxy {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

struct ProxyState {
    link: InviteLink,
    fingerprint: [u8; 32],
    session_token: String,
    token: String,
    /// Server-side per-file limit, in bytes. Both the request head and the
    /// streamed frames are checked against it.
    max_upload: u64,
    /// Avatars already downloaded in this session, keyed by content hash.
    avatars: Mutex<AvatarCache>,
    new_year_support: OnceCell<Result<Bytes, ProxyError>>,
}

async fn handle(
    request: Request<Incoming>,
    state: Arc<ProxyState>,
) -> Result<Response<ProxyBody>, std::convert::Infallible> {
    // The App origin is the only one allowed to read an answer. A browser page
    // cannot forge `Origin`, so a foreign page that somehow learns the port and
    // the token still cannot read the reply.
    let origin = request.headers().get("origin").cloned();
    let response = match route(request, state).await {
        Ok(response) => response,
        Err(error) => error_response(&error),
    };
    Ok(with_cors(response, origin.as_ref()))
}

async fn route(
    request: Request<Incoming>,
    state: Arc<ProxyState>,
) -> Result<Response<ProxyBody>, ProxyError> {
    if request.method() == Method::OPTIONS {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(empty_body())
            .map_err(ProxyError::internal);
    }

    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    // The query-string form of the token exists only for `<img src>` and
    // `<video src>`, which cannot set a header. A general-purpose page script
    // has to send the header.
    let attachment = method == Method::GET && attachment_id(&path).is_some();
    let avatar = method == Method::GET && avatar_hash(&path).is_some();
    let authorized = request
        .headers()
        .get("x-rostalk-proxy-token")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| constant_time_eq(value.as_bytes(), state.token.as_bytes()))
        || ((attachment || avatar) && query_token_matches(request.uri().query(), &state.token));
    if !authorized {
        return Ok(status_response(StatusCode::UNAUTHORIZED, "unauthenticated"));
    }

    if let Some(suffix) = path.strip_prefix(EVENT_PREFIX) {
        return route_event(request, state, suffix).await;
    }

    let query = request.uri().query().unwrap_or("").to_owned();
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let content_length = request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let range = request.headers().get(RANGE).cloned();

    let avatar_upload = method == Method::PUT && path == "/avatars/me";
    let allowed = (method == Method::GET && path == "/chat/history")
        || (method == Method::POST && path == "/chat/attachments")
        || attachment
        || avatar
        || avatar_upload
        || (method == Method::DELETE && path == "/avatars/me");
    if !allowed {
        return Ok(status_response(StatusCode::NOT_FOUND, "not_found"));
    }

    // The server enforces the same limit, but checking the declared length
    // here means a page cannot even start streaming an impossible upload.
    let body_limit = if avatar_upload {
        AVATAR_MAX_BYTES
    } else {
        state.max_upload
    };
    if matches!(method, Method::POST | Method::PUT) {
        let declared = content_length.unwrap_or(0);
        if declared > body_limit {
            return Err(ProxyError::too_large());
        }
    }

    // A cached avatar is served without touching the network: the URL is a
    // content hash, so the bytes can never change for it.
    if let (true, Some(hash)) = (avatar, avatar_hash(&path)) {
        if let Some(cached) = state
            .avatars
            .lock()
            .ok()
            .and_then(|mut cache| cache.get(hash))
        {
            return avatar_response(StatusCode::OK, &cached.content_type, cached.bytes);
        }
    }

    let target = upstream_target(&path, &query);
    let upstream = forward(
        &state,
        &method,
        &target,
        ForwardHead {
            content_type: &content_type,
            content_length,
            range: range.as_ref(),
            body_limit,
            response_limit: None,
        },
        request.into_body(),
    )
    .await?;
    if avatar {
        let bytes = collect_body(upstream.body, AVATAR_CACHE_BODY_LIMIT).await?;
        if upstream.status == StatusCode::OK {
            if let Some(hash) = avatar_hash(&path) {
                if let Ok(mut cache) = state.avatars.lock() {
                    cache.insert(
                        hash.to_owned(),
                        upstream.content_type.clone(),
                        bytes.clone(),
                    );
                }
            }
        }
        return avatar_response(upstream.status, &upstream.content_type, bytes);
    }
    let disposition = if attachment {
        Some(attachment_disposition(
            upstream.content_disposition,
            &upstream.content_type,
        ))
    } else {
        upstream.content_disposition
    };
    let mut builder = Response::builder()
        .status(upstream.status)
        .header(CONTENT_TYPE, upstream.content_type)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store");
    if let Some(disposition) = disposition {
        builder = builder.header("Content-Disposition", disposition);
    }
    if let Some(length) = upstream.content_length {
        builder = builder.header(CONTENT_LENGTH, length);
    }
    if let Some(range) = upstream.content_range {
        builder = builder.header(CONTENT_RANGE, range);
    }
    if let Some(ranges) = upstream.accept_ranges {
        builder = builder.header(ACCEPT_RANGES, ranges);
    }
    if attachment {
        // Defence in depth for the loopback origin: even if a browser ignored
        // the disposition, scripts and subresources stay blocked.
        builder = builder
            .header("Content-Security-Policy", "default-src 'none'; sandbox")
            .header("X-Frame-Options", "DENY");
    }
    builder.body(upstream.body).map_err(ProxyError::internal)
}

#[derive(Clone, Copy)]
enum EventRoute {
    Support,
    Game { request_limit: usize },
}

fn event_route(method: &Method, suffix: &str) -> Option<EventRoute> {
    let request_limit = match (method, suffix) {
        (&Method::GET, "/support") => return Some(EventRoute::Support),
        (&Method::GET, "/me") => 0,
        (&Method::GET, path) if path.strip_prefix("/trees/").is_some_and(canonical_peer_id) => 0,
        (&Method::PUT, "/me/enrollment")
        | (&Method::POST, "/me/claim" | "/me/water" | "/me/spins") => EVENT_SMALL_BODY_LIMIT,
        (&Method::PUT, "/me/layout") => EVENT_LAYOUT_BODY_LIMIT,
        _ => return None,
    };
    Some(EventRoute::Game { request_limit })
}

fn canonical_peer_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 19
        && !id.starts_with('0')
        && id.bytes().all(|byte| byte.is_ascii_digit())
        && id.parse::<i64>().is_ok()
}

fn is_json(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
}

async fn route_event(
    request: Request<Incoming>,
    state: Arc<ProxyState>,
    suffix: &str,
) -> Result<Response<ProxyBody>, ProxyError> {
    let Some(route) = event_route(request.method(), suffix) else {
        return Ok(status_response(StatusCode::NOT_FOUND, "not_found"));
    };
    if request.uri().query().is_some() {
        return Ok(status_response(StatusCode::NOT_FOUND, "not_found"));
    }
    let request_limit = match route {
        EventRoute::Support => 0,
        EventRoute::Game { request_limit } => request_limit,
    };
    let declared = request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared.is_some_and(|length| length > request_limit as u64) {
        return Err(ProxyError::too_large());
    }
    if request_limit > 0
        && !request
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(is_json)
    {
        return Ok(status_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
        ));
    }

    // Buffer only these small JSON requests so a rejected body never reaches TLS.
    let (head, incoming) = request.into_parts();
    let body = tokio::time::timeout(IO_TIMEOUT, Limited::new(incoming, request_limit).collect())
        .await
        .map_err(|_| ProxyError::timeout())?
        .map_err(|error| {
            if error.is::<LengthLimitError>() {
                ProxyError::too_large()
            } else {
                ProxyError::network()
            }
        })?
        .to_bytes();

    if matches!(route, EventRoute::Support) {
        // A WebView can disappear while discovery is running. Keep the shared
        // probe alive and remember even an inconclusive result until reconnect.
        let bytes = tokio::spawn(async move {
            state
                .new_year_support
                .get_or_init(|| async {
                    tokio::time::timeout(IO_TIMEOUT, fetch_event_support(&state))
                        .await
                        .map_err(|_| ProxyError::timeout())?
                })
                .await
                .clone()
        })
        .await
        .map_err(ProxyError::internal)??;
        return event_response(StatusCode::OK, bytes);
    }

    let target = upstream_target(head.uri.path(), "");
    let upstream = forward_event(&state, &head.method, &target, body, EVENT_RESPONSE_LIMIT).await?;
    let content_type = upstream.content_type.to_str().ok();
    if !content_type.is_some_and(is_json) {
        return Err(event_upstream_error(upstream.status));
    }
    let bytes = collect_body(upstream.body, EVENT_RESPONSE_LIMIT).await?;
    event_response(upstream.status, bytes)
}

async fn forward_event(
    state: &ProxyState,
    method: &Method,
    target: &str,
    body: Bytes,
    response_limit: usize,
) -> Result<Upstream, ProxyError> {
    let length = body.len() as u64;
    forward(
        state,
        method,
        target,
        ForwardHead {
            content_type: "application/json",
            content_length: Some(length),
            range: None,
            body_limit: length,
            response_limit: Some(response_limit),
        },
        Full::new(body),
    )
    .await
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EventSupport {
    api_version: u32,
    season: String,
    phase: EventPhase,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum EventPhase {
    Upcoming,
    Active,
    Gallery,
    Closed,
}

async fn fetch_event_support(state: &ProxyState) -> Result<Bytes, ProxyError> {
    let target = format!("{API_PREFIX}{EVENT_PREFIX}/support");
    let upstream = forward_event(
        state,
        &Method::GET,
        &target,
        Bytes::new(),
        EVENT_SUPPORT_LIMIT,
    )
    .await?;
    if upstream.status != StatusCode::OK
        || !upstream.content_type.to_str().ok().is_some_and(is_json)
    {
        return Err(event_upstream_error(upstream.status));
    }
    let bytes = collect_body(upstream.body, EVENT_SUPPORT_LIMIT).await?;
    let support: EventSupport = serde_json::from_slice(&bytes).map_err(ProxyError::internal)?;
    let valid_season = support.season.split_once('-').is_some_and(|(year, month)| {
        year.len() == 4
            && year.bytes().all(|byte| byte.is_ascii_digit())
            && matches!(month.as_bytes(), [b'0', b'1'..=b'9'] | [b'1', b'0'..=b'2'])
    });
    if !valid_season {
        return Err(ProxyError::upstream("invalid event season"));
    }
    serde_json::to_vec(&support)
        .map(Bytes::from)
        .map_err(ProxyError::internal)
}

fn event_upstream_error(status: StatusCode) -> ProxyError {
    let code = match status {
        StatusCode::UNAUTHORIZED => "unauthenticated",
        StatusCode::FORBIDDEN => "permission_denied",
        StatusCode::NOT_FOUND => "not_found",
        status if status.is_client_error() || status.is_server_error() => "upstream_failed",
        _ => return ProxyError::upstream("invalid event response"),
    };
    ProxyError { status, code }
}

fn event_response(status: StatusCode, bytes: Bytes) -> Result<Response<ProxyBody>, ProxyError> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .body(full_body(bytes))
        .map_err(ProxyError::internal)
}

fn empty_body() -> ProxyBody {
    Full::new(Bytes::new())
        .map_err(|never| match never {})
        .boxed()
}

fn full_body(bytes: Bytes) -> ProxyBody {
    Full::new(bytes).map_err(|never| match never {}).boxed()
}

/// Response body backed by a bounded channel. The TLS pump awaits an empty
/// slot, so a slow page cannot make the core hold more than a few chunks.
struct ChannelBody {
    frames: mpsc::Receiver<Result<Frame<Bytes>, io::Error>>,
}

impl hyper::body::Body for ChannelBody {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        self.frames.poll_recv(cx)
    }
}

/// Returns the attachment id of `/chat/attachments/<digits>`.
///
/// The id must be a plain positive integer: the path is forwarded verbatim, so
/// anything else (`..`, an encoded separator, a slash) would let the page aim
/// the pinned TLS connection at a different upstream route.
fn attachment_id(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/chat/attachments/")?;
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(id)
}

/// Media the browser renders itself. These are the only non-image types that
/// may keep an `inline` disposition; everything else is forced to download.
fn inline_media(content_type: &HeaderValue) -> bool {
    content_type.to_str().is_ok_and(|text| {
        text.starts_with("image/") || text.starts_with("video/") || text.starts_with("audio/")
    })
}

/// Picks the disposition of an attachment read.
///
/// The server marks images, video and audio `inline` and everything else
/// `attachment`. The proxy keeps an `attachment` answer as-is, keeps `inline`
/// only for a media type, and forces `attachment` for anything else. A
/// top-level navigation to a text or HTML file therefore downloads it instead
/// of rendering it in the loopback origin (the server already rejects those
/// uploads; this is the second line of defence).
fn attachment_disposition(
    from_server: Option<HeaderValue>,
    content_type: &HeaderValue,
) -> HeaderValue {
    if let Some(value) = &from_server {
        let text = value
            .to_str()
            .unwrap_or("")
            .trim_start()
            .to_ascii_lowercase();
        if text.starts_with("attachment") {
            return value.clone();
        }
    }
    if inline_media(content_type) {
        if let Some(value) = from_server {
            if value
                .to_str()
                .is_ok_and(|text| text.trim_start().to_ascii_lowercase().starts_with("inline"))
            {
                return value;
            }
        }
        return HeaderValue::from_static("inline");
    }
    HeaderValue::from_static("attachment")
}

#[derive(Clone)]
struct CachedAvatar {
    content_type: HeaderValue,
    bytes: Bytes,
    stored: Instant,
}

#[derive(Default)]
struct AvatarCache {
    entries: HashMap<String, CachedAvatar>,
    bytes: usize,
}

impl AvatarCache {
    fn get(&mut self, hash: &str) -> Option<CachedAvatar> {
        let entry = self.entries.get(hash)?;
        if entry.stored.elapsed() > AVATAR_CACHE_TTL {
            if let Some(removed) = self.entries.remove(hash) {
                self.bytes = self.bytes.saturating_sub(removed.bytes.len());
            }
            return None;
        }
        Some(entry.clone())
    }

    fn insert(&mut self, hash: String, content_type: HeaderValue, bytes: Bytes) {
        if bytes.len() > AVATAR_CACHE_BODY_LIMIT {
            return;
        }
        if let Some(previous) = self.entries.insert(
            hash,
            CachedAvatar {
                content_type,
                bytes: bytes.clone(),
                stored: Instant::now(),
            },
        ) {
            self.bytes = self.bytes.saturating_sub(previous.bytes.len());
        }
        self.bytes += bytes.len();
        while self.bytes > AVATAR_CACHE_BYTES || self.entries.len() > AVATAR_CACHE_ENTRIES {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.stored)
                .map(|(hash, _)| hash.clone())
            else {
                break;
            };
            if let Some(removed) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(removed.bytes.len());
            }
        }
    }
}

/// Builds an avatar reply. The picture is content-addressed and immutable, so
/// the page may keep it as long as it likes; script execution stays blocked as
/// an extra layer over the already inert PNG/JPEG bytes.
fn avatar_response(
    status: StatusCode,
    content_type: &HeaderValue,
    bytes: Bytes,
) -> Result<Response<ProxyBody>, ProxyError> {
    let mut builder = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, content_type)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("X-Frame-Options", "DENY")
        .header(CONTENT_LENGTH, bytes.len());
    builder = if status == StatusCode::OK {
        builder.header("Cache-Control", "public, max-age=31536000, immutable")
    } else {
        builder.header("Cache-Control", "no-store")
    };
    builder.body(full_body(bytes)).map_err(ProxyError::internal)
}

/// Collects a small response body, refusing anything that could
/// make the core hold a large buffer. Attachment reads keep streaming.
async fn collect_body(mut body: ProxyBody, limit: usize) -> Result<Bytes, ProxyError> {
    let mut collected = BytesMut::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| ProxyError::network())?;
        let Some(data) = frame.data_ref() else {
            continue;
        };
        if collected.len().saturating_add(data.len()) > limit {
            return Err(ProxyError::upstream("the response is too large"));
        }
        collected.extend_from_slice(data);
    }
    Ok(collected.freeze())
}

/// Returns the hash of `/avatars/<64 lowercase hex>`.
///
/// The path is forwarded verbatim, so a hash that is not exactly a SHA-256
/// digest (a slash, `..`, uppercase or percent-encoding) must never become an
/// upstream path component.
fn avatar_hash(path: &str) -> Option<&str> {
    let hash = path.strip_prefix("/avatars/")?;
    if hash.len() != 64 {
        return None;
    }
    if !hash
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    Some(hash)
}

/// One upstream response head plus its streaming body.
struct Upstream {
    status: StatusCode,
    content_type: HeaderValue,
    content_disposition: Option<HeaderValue>,
    content_length: Option<u64>,
    content_range: Option<HeaderValue>,
    accept_ranges: Option<HeaderValue>,
    body: ProxyBody,
}

/// Request fields forwarded to the server besides method, target and body.
struct ForwardHead<'a> {
    content_type: &'a str,
    content_length: Option<u64>,
    range: Option<&'a HeaderValue>,
    /// Declared body ceiling for this route.
    body_limit: u64,
    response_limit: Option<usize>,
}

async fn forward(
    state: &ProxyState,
    method: &Method,
    target: &str,
    head: ForwardHead<'_>,
    body: impl hyper::body::Body<Data = Bytes> + Unpin,
) -> Result<Upstream, ProxyError> {
    let ForwardHead {
        content_type,
        content_length,
        range,
        body_limit,
        response_limit,
    } = head;
    let setup = tls::tls_setup(state.link.mode(), state.fingerprint).map_err(ProxyError::core)?;
    let server_name = tls::server_name(&state.link.hostname).map_err(ProxyError::core)?;
    let authority = state.link.authority();

    let tcp = tokio::time::timeout(IO_TIMEOUT, TcpStream::connect(&authority))
        .await
        .map_err(|_| ProxyError::timeout())?
        .map_err(|_| ProxyError::network())?;
    let _ = tcp.set_nodelay(true);
    let connector = TlsConnector::from(setup.config);
    let tls = tokio::time::timeout(IO_TIMEOUT, connector.connect(server_name, tcp))
        .await
        .map_err(|_| ProxyError::timeout())?
        .map_err(|_| ProxyError::fingerprint())?;
    let mut stream = tls;

    let chunked = (method == Method::POST || method == Method::PUT) && content_length.is_none();
    let mut head = format!(
        "{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAuthorization: Bearer {}\r\nAccept: application/json\r\nContent-Type: {}\r\n",
        method.as_str(),
        target,
        authority,
        state.session_token,
        content_type,
    );
    if let Some(length) = content_length {
        head.push_str(&format!("Content-Length: {length}\r\n"));
    } else if chunked {
        head.push_str("Transfer-Encoding: chunked\r\n");
    } else {
        head.push_str("Content-Length: 0\r\n");
    }
    if let Some(range) = range.and_then(|value| value.to_str().ok()) {
        head.push_str(&format!("Range: {range}\r\n"));
    }
    head.push_str("\r\n");
    write_idle(&mut stream, head.as_bytes(), IO_TIMEOUT)
        .await
        .map_err(|_| ProxyError::timeout())?;

    // Forward the request body frame by frame. Nothing is collected: the TLS
    // write waits for the page, the page waits for the disk, and memory stays
    // at one frame.
    let mut body = body;
    let mut received: u64 = 0;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| ProxyError::network())?;
        let Some(data) = frame.data_ref() else {
            continue;
        };
        received = received.saturating_add(data.len() as u64);
        if received > body_limit {
            return Err(ProxyError::too_large());
        }
        if chunked {
            let header = format!("{:x}\r\n", data.len());
            write_idle(&mut stream, header.as_bytes(), IDLE_TIMEOUT)
                .await
                .map_err(|_| ProxyError::timeout())?;
            write_idle(&mut stream, data, IDLE_TIMEOUT)
                .await
                .map_err(|_| ProxyError::timeout())?;
            write_idle(&mut stream, b"\r\n", IDLE_TIMEOUT)
                .await
                .map_err(|_| ProxyError::timeout())?;
        } else if !data.is_empty() {
            write_idle(&mut stream, data, IDLE_TIMEOUT)
                .await
                .map_err(|_| ProxyError::timeout())?;
        }
    }
    if chunked {
        write_idle(&mut stream, b"0\r\n\r\n", IDLE_TIMEOUT)
            .await
            .map_err(|_| ProxyError::timeout())?;
    }
    stream.flush().await.map_err(|_| ProxyError::network())?;

    read_response(stream, response_limit).await
}

/// Reads and parses one HTTP/1.1 response head, then hands the body to a pump
/// task. Only `Content-Length`, chunked and close-delimited bodies are used by
/// rostalk-server.
async fn read_response(
    mut stream: tokio_rustls::client::TlsStream<TcpStream>,
    response_limit: Option<usize>,
) -> Result<Upstream, ProxyError> {
    let mut buffer = Vec::with_capacity(4096);
    let head_end = loop {
        if let Some(position) = find_head_end(&buffer) {
            break position;
        }
        if buffer.len() > 64 << 10 {
            return Err(ProxyError::upstream("the server sent oversized headers"));
        }
        read_more(&mut stream, &mut buffer, IO_TIMEOUT).await?;
    };
    let head = std::str::from_utf8(&buffer[..head_end])
        .map_err(|_| ProxyError::upstream("the server sent a malformed response"))?;
    let mut lines = head.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| ProxyError::upstream("the server sent an empty response"))?;
    let mut parts = status_line.split_whitespace();
    let _version = parts.next();
    let status = parts
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .and_then(|value| StatusCode::from_u16(value).ok())
        .ok_or_else(|| ProxyError::upstream("the server sent an invalid status"))?;

    let mut content_type = HeaderValue::from_static("application/octet-stream");
    let mut content_disposition = None;
    let mut content_length: Option<u64> = None;
    let mut content_range = None;
    let mut accept_ranges = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        match name.as_str() {
            "content-type" => {
                if let Ok(parsed) = HeaderValue::from_str(value) {
                    content_type = parsed;
                }
            }
            "content-disposition" => {
                if let Ok(parsed) = HeaderValue::from_str(value) {
                    content_disposition = Some(parsed);
                }
            }
            "content-length" => content_length = value.parse::<u64>().ok(),
            "content-range" => {
                if let Ok(parsed) = HeaderValue::from_str(value) {
                    content_range = Some(parsed);
                }
            }
            "accept-ranges" => {
                if let Ok(parsed) = HeaderValue::from_str(value) {
                    accept_ranges = Some(parsed);
                }
            }
            "transfer-encoding" => chunked = value.to_ascii_lowercase().contains("chunked"),
            _ => {}
        }
    }

    if response_limit
        .zip(content_length)
        .is_some_and(|(limit, length)| length > limit as u64)
    {
        return Err(event_upstream_error(status));
    }
    let prefix = buffer.split_off(head_end + 4);
    let (sender, receiver) = mpsc::channel(BODY_CHANNEL);
    tokio::spawn(async move {
        if let Err(error) = pump_body(
            stream,
            prefix,
            content_length,
            chunked,
            sender.clone(),
            IDLE_TIMEOUT,
        )
        .await
        {
            // The receiver may be gone because the page navigated away; the
            // error is only meaningful while somebody is still reading.
            let _ = sender.send(Err(error)).await;
        }
    });
    Ok(Upstream {
        status,
        content_type,
        content_disposition,
        content_length,
        content_range,
        accept_ranges,
        body: BoxBody::new(ChannelBody { frames: receiver }),
    })
}

/// Streams a decoded response body into `frames`, resetting the idle timeout
/// on every chunk. Generic over the reader so the timeout path is testable
/// without TLS.
async fn pump_body<R>(
    mut stream: R,
    mut buffer: Vec<u8>,
    length: Option<u64>,
    chunked: bool,
    frames: mpsc::Sender<Result<Frame<Bytes>, io::Error>>,
    idle: Duration,
) -> Result<(), io::Error>
where
    R: AsyncRead + Unpin,
{
    if chunked {
        return pump_chunked(&mut stream, buffer, frames, idle).await;
    }
    if let Some(mut remaining) = length {
        if !buffer.is_empty() {
            let take = usize::try_from(remaining)
                .unwrap_or(usize::MAX)
                .min(buffer.len());
            if take > 0 {
                send_frame(&frames, Bytes::copy_from_slice(&buffer[..take])).await?;
                remaining -= take as u64;
            }
            buffer.drain(..take);
        }
        while remaining > 0 {
            let want = usize::try_from(remaining)
                .unwrap_or(BODY_CHUNK)
                .min(BODY_CHUNK);
            let mut chunk = vec![0u8; want];
            let read = read_idle(&mut stream, &mut chunk, idle).await?;
            if read == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "the server closed the connection before the body ended",
                ));
            }
            remaining -= read as u64;
            send_frame(&frames, Bytes::copy_from_slice(&chunk[..read])).await?;
        }
        return Ok(());
    }

    // Close-delimited: the end of the TLS stream is the end of the body.
    if !buffer.is_empty() {
        send_frame(&frames, Bytes::from(buffer)).await?;
    }
    loop {
        let mut chunk = vec![0u8; BODY_CHUNK];
        let read = read_idle(&mut stream, &mut chunk, idle).await?;
        if read == 0 {
            return Ok(());
        }
        send_frame(&frames, Bytes::copy_from_slice(&chunk[..read])).await?;
    }
}

async fn pump_chunked<R>(
    stream: &mut R,
    mut buffer: Vec<u8>,
    frames: mpsc::Sender<Result<Frame<Bytes>, io::Error>>,
    idle: Duration,
) -> Result<(), io::Error>
where
    R: AsyncRead + Unpin,
{
    loop {
        let line_end = loop {
            if let Some(position) = buffer.windows(2).position(|window| window == b"\r\n") {
                break position;
            }
            if buffer.len() > BODY_CHUNK {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "oversized chunk header",
                ));
            }
            read_more(stream, &mut buffer, idle).await.map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "malformed chunk header")
            })?;
        };
        let line = std::str::from_utf8(&buffer[..line_end])
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "malformed chunk header"))?;
        let size_text = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "malformed chunk size"))?;
        buffer.drain(..line_end + 2);
        if size == 0 {
            return Ok(());
        }
        let mut remaining = size;
        while remaining > 0 {
            if buffer.is_empty() {
                read_more(stream, &mut buffer, idle)
                    .await
                    .map_err(|_| io::Error::new(io::ErrorKind::UnexpectedEof, "truncated chunk"))?;
            }
            let take = remaining.min(buffer.len());
            send_frame(&frames, Bytes::copy_from_slice(&buffer[..take])).await?;
            buffer.drain(..take);
            remaining -= take;
        }
        while buffer.len() < 2 {
            read_more(stream, &mut buffer, idle)
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::UnexpectedEof, "truncated chunk"))?;
        }
        if &buffer[..2] != b"\r\n" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "malformed chunk terminator",
            ));
        }
        buffer.drain(..2);
    }
}

async fn send_frame(
    frames: &mpsc::Sender<Result<Frame<Bytes>, io::Error>>,
    data: Bytes,
) -> Result<(), io::Error> {
    frames
        .send(Ok(Frame::data(data)))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "the page stopped reading"))
}

async fn read_more<R>(
    stream: &mut R,
    buffer: &mut Vec<u8>,
    idle: Duration,
) -> Result<(), ProxyError>
where
    R: AsyncRead + Unpin,
{
    let mut chunk = [0u8; 16 * 1024];
    let read = read_idle(stream, &mut chunk, idle).await.map_err(|error| {
        if error.kind() == io::ErrorKind::TimedOut {
            ProxyError::timeout()
        } else {
            ProxyError::network()
        }
    })?;
    if read == 0 {
        return Err(ProxyError::network());
    }
    buffer.extend_from_slice(&chunk[..read]);
    Ok(())
}

async fn read_idle<R>(stream: &mut R, buffer: &mut [u8], idle: Duration) -> Result<usize, io::Error>
where
    R: AsyncRead + Unpin,
{
    match tokio::time::timeout(idle, stream.read(buffer)).await {
        Ok(Ok(read)) => Ok(read),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "no bytes arrived")),
    }
}

async fn write_idle<W>(stream: &mut W, bytes: &[u8], idle: Duration) -> Result<(), io::Error>
where
    W: AsyncWrite + Unpin,
{
    match tokio::time::timeout(idle, stream.write_all(bytes)).await {
        Ok(result) => result,
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "the peer stopped reading",
        )),
    }
}

fn find_head_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn query_token_matches(query: Option<&str>, token: &str) -> bool {
    let Some(query) = query else {
        return false;
    };
    for pair in query.split('&') {
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        if name == "pt" && constant_time_eq(value.as_bytes(), token.as_bytes()) {
            return true;
        }
    }
    false
}

/// The server mounts the chat endpoints under the versioned API prefix
/// (design 4.4). The page routes stay short, so the prefix is added here.
const API_PREFIX: &str = "/api/v1";

/// Builds the upstream request target, dropping the proxy's own `pt` token.
///
/// The loopback token authenticates the page to the proxy; it has no meaning
/// for the server and must not travel there, especially not in a URL that the
/// server or an intermediary may record. The real parameters (`limit`,
/// `cursor`, `channelId`, `peerId`, `name`) are kept and re-encoded.
fn upstream_target(path: &str, query: &str) -> String {
    let pairs =
        url::form_urlencoded::parse(query.as_bytes()).filter(|(name, _)| name.as_ref() != "pt");
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish();
    let path = format!("{API_PREFIX}{path}");
    if encoded.is_empty() {
        path
    } else {
        format!("{path}?{encoded}")
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right) {
        difference |= a ^ b;
    }
    difference == 0
}

fn random_token() -> Result<String, CoreError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|err| CoreError::internal(format!("could not generate a proxy token: {err}")))?;
    Ok(hex::encode(bytes))
}

/// Origins of the RosTalk WebView: the Windows custom protocol and the generic
/// `tauri://` one. The Vite dev server is added in a development build only.
/// Nothing else may read the proxy.
#[must_use]
fn allowed_origin(origin: &str, dev_build: bool) -> bool {
    match origin {
        "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost" => true,
        "http://localhost:1420" | "http://127.0.0.1:1420" => dev_build,
        _ => false,
    }
}

fn with_cors(
    mut response: Response<ProxyBody>,
    origin: Option<&HeaderValue>,
) -> Response<ProxyBody> {
    let allowed = origin
        .and_then(|value| value.to_str().ok())
        .filter(|value| allowed_origin(value, cfg!(debug_assertions)));
    let Some(allowed) = allowed else {
        return response;
    };
    let Ok(allowed) = HeaderValue::from_str(allowed) else {
        return response;
    };
    let headers = response.headers_mut();
    headers.insert("Access-Control-Allow-Origin", allowed);
    headers.insert("Vary", HeaderValue::from_static("Origin"));
    headers.insert(
        "Access-Control-Allow-Headers",
        HeaderValue::from_static("content-type, x-rostalk-proxy-token, range"),
    );
    headers.insert(
        "Access-Control-Allow-Methods",
        HeaderValue::from_static("GET, POST, PUT, DELETE, OPTIONS"),
    );
    headers.insert(
        "Access-Control-Expose-Headers",
        HeaderValue::from_static(
            "content-length, content-range, accept-ranges, content-disposition",
        ),
    );
    headers.insert("Access-Control-Max-Age", HeaderValue::from_static("600"));
    response
}

fn status_response(status: StatusCode, code: &str) -> Response<ProxyBody> {
    let body = format!(
        "{{\"error\":{{\"code\":\"{}\",\"message\":\"{}\"}}}}",
        code, code
    );
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header("Cache-Control", "no-store")
        .body(full_body(Bytes::from(body)))
        .unwrap_or_else(|_| Response::new(empty_body()))
}

fn error_response(error: &ProxyError) -> Response<ProxyBody> {
    // Never include the URL, token or certificate material in the reply.
    status_response(error.status, error.code)
}

/// Internal proxy failure with a safe public code.
#[derive(Clone)]
struct ProxyError {
    status: StatusCode,
    code: &'static str,
}

impl ProxyError {
    fn internal(_error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "upstream_failed",
        }
    }

    fn upstream(_message: &'static str) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "upstream_failed",
        }
    }

    /// The upstream accepted the connection but sent nothing within the idle
    /// timeout. The UI shows a "timed out" message for this code.
    fn timeout() -> Self {
        Self {
            status: StatusCode::GATEWAY_TIMEOUT,
            code: "timeout",
        }
    }

    /// Connect, TLS or transport failure. The UI distinguishes it from a
    /// server-side rejection and suggests checking the connection.
    fn network() -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "network",
        }
    }

    fn fingerprint() -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "server_certificate_mismatch",
        }
    }

    fn too_large() -> Self {
        Self {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            code: "file_too_large",
        }
    }

    fn core(_error: CoreError) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "upstream_failed",
        }
    }
}

/// The server's limit is used for every session; this keeps the constant
/// meaningful for callers that build a proxy before a snapshot exists.
#[must_use]
pub fn default_max_upload() -> u64 {
    DEFAULT_MAX_UPLOAD
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_tokens_are_random_hex() {
        let first = random_token().expect("token");
        let second = random_token().expect("token");
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn token_comparison_is_length_safe() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    #[test]
    fn query_tokens_are_read_from_pt() {
        assert!(query_token_matches(Some("pt=abc&x=1"), "abc"));
        assert!(!query_token_matches(Some("x=1"), "abc"));
        assert!(!query_token_matches(None, "abc"));
    }

    #[test]
    fn attachment_paths_are_a_plain_numeric_id() {
        assert_eq!(attachment_id("/chat/attachments/7"), Some("7"));
        assert_eq!(
            attachment_id("/chat/attachments/4294967296"),
            Some("4294967296")
        );
        for path in [
            "/chat/attachments/",
            "/chat/attachments/../chat/history",
            "/chat/attachments/7/../../admin",
            "/chat/attachments/7%2f..",
            "/chat/attachments/%2e%2e",
            "/chat/attachments/-1",
            "/chat/history",
        ] {
            assert_eq!(attachment_id(path), None, "path {path}");
        }
    }

    #[test]
    fn text_and_archives_are_always_served_as_downloads() {
        let html = HeaderValue::from_static("text/html");
        assert_eq!(
            attachment_disposition(None, &html),
            HeaderValue::from_static("attachment")
        );
        assert_eq!(
            attachment_disposition(Some(HeaderValue::from_static("inline")), &html),
            HeaderValue::from_static("attachment")
        );
        let zip = HeaderValue::from_static("application/zip");
        assert_eq!(
            attachment_disposition(Some(HeaderValue::from_static("inline")), &zip),
            HeaderValue::from_static("attachment")
        );
        assert_eq!(
            attachment_disposition(
                Some(HeaderValue::from_static("attachment; filename=\"a.zip\"")),
                &zip
            ),
            HeaderValue::from_static("attachment; filename=\"a.zip\"")
        );
    }

    #[test]
    fn images_and_media_may_stay_inline() {
        for (content_type, from_server) in [
            ("image/png", Some(HeaderValue::from_static("inline"))),
            ("video/mp4", Some(HeaderValue::from_static("inline"))),
            ("audio/ogg", None),
        ] {
            let content_type = HeaderValue::from_static(content_type);
            let disposition = attachment_disposition(from_server, &content_type);
            assert!(
                disposition.to_str().expect("ascii").starts_with("inline"),
                "{content_type:?} -> {disposition:?}"
            );
        }
    }

    #[test]
    fn cors_origins_are_an_allow_list() {
        for origin in [
            "http://tauri.localhost",
            "https://tauri.localhost",
            "tauri://localhost",
        ] {
            assert!(allowed_origin(origin, false), "{origin}");
            assert!(allowed_origin(origin, true), "{origin}");
        }
        // The Vite dev server is a development-only origin.
        for origin in ["http://localhost:1420", "http://127.0.0.1:1420"] {
            assert!(allowed_origin(origin, true), "{origin}");
            assert!(!allowed_origin(origin, false), "{origin}");
        }
        for origin in [
            "http://evil.example",
            "null",
            "https://tauri.localhost.evil.example",
            "http://localhost:1421",
            "http://127.0.0.1:8080",
            "file://",
        ] {
            assert!(!allowed_origin(origin, true), "{origin}");
        }
    }

    #[test]
    fn upstream_target_uses_the_versioned_api_prefix() {
        // The server mounts the chat endpoints under /api/v1 (httpapi routes).
        // Forwarding the page route verbatim made every history request a 404,
        // which the UI showed as "messages failed to load" even for an empty
        // conversation (playtest-1, complaint 10).
        for (path, expected) in [
            ("/chat/history", "/api/v1/chat/history"),
            ("/chat/attachments", "/api/v1/chat/attachments"),
            ("/chat/attachments/9", "/api/v1/chat/attachments/9"),
        ] {
            assert_eq!(upstream_target(path, ""), expected);
        }
    }

    #[test]
    fn avatar_paths_are_content_hashes() {
        let hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
        assert_eq!(avatar_hash(&format!("/avatars/{hash}")), Some(hash));
        for path in [
            "/avatars/",
            "/avatars/../chat/history",
            "/avatars/9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08",
            "/avatars/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a0",
            "/avatars/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a0z",
            "/avatars/9f86d0/..",
            "/chat/attachments/1",
        ] {
            assert_eq!(avatar_hash(path), None, "path {path}");
        }
    }

    #[tokio::test]
    async fn avatars_are_cached_in_memory_after_the_first_read() {
        let hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
        let capture = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (authority, fingerprint) = mock_upstream_capturing(
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4\r\n\r\nPNG!",
            Some(capture.clone()),
        )
        .await;
        let link = InviteLink::parse(&format!(
            "rostalk://join?host={authority}&fp={}",
            hex::encode(fingerprint)
        ))
        .expect("link");
        let proxy = ChatProxy::start(link, fingerprint, "session-token".to_owned(), 1 << 20)
            .await
            .expect("proxy");
        let token = proxy.token().to_owned();

        let first = ask(
            &proxy,
            &format!(
                "GET /avatars/{hash}?pt={token} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(first.starts_with("HTTP/1.1 200"), "{first}");
        let lower = first.to_ascii_lowercase();
        assert!(
            lower.contains("cache-control: public, max-age=31536000, immutable"),
            "{first}"
        );
        assert!(lower.contains("x-content-type-options: nosniff"), "{first}");
        assert!(first.ends_with("PNG!"), "{first}");

        let second = ask(
            &proxy,
            &format!(
                "GET /avatars/{hash}?pt={token} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(second.starts_with("HTTP/1.1 200"), "{second}");
        assert!(second.ends_with("PNG!"), "{second}");
        let requests = capture.lock().expect("capture").clone();
        assert_eq!(
            requests.len(),
            1,
            "the second read went to the server: {requests:?}"
        );
        assert!(
            requests[0].starts_with(&format!("GET /api/v1/avatars/{hash} HTTP/1.1")),
            "{}",
            requests[0]
        );
    }

    #[tokio::test]
    async fn new_year_allows_only_exact_header_authenticated_event_routes() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let (authority, fingerprint) = mock_upstream_capturing(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
            Some(captured.clone()),
        )
        .await;
        let proxy = event_proxy(&authority, fingerprint).await;
        let request = format!(
            "GET {EVENT_PREFIX}/support?pt={} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer role-token\r\nConnection: close\r\n\r\n",
            proxy.token()
        );
        let response = ask(&proxy, &request).await;
        assert!(response.starts_with("HTTP/1.1 401"), "{response}");

        let response = ask_event(
            &proxy,
            "OPTIONS",
            "/support",
            "Origin: http://tauri.localhost\r\n",
            "",
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 204"), "{response}");
        assert!(
            response.contains("access-control-allow-origin: http://tauri.localhost"),
            "{response}"
        );

        for (method, suffix) in [
            ("HEAD", "/support"),
            ("FROB", "/me"),
            ("GET", "/me/layout"),
            ("POST", "/me/enrollment"),
            ("DELETE", "/me/layout"),
            ("GET", "/support?"),
            ("GET", "/me?debug=1"),
            ("GET", "/trees/7?x=1"),
            ("GET", "/support/"),
            ("GET", "/unsupported"),
            ("GET", "/trees/0"),
            ("GET", "/trees/07"),
            ("GET", "/trees/+7"),
            ("GET", "/trees/%37"),
            ("GET", "/trees/7/extra"),
            ("GET", "/trees/7/"),
            ("GET", "/trees/9223372036854775808"),
        ] {
            let response = ask_event(&proxy, method, suffix, "", "").await;
            assert!(
                response.starts_with("HTTP/1.1 404"),
                "{method} {suffix}: {response}"
            );
        }
        assert!(captured.lock().expect("capture").is_empty());

        let reads = [("GET", "/me"), ("GET", "/trees/9223372036854775807")];
        let writes = [
            ("PUT", "/me/enrollment"),
            ("POST", "/me/claim"),
            ("POST", "/me/water"),
            ("POST", "/me/spins"),
            ("PUT", "/me/layout"),
        ];
        let passthrough_attempt = "Authorization: Bearer role-token\r\nRange: bytes=0-1\r\n";
        for (method, suffix) in reads {
            let response = ask_event(&proxy, method, suffix, passthrough_attempt, "").await;
            assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        }
        for (method, suffix) in writes {
            let headers = format!("{passthrough_attempt}Content-Type: application/json; charset=utf-8\r\nContent-Length: 2\r\n");
            let response = ask_event(&proxy, method, suffix, &headers, "{}").await;
            assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        }
        let requests = captured.lock().expect("capture");
        assert_eq!(requests.len(), 7);
        for (request, (method, suffix)) in requests.iter().zip(reads.into_iter().chain(writes)) {
            assert!(
                request.starts_with(&format!("{method} /api/v1{EVENT_PREFIX}{suffix} HTTP/1.1"))
            );
            assert!(request.contains("Authorization: Bearer session-token\r\n"));
            assert!(!request.contains("role-token"));
            assert!(!request.contains("Range:"));
            assert!(!request.contains(proxy.token()));
        }
    }

    #[tokio::test]
    async fn new_year_rejects_declared_and_chunked_bodies_over_each_route_limit() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let (authority, fingerprint) = mock_upstream_capturing(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
            Some(captured.clone()),
        )
        .await;
        let proxy = event_proxy(&authority, fingerprint).await;
        for (method, suffix, limit) in [
            ("GET", "/support", 0),
            ("GET", "/me", 0),
            ("PUT", "/me/enrollment", 256),
            ("POST", "/me/claim", 256),
            ("POST", "/me/water", 256),
            ("POST", "/me/spins", 256),
            ("PUT", "/me/layout", 4096),
        ] {
            let headers = format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                limit + 1
            );
            let response = ask_event(&proxy, method, suffix, &headers, "").await;
            assert!(response.starts_with("HTTP/1.1 413"), "{suffix}: {response}");
            assert!(response.contains("file_too_large"), "{response}");

            let mut chunks = String::new();
            if limit > 0 {
                chunks = format!("{limit:x}\r\n{}\r\n", "x".repeat(limit));
            }
            chunks.push_str("1\r\nx\r\n0\r\n\r\n");
            let response = ask_event(
                &proxy,
                method,
                suffix,
                "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n",
                &chunks,
            )
            .await;
            assert!(response.starts_with("HTTP/1.1 413"), "{suffix}: {response}");
            assert!(response.contains("file_too_large"), "{response}");
        }
        let response = ask_event(
            &proxy,
            "PUT",
            "/me/layout",
            "Content-Type: text/plain\r\nContent-Length: 2\r\n",
            "{}",
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 415"), "{response}");
        assert!(captured.lock().expect("capture").is_empty());

        for (method, suffix, limit) in [("POST", "/me/spins", 256), ("PUT", "/me/layout", 4096)] {
            let body = format!("{limit:x}\r\n{{}}{}\r\n0\r\n\r\n", " ".repeat(limit - 2));
            let response = ask_event(
                &proxy,
                method,
                suffix,
                "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n",
                &body,
            )
            .await;
            assert!(response.starts_with("HTTP/1.1 200"), "{suffix}: {response}");
        }
        let requests = captured.lock().expect("capture");
        assert_eq!(requests.len(), 2);
        assert!(requests[0].contains("Content-Length: 256\r\n"));
        assert!(requests[1].contains("Content-Length: 4096\r\n"));
    }

    #[tokio::test]
    async fn new_year_support_is_single_flight_sanitized_and_scoped_to_the_session() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let body = r#"{"apiVersion":1,"season":"2026-12","phase":"active","extra":"discard"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let (authority, fingerprint) =
            mock_upstream_capturing(response, Some(captured.clone())).await;
        let proxy = event_proxy(&authority, fingerprint).await;
        let (first, second) = tokio::join!(
            ask_event(&proxy, "GET", "/support", "", ""),
            ask_event(&proxy, "GET", "/support", "", ""),
        );
        for response in [
            first,
            second,
            ask_event(&proxy, "GET", "/support", "", "").await,
        ] {
            assert!(response.starts_with("HTTP/1.1 200"), "{response}");
            assert!(response.contains("cache-control: no-store"));
            assert!(
                response.ends_with(r#"{"apiVersion":1,"season":"2026-12","phase":"active"}"#),
                "{response}"
            );
        }
        assert_eq!(captured.lock().expect("capture").len(), 1);

        for _ in 0..2 {
            let response = ask_event(&proxy, "GET", "/me", "", "").await;
            assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        }
        assert_eq!(captured.lock().expect("capture").len(), 3);
        let new_session = event_proxy(&authority, fingerprint).await;
        let response = ask_event(&new_session, "GET", "/support", "", "").await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert_eq!(captured.lock().expect("capture").len(), 4);

        let wrong_pin = event_proxy(&authority, [0; 32]).await;
        let response = ask_event(&wrong_pin, "GET", "/support", "", "").await;
        assert!(response.starts_with("HTTP/1.1 502"), "{response}");
        assert!(
            response.contains("server_certificate_mismatch"),
            "{response}"
        );
        assert_eq!(captured.lock().expect("capture").len(), 4);
    }

    #[tokio::test]
    async fn new_year_support_caches_only_sanitized_failure_for_inconclusive_replies() {
        let oversized_chunk = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n101\r\n{}\r\n0\r\n\r\n", "x".repeat(257));
        for (upstream, status) in [
            ("HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nContent-Length: 14\r\n\r\n<b>ignored</b>".to_owned(), "HTTP/1.1 404"),
            ("HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nContent-Length: 300\r\n\r\n".to_owned(), "HTTP/1.1 404"),
            ("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}".to_owned(), "HTTP/1.1 403"),
            ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}".to_owned(), "HTTP/1.1 502"),
            ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 257\r\n\r\n".to_owned(), "HTTP/1.1 502"),
            (oversized_chunk, "HTTP/1.1 502"),
        ] {
            let captured = Arc::new(Mutex::new(Vec::new()));
            let (authority, fingerprint) = mock_upstream_capturing(upstream, Some(captured.clone())).await;
            let proxy = event_proxy(&authority, fingerprint).await;
            for _ in 0..2 {
                let response = ask_event(&proxy, "GET", "/support", "", "").await;
                assert!(response.starts_with(status), "{response}");
                assert!(!response.contains("<b>"));
                assert!(response.contains("cache-control: no-store"));
            }
            assert_eq!(captured.lock().expect("capture").len(), 1);
        }
    }

    #[tokio::test]
    async fn new_year_game_reads_refuse_oversized_upstream_bodies() {
        let body = "x".repeat(32 * 1024 + 1);
        let size = body.len();
        let upstream = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n{size:x}\r\n{body}\r\n0\r\n\r\n"
        );
        let (authority, fingerprint) = mock_upstream_capturing(upstream, None).await;
        let proxy = event_proxy(&authority, fingerprint).await;
        let response = ask_event(&proxy, "GET", "/me", "", "").await;
        assert!(response.starts_with("HTTP/1.1 502"), "{response}");
        assert!(response.contains("upstream_failed"));
    }

    async fn event_proxy(authority: &str, fingerprint: [u8; 32]) -> ChatProxy {
        let link = InviteLink::parse(&format!(
            "rostalk://join?host={authority}&fp={}",
            hex::encode(fingerprint)
        ))
        .expect("link");
        ChatProxy::start(link, fingerprint, "session-token".to_owned(), 1 << 20)
            .await
            .expect("proxy")
    }

    async fn ask_event(
        proxy: &ChatProxy,
        method: &str,
        suffix: &str,
        headers: &str,
        body: &str,
    ) -> String {
        ask(proxy, &format!("{method} {EVENT_PREFIX}{suffix} HTTP/1.1\r\nHost: x\r\nX-RosTalk-Proxy-Token: {}\r\nConnection: close\r\n{headers}\r\n{body}", proxy.token())).await
    }

    #[tokio::test]
    async fn avatar_upload_routes_stay_behind_the_proxy_token() {
        let capture = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (authority, fingerprint) = mock_upstream_capturing(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
            Some(capture.clone()),
        )
        .await;
        let link = InviteLink::parse(&format!(
            "rostalk://join?host={authority}&fp={}",
            hex::encode(fingerprint)
        ))
        .expect("link");
        let proxy = ChatProxy::start(link, fingerprint, "session-token".to_owned(), 1 << 20)
            .await
            .expect("proxy");
        let token = proxy.token().to_owned();
        let hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

        // The query token is for <img> reads only, not for a write.
        let unauthorized = ask(
            &proxy,
            &format!(
                "PUT /avatars/me?pt={token} HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(unauthorized.starts_with("HTTP/1.1 401"), "{unauthorized}");

        for request in [
            format!("PUT /avatars/me HTTP/1.1\r\nHost: x\r\nX-RosTalk-Proxy-Token: {token}\r\nContent-Type: image/png\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
            format!("DELETE /avatars/me HTTP/1.1\r\nHost: x\r\nX-RosTalk-Proxy-Token: {token}\r\nConnection: close\r\n\r\n"),
            format!("GET /avatars/{hash} HTTP/1.1\r\nHost: x\r\nX-RosTalk-Proxy-Token: {token}\r\nConnection: close\r\n\r\n"),
        ] {
            let response = ask(&proxy, &request).await;
            assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        }

        // Stage P27: the cross-user reset route was removed on the server, and
        // the proxy no longer has a route for it either. An old page cannot
        // reach the server through the proxy.
        let legacy_reset = ask(
            &proxy,
            &format!(
                "DELETE /members/7/avatar HTTP/1.1\r\nHost: x\r\nX-RosTalk-Proxy-Token: {token}\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(legacy_reset.starts_with("HTTP/1.1 404"), "{legacy_reset}");
        assert!(legacy_reset.contains("not_found"), "{legacy_reset}");

        for path in [
            "/avatars/../admin",
            "/members/7/avatar/extra",
            "/avatars/ME",
            "/avatars/9f86d0",
        ] {
            let response = ask(
                &proxy,
                &format!(
                    "GET {path} HTTP/1.1\r\nHost: x\r\nX-RosTalk-Proxy-Token: {token}\r\nConnection: close\r\n\r\n"
                ),
            )
            .await;
            assert!(response.starts_with("HTTP/1.1 404"), "{path}: {response}");
        }

        let requests = capture.lock().expect("capture").clone();
        assert_eq!(
            requests.len(),
            3,
            "a refused route reached the server: {requests:?}"
        );
        assert!(
            requests.iter().all(|line| !line.contains("/members/")),
            "{requests:?}"
        );
    }

    #[tokio::test]
    async fn a_declared_avatar_over_four_mebibytes_is_refused_before_connecting() {
        // The mock has a real certificate but is never reached.
        let (authority, fingerprint) = mock_upstream(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
        )
        .await;
        let link = InviteLink::parse(&format!(
            "rostalk://join?host={authority}&fp={}",
            hex::encode(fingerprint)
        ))
        .expect("link");
        let proxy = ChatProxy::start(link, fingerprint, "session-token".to_owned(), 25 << 20)
            .await
            .expect("proxy");
        let token = proxy.token().to_owned();
        let response = ask(
            &proxy,
            &format!(
                "PUT /avatars/me HTTP/1.1\r\nHost: x\r\nX-RosTalk-Proxy-Token: {token}\r\nContent-Type: image/png\r\nContent-Length: 4194305\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 413"), "{response}");
        assert!(response.contains("file_too_large"), "{response}");
    }

    #[test]
    fn upstream_target_keeps_the_real_parameters_and_drops_the_proxy_token() {
        assert_eq!(
            upstream_target("/chat/history", "channelId=4&cursor=777&limit=50&pt=secret"),
            "/api/v1/chat/history?channelId=4&cursor=777&limit=50"
        );
        assert_eq!(
            upstream_target("/chat/attachments/9", "pt=secret"),
            "/api/v1/chat/attachments/9"
        );
        assert_eq!(
            upstream_target("/chat/attachments/9", "pt=secret&limit=10&cursor=a%20b"),
            "/api/v1/chat/attachments/9?limit=10&cursor=a+b"
        );
        assert_eq!(
            upstream_target("/chat/attachments/9", "ptx=secret&pt=other"),
            "/api/v1/chat/attachments/9?ptx=secret"
        );
        assert_eq!(upstream_target("/chat/history", ""), "/api/v1/chat/history");
    }

    #[tokio::test]
    async fn the_proxy_never_forwards_its_token_to_the_server() {
        let capture = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (authority, fingerprint) = mock_upstream_capturing(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
            Some(capture.clone()),
        )
        .await;
        let link = InviteLink::parse(&format!(
            "rostalk://join?host={authority}&fp={}",
            hex::encode(fingerprint)
        ))
        .expect("link");
        let proxy = ChatProxy::start(link, fingerprint, "session-token".to_owned(), 1 << 20)
            .await
            .expect("proxy");
        let token = proxy.token().to_owned();

        let history = ask(
            &proxy,
            &format!(
                "GET /chat/history?channelId=4&cursor=777&limit=50&pt={token} HTTP/1.1\r\nHost: x\r\nX-RosTalk-Proxy-Token: {token}\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(history.starts_with("HTTP/1.1 200"), "{history}");

        let attachment = ask(
            &proxy,
            &format!(
                "GET /chat/attachments/9?pt={token}&limit=10 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(attachment.starts_with("HTTP/1.1 200"), "{attachment}");

        let requests = capture.lock().expect("capture").clone();
        assert_eq!(requests.len(), 2, "{requests:?}");
        let first = requests[0].lines().next().unwrap_or_default();
        let second = requests[1].lines().next().unwrap_or_default();
        assert_eq!(
            first,
            "GET /api/v1/chat/history?channelId=4&cursor=777&limit=50 HTTP/1.1"
        );
        assert_eq!(second, "GET /api/v1/chat/attachments/9?limit=10 HTTP/1.1");
        for request in &requests {
            assert!(
                !request.contains("pt="),
                "the proxy token leaked: {request}"
            );
            assert!(
                !request.contains(&token),
                "the proxy token leaked: {request}"
            );
        }
    }

    #[tokio::test]
    async fn a_declared_body_over_the_limit_is_refused_before_connecting() {
        // The mock is never reached: the check uses only the head.
        let (authority, fingerprint) = mock_upstream(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
        )
        .await;
        let link = InviteLink::parse(&format!(
            "rostalk://join?host={authority}&fp={}",
            hex::encode(fingerprint)
        ))
        .expect("link");
        let proxy = ChatProxy::start(link, fingerprint, "session-token".to_owned(), 1024)
            .await
            .expect("proxy");
        let token = proxy.token().to_owned();
        let response = ask(
            &proxy,
            &format!(
                "POST /chat/attachments?channelId=4 HTTP/1.1\r\nHost: x\r\nX-RosTalk-Proxy-Token: {token}\r\nContent-Type: application/octet-stream\r\nContent-Length: 4096\r\nConnection: close\r\n\r\nabcdef"
            ),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 413"), "{response}");
        assert!(response.contains("file_too_large"), "{response}");
    }

    /// The response body must arrive before the upstream has finished sending
    /// it. The old proxy collected `Content-Length` bytes first, which is what
    /// made a video wait for the whole file.
    #[tokio::test]
    async fn a_slow_response_is_streamed_in_parts() {
        let (authority, fingerprint) = mock_upstream_scripted(vec![
            "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 8\r\n\r\nABCD"
                .to_owned(),
            String::new(), // a pause before the second half
            "EFGH".to_owned(),
        ])
        .await;
        let link = InviteLink::parse(&format!(
            "rostalk://join?host={authority}&fp={}",
            hex::encode(fingerprint)
        ))
        .expect("link");
        let proxy = ChatProxy::start(link, fingerprint, "session-token".to_owned(), 1 << 20)
            .await
            .expect("proxy");
        let address = proxy.base_url().trim_start_matches("http://").to_owned();
        let token = proxy.token().to_owned();

        let mut stream = TcpStream::connect(&address).await.expect("connect");
        stream
            .write_all(
                format!(
                    "GET /chat/attachments/3?pt={token} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .expect("write");

        // The first four body bytes are already there while the upstream is
        // still sleeping. Waiting for the complete exchange would hide this.
        // Headers and the first body chunk may arrive in separate reads, so
        // collect until the body prefix is visible, but only within 400 ms:
        // the rest is sent at 500 ms.
        let mut first = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(400);
        loop {
            let mut chunk = [0u8; 256];
            let read = tokio::time::timeout_at(deadline, stream.read(&mut chunk))
                .await
                .expect("the first part arrived before the upstream finished")
                .expect("read");
            if read == 0 {
                break;
            }
            first.extend_from_slice(&chunk[..read]);
            if first.windows(4).any(|window| window == b"ABCD") {
                break;
            }
        }
        let first = String::from_utf8_lossy(&first).into_owned();
        assert!(first.contains("HTTP/1.1 200"), "{first}");
        assert!(first.contains("ABCD"), "{first}");

        let mut rest = Vec::new();
        let _ = stream.read_to_end(&mut rest).await;
        let rest = String::from_utf8_lossy(&rest).into_owned();
        assert!(rest.contains("EFGH"), "{rest}");
    }

    /// A large upload is relayed frame by frame; the upstream receives the
    /// same bytes and the declared length, without the proxy buffering it all.
    #[tokio::test]
    async fn a_large_upload_reaches_the_upstream_intact() {
        let (authority, fingerprint) = mock_recording_upload().await;
        let link = InviteLink::parse(&format!(
            "rostalk://join?host={authority}&fp={}",
            hex::encode(fingerprint)
        ))
        .expect("link");
        let max = 8 << 20;
        let proxy = ChatProxy::start(link, fingerprint, "session-token".to_owned(), max)
            .await
            .expect("proxy");
        let token = proxy.token().to_owned();
        let body = vec![0x5au8; 4 << 20];

        let mut request = format!(
            "POST /chat/attachments?channelId=4&name=clip.mp4 HTTP/1.1\r\nHost: x\r\nX-RosTalk-Proxy-Token: {token}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        request.extend_from_slice(&body);
        let response = ask_bytes(&proxy, request).await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(
            response.contains(&format!("\"received\":{}", body.len())),
            "{response}"
        );
    }

    /// A body that stops arriving must fail on the idle timeout, not hang and
    /// not be killed simply because the whole transfer is large.
    #[tokio::test]
    async fn a_stalled_body_hits_the_idle_timeout() {
        let (client, mut upstream) = tokio::io::duplex(64);
        upstream.write_all(b"abc").await.expect("write");
        let (frames, _receiver) = mpsc::channel(4);
        let started = std::time::Instant::now();
        let error = pump_body(
            client,
            Vec::new(),
            Some(8),
            false,
            frames,
            Duration::from_millis(60),
        )
        .await
        .expect_err("a stalled body must time out");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    /// A live but slow body is not killed: the timeout is per read, so three
    /// chunks that each arrive within the window complete successfully.
    #[tokio::test]
    async fn a_slow_but_live_body_completes() {
        let (client, mut upstream) = tokio::io::duplex(64);
        let (frames, mut receiver) = mpsc::channel(8);
        let pump = tokio::spawn(async move {
            pump_body(
                client,
                Vec::new(),
                Some(6),
                false,
                frames,
                Duration::from_millis(200),
            )
            .await
        });
        for _ in 0..6 {
            upstream.write_all(b"x").await.expect("write");
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        drop(upstream);
        pump.await.expect("join").expect("pump");
        let mut received = 0;
        while let Some(frame) = receiver.recv().await {
            if let Ok(frame) = frame {
                received += frame.data_ref().map_or(0, Bytes::len);
            }
        }
        assert_eq!(received, 6);
    }

    #[tokio::test]
    async fn the_proxy_authenticates_every_route_and_hardens_attachments() {
        let (authority, fingerprint) = mock_upstream(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Disposition: inline\r\nContent-Length: 11\r\n\r\n<h1>hi</h1>",
        )
        .await;
        let link = InviteLink::parse(&format!(
            "rostalk://join?host={authority}&fp={}",
            hex::encode(fingerprint)
        ))
        .expect("link");
        let proxy = ChatProxy::start(link, fingerprint, "session-token".to_owned(), 1 << 20)
            .await
            .expect("proxy");
        let token = proxy.token().to_owned();

        let unauthorized = ask(
            &proxy,
            "GET /chat/history HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(unauthorized.starts_with("HTTP/1.1 401"), "{unauthorized}");

        // The query token is accepted for an image, not for a page request.
        let query_on_history = ask(
            &proxy,
            &format!(
                "GET /chat/history?pt={token} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(
            query_on_history.starts_with("HTTP/1.1 401"),
            "{query_on_history}"
        );

        // A traversal path is not an attachment, so the query token cannot
        // authenticate it; with the header token it is routed but rejected.
        let query_traversal = ask(
            &proxy,
            &format!(
                "GET /chat/attachments/../admin?pt={token} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(
            query_traversal.starts_with("HTTP/1.1 401"),
            "{query_traversal}"
        );
        let traversal = ask(
            &proxy,
            &format!(
                "GET /chat/attachments/../admin HTTP/1.1\r\nHost: x\r\nX-RosTalk-Proxy-Token: {token}\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(traversal.starts_with("HTTP/1.1 404"), "{traversal}");

        let attachment = ask(
            &proxy,
            &format!(
                "GET /chat/attachments/7?pt={token} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(attachment.starts_with("HTTP/1.1 200"), "{attachment}");
        let lower = attachment.to_ascii_lowercase();
        assert!(
            lower.contains("content-disposition: attachment"),
            "{attachment}"
        );
        assert!(
            lower.contains("content-security-policy: default-src 'none'; sandbox"),
            "{attachment}"
        );
        assert!(
            lower.contains("x-content-type-options: nosniff"),
            "{attachment}"
        );
        assert!(attachment.ends_with("<h1>hi</h1>"), "{attachment}");
        // No `Origin` header (an `<img>`): no CORS grant at all.
        assert!(
            !lower.contains("access-control-allow-origin"),
            "{attachment}"
        );

        let allowed = ask(
            &proxy,
            &format!(
                "GET /chat/attachments/7?pt={token} HTTP/1.1\r\nHost: x\r\nOrigin: http://tauri.localhost\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        let allowed_lower = allowed.to_ascii_lowercase();
        assert!(
            allowed_lower.contains("access-control-allow-origin: http://tauri.localhost"),
            "{allowed}"
        );

        let denied = ask(
            &proxy,
            &format!(
                "GET /chat/attachments/7?pt={token} HTTP/1.1\r\nHost: x\r\nOrigin: http://evil.example\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(
            !denied
                .to_ascii_lowercase()
                .contains("access-control-allow-origin"),
            "{denied}"
        );

        // A preflight from the App origin is still answered.
        let preflight = ask(
            &proxy,
            "OPTIONS /chat/history HTTP/1.1\r\nHost: x\r\nOrigin: http://tauri.localhost\r\nAccess-Control-Request-Method: GET\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(preflight.starts_with("HTTP/1.1 204"), "{preflight}");
        let preflight_lower = preflight.to_ascii_lowercase();
        assert!(
            preflight_lower.contains("access-control-allow-origin: http://tauri.localhost"),
            "{preflight}"
        );
        assert!(
            preflight_lower
                .contains("access-control-allow-methods: get, post, put, delete, options"),
            "{preflight}"
        );
    }

    /// Range and the partial-content headers must reach the page unchanged;
    /// without them `<video>` cannot seek.
    #[tokio::test]
    async fn range_requests_and_partial_responses_are_forwarded() {
        let capture = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (authority, fingerprint) = mock_upstream_capturing(
            "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Length: 4\r\nContent-Range: bytes 4-7/8\r\nAccept-Ranges: bytes\r\n\r\nEFGH",
            Some(capture.clone()),
        )
        .await;
        let link = InviteLink::parse(&format!(
            "rostalk://join?host={authority}&fp={}",
            hex::encode(fingerprint)
        ))
        .expect("link");
        let proxy = ChatProxy::start(link, fingerprint, "session-token".to_owned(), 1 << 20)
            .await
            .expect("proxy");
        let token = proxy.token().to_owned();
        let response = ask(
            &proxy,
            &format!(
                "GET /chat/attachments/5?pt={token} HTTP/1.1\r\nHost: x\r\nRange: bytes=4-7\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 206"), "{response}");
        let lower = response.to_ascii_lowercase();
        assert!(lower.contains("content-range: bytes 4-7/8"), "{response}");
        assert!(lower.contains("accept-ranges: bytes"), "{response}");
        assert!(response.ends_with("EFGH"), "{response}");

        let requests = capture.lock().expect("capture").clone();
        assert_eq!(requests.len(), 1);
        assert!(
            requests[0]
                .to_ascii_lowercase()
                .contains("range: bytes=4-7"),
            "the Range header did not reach the server: {}",
            requests[0]
        );
    }

    /// Minimal pinned TLS upstream that answers every request with `response`.
    async fn mock_upstream(response: &'static str) -> (String, [u8; 32]) {
        mock_upstream_capturing(response, None).await
    }

    /// Same, recording every request head it receives, for assertions about
    /// what the proxy actually forwards to the server.
    async fn mock_upstream_capturing(
        response: impl Into<String>,
        capture: Option<Arc<std::sync::Mutex<Vec<String>>>>,
    ) -> (String, [u8; 32]) {
        let response: Arc<str> = Arc::from(response.into());
        let certified =
            rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).expect("certificate");
        let certificate = certified.cert.der().clone();
        let fingerprint = crate::link::leaf_fingerprint(certificate.as_ref());
        let key = rustls::pki_types::PrivateKeyDer::Pkcs8(
            rustls::pki_types::PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der()),
        );
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("protocol versions")
            .with_no_client_auth()
            .with_single_cert(vec![certificate], key)
            .expect("server config");
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let address = listener.local_addr().expect("address");
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let acceptor = acceptor.clone();
                let capture = capture.clone();
                let response = response.clone();
                tokio::spawn(async move {
                    let Ok(mut tls) = acceptor.accept(stream).await else {
                        return;
                    };
                    let mut buffer = vec![0u8; 8192];
                    let read = tls.read(&mut buffer).await.unwrap_or(0);
                    if let Some(capture) = capture {
                        let head = String::from_utf8_lossy(&buffer[..read]).into_owned();
                        capture.lock().expect("capture").push(head);
                    }
                    let _ = tls.write_all(response.as_bytes()).await;
                    let _ = tls.shutdown().await;
                });
            }
        });
        (address.to_string(), fingerprint)
    }

    /// Upstream that writes the given pieces with a pause between them, so a
    /// test can observe the first bytes before the whole response exists.
    async fn mock_upstream_scripted(parts: Vec<String>) -> (String, [u8; 32]) {
        let certified =
            rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).expect("certificate");
        let certificate = certified.cert.der().clone();
        let fingerprint = crate::link::leaf_fingerprint(certificate.as_ref());
        let key = rustls::pki_types::PrivateKeyDer::Pkcs8(
            rustls::pki_types::PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der()),
        );
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("protocol versions")
            .with_no_client_auth()
            .with_single_cert(vec![certificate], key)
            .expect("server config");
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let address = listener.local_addr().expect("address");
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let acceptor = acceptor.clone();
                let parts = parts.clone();
                tokio::spawn(async move {
                    let Ok(mut tls) = acceptor.accept(stream).await else {
                        return;
                    };
                    let mut buffer = vec![0u8; 8192];
                    let _ = tls.read(&mut buffer).await;
                    for (index, part) in parts.iter().enumerate() {
                        if index == 1 {
                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
                        let _ = tls.write_all(part.as_bytes()).await;
                        let _ = tls.flush().await;
                    }
                    let _ = tls.shutdown().await;
                });
            }
        });
        (address.to_string(), fingerprint)
    }

    /// Upstream that reads the full upload declared by Content-Length and
    /// answers with how many bytes it received.
    async fn mock_recording_upload() -> (String, [u8; 32]) {
        let certified =
            rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).expect("certificate");
        let certificate = certified.cert.der().clone();
        let fingerprint = crate::link::leaf_fingerprint(certificate.as_ref());
        let key = rustls::pki_types::PrivateKeyDer::Pkcs8(
            rustls::pki_types::PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der()),
        );
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("protocol versions")
            .with_no_client_auth()
            .with_single_cert(vec![certificate], key)
            .expect("server config");
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let address = listener.local_addr().expect("address");
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(mut tls) = acceptor.accept(stream).await else {
                        return;
                    };
                    let mut head = Vec::new();
                    let mut buffer = [0u8; 4096];
                    let head_end = loop {
                        if let Some(position) = find_head_end(&head) {
                            break position;
                        }
                        let read = tls.read(&mut buffer).await.unwrap_or(0);
                        if read == 0 {
                            return;
                        }
                        head.extend_from_slice(&buffer[..read]);
                    };
                    let head_text = String::from_utf8_lossy(&head[..head_end]).into_owned();
                    let length = head_text
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    let mut received = head.len() - (head_end + 4);
                    while received < length {
                        let read = tls.read(&mut buffer).await.unwrap_or(0);
                        if read == 0 {
                            return;
                        }
                        received += read;
                    }
                    let body = format!("{{\"received\":{received}}}");
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = tls.write_all(response.as_bytes()).await;
                    let _ = tls.shutdown().await;
                });
            }
        });
        (address.to_string(), fingerprint)
    }

    /// Sends one raw HTTP/1.1 request to the loopback proxy and reads the reply.
    async fn ask(proxy: &ChatProxy, request: &str) -> String {
        ask_bytes(proxy, request.as_bytes().to_vec()).await
    }

    async fn ask_bytes(proxy: &ChatProxy, request: Vec<u8>) -> String {
        let address = proxy.base_url().trim_start_matches("http://").to_owned();
        let exchange = async {
            let mut stream = TcpStream::connect(&address).await.expect("connect");
            stream.write_all(&request).await.expect("write");
            let mut reply = Vec::new();
            let _ = stream.read_to_end(&mut reply).await;
            String::from_utf8_lossy(&reply).into_owned()
        };
        tokio::time::timeout(IO_TIMEOUT, exchange)
            .await
            .expect("the proxy answered")
    }
}
