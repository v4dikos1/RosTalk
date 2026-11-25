//! The connection engine: one worker task owns the WebSocket, the state store
//! and reconnection. IPC commands only send messages to it.
//!
//! Behaviour required by stage 2.2:
//! - `Hello -> Challenge -> Authenticate -> Welcome`, protocol version checked
//!   in `Welcome` with a readable error for an outdated client;
//! - client pings and liveness detection;
//! - an established session that drops is retried with increasing backoff and
//!   a fresh snapshot on every successful reconnect (design 4.6);
//! - the previous channel is re-joined after a reconnect when possible;
//! - a self-move (a moderator move or an eviction) requests fresh voice
//!   credentials for the new channel without joining it again;
//! - media credentials stay in this module's memory and are renewed with
//!   `RequestMediaCredentials`, never with a second `JoinChannel`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use rostalk_platform::Identity;
use tokio::sync::{mpsc, oneshot};

use crate::error::{CoreError, CoreErrorCode, ServerErrorCode};
use crate::identity::IdentityProvider;
use crate::link::{self, InviteLink};
use crate::model::{
    self, BookmarkLogin, ChatProxyView, ChatTarget, ConnectionPhase, CoreEvent, CoreState,
    ReconnectInfo, ServerProbeView, StateDelta,
};
use crate::proto;
use crate::protocol::{self, HelloParams, Incoming, Session};
use crate::proxy::ChatProxy;
use crate::settings::{
    ClientSettings, ParticipantSettings, ProfileView, SettingsStore, VoicePreferences,
};
use crate::state::{BookmarkStore, StateStore};
use crate::stream_proxy::StreamProxy;

/// How long an IPC request waits for the server's reply.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Client ping interval.
const PING_INTERVAL: Duration = Duration::from_secs(20);
/// A ping without any inbound frame for this long marks the socket dead.
const PONG_TIMEOUT: Duration = Duration::from_secs(15);
/// Media credentials are renewed this long before they expire.
const MEDIA_RENEW_MARGIN: Duration = Duration::from_secs(15);
/// Retry delay after a failed media renewal.
const MEDIA_RETRY_DELAY: Duration = Duration::from_secs(10);
/// Maximum reconnect delay.
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// How often the worker checks the media renewal deadline.
const MEDIA_TICK: Duration = Duration::from_secs(5);

/// How long the voice credentials survive a dropped control connection.
///
/// The server keeps the media participants for `control.DefaultDisconnectGrace`
/// (10 s) so a client that reconnects quickly keeps its audio session. The core
/// must do the same: clearing the credentials at the first TCP error would tear
/// the room down and make a short network change an audible leave/join, even
/// though the LiveKit engine is able to restart ICE and resume within its own
/// 60 s window. Once the hold expires, the media session is closed so a stale
/// participant does not linger in the room.
const MEDIA_HOLD_AFTER_DROP: Duration = Duration::from_secs(10);

/// How long a handshake that was dropped after `Authenticate` may still be
/// registered by the server.
///
/// The client abandons a stuck handshake after [`protocol::HANDSHAKE_TIMEOUT`]
/// while the server keeps it for [`protocol::SERVER_HANDSHAKE_BUDGET`]. A
/// connection the client gave up on can therefore be registered seconds later
/// and replace the session the client is really using: the server then answers
/// this session with `SESSION_REPLACED` even though the replacement came from
/// the client's own earlier attempt. Such a replacement must reconnect, not
/// stop the client; a genuine login from another device arrives without a
/// freshly abandoned handshake and stays fatal.
const LATE_HANDSHAKE_GRACE: Duration = Duration::from_secs(35);

/// What to connect to (ADR 0008).
#[derive(Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum ConnectTarget {
    /// `rostalk://join?host=...&fp=...&invite=...` from an invitation. The link
    /// carries the certificate fingerprint, so it is trusted as before.
    Link {
        /// Invitation link, possibly without an invite for a known key.
        link: String,
    },
    /// A typed `host:port` for a server that may use a password or open login.
    ///
    /// `fingerprint` is the SHA-256 confirmed on first use (TOFU) or typed in
    /// manually. It is required for an IP host and is the identity that gets
    /// pinned; a DNS host uses Web PKI and the value is recorded for display
    /// only (ADR 0008).
    Direct {
        /// Host or `host:port` exactly as typed by the user.
        host: String,
        /// Control-plane port; 7443 when the user typed no port.
        port: u16,
        /// Confirmed leaf certificate, lowercase hex.
        fingerprint: Option<String>,
    },
}

/// Request to open a connection. `password` is used only on password-login
/// servers and is never stored or logged.
#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    /// Invitation link or a direct address.
    pub target: ConnectTarget,
    /// Display name to request on this server. Empty means "use the saved one".
    #[serde(default)]
    pub nickname: String,
    /// Server password, if the server uses password login. Never the channel
    /// password: channels are joined later with their own password.
    #[serde(default)]
    pub password: Option<String>,
    /// Accept a certificate that differs from the one saved for this host.
    ///
    /// Only a direct login can set this, and only after the user has seen the
    /// mismatch warning. The fingerprint still has to match the certificate
    /// the server actually presents (ADR 0008).
    #[serde(default)]
    pub accept_new_certificate: bool,
}

/// Optional voice-state flags; unset fields keep their current value.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatePatch {
    pub self_muted: Option<bool>,
    pub self_deafened: Option<bool>,
    pub away: Option<bool>,
}

/// Public identity data safe to show in the UI.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IdentityInfo {
    /// Ed25519 public key in lowercase hex.
    pub public_key: String,
    /// SHA-256 of the public key in lowercase hex.
    pub fingerprint: String,
}

/// Media credentials handed to the voice crate in stage 2.3.
///
/// Deliberately has no `Debug`, `Serialize` or `specta::Type`: the token and
/// URL must not reach a log, the UI or `localStorage`.
#[derive(Clone)]
pub struct VoiceMediaCredentials {
    pub url: String,
    pub room: String,
    pub token: String,
    pub participant_identity: String,
    pub channel_id: u64,
    pub expires_in_seconds: u32,
    /// Increments when a new media session starts. A renewal keeps the value,
    /// so the voice engine reconnects only when the session really changed
    /// (new channel, or a control reconnect that had to re-join the room).
    pub generation: u64,
    /// Opus max bitrate of the channel's voice profile.
    pub bitrate_bps: u64,
    /// Publish stereo (music profile).
    pub stereo: bool,
    /// Apply APM (voice profiles) or publish untouched audio (music).
    pub processing_enabled: bool,
    /// SHA-256 of the server's TLS leaf certificate, lowercase hex. The media
    /// SDK cannot pin a certificate itself, so the voice engine runs a local
    /// signalling proxy that verifies this fingerprint (ADR 0006).
    pub tls_fingerprint: String,
}

/// Everything the UI needs to connect the screen-share participant (stage 5.1).
///
/// It deliberately has no media token: the token stays in the core and the
/// loopback [`StreamProxy`](crate::stream_proxy::StreamProxy) injects it into
/// the upstream signalling URL. `url` is the local proxy URL, not the server
/// gateway.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StreamCredentialsView {
    /// `ws://127.0.0.1:<port>?pt=<proxy token>`; `livekit-client` appends the
    /// signalling path itself.
    pub url: String,
    /// Media room, for diagnostics only.
    pub room: String,
    /// `<user id>:stream`.
    pub participant_identity: String,
    /// Channel the token is bound to.
    pub channel_id: u64,
    /// Remaining token lifetime in seconds.
    pub expires_in_seconds: u32,
    /// Presets the caller may use: `720p30`, `1080p30`, and `1080p60` with the
    /// HQ permission.
    pub presets: Vec<String>,
}

/// One connection worker command.
enum Command {
    Connect {
        config: Box<ClientConfig>,
        reply: oneshot::Sender<Result<(), CoreError>>,
    },
    Disconnect {
        reply: oneshot::Sender<()>,
    },
    Request {
        payload: proto::client_frame::Payload,
        kind: RequestKind,
        reply: oneshot::Sender<Result<(), CoreError>>,
    },
    Admin {
        action: proto::AdminAction,
        reply: oneshot::Sender<Result<proto::AdminResult, CoreError>>,
    },
    StreamCredentials {
        channel_id: u64,
        reply: oneshot::Sender<Result<StreamCredentialsView, CoreError>>,
    },
}

/// Parameters of one connection attempt. Contains the private key, so it must
/// never derive `Debug`.
#[derive(Clone)]
struct ClientConfig {
    link: InviteLink,
    nickname: String,
    password: String,
    /// How this server was reached, stored in the bookmark.
    login: BookmarkLogin,
    identity: Identity,
}

struct Inner {
    state: RwLock<StateStore>,
    bookmarks: Mutex<BookmarkStore>,
    settings: Mutex<SettingsStore>,
    identity: Arc<dyn IdentityProvider>,
    events: Arc<dyn Fn(CoreEvent) + Send + Sync>,
    worker: Mutex<Option<mpsc::UnboundedSender<Command>>>,
    media: Mutex<Option<MediaSecret>>,
    /// Receives the credentials (or their removal) without exposing them to the
    /// UI. The voice engine is the only subscriber.
    media_sink: Mutex<Arc<dyn Fn(Option<VoiceMediaCredentials>) + Send + Sync>>,
    media_generation: AtomicU64,
    /// Deadline of the media hold after a dropped control connection. `None`
    /// when the media session follows the control connection directly.
    media_hold_until: Mutex<Option<Instant>>,
    /// Fingerprint of the leaf certificate of the active server (ADR 0001),
    /// used by the media signalling proxy.
    fingerprint: Mutex<String>,
    last_channel: AtomicU64,
    /// Loopback HTTP proxy for chat history, uploads and attachments. It is
    /// started after Welcome and dropped when the session ends.
    proxy: Mutex<Option<ChatProxy>>,
    /// Loopback WebSocket proxy for LiveKit signalling, started after Welcome.
    /// It owns the current screen-share media token; the UI never sees it.
    stream_proxy: Mutex<Option<StreamProxy>>,
    /// Client-side handshake deadline. `protocol::HANDSHAKE_TIMEOUT` in
    /// production; unit tests shorten it to exercise the reconnect race
    /// without waiting fifteen seconds.
    handshake_timeout_ms: AtomicU64,
    /// When handshakes were dropped after `Authenticate`. Each of them may be
    /// registered by the server later, so a `SESSION_REPLACED` inside
    /// [`LATE_HANDSHAKE_GRACE`] can be the client's own stale attempt.
    late_handshakes: Mutex<Vec<Instant>>,
}

impl Inner {
    /// Clears the session and tells the UI with a reset delta. Saved servers
    /// and the local profile stay in place: only the connection, tree, users
    /// and own connected identity go.
    fn reset(&self, error: Option<CoreError>) {
        self.clear_media();
        self.clear_stream();
        *self.proxy.lock() = None;
        *self.stream_proxy.lock() = None;
        self.last_channel.store(0, Ordering::SeqCst);
        let delta = {
            let mut state = self.state.write();
            state.clear_session();
            state.set_connection(ConnectionPhase::Disconnected, None, error.clone());
            let snapshot = state.state();
            StateDelta::Reset(model::ResetDelta {
                servers: snapshot.servers.clone(),
                active_server_id: snapshot.active_server_id.clone(),
                profile: snapshot.profile.clone(),
                error,
                protocol_version: snapshot.protocol_version,
                client_version: snapshot.client_version.clone(),
            })
        };
        (self.events)(CoreEvent::Delta(delta));
    }

    /// Drops the media credentials and tells the voice engine to leave.
    fn clear_media(&self) {
        *self.media_hold_until.lock() = None;
        let removed = self.media.lock().take();
        if removed.is_some() {
            let sink = self.media_sink.lock().clone();
            sink(None);
        }
    }

    /// Drops the screen-share credentials from the proxy. The proxy itself
    /// stays up until the session ends.
    fn clear_stream(&self) {
        if let Some(proxy) = self.stream_proxy.lock().as_ref() {
            proxy.clear_credential();
        }
    }

    /// Keeps the media session for [`MEDIA_HOLD_AFTER_DROP`] after the control
    /// connection ended. The voice engine keeps the room while the core
    /// reconnects, so a short outage is an ICE restart for the user, not a
    /// leave/join. The server keeps the participants for the same grace.
    fn hold_media(&self) {
        if self.media.lock().is_some() {
            *self.media_hold_until.lock() = Some(Instant::now() + MEDIA_HOLD_AFTER_DROP);
        }
    }

    /// Closes a media session whose hold expired. Returns true when it did.
    fn expire_media_hold(&self) -> bool {
        let expired = {
            let mut hold = self.media_hold_until.lock();
            match *hold {
                Some(deadline) if Instant::now() >= deadline => {
                    *hold = None;
                    true
                }
                _ => false,
            }
        };
        if expired {
            self.clear_media();
        }
        expired
    }

    /// The maximum time one handshake may take before the client gives up.
    fn handshake_timeout(&self) -> Duration {
        Duration::from_millis(self.handshake_timeout_ms.load(Ordering::SeqCst))
    }

    /// Remembers a handshake that was dropped after the client authenticated.
    ///
    /// The server may still finish it and register a second session for this
    /// key; stale entries are pruned on the way so the list stays tiny.
    fn note_late_handshake(&self) {
        let now = Instant::now();
        let mut entries = self.late_handshakes.lock();
        entries.retain(|at| now.duration_since(*at) <= LATE_HANDSHAKE_GRACE);
        entries.push(now);
    }

    /// Whether a dropped handshake may still have been registered by the server.
    ///
    /// Consumes the oldest marker inside the window: one abandoned handshake
    /// can register once, so each recovery needs its own leftover.
    fn take_recent_late_handshake(&self) -> bool {
        let now = Instant::now();
        let mut entries = self.late_handshakes.lock();
        entries.retain(|at| now.duration_since(*at) <= LATE_HANDSHAKE_GRACE);
        if entries.is_empty() {
            return false;
        }
        entries.remove(0);
        true
    }
}

/// Handle used by the Tauri commands. Cheap to clone.
#[derive(Clone)]
pub struct CoreHandle {
    inner: Arc<Inner>,
}

impl CoreHandle {
    /// Creates the core. Bookmarks are loaded from `data_dir`; no connection is
    /// opened until [`CoreHandle::connect`].
    pub fn new(
        identity: Arc<dyn IdentityProvider>,
        data_dir: &Path,
        events: Arc<dyn Fn(CoreEvent) + Send + Sync>,
    ) -> Result<Self, CoreError> {
        let bookmarks = BookmarkStore::open(data_dir);
        let servers = bookmarks.servers();
        let active = bookmarks.active();
        let settings = SettingsStore::open(data_dir);
        let profile_view = settings.settings().profile();
        Ok(Self {
            inner: Arc::new(Inner {
                state: RwLock::new(StateStore::new(servers, active, profile_view)),
                bookmarks: Mutex::new(bookmarks),
                settings: Mutex::new(settings),
                identity,
                events,
                worker: Mutex::new(None),
                media: Mutex::new(None),
                media_sink: Mutex::new(Arc::new(|_| {})),
                media_generation: AtomicU64::new(0),
                media_hold_until: Mutex::new(None),
                fingerprint: Mutex::new(String::new()),
                last_channel: AtomicU64::new(0),
                proxy: Mutex::new(None),
                stream_proxy: Mutex::new(None),
                handshake_timeout_ms: AtomicU64::new(
                    u64::try_from(protocol::HANDSHAKE_TIMEOUT.as_millis()).unwrap_or(u64::MAX),
                ),
                late_handshakes: Mutex::new(Vec::new()),
            }),
        })
    }

    /// Current snapshot for `get_state` and for a newly opened window.
    #[must_use]
    pub fn state(&self) -> CoreState {
        self.inner.state.read().state().clone()
    }

    /// Last self mute/deafen flags, so a restart starts the engine in the same
    /// state the user left it in (stage 2.3.1).
    #[must_use]
    pub fn voice_preferences(&self) -> VoicePreferences {
        self.inner.settings.lock().voice_preferences()
    }

    /// Opens a connection and waits for the first `Welcome`.
    ///
    /// Two entry points (ADR 0008): an invitation link, which carries the
    /// certificate fingerprint, or a typed `host:port` with a fingerprint the
    /// user confirmed. The server password is used only for password login; it
    /// is never stored, logged or put into the snapshot.
    pub async fn connect(&self, request: ConnectRequest) -> Result<CoreState, CoreError> {
        let (link, login) = self.prepare_target(&request)?;
        let host = link.authority();
        let nickname = self.resolve_nickname(&request.nickname, &host)?;

        // A direct login trusts a fingerprint the user confirmed, so a changed
        // certificate must stop here instead of silently pinning the new one.
        // An invitation link is its own out-of-band confirmation: the admin
        // sent the new fingerprint, so it replaces the saved one.
        if login == BookmarkLogin::Direct && link.mode() == crate::link::ServerMode::Pinned {
            let check = self
                .inner
                .bookmarks
                .lock()
                .check_certificate(&host, &link.fingerprint_hex());
            if let Err(error) = check {
                if !request.accept_new_certificate {
                    return Err(error);
                }
                log::info!("a changed server certificate was confirmed by the user");
            }
        }

        let identity = self.load_identity().await?;
        let config = ClientConfig {
            link,
            nickname,
            password: request.password.unwrap_or_default(),
            login,
            identity,
        };

        let sender = self.ensure_worker();
        let (reply, reply_rx) = oneshot::channel();
        sender
            .send(Command::Connect {
                config: Box::new(config),
                reply,
            })
            .map_err(|_| CoreError::internal("the connection worker is not running"))?;
        match tokio::time::timeout(REQUEST_TIMEOUT + protocol::HANDSHAKE_TIMEOUT, reply_rx).await {
            Ok(Ok(result)) => result?,
            Ok(Err(_)) => {
                return Err(CoreError::internal(
                    "the connection worker stopped before replying",
                ))
            }
            Err(_) => {
                return Err(CoreError::new(
                    CoreErrorCode::Timeout,
                    "the server did not complete the handshake in time",
                )
                .retryable(true))
            }
        }
        Ok(self.state())
    }

    /// Turns a [`ConnectTarget`] into a connection descriptor.
    ///
    /// A direct target has no out-of-band fingerprint, so an IP host is
    /// rejected without one: connecting and accepting whatever certificate
    /// arrives would silently weaken ADR 0001. The UI always probes first and
    /// passes the confirmed digest.
    fn prepare_target(
        &self,
        request: &ConnectRequest,
    ) -> Result<(InviteLink, BookmarkLogin), CoreError> {
        match &request.target {
            ConnectTarget::Link { link } => {
                let link = InviteLink::parse(link)?;
                Ok((link, BookmarkLogin::Invite))
            }
            ConnectTarget::Direct {
                host,
                port,
                fingerprint,
            } => {
                let (hostname, parsed_port) = link::parse_authority(host)?;
                // An explicit port wins; the parsed one is the default when the
                // input carried no port.
                let port = if *port == 0 { parsed_port } else { *port };
                let mode = link::mode_for_host(&hostname);
                let fingerprint = fingerprint
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty());

                let parsed = match fingerprint {
                    Some(value) => Some(link::parse_fingerprint_hex(value)?),
                    None => None,
                };
                if mode == crate::link::ServerMode::Pinned && parsed.is_none() {
                    return Err(CoreError::new(
                        CoreErrorCode::InvalidFingerprint,
                        "a direct login to an IP address needs the confirmed certificate fingerprint",
                    ));
                }
                let link = InviteLink::direct(hostname, port, parsed);
                Ok((link, BookmarkLogin::Direct))
            }
        }
    }

    /// Nickname for a new login: the request, then the one saved for this
    /// server, then the profile default. Empty everywhere is an error, so the
    /// UI asks instead of connecting with a generated name.
    fn resolve_nickname(&self, requested: &str, host: &str) -> Result<String, CoreError> {
        let requested = requested.trim();
        if !requested.is_empty() {
            return Ok(requested.to_owned());
        }
        if let Some(bookmark) = self.inner.bookmarks.lock().bookmark_for(host) {
            if !bookmark.nickname.trim().is_empty() {
                return Ok(bookmark.nickname);
            }
        }
        let profile = self.inner.settings.lock().nickname().trim().to_owned();
        if !profile.is_empty() {
            return Ok(profile);
        }
        Err(CoreError::new(
            CoreErrorCode::InvalidRequest,
            "nickname must not be empty",
        ))
    }

    /// Reads the TLS certificate a direct login would pin, without sending any
    /// credential (ADR 0008).
    ///
    /// The UI shows the digest, warns when it differs from the saved one and
    /// then connects with the confirmed value. A probe is not a login: it does
    /// not create a session, save a bookmark or reveal the local identity.
    pub async fn probe_server(&self, host: &str) -> Result<ServerProbeView, CoreError> {
        let (hostname, port) = link::parse_authority(host)?;
        let mode = link::mode_for_host(&hostname);
        let fingerprint = protocol::probe_certificate(&hostname, port).await?;
        let fingerprint_hex = hex::encode(fingerprint);
        let authority = link::authority(&hostname, port);
        let saved = self.inner.bookmarks.lock().bookmark_for(&authority);
        let (known_name, known_fingerprint, certificate_changed) = match saved {
            Some(bookmark) => {
                let changed =
                    !bookmark.fingerprint.is_empty() && bookmark.fingerprint != fingerprint_hex;
                (Some(bookmark.name), Some(bookmark.fingerprint), changed)
            }
            None => (None, None, false),
        };
        Ok(ServerProbeView {
            host: authority,
            hostname,
            port,
            mode,
            fingerprint: fingerprint_hex,
            known_name,
            known_fingerprint,
            certificate_changed,
        })
    }

    /// Closes the session and clears the tree. Saved servers are kept.
    pub async fn disconnect(&self) -> Result<(), CoreError> {
        let Some(sender) = self.worker_sender() else {
            self.clear_session(None);
            return Ok(());
        };
        let (reply, reply_rx) = oneshot::channel();
        if sender.send(Command::Disconnect { reply }).is_err() {
            self.clear_session(None);
            return Ok(());
        }
        let _ = tokio::time::timeout(Duration::from_secs(5), reply_rx).await;
        Ok(())
    }

    /// Joins a voice channel.
    pub async fn join_channel(
        &self,
        channel_id: u64,
        password: Option<String>,
    ) -> Result<(), CoreError> {
        self.request(
            proto::client_frame::Payload::JoinChannel(proto::JoinChannel {
                channel_id,
                password: password.unwrap_or_default(),
            }),
            RequestKind::Join { channel_id },
        )
        .await
    }

    /// Leaves the current channel.
    pub async fn leave_channel(&self) -> Result<(), CoreError> {
        self.request(
            proto::client_frame::Payload::LeaveChannel(proto::LeaveChannel {}),
            RequestKind::Leave,
        )
        .await
    }

    /// Posts a channel or direct message. The stored message arrives as a
    /// `messageCreated` delta; the call resolves when the server accepted it.
    pub async fn send_message(
        &self,
        target: ChatTarget,
        body: String,
        attachment_ids: Vec<u64>,
    ) -> Result<(), CoreError> {
        self.request(
            proto::client_frame::Payload::ChatSend(proto::ChatSend {
                target: Some(chat_target(target)),
                body,
                attachment_ids,
            }),
            RequestKind::Generic,
        )
        .await
    }

    /// Replaces the body of a message the caller may edit.
    pub async fn edit_message(&self, message_id: u64, body: String) -> Result<(), CoreError> {
        self.request(
            proto::client_frame::Payload::EditMessage(proto::EditMessage { message_id, body }),
            RequestKind::Generic,
        )
        .await
    }

    /// Removes a message and its attachments.
    pub async fn delete_message(&self, message_id: u64) -> Result<(), CoreError> {
        self.request(
            proto::client_frame::Payload::DeleteMessage(proto::DeleteMessage { message_id }),
            RequestKind::Generic,
        )
        .await
    }

    /// Advances the read marker of a conversation.
    pub async fn mark_read(
        &self,
        target: ChatTarget,
        up_to_message_id: u64,
    ) -> Result<(), CoreError> {
        self.request(
            proto::client_frame::Payload::MarkRead(proto::MarkRead {
                target: Some(chat_target(target)),
                up_to_message_id,
            }),
            RequestKind::Generic,
        )
        .await
    }

    /// Coordinates of the loopback chat proxy, `None` while disconnected.
    ///
    /// The page uses this URL for history, uploads and attachment reads; the
    /// server session token and the pinned certificate stay in the core.
    #[must_use]
    pub fn chat_proxy(&self) -> Option<ChatProxyView> {
        let guard = self.inner.proxy.lock();
        guard.as_ref().map(|proxy| ChatProxyView {
            base_url: proxy.base_url(),
            token: proxy.token().to_owned(),
        })
    }

    /// Changes own voice flags.
    ///
    /// The server is the authority for the presence flags. The local profile
    /// also remembers mute/deafen, so the next start and every reconnect send
    /// the same state again (tech debt of stage 2.2).
    pub async fn set_voice_state(&self, patch: VoiceStatePatch) -> Result<(), CoreError> {
        self.request(
            proto::client_frame::Payload::SetVoiceState(proto::SetVoiceState {
                self_muted: patch.self_muted,
                self_deafened: patch.self_deafened,
                away: patch.away,
            }),
            RequestKind::Generic,
        )
        .await?;
        if patch.self_muted.is_some() || patch.self_deafened.is_some() {
            let mut settings = self.inner.settings.lock();
            let current = settings.voice_preferences();
            let next = VoicePreferences {
                self_muted: patch.self_muted.unwrap_or(current.self_muted),
                self_deafened: patch.self_deafened.unwrap_or(current.self_deafened),
            };
            if let Err(error) = settings.set_voice_preferences(next) {
                // The server already accepted the flags; a profile write is not
                // worth failing the command over.
                log::warn!("could not save the voice flags: {}", error.message);
            }
        }
        Ok(())
    }

    /// Replaces the set of screen shares the caller watches (stage P12).
    ///
    /// The whole set is sent every time; the server keeps only live shares of
    /// the caller's own channel and drops the rest, so a click that races the
    /// end of a stream does not fail the request. The audience arrives back as
    /// `watchingUserIds` in the presence of every participant.
    pub async fn set_watching(&self, streamer_ids: Vec<u64>) -> Result<(), CoreError> {
        self.request(
            proto::client_frame::Payload::SetWatching(proto::SetWatching { streamer_ids }),
            RequestKind::Generic,
        )
        .await
    }

    /// Changes own nickname.
    ///
    /// While connected the change goes to the server first; if the server
    /// accepts it, the nickname is saved in the local profile and in the
    /// bookmark of the active server, so it survives a restart. While offline
    /// the command only updates the local profile: this is what the profile
    /// screen needs before the first login.
    pub async fn set_nickname(&self, nickname: String) -> Result<(), CoreError> {
        let nickname = nickname.trim().to_owned();
        if nickname.is_empty() {
            return Err(CoreError::new(
                CoreErrorCode::InvalidRequest,
                "nickname must not be empty",
            ));
        }
        let connected = self.inner.state.read().state().connection == ConnectionPhase::Connected;
        if connected {
            self.request(
                proto::client_frame::Payload::SetNickname(proto::SetNickname {
                    nickname: nickname.clone(),
                }),
                RequestKind::Generic,
            )
            .await?;
        }
        self.persist_nickname(&nickname)
    }

    /// Saves the nickname in the profile and in the active bookmark and emits
    /// the changed state to the UI.
    fn persist_nickname(&self, nickname: &str) -> Result<(), CoreError> {
        let profile = self.inner.settings.lock().set_nickname(nickname)?;
        let (active, servers) = {
            let mut bookmarks = self.inner.bookmarks.lock();
            let active = bookmarks.active();
            if let Some(id) = &active {
                bookmarks.set_nickname(id, nickname)?;
            }
            (active, bookmarks.servers())
        };
        let deltas = {
            let mut state = self.inner.state.write();
            state.set_active_server(active);
            state.set_bookmarks(servers.clone());
            vec![StateDelta::Bookmarks(servers), state.set_profile(profile)]
        };
        for delta in deltas {
            self.emit_delta(delta);
        }
        Ok(())
    }

    /// Removes a saved server.
    pub fn remove_server(&self, id: &str) -> Result<Vec<model::ServerBookmark>, CoreError> {
        let servers = self.inner.bookmarks.lock().remove(id)?;
        let delta = {
            let mut state = self.inner.state.write();
            state.set_bookmarks(servers.clone());
            if state.state().active_server_id.as_deref() == Some(id) {
                state.set_active_server(None);
            }
            StateDelta::Bookmarks(servers.clone())
        };
        self.emit_delta(delta);
        Ok(servers)
    }

    /// Current persisted settings (stages 2.3.1 and 2.4).
    #[must_use]
    pub fn settings(&self) -> ClientSettings {
        self.inner.settings.lock().settings()
    }

    /// Replaces and persists the settings, returning the sanitised value.
    ///
    /// The nickname is also mirrored into the state snapshot, so the profile
    /// screen and the next login see the same value without another round trip.
    pub fn update_settings(&self, settings: ClientSettings) -> Result<ClientSettings, CoreError> {
        let saved = self.inner.settings.lock().replace(settings)?;
        let profile = {
            let mut state = self.inner.state.write();
            state.set_profile(saved.profile())
        };
        self.emit_delta(profile);
        Ok(saved)
    }

    /// Stores local volume and mute for one user (`server_id:user_id`).
    pub fn set_participant_preference(
        &self,
        key: &str,
        volume: u8,
        muted: bool,
    ) -> Result<Vec<ParticipantSettings>, CoreError> {
        self.inner
            .settings
            .lock()
            .set_participant(key, volume, muted)
    }

    /// Finishes the first-run wizard and remembers the nickname.
    pub fn complete_onboarding(&self, nickname: &str) -> Result<ClientSettings, CoreError> {
        let saved = self.inner.settings.lock().complete_onboarding(nickname)?;
        let profile = {
            let mut state = self.inner.state.write();
            state.set_profile(ProfileView {
                nickname: saved.nickname.clone(),
            })
        };
        self.emit_delta(profile);
        Ok(saved)
    }

    /// Shows the first-run wizard again on the next start.
    pub fn reset_onboarding(&self) -> Result<ClientSettings, CoreError> {
        self.inner.settings.lock().reset_onboarding()
    }

    /// Public identity data. Creates the identity on first call.
    pub async fn identity_info(&self) -> Result<IdentityInfo, CoreError> {
        let identity = self.load_identity().await?;
        Ok(IdentityInfo {
            public_key: identity.public_key_hex(),
            fingerprint: identity.fingerprint(),
        })
    }

    /// Exports the identity into a password protected file.
    pub async fn export_identity(&self, path: String, password: String) -> Result<(), CoreError> {
        if password.is_empty() {
            return Err(CoreError::new(
                CoreErrorCode::InvalidPassword,
                "the export password must not be empty",
            ));
        }
        let provider = self.inner.identity.clone();
        tokio::task::spawn_blocking(move || provider.export_to_file(Path::new(&path), &password))
            .await
            .map_err(|err| CoreError::internal(format!("identity task failed: {err}")))??;
        Ok(())
    }

    /// Imports an identity file, replacing the stored key. The current session
    /// keeps working until the next connection.
    pub async fn import_identity(
        &self,
        path: String,
        password: String,
    ) -> Result<IdentityInfo, CoreError> {
        let provider = self.inner.identity.clone();
        let identity = tokio::task::spawn_blocking(move || {
            provider.import_from_file(Path::new(&path), &password)
        })
        .await
        .map_err(|err| CoreError::internal(format!("identity task failed: {err}")))??;
        Ok(IdentityInfo {
            public_key: identity.public_key_hex(),
            fingerprint: identity.fingerprint(),
        })
    }

    /// Voice credentials for stage 2.3. `None` while not in a channel or after
    /// they expired. Never exposed over IPC.
    #[must_use]
    pub fn voice_credentials(&self) -> Option<VoiceMediaCredentials> {
        let media = self.inner.media.lock();
        let secret = media.as_ref()?;
        if secret.expires_at <= Instant::now() {
            return None;
        }
        Some(secret.credentials.clone())
    }

    /// Asks the control plane for screen-share credentials and returns the
    /// coordinates of the loopback signalling proxy (stage 5.1).
    ///
    /// The token itself is stored in the core and installed into the proxy;
    /// this reply carries no secret. Repeated calls replace both, so the UI can
    /// reconnect after a token expiry without leaving the channel.
    pub async fn request_stream_credentials(
        &self,
        channel_id: u64,
    ) -> Result<StreamCredentialsView, CoreError> {
        let Some(sender) = self.worker_sender() else {
            return Err(CoreError::not_connected());
        };
        let (reply, reply_rx) = oneshot::channel();
        sender
            .send(Command::StreamCredentials { channel_id, reply })
            .map_err(|_| CoreError::not_connected())?;
        match tokio::time::timeout(REQUEST_TIMEOUT, reply_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(CoreError::not_connected()),
            Err(_) => Err(CoreError::new(
                CoreErrorCode::Timeout,
                "the server did not answer the stream credential request in time",
            )
            .retryable(true)),
        }
    }

    /// Wires the voice engine to media credentials.
    ///
    /// The sink receives `Some` with every new or renewed credential set and
    /// `None` when the media session ends. Credentials never travel through the
    /// IPC bridge. Calling this after a session is already up hands the current
    /// credentials to the new sink immediately.
    pub fn set_media_sink(&self, sink: Arc<dyn Fn(Option<VoiceMediaCredentials>) + Send + Sync>) {
        *self.inner.media_sink.lock() = sink.clone();
        if let Some(credentials) = self.voice_credentials() {
            sink(Some(credentials));
        }
    }

    async fn request(
        &self,
        payload: proto::client_frame::Payload,
        kind: RequestKind,
    ) -> Result<(), CoreError> {
        let Some(sender) = self.worker_sender() else {
            return Err(CoreError::not_connected());
        };
        let (reply, reply_rx) = oneshot::channel();
        sender
            .send(Command::Request {
                payload,
                kind,
                reply,
            })
            .map_err(|_| CoreError::not_connected())?;
        match tokio::time::timeout(REQUEST_TIMEOUT, reply_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(CoreError::not_connected()),
            Err(_) => Err(CoreError::new(
                CoreErrorCode::Timeout,
                "the server did not answer the request in time",
            )
            .retryable(true)),
        }
    }

    /// Sends one encoded `AdminAction` and returns the encoded `AdminResult`.
    ///
    /// The UI builds the generated protobuf message and decodes the reply, so
    /// there is no second hand-written DTO to drift from `proto/rostalk/v1`.
    /// The bytes carry no secret: an API token is created by the server and
    /// returned in the `AdminResult` only once.
    pub async fn admin_action(&self, request: Vec<u8>) -> Result<Vec<u8>, CoreError> {
        use prost::Message as _;
        if request.is_empty() {
            return Err(CoreError::new(
                CoreErrorCode::InvalidRequest,
                "the administrative request is empty",
            ));
        }
        let action = proto::AdminAction::decode(request.as_slice()).map_err(|error| {
            CoreError::new(
                CoreErrorCode::InvalidRequest,
                format!("malformed administrative request: {error}"),
            )
        })?;
        let Some(sender) = self.worker_sender() else {
            return Err(CoreError::not_connected());
        };
        let (reply, reply_rx) = oneshot::channel();
        sender
            .send(Command::Admin { action, reply })
            .map_err(|_| CoreError::not_connected())?;
        match tokio::time::timeout(REQUEST_TIMEOUT, reply_rx).await {
            Ok(Ok(result)) => result.map(|result| result.encode_to_vec()),
            Ok(Err(_)) => Err(CoreError::not_connected()),
            Err(_) => Err(CoreError::new(
                CoreErrorCode::Timeout,
                "the server did not answer the administrative request in time",
            )
            .retryable(true)),
        }
    }

    async fn load_identity(&self) -> Result<Identity, CoreError> {
        let provider = self.inner.identity.clone();
        tokio::task::spawn_blocking(move || provider.load_or_create())
            .await
            .map_err(|err| CoreError::internal(format!("identity task failed: {err}")))?
            .map_err(CoreError::from)
    }

    fn worker_sender(&self) -> Option<mpsc::UnboundedSender<Command>> {
        let guard = self.inner.worker.lock();
        guard.as_ref().filter(|sender| !sender.is_closed()).cloned()
    }

    fn ensure_worker(&self) -> mpsc::UnboundedSender<Command> {
        let mut guard = self.inner.worker.lock();
        if let Some(sender) = guard.as_ref() {
            if !sender.is_closed() {
                return sender.clone();
            }
        }
        let (sender, receiver) = mpsc::unbounded_channel();
        let worker = Worker {
            inner: self.inner.clone(),
            rx: receiver,
        };
        tokio::spawn(worker.run());
        *guard = Some(sender.clone());
        sender
    }

    fn emit_delta(&self, delta: StateDelta) {
        (self.inner.events)(CoreEvent::Delta(delta));
    }

    fn clear_session(&self, error: Option<CoreError>) {
        self.inner.reset(error);
    }
}

/// Stored media credentials plus their renewal deadline.
struct MediaSecret {
    credentials: VoiceMediaCredentials,
    expires_at: Instant,
    renew_at: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequestKind {
    Generic,
    Join {
        channel_id: u64,
    },
    Leave,
    /// Renewal of the voice token for the room the caller already occupies.
    MediaRenew {
        channel_id: u64,
    },
    /// Voice token requested after the server moved the caller: a moderator
    /// move or an automatic eviction removes the old media participant and
    /// issues no credentials of its own.
    MediaMove {
        channel_id: u64,
    },
    Rejoin,
    Stream,
}

struct PendingRequest {
    reply: Option<oneshot::Sender<Result<(), CoreError>>>,
    /// Set for `AdminAction`: the reply carries an `AdminResult` payload.
    admin: Option<oneshot::Sender<Result<proto::AdminResult, CoreError>>>,
    /// Set for a stream credential request: the reply is a view, not an ack.
    stream: Option<oneshot::Sender<Result<StreamCredentialsView, CoreError>>>,
    kind: RequestKind,
}

enum RetryWait {
    Sleep,
    Disconnected(oneshot::Sender<()>),
    Replaced(Box<ClientConfig>, oneshot::Sender<Result<(), CoreError>>),
    Shutdown,
}

enum Phase {
    Idle,
    Attempt {
        config: Box<ClientConfig>,
        reply: Option<oneshot::Sender<Result<(), CoreError>>>,
        attempt: u32,
    },
}

struct Worker {
    inner: Arc<Inner>,
    rx: mpsc::UnboundedReceiver<Command>,
}

impl Worker {
    async fn run(mut self) {
        let mut phase = Phase::Idle;
        loop {
            phase = match phase {
                Phase::Idle => match self.rx.recv().await {
                    None => return,
                    Some(Command::Connect { config, reply }) => Phase::Attempt {
                        config,
                        reply: Some(reply),
                        attempt: 0,
                    },
                    Some(Command::Disconnect { reply }) => {
                        self.clear_and_emit();
                        let _ = reply.send(());
                        Phase::Idle
                    }
                    Some(Command::Request { reply, .. }) => {
                        let _ = reply.send(Err(CoreError::not_connected()));
                        Phase::Idle
                    }
                    Some(Command::Admin { reply, .. }) => {
                        let _ = reply.send(Err(CoreError::not_connected()));
                        Phase::Idle
                    }
                    Some(Command::StreamCredentials { reply, .. }) => {
                        let _ = reply.send(Err(CoreError::not_connected()));
                        Phase::Idle
                    }
                },
                Phase::Attempt {
                    config,
                    reply,
                    attempt,
                } => match self.attempt_phase(config, reply, attempt).await {
                    Some(next) => next,
                    None => return,
                },
            };
        }
    }

    /// One connection attempt, including the backoff wait before a retry.
    /// Returns the next phase, or `None` when the worker must stop.
    async fn attempt_phase(
        &mut self,
        config: Box<ClientConfig>,
        reply: Option<oneshot::Sender<Result<(), CoreError>>>,
        attempt: u32,
    ) -> Option<Phase> {
        let mut reply = reply;
        // A new Connect is a different session (possibly a different server).
        // Never carry the previous channel or media credentials into it; only
        // an automatic reconnect of the same session may re-join the channel.
        if attempt == 0 {
            self.clear_media();
            self.inner.last_channel.store(0, Ordering::SeqCst);
        }
        if attempt > 0 {
            // The media session outlives the control connection only for the
            // server's grace window; after that the old room is stale.
            self.inner.expire_media_hold();
            let delay = backoff(attempt);
            self.set_phase(
                ConnectionPhase::Reconnecting,
                Some(ReconnectInfo {
                    attempt,
                    delay_ms: u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
                }),
                None,
            );
            match self.wait_before_retry(delay).await {
                RetryWait::Sleep => {}
                RetryWait::Disconnected(reply) => {
                    self.clear_and_emit();
                    let _ = reply.send(());
                    return Some(Phase::Idle);
                }
                RetryWait::Replaced(config, reply) => {
                    return Some(Phase::Attempt {
                        config,
                        reply: Some(reply),
                        attempt: 0,
                    });
                }
                RetryWait::Shutdown => return None,
            }
        } else {
            self.set_phase(ConnectionPhase::Connecting, None, None);
        }

        // The wait above may have been longer than the grace: close the room
        // before opening the new session instead of re-joining with stale
        // credentials.
        self.inner.expire_media_hold();
        match self.open(&config, attempt > 0).await {
            Ok(session) => {
                if let Some(reply) = reply.take() {
                    let _ = reply.send(Ok(()));
                }
                let rejoin = if attempt > 0 {
                    self.inner.last_channel.load(Ordering::SeqCst)
                } else {
                    0
                };
                Some(self.run_session(session, config, rejoin).await)
            }
            Err(error) => {
                if let Some(reply) = reply.take() {
                    let _ = reply.send(Err(error.clone()));
                }
                if attempt > 0 && error.retryable {
                    Some(Phase::Attempt {
                        config,
                        reply: None,
                        attempt: attempt + 1,
                    })
                } else {
                    self.fail(&error);
                    Some(Phase::Idle)
                }
            }
        }
    }

    /// Opens the session and publishes the fresh snapshot.
    ///
    /// On a reconnect the nickname is deliberately empty: the server already
    /// knows this key and substitutes the nickname saved in its database. That
    /// keeps a `SetNickname` from being rolled back and avoids a pointless
    /// nickname conflict when the old one was taken in the meantime.
    async fn open(&self, config: &ClientConfig, reconnect: bool) -> Result<Session, CoreError> {
        let nickname = if reconnect {
            ""
        } else {
            config.nickname.as_str()
        };
        let authenticate_sent = AtomicBool::new(false);
        let session = protocol::connect(
            config.link.clone(),
            &config.identity,
            HelloParams {
                nickname,
                password: &config.password,
            },
            self.inner.handshake_timeout(),
            &authenticate_sent,
        )
        .await;

        // A handshake dropped after `Authenticate` may still be registered by
        // the server later. Remember it so a replacement that follows is not
        // mistaken for a login from another device (see `end_session`).
        let session = match session {
            Ok(session) => session,
            Err(error) => {
                // A server `Error` reply means the handshake was rejected and
                // nothing was registered; `InvalidRequest` means a reply did
                // arrive. Only a timeout or a transport failure can leave a
                // registration the client never saw.
                let may_have_registered = authenticate_sent.load(Ordering::SeqCst)
                    && error.server_code.is_none()
                    && matches!(
                        error.code,
                        CoreErrorCode::Timeout | CoreErrorCode::ConnectionFailed
                    );
                if may_have_registered {
                    self.inner.note_late_handshake();
                }
                return Err(error);
            }
        };

        // The certificate this session really used: the pinned one, or the
        // actual leaf on a Web PKI domain deployment. The media signalling
        // proxy pins exactly this digest (ADR 0006).
        let fingerprint = hex::encode(session.tls_fingerprint());
        *self.inner.fingerprint.lock() = fingerprint.clone();

        let welcome = session.welcome();
        let snapshot = welcome.snapshot.as_ref().ok_or_else(|| {
            CoreError::new(CoreErrorCode::InvalidRequest, "Welcome has no snapshot")
        })?;
        let server = snapshot
            .server
            .as_ref()
            .map(model::server_view)
            .ok_or_else(|| {
                CoreError::new(CoreErrorCode::InvalidRequest, "Welcome has no server info")
            })?;

        // Identity binding first: never save or show a server whose key changed
        // under the certificate we already pinned (ADR 0004).
        self.inner
            .bookmarks
            .lock()
            .check_server_identity(&config.link, &server.id)?;

        // The nickname the server actually applied: on a reconnect the client
        // sends an empty one and the server substitutes the saved name.
        let accepted = snapshot
            .users
            .iter()
            .find(|user| user.id == welcome.self_user_id)
            .map(|user| user.nickname.clone())
            .unwrap_or_default();
        let nickname = if accepted.is_empty() {
            config.nickname.clone()
        } else {
            accepted
        };

        // Bookmark store first, then the state store: the same order as
        // `remove_server`, so the two locks cannot deadlock.
        let (servers, active) = {
            let mut bookmarks = self.inner.bookmarks.lock();
            let servers = bookmarks.remember_connected(
                &config.link,
                &server,
                config.login,
                &nickname,
                &fingerprint,
            )?;
            (servers, bookmarks.active())
        };
        {
            let mut state = self.inner.state.write();
            state.apply_snapshot(snapshot, welcome.self_user_id, ConnectionPhase::Connected);
            state.set_bookmarks(servers);
            state.set_active_server(active);
        }
        // The profile keeps the last accepted nickname, so the first login asks
        // once and the profile screen can pre-fill it after a restart.
        if !nickname.trim().is_empty() {
            match self.inner.settings.lock().set_nickname(&nickname) {
                Ok(profile) => {
                    self.inner.state.write().set_profile(profile);
                }
                Err(error) => {
                    // A nickname the server accepted is not the place to stop a
                    // working connection; log without the value.
                    log::warn!("could not save the profile nickname: {}", error.message);
                }
            }
        }
        // The attachment limit comes from the server snapshot (stage P3). The
        // proxy uses it as the ceiling for an upload, so the page and the
        // server cannot disagree about what is too large.
        let max_upload = snapshot
            .server
            .as_ref()
            .map(|server| server.max_attachment_bytes)
            .filter(|value| *value > 0)
            .unwrap_or_else(crate::proxy::default_max_upload);
        // A fresh snapshot never carries presence after a restart, so only
        // overwrite the remembered channel when the server already knows one.
        let own_channel = self.inner.state.read().own_channel_id();
        if own_channel != 0 {
            self.inner.last_channel.store(own_channel, Ordering::SeqCst);
        }

        let snapshot = self.inner.state.read().state().clone();
        (self.inner.events)(CoreEvent::Snapshot(Box::new(snapshot)));
        let token = session.welcome().http_token.clone();
        self.start_chat_proxy(&config.link, session.tls_fingerprint(), token, max_upload)
            .await;
        self.start_stream_proxy(&config.link, session.tls_fingerprint())
            .await;
        Ok(session)
    }

    /// Starts the loopback chat proxy for this session. A failure is not fatal
    /// for voice: chat history and uploads report "unavailable" until the next
    /// reconnect.
    async fn start_chat_proxy(
        &self,
        link: &InviteLink,
        fingerprint: [u8; 32],
        token: String,
        max_upload: u64,
    ) {
        if token.is_empty() {
            *self.inner.proxy.lock() = None;
            return;
        }
        match ChatProxy::start(link.clone(), fingerprint, token, max_upload).await {
            Ok(proxy) => {
                *self.inner.proxy.lock() = Some(proxy);
            }
            Err(error) => {
                *self.inner.proxy.lock() = None;
                log::warn!("could not start the chat proxy: {}", error.message);
            }
        }
    }

    /// Starts the loopback screen-share signalling proxy for this session.
    /// A failure only disables screen sharing; voice and chat keep working.
    async fn start_stream_proxy(&self, link: &InviteLink, fingerprint: [u8; 32]) {
        match StreamProxy::start(link.clone(), fingerprint).await {
            Ok(proxy) => {
                *self.inner.stream_proxy.lock() = Some(proxy);
            }
            Err(error) => {
                *self.inner.stream_proxy.lock() = None;
                log::warn!("could not start the stream proxy: {}", error.message);
            }
        }
    }

    /// Runs one authenticated session until it ends, returning the next phase.
    async fn run_session(
        &mut self,
        mut session: Session,
        config: Box<ClientConfig>,
        rejoin: u64,
    ) -> Phase {
        let mut pending: HashMap<u64, PendingRequest> = HashMap::new();
        let mut ping_tick = tokio::time::interval(PING_INTERVAL);
        ping_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ping_tick.tick().await; // the first tick fires immediately
        let mut media_tick = tokio::time::interval(MEDIA_TICK);
        media_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        media_tick.tick().await;
        let mut awaiting_pong: Option<Instant> = None;

        // A new session starts with the server's default flags. Restore the
        // local mute/deafen state on every session, including a reconnect:
        // other users must see the same state the user left (stage 2.3.1).
        let voice_flags = voice_flags_request(self.inner.settings.lock().voice_preferences());
        if let Some(flags) = voice_flags {
            match session
                .send(proto::client_frame::Payload::SetVoiceState(flags))
                .await
            {
                Ok(id) => {
                    pending.insert(
                        id,
                        PendingRequest {
                            reply: None,
                            admin: None,
                            stream: None,
                            kind: RequestKind::Generic,
                        },
                    );
                }
                Err(error) => log::warn!("could not restore the voice flags: {}", error.message),
            }
        }

        if rejoin != 0 {
            match session
                .send(proto::client_frame::Payload::JoinChannel(
                    proto::JoinChannel {
                        channel_id: rejoin,
                        password: String::new(),
                    },
                ))
                .await
            {
                Ok(id) => {
                    pending.insert(
                        id,
                        PendingRequest {
                            reply: None,
                            admin: None,
                            stream: None,
                            kind: RequestKind::Rejoin,
                        },
                    );
                }
                Err(error) => {
                    // Non-fatal: the user stays connected and can re-join from
                    // the tree.
                    log::warn!(
                        "could not rejoin channel after reconnect: {}",
                        error.message
                    );
                }
            }
        }

        let next = loop {
            tokio::select! {
                incoming = session.next() => {
                    match incoming {
                        Ok(Incoming::Pong) => awaiting_pong = None,
                        Ok(Incoming::Frame(frame)) => {
                            // Any inbound frame proves the connection is alive.
                            awaiting_pong = None;
                            let mut outbound = Vec::new();
                            let handled = self.handle_frame(frame, &mut pending, &mut outbound);
                            if handled.is_ok() {
                                for (payload, kind) in outbound {
                                    match session.send(payload).await {
                                        Ok(id) => {
                                            pending.insert(id, PendingRequest {
                                                reply: None,
                                                admin: None,
                                                stream: None,
                                                kind,
                                            });
                                        }
                                        Err(error) => {
                                            // Non-fatal: the next move or a
                                            // reconnect retries the request.
                                            log::debug!(
                                                "could not request voice credentials after a move: {}",
                                                error.message
                                            );
                                        }
                                    }
                                }
                            }
                            if let Err(error) = handled {
                                break self.end_session(error, &config);
                            }
                        }
                        Err(error) => {
                            break self.end_session(error, &config);
                        }
                    }
                }
                command = self.rx.recv() => {
                    match command {
                        None => break Phase::Idle,
                        Some(Command::Disconnect { reply }) => {
                            let _ = reply.send(());
                            self.inner.reset(None);
                            break Phase::Idle;
                        }
                        Some(Command::Connect { config, reply }) => {
                            self.clear_media();
                            self.inner.last_channel.store(0, Ordering::SeqCst);
                            break Phase::Attempt {
                                config,
                                reply: Some(reply),
                                attempt: 0,
                            };
                        }
                        Some(Command::Request {
                            payload,
                            kind,
                            reply,
                        }) => {
                            // A JoinChannel for the channel the caller already
                            // sits in makes the server remove and re-add the
                            // media participant (an audible gap). When the token
                            // is missing — after a moderator move, an eviction
                            // or a failed renewal — a click on the current
                            // channel must still restore audio, so ask for voice
                            // credentials instead of joining again.
                            let own_channel = self.inner.state.read().own_channel_id();
                            let payload = recover_own_channel_join(payload, own_channel);
                            match session.send(payload).await {
                                Ok(id) => {
                                    pending.insert(id, PendingRequest {
                                        reply: Some(reply),
                                        admin: None,
                                        stream: None,
                                        kind,
                                    });
                                }
                                Err(error) => {
                                    let _ = reply.send(Err(error));
                                }
                            }
                        }
                        Some(Command::Admin { action, reply }) => {
                            match session
                                .send(proto::client_frame::Payload::AdminAction(action))
                                .await
                            {
                                Ok(id) => {
                                    pending.insert(id, PendingRequest {
                                        reply: None,
                                        admin: Some(reply),
                                        stream: None,
                                        kind: RequestKind::Generic,
                                    });
                                }
                                Err(error) => {
                                    let _ = reply.send(Err(error));
                                }
                            }
                        }
                        Some(Command::StreamCredentials { channel_id, reply }) => {
                            match session
                                .send(proto::client_frame::Payload::RequestMediaCredentials(
                                    proto::RequestMediaCredentials {
                                        channel_id,
                                        kind: proto::MediaKind::Stream as i32,
                                    },
                                ))
                                .await
                            {
                                Ok(id) => {
                                    pending.insert(id, PendingRequest {
                                        reply: None,
                                        admin: None,
                                        stream: Some(reply),
                                        kind: RequestKind::Stream,
                                    });
                                }
                                Err(error) => {
                                    let _ = reply.send(Err(error));
                                }
                            }
                        }
                    }
                }
                _ = ping_tick.tick() => {
                    if let Some(sent) = awaiting_pong {
                        if sent.elapsed() > PONG_TIMEOUT {
                            self.inner.hold_media();
                            break Phase::Attempt { config: config.clone(), reply: None, attempt: 1 };
                        }
                    } else if let Err(error) = session.ping().await {
                        log::debug!("client ping failed: {}", error.message);
                        self.inner.hold_media();
                        break Phase::Attempt { config: config.clone(), reply: None, attempt: 1 };
                    } else {
                        awaiting_pong = Some(Instant::now());
                    }
                }
                _ = media_tick.tick() => {
                    // The hold from a previous control drop may have run out
                    // while the session is back but the media is still stale.
                    self.inner.expire_media_hold();
                    if let Err(error) = self.renew_media(&mut pending, &mut session).await {
                        log::debug!("media renewal failed: {}", error.message);
                        self.inner.hold_media();
                        break Phase::Attempt { config: config.clone(), reply: None, attempt: 1 };
                    }
                }
            }
        };

        // Nobody is waiting any more: fail in-flight commands immediately
        // instead of letting the UI time out ten seconds later.
        for (_, request) in pending.drain() {
            let error = || {
                CoreError::new(
                    CoreErrorCode::ConnectionFailed,
                    "the connection was lost before the reply arrived",
                )
                .retryable(true)
            };
            if let Some(reply) = request.reply {
                let _ = reply.send(Err(error()));
            }
            if let Some(reply) = request.admin {
                let _ = reply.send(Err(error()));
            }
        }
        session.close().await;
        *self.inner.proxy.lock() = None;
        self.inner.clear_stream();
        *self.inner.stream_proxy.lock() = None;
        next
    }

    /// The phase to enter after the current session ended with `error`.
    ///
    /// A `SESSION_REPLACED` that follows a handshake this client itself gave up
    /// on is not "you signed in somewhere else": the server registered a late
    /// leftover attempt, which then dies with the socket it was opened on. The
    /// fresh session is the one that must win, so reconnect instead of stopping
    /// the client. Without such a leftover the replacement is a real login from
    /// another device and stays fatal (no reconnect fight between two clients).
    fn end_session(&self, error: CoreError, config: &ClientConfig) -> Phase {
        let stale_replacement = error.server_code == Some(ServerErrorCode::SessionReplaced)
            && self.inner.take_recent_late_handshake();
        if stale_replacement {
            log::warn!(
                "a leftover handshake from an earlier attempt replaced this session; reconnecting"
            );
        }
        if stale_replacement || error.retryable {
            self.inner.hold_media();
            Phase::Attempt {
                config: Box::new(config.clone()),
                reply: None,
                attempt: 1,
            }
        } else {
            self.fail(&error);
            Phase::Idle
        }
    }

    fn handle_frame(
        &self,
        frame: Box<proto::ServerFrame>,
        pending: &mut HashMap<u64, PendingRequest>,
        outbound: &mut Vec<(proto::client_frame::Payload, RequestKind)>,
    ) -> Result<(), CoreError> {
        let frame = *frame;
        if frame.reply_to == 0 {
            match frame.payload {
                Some(proto::server_frame::Payload::Event(event)) => {
                    let self_id = self.inner.state.read().state().self_user_id;
                    let mut clear_media = false;
                    let mut clear_stream = false;
                    let mut request_voice_for = 0u64;
                    {
                        let mut state = self.inner.state.write();
                        if let Some(delta) = state.apply_event(&event) {
                            // A move of the caller changes the channel to rejoin
                            // after a reconnect. Moving to another channel keeps
                            // the old media alive until the new credentials
                            // arrive: the voice engine connects to the new room
                            // first and only then closes the old one (stage 2.3,
                            // requirement 8). Leaving to no channel has no new
                            // room, so the media goes away immediately.
                            if let StateDelta::UserMoved(moved) = &delta {
                                if moved.user_id == self_id {
                                    self.inner
                                        .last_channel
                                        .store(moved.to_channel_id, Ordering::SeqCst);
                                    clear_media = media_is_cleared_on_move(moved.to_channel_id);
                                    // A screen share belongs to one channel.
                                    // Moving (or leaving) ends it; the media
                                    // plane's unpublish event clears the flag.
                                    clear_stream = true;
                                    request_voice_for = moved.to_channel_id;
                                }
                            }
                            drop(state);
                            (self.inner.events)(CoreEvent::Delta(delta));
                        }
                    }
                    if request_voice_for != 0 {
                        // The server moved the presence but not the media
                        // participant: it removed the old one without issuing
                        // credentials. Ask for the voice token of the new room,
                        // unless a join or credential request is already on its
                        // way there.
                        self.request_voice_after_move(request_voice_for, pending, outbound);
                    }
                    if clear_media {
                        self.clear_media();
                    }
                    if clear_stream {
                        self.inner.clear_stream();
                    }
                    Ok(())
                }
                Some(proto::server_frame::Payload::Error(error)) => {
                    Err(CoreError::from_server(&error))
                }
                // A server-initiated challenge/welcome in an authenticated
                // session is a protocol violation.
                Some(_) => Err(CoreError::new(
                    CoreErrorCode::InvalidRequest,
                    "unexpected server frame outside a reply",
                )),
                None => Ok(()),
            }
        } else {
            let Some(mut request) = pending.remove(&frame.reply_to) else {
                // Late reply after a timeout: nothing waits for it.
                return Ok(());
            };
            // A stream credential request is answered with a token-free view;
            // the token itself stays in the proxy.
            if let Some(stream_reply) = request.stream.take() {
                let result = match frame.payload {
                    Some(proto::server_frame::Payload::MediaCredentials(credentials)) => {
                        self.store_stream_media(&credentials)
                    }
                    Some(proto::server_frame::Payload::Error(error)) => {
                        Err(CoreError::from_server(&error))
                    }
                    _ => Err(CoreError::new(
                        CoreErrorCode::InvalidRequest,
                        "server sent an unexpected stream credential reply",
                    )),
                };
                let _ = stream_reply.send(result);
                return Ok(());
            }
            // Administrative requests carry an AdminResult instead of an Ack.
            if let Some(admin_reply) = request.admin.take() {
                let result = match frame.payload {
                    Some(proto::server_frame::Payload::Error(error)) => {
                        Err(CoreError::from_server(&error))
                    }
                    Some(proto::server_frame::Payload::AdminResult(result)) => Ok(result),
                    _ => Err(CoreError::new(
                        CoreErrorCode::InvalidRequest,
                        "server sent an unexpected admin reply",
                    )),
                };
                let _ = admin_reply.send(result);
                return Ok(());
            }
            let result = match frame.payload {
                Some(proto::server_frame::Payload::Error(error)) => {
                    Err(CoreError::from_server(&error))
                }
                Some(proto::server_frame::Payload::Ack(_)) => {
                    match request.kind {
                        RequestKind::Join { channel_id } => {
                            self.inner.last_channel.store(channel_id, Ordering::SeqCst);
                        }
                        RequestKind::Leave => {
                            self.inner.last_channel.store(0, Ordering::SeqCst);
                            self.clear_media();
                            self.inner.clear_stream();
                        }
                        _ => {}
                    }
                    Ok(())
                }
                Some(proto::server_frame::Payload::MediaCredentials(credentials)) => {
                    if media_reply_is_current(
                        request.kind,
                        credentials.channel_id,
                        self.inner.last_channel.load(Ordering::SeqCst),
                    ) {
                        if let Some(channel_id) = self.store_media(&credentials) {
                            self.inner.last_channel.store(channel_id, Ordering::SeqCst);
                        }
                    } else {
                        // A renewal or move-recovery reply overtaken by the
                        // next move. Keeping its token would point the voice
                        // engine at the room the caller has already left.
                        log::debug!("ignoring voice credentials for a channel the caller has left");
                    }
                    Ok(())
                }
                // Chat replies: the stored message also arrives as an event,
                // which is what the UI mirrors. A successful reply is enough
                // for the request that produced it.
                Some(proto::server_frame::Payload::Message(_))
                | Some(proto::server_frame::Payload::ChatHistory(_)) => Ok(()),
                _ => Err(CoreError::new(
                    CoreErrorCode::InvalidRequest,
                    "server sent an unexpected reply payload",
                )),
            };
            if request.reply.is_none() {
                if let Err(error) = &result {
                    // Background requests (media renewal, re-join after a
                    // reconnect) have no UI waiter; make the failure visible in
                    // diagnostics. The message never contains a token.
                    log::debug!(
                        "background {:?} request failed: {}",
                        request.kind,
                        error.message
                    );
                    if request.kind == RequestKind::Rejoin
                        || matches!(
                            request.kind,
                            RequestKind::MediaMove { channel_id }
                                if channel_id == self.inner.last_channel.load(Ordering::SeqCst)
                        )
                    {
                        // The server refused the channel the caller should be
                        // in (deleted, password changed, no permission): there
                        // is no room to keep. This also stops the voice engine
                        // from retrying a room the server already removed it
                        // from after a move.
                        self.clear_media();
                    }
                }
            }
            if let Some(reply) = request.reply {
                let _ = reply.send(result);
            }
            Ok(())
        }
    }

    /// Queues the voice credential request that restores audio after a move.
    ///
    /// A moderator move or an automatic eviction changes the control-plane
    /// presence and removes the old media participant, but the server does not
    /// issue credentials for the new room. The client therefore asks for them
    /// with `RequestMediaCredentials`, never with a second `JoinChannel`.
    ///
    /// Nothing is sent when the room is already up, or when a join/renewal for
    /// the same channel is in flight: in that case its reply is authoritative
    /// and a duplicate request would only race it.
    fn request_voice_after_move(
        &self,
        channel_id: u64,
        pending: &HashMap<u64, PendingRequest>,
        outbound: &mut Vec<(proto::client_frame::Payload, RequestKind)>,
    ) {
        if self
            .inner
            .media
            .lock()
            .as_ref()
            .is_some_and(|secret| secret.credentials.channel_id == channel_id)
        {
            return;
        }
        let in_flight = pending.values().any(|request| match request.kind {
            RequestKind::Join { channel_id: target }
            | RequestKind::MediaRenew { channel_id: target }
            | RequestKind::MediaMove { channel_id: target } => target == channel_id,
            _ => false,
        });
        if in_flight {
            return;
        }
        outbound.push((
            proto::client_frame::Payload::RequestMediaCredentials(proto::RequestMediaCredentials {
                channel_id,
                kind: proto::MediaKind::Voice as i32,
            }),
            RequestKind::MediaMove { channel_id },
        ));
    }

    /// Stores voice credentials in memory and returns their channel id.
    /// Screen-share credentials are ignored in stage 2.3.
    fn store_media(&self, credentials: &proto::MediaCredentials) -> Option<u64> {
        let kind =
            proto::MediaKind::try_from(credentials.kind).unwrap_or(proto::MediaKind::Unspecified);
        if kind == proto::MediaKind::Stream {
            return None;
        }
        let minutes = credentials.expires_in_seconds.max(1);
        let now = Instant::now();
        let expires_at = now + Duration::from_secs(u64::from(minutes));
        let margin = MEDIA_RENEW_MARGIN.min(Duration::from_secs(u64::from(minutes / 3)));
        let renew_at = expires_at.checked_sub(margin).unwrap_or(now);

        let profile = self.channel_voice_profile(credentials.channel_id);
        let (bitrate_bps, stereo, processing_enabled) = match profile {
            crate::model::VoiceProfileView::VoiceHq => (96_000, false, true),
            crate::model::VoiceProfileView::Music => (192_000, true, false),
            crate::model::VoiceProfileView::Voice => (48_000, false, true),
        };

        // Same room and gateway means the control plane renewed the token of a
        // live session. A different room (channel switch) or a session that was
        // cleared earlier (control reconnect) starts a new generation.
        let generation = {
            let existing = self.inner.media.lock();
            match existing.as_ref() {
                Some(secret)
                    if secret.credentials.room == credentials.room
                        && secret.credentials.url == credentials.url =>
                {
                    secret.credentials.generation
                }
                _ => self.inner.media_generation.fetch_add(1, Ordering::SeqCst) + 1,
            }
        };

        let secret = MediaSecret {
            credentials: VoiceMediaCredentials {
                url: credentials.url.clone(),
                room: credentials.room.clone(),
                token: credentials.token.clone(),
                participant_identity: credentials.participant_identity.clone(),
                channel_id: credentials.channel_id,
                expires_in_seconds: credentials.expires_in_seconds,
                generation,
                bitrate_bps,
                stereo,
                processing_enabled,
                tls_fingerprint: self.inner.fingerprint.lock().clone(),
            },
            expires_at,
            renew_at,
        };
        *self.inner.media.lock() = Some(secret);
        let current = self
            .inner
            .media
            .lock()
            .as_ref()
            .map(|secret| secret.credentials.clone());
        if let Some(current) = current {
            let sink = self.inner.media_sink.lock().clone();
            sink(Some(current));
        }
        Some(credentials.channel_id)
    }

    /// Stores screen-share credentials and installs the token into the stream
    /// proxy. Returns only the token-free coordinates for the page.
    fn store_stream_media(
        &self,
        credentials: &proto::MediaCredentials,
    ) -> Result<StreamCredentialsView, CoreError> {
        let kind =
            proto::MediaKind::try_from(credentials.kind).unwrap_or(proto::MediaKind::Unspecified);
        if kind != proto::MediaKind::Stream {
            return Err(CoreError::new(
                CoreErrorCode::InvalidRequest,
                "the server sent non-stream credentials for a stream request",
            ));
        }
        let seconds = credentials.expires_in_seconds.max(1);
        let (url, presets) = {
            let proxy = self.inner.stream_proxy.lock();
            let proxy = proxy.as_ref().ok_or_else(|| {
                CoreError::internal("the stream proxy is not running for this session")
            })?;
            proxy.set_credential(
                credentials.token.clone(),
                Duration::from_secs(u64::from(seconds)),
            );
            (proxy.url(), credentials.stream_presets.clone())
        };
        Ok(StreamCredentialsView {
            url,
            room: credentials.room.clone(),
            participant_identity: credentials.participant_identity.clone(),
            channel_id: credentials.channel_id,
            expires_in_seconds: seconds,
            presets,
        })
    }

    fn channel_voice_profile(&self, channel_id: u64) -> crate::model::VoiceProfileView {
        let state = self.inner.state.read();
        state
            .state()
            .channels
            .iter()
            .find(|channel| channel.id == channel_id)
            .map(|channel| channel.voice_profile)
            .unwrap_or_default()
    }

    fn clear_media(&self) {
        self.inner.clear_media();
    }

    /// Renews an expiring voice token with `RequestMediaCredentials`.
    /// Never a second `JoinChannel` (stage 1.4 requirement).
    async fn renew_media(
        &self,
        pending: &mut HashMap<u64, PendingRequest>,
        session: &mut Session,
    ) -> Result<(), CoreError> {
        let due = {
            let mut media = self.inner.media.lock();
            match media.as_mut() {
                Some(secret) if secret.renew_at <= Instant::now() => {
                    // Do not busy-loop while the reply is in flight.
                    secret.renew_at = Instant::now() + MEDIA_RETRY_DELAY;
                    Some(secret.credentials.channel_id)
                }
                _ => None,
            }
        };
        let Some(channel_id) = due else {
            return Ok(());
        };
        let id = session
            .send(proto::client_frame::Payload::RequestMediaCredentials(
                proto::RequestMediaCredentials {
                    channel_id,
                    kind: proto::MediaKind::Voice as i32,
                },
            ))
            .await?;
        pending.insert(
            id,
            PendingRequest {
                reply: None,
                admin: None,
                stream: None,
                kind: RequestKind::MediaRenew { channel_id },
            },
        );
        Ok(())
    }

    fn set_phase(
        &self,
        phase: ConnectionPhase,
        reconnect: Option<ReconnectInfo>,
        error: Option<CoreError>,
    ) {
        let delta = {
            let mut state = self.inner.state.write();
            state.set_connection(phase, reconnect, error)
        };
        (self.inner.events)(CoreEvent::Delta(delta));
    }

    fn clear_and_emit(&self) {
        self.inner.reset(None);
    }

    fn fail(&self, error: &CoreError) {
        self.inner.reset(Some(error.clone()));
    }

    async fn wait_before_retry(&mut self, delay: Duration) -> RetryWait {
        let sleep = tokio::time::sleep(delay);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => return RetryWait::Sleep,
                command = self.rx.recv() => {
                    match command {
                        None => return RetryWait::Shutdown,
                        Some(Command::Disconnect { reply }) => return RetryWait::Disconnected(reply),
                        Some(Command::Connect { config, reply }) => return RetryWait::Replaced(config, reply),
                        Some(Command::Request { reply, .. }) => {
                            let _ = reply.send(Err(CoreError::not_connected()));
                        }
                        Some(Command::Admin { reply, .. }) => {
                            let _ = reply.send(Err(CoreError::not_connected()));
                        }
                        Some(Command::StreamCredentials { reply, .. }) => {
                            let _ = reply.send(Err(CoreError::not_connected()));
                        }
                    }
                }
            }
        }
    }
}

fn backoff(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(5);
    let seconds = 1u64 << exponent;
    Duration::from_secs(seconds.min(MAX_BACKOFF.as_secs()))
}

/// Whether a self-move drops the media session immediately.
///
/// A move to another channel keeps the current room until the new credentials
/// arrive: the voice engine connects to the new room first and closes the old
/// one afterwards. Reaching channel 0 means the caller is no longer in voice,
/// so there is nothing to hand over.
fn media_is_cleared_on_move(to_channel_id: u64) -> bool {
    to_channel_id == 0
}

/// Whether a `MediaCredentials` reply still belongs to the caller's position.
///
/// The server broadcasts the caller's own `UserMoved` before it sends the
/// credentials, so the presence is already at the requested channel by the time
/// the reply is read. A mismatch therefore means the reply was overtaken by the
/// next move; keeping its token would point the voice engine at a room the
/// caller has already left.
fn media_reply_is_current(kind: RequestKind, reply_channel: u64, current_channel: u64) -> bool {
    match kind {
        RequestKind::Join { channel_id }
        | RequestKind::MediaMove { channel_id }
        | RequestKind::MediaRenew { channel_id } => {
            channel_id == reply_channel && current_channel == channel_id
        }
        RequestKind::Rejoin => current_channel == reply_channel,
        _ => true,
    }
}

/// Rewrites a `JoinChannel` for the caller's current channel into a voice
/// credential request.
///
/// The presence is already right; only the media token may be missing (a
/// moderator move, an automatic eviction, an expired renewal). A real join
/// would make the server remove and re-add the participant and produce a short
/// audible gap for no reason.
fn recover_own_channel_join(
    payload: proto::client_frame::Payload,
    own_channel_id: u64,
) -> proto::client_frame::Payload {
    match payload {
        proto::client_frame::Payload::JoinChannel(join)
            if own_channel_id != 0 && join.channel_id == own_channel_id =>
        {
            proto::client_frame::Payload::RequestMediaCredentials(proto::RequestMediaCredentials {
                channel_id: join.channel_id,
                kind: proto::MediaKind::Voice as i32,
            })
        }
        other => other,
    }
}

/// The `SetVoiceState` request that restores the persisted flags on a new
/// session. Sending nothing while both flags are false keeps a fresh login
/// quiet and lets the server defaults stand.
/// Converts an IPC chat target into the wire form.
fn chat_target(target: ChatTarget) -> proto::ChatTarget {
    let inner = match target {
        ChatTarget::Channel { channel_id } => proto::chat_target::Target::ChannelId(channel_id),
        ChatTarget::Dm { peer_id } => proto::chat_target::Target::PeerUserId(peer_id),
    };
    proto::ChatTarget {
        target: Some(inner),
    }
}

fn voice_flags_request(prefs: VoicePreferences) -> Option<proto::SetVoiceState> {
    (prefs.self_muted || prefs.self_deafened).then_some(proto::SetVoiceState {
        self_muted: Some(prefs.self_muted),
        self_deafened: Some(prefs.self_deafened),
        away: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rostalk_platform::{IdentityVault, MemoryStore};

    fn test_core() -> (CoreHandle, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault = IdentityVault::new("rostalk-core-test", MemoryStore::new());
        let core = CoreHandle::new(Arc::new(vault), dir.path(), Arc::new(|_| {})).expect("core");
        (core, dir)
    }

    #[test]
    fn a_short_control_drop_keeps_the_media_session_for_the_grace() {
        let (core, _dir) = test_core();
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = seen.clone();
        core.set_media_sink(Arc::new(move |credentials| {
            observed
                .lock()
                .expect("sink")
                .push(credentials.map(|value| value.channel_id));
        }));
        let secret = MediaSecret {
            credentials: VoiceMediaCredentials {
                url: "wss://example.test/rtc".to_owned(),
                room: "channel-3".to_owned(),
                token: "test-token".to_owned(),
                participant_identity: "7:voice".to_owned(),
                channel_id: 3,
                expires_in_seconds: 60,
                generation: 1,
                bitrate_bps: 48_000,
                stereo: false,
                processing_enabled: true,
                tls_fingerprint: String::new(),
            },
            expires_at: Instant::now() + Duration::from_secs(60),
            renew_at: Instant::now() + Duration::from_secs(60),
        };
        *core.inner.media.lock() = Some(secret);

        // A dropped control connection holds the media instead of leaving.
        core.inner.hold_media();
        assert!(core.inner.media.lock().is_some());
        assert!(!core.inner.expire_media_hold());
        assert!(seen.lock().expect("seen").is_empty());

        // After the grace the room is closed once and the engine is told.
        *core.inner.media_hold_until.lock() = Some(Instant::now() - Duration::from_secs(1));
        assert!(core.inner.expire_media_hold());
        assert!(core.inner.media.lock().is_none());
        assert_eq!(*seen.lock().expect("seen"), vec![None]);
        // A second expiry check is a no-op, so the sink is not called twice.
        assert!(!core.inner.expire_media_hold());
        assert_eq!(seen.lock().expect("seen").len(), 1);
    }

    #[test]
    fn ending_the_session_explicitly_drops_the_media_without_a_hold() {
        let (core, _dir) = test_core();
        *core.inner.media_hold_until.lock() = Some(Instant::now() + Duration::from_secs(60));
        core.inner.clear_media();
        assert!(core.inner.media_hold_until.lock().is_none());
    }

    fn target_direct(host: &str, fingerprint: Option<&str>) -> ConnectRequest {
        ConnectRequest {
            target: ConnectTarget::Direct {
                host: host.to_owned(),
                port: 0,
                fingerprint: fingerprint.map(str::to_owned),
            },
            nickname: "alice".to_owned(),
            password: None,
            accept_new_certificate: false,
        }
    }

    #[test]
    fn backoff_grows_then_caps() {
        let delays: Vec<u64> = (1..=8).map(|attempt| backoff(attempt).as_secs()).collect();
        assert_eq!(delays, vec![1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn a_move_to_another_channel_keeps_media_until_the_new_room_is_up() {
        // Clearing here would close the old room before the new credentials
        // arrive, which is exactly the wrong order (stage 2.3, requirement 8).
        assert!(!media_is_cleared_on_move(2));
        assert!(!media_is_cleared_on_move(42));
        // Leaving voice has no new room to connect to first.
        assert!(media_is_cleared_on_move(0));
    }

    /// A worker without a connection: enough to drive `handle_frame` directly.
    fn test_worker(core: &CoreHandle) -> Worker {
        let (_tx, rx) = mpsc::unbounded_channel();
        Worker {
            inner: core.inner.clone(),
            rx,
        }
    }

    /// Puts one user into the state store, as a `Welcome` snapshot would.
    fn put_user(core: &CoreHandle, user_id: u64, channel_id: u64) {
        let mut state = core.inner.state.write();
        state.state_mut().self_user_id = user_id;
        state.state_mut().users.push(model::UserView {
            id: user_id,
            nickname: "alice".to_owned(),
            role_ids: Vec::new(),
            color: None,
            channel_id,
            voice: model::VoiceStateView::default(),
            streaming: false,
            watching_user_ids: Vec::new(),
            connected_at_unix_ms: 0,
            avatar_hash: String::new(),
        });
    }

    fn moved_frame(user_id: u64, from: u64, to: u64) -> Box<proto::ServerFrame> {
        Box::new(proto::ServerFrame {
            reply_to: 0,
            payload: Some(proto::server_frame::Payload::Event(proto::Event {
                payload: Some(proto::event::Payload::UserMoved(proto::UserMoved {
                    user_id,
                    from_channel_id: from,
                    to_channel_id: to,
                })),
            })),
        })
    }

    fn credentials(channel_id: u64) -> proto::MediaCredentials {
        proto::MediaCredentials {
            url: "wss://example.test/rtc".to_owned(),
            room: format!("channel-{channel_id}"),
            token: format!("token-{channel_id}"),
            participant_identity: "7:voice".to_owned(),
            expires_in_seconds: 60,
            kind: proto::MediaKind::Voice as i32,
            channel_id,
            stream_presets: Vec::new(),
        }
    }

    fn media_reply(
        request_id: u64,
        credentials: proto::MediaCredentials,
    ) -> Box<proto::ServerFrame> {
        Box::new(proto::ServerFrame {
            reply_to: request_id,
            payload: Some(proto::server_frame::Payload::MediaCredentials(credentials)),
        })
    }

    fn error_reply(request_id: u64) -> Box<proto::ServerFrame> {
        Box::new(proto::ServerFrame {
            reply_to: request_id,
            payload: Some(proto::server_frame::Payload::Error(proto::Error {
                code: proto::ErrorCode::PermissionDenied as i32,
                message: "not allowed".to_owned(),
                retryable: false,
                action_url: String::new(),
            })),
        })
    }

    fn pending_request(kind: RequestKind) -> PendingRequest {
        PendingRequest {
            reply: None,
            admin: None,
            stream: None,
            kind,
        }
    }

    #[test]
    fn a_moderator_move_requests_voice_credentials_for_the_new_channel() {
        let (core, _dir) = test_core();
        put_user(&core, 7, 1);
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = seen.clone();
        core.set_media_sink(Arc::new(move |credentials| {
            observed
                .lock()
                .expect("sink")
                .push(credentials.map(|value| value.channel_id));
        }));
        let worker = test_worker(&core);
        // The room the server just removed us from.
        assert_eq!(worker.store_media(&credentials(1)), Some(1));
        assert_eq!(*seen.lock().expect("seen"), vec![Some(1)]);
        let old_generation = core
            .voice_credentials()
            .expect("old credentials")
            .generation;

        let mut pending = HashMap::new();
        let mut outbound = Vec::new();
        worker
            .handle_frame(moved_frame(7, 1, 2), &mut pending, &mut outbound)
            .expect("move is accepted");

        // The server moved the presence but issued nothing; the client asks for
        // the voice token of the new room, and never for a second join.
        assert_eq!(outbound.len(), 1);
        assert_eq!(
            outbound[0].0,
            proto::client_frame::Payload::RequestMediaCredentials(proto::RequestMediaCredentials {
                channel_id: 2,
                kind: proto::MediaKind::Voice as i32,
            })
        );
        assert_eq!(outbound[0].1, RequestKind::MediaMove { channel_id: 2 });
        assert!(core.inner.media.lock().is_some(), "the old room is kept");

        // The reply to that request is applied as usual: the voice engine sees
        // the new room and a new generation, so it reconnects there.
        pending.insert(
            11,
            pending_request(RequestKind::MediaMove { channel_id: 2 }),
        );
        worker
            .handle_frame(media_reply(11, credentials(2)), &mut pending, &mut outbound)
            .expect("credentials are accepted");
        let current = core.voice_credentials().expect("new credentials");
        assert_eq!(current.channel_id, 2);
        assert_eq!(current.room, "channel-2");
        assert!(current.generation > old_generation);
        assert_eq!(core.inner.last_channel.load(Ordering::SeqCst), 2);
        assert_eq!(*seen.lock().expect("seen"), vec![Some(1), Some(2)]);
    }

    #[test]
    fn a_move_does_not_duplicate_a_join_or_request_already_in_flight() {
        for kind in [
            RequestKind::Join { channel_id: 2 },
            RequestKind::MediaMove { channel_id: 2 },
            RequestKind::MediaRenew { channel_id: 2 },
        ] {
            let (core, _dir) = test_core();
            put_user(&core, 7, 1);
            let worker = test_worker(&core);
            let mut pending = HashMap::new();
            pending.insert(5, pending_request(kind));
            let mut outbound = Vec::new();
            worker
                .handle_frame(moved_frame(7, 1, 2), &mut pending, &mut outbound)
                .expect("move is accepted");
            assert!(outbound.is_empty(), "{kind:?} already covers the move");
        }

        // The room is already up: nothing to recover.
        let (core, _dir) = test_core();
        put_user(&core, 7, 2);
        let worker = test_worker(&core);
        assert_eq!(worker.store_media(&credentials(2)), Some(2));
        let mut pending = HashMap::new();
        let mut outbound = Vec::new();
        worker
            .handle_frame(moved_frame(7, 1, 2), &mut pending, &mut outbound)
            .expect("move is accepted");
        assert!(outbound.is_empty(), "the existing room needs no request");
    }

    #[test]
    fn credentials_overtaken_by_the_next_move_are_ignored() {
        let (core, _dir) = test_core();
        put_user(&core, 7, 1);
        let worker = test_worker(&core);
        let mut pending = HashMap::new();
        let mut outbound = Vec::new();

        // Moved to 2, then to 3 before the reply for 2 arrived.
        worker
            .handle_frame(moved_frame(7, 1, 2), &mut pending, &mut outbound)
            .expect("first move");
        worker
            .handle_frame(moved_frame(7, 2, 3), &mut pending, &mut outbound)
            .expect("second move");
        pending.insert(
            11,
            pending_request(RequestKind::MediaMove { channel_id: 2 }),
        );
        worker
            .handle_frame(media_reply(11, credentials(2)), &mut pending, &mut outbound)
            .expect("late reply");
        assert!(
            core.voice_credentials().is_none(),
            "a token for the room the caller already left must not be stored"
        );

        // The reply for the current channel is accepted.
        pending.insert(
            12,
            pending_request(RequestKind::MediaMove { channel_id: 3 }),
        );
        worker
            .handle_frame(media_reply(12, credentials(3)), &mut pending, &mut outbound)
            .expect("current reply");
        assert_eq!(
            core.voice_credentials().map(|value| value.channel_id),
            Some(3)
        );
    }

    #[test]
    fn a_refused_move_recovery_clears_the_dead_room() {
        let (core, _dir) = test_core();
        put_user(&core, 7, 2);
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = seen.clone();
        core.set_media_sink(Arc::new(move |credentials| {
            observed
                .lock()
                .expect("sink")
                .push(credentials.map(|value| value.channel_id));
        }));
        let worker = test_worker(&core);
        // The server removed the participant from the old room; the new token
        // was refused, so the stale room must not stay around.
        assert_eq!(worker.store_media(&credentials(1)), Some(1));
        core.inner.last_channel.store(2, Ordering::SeqCst);
        let mut pending = HashMap::new();
        pending.insert(5, pending_request(RequestKind::MediaMove { channel_id: 2 }));
        let mut outbound = Vec::new();
        worker
            .handle_frame(error_reply(5), &mut pending, &mut outbound)
            .expect("error reply is handled");
        assert!(core.voice_credentials().is_none());
        assert_eq!(*seen.lock().expect("seen"), vec![Some(1), None]);

        // A failure for a channel the caller has already left is stale: the
        // live room of the current channel stays.
        let worker = test_worker(&core);
        assert_eq!(worker.store_media(&credentials(2)), Some(2));
        core.inner.last_channel.store(3, Ordering::SeqCst);
        pending.insert(6, pending_request(RequestKind::MediaMove { channel_id: 2 }));
        worker
            .handle_frame(error_reply(6), &mut pending, &mut outbound)
            .expect("stale error reply is handled");
        assert_eq!(
            core.voice_credentials().map(|value| value.channel_id),
            Some(2)
        );
    }

    #[test]
    fn joining_the_current_channel_asks_for_credentials_not_a_second_join() {
        let joined = proto::client_frame::Payload::JoinChannel(proto::JoinChannel {
            channel_id: 2,
            password: String::new(),
        });
        assert_eq!(
            recover_own_channel_join(joined, 2),
            proto::client_frame::Payload::RequestMediaCredentials(proto::RequestMediaCredentials {
                channel_id: 2,
                kind: proto::MediaKind::Voice as i32,
            })
        );

        // Another channel still goes through a real join; so does a request
        // made before any presence is known.
        let joined = proto::client_frame::Payload::JoinChannel(proto::JoinChannel {
            channel_id: 2,
            password: String::new(),
        });
        assert_eq!(recover_own_channel_join(joined.clone(), 3), joined);
        assert_eq!(recover_own_channel_join(joined.clone(), 0), joined);
    }

    #[test]
    fn persisted_voice_flags_are_sent_on_a_new_session() {
        assert!(voice_flags_request(VoicePreferences::default()).is_none());

        let muted = voice_flags_request(VoicePreferences {
            self_muted: true,
            self_deafened: false,
        })
        .expect("mute is restored");
        assert_eq!(muted.self_muted, Some(true));
        assert_eq!(muted.self_deafened, Some(false));

        // Deafen alone is also worth restoring: the UI shows it and the voice
        // engine starts deafened after a restart.
        let deafened = voice_flags_request(VoicePreferences {
            self_muted: false,
            self_deafened: true,
        })
        .expect("deafen is restored");
        assert_eq!(deafened.self_muted, Some(false));
        assert_eq!(deafened.self_deafened, Some(true));
    }

    #[test]
    fn the_voice_preferences_survive_a_core_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault = IdentityVault::new("rostalk-core-test", MemoryStore::new());
        let core =
            CoreHandle::new(Arc::new(vault), dir.path(), Arc::new(|_| {})).expect("first core");
        assert_eq!(core.voice_preferences(), VoicePreferences::default());
        core.inner
            .settings
            .lock()
            .set_voice_preferences(VoicePreferences {
                self_muted: true,
                self_deafened: true,
            })
            .expect("save");

        let vault = IdentityVault::new("rostalk-core-test", MemoryStore::new());
        let reopened =
            CoreHandle::new(Arc::new(vault), dir.path(), Arc::new(|_| {})).expect("second core");
        assert_eq!(
            reopened.voice_preferences(),
            VoicePreferences {
                self_muted: true,
                self_deafened: true,
            }
        );
    }

    #[test]
    fn a_direct_ip_target_requires_the_confirmed_fingerprint() {
        let (core, _dir) = test_core();
        let error = core
            .prepare_target(&target_direct("192.168.0.13", None))
            .expect_err("no fingerprint");
        assert_eq!(error.code, CoreErrorCode::InvalidFingerprint);

        let fingerprint = "ab".repeat(32);
        let (link, login) = core
            .prepare_target(&target_direct("192.168.0.13:7443", Some(&fingerprint)))
            .expect("direct target");
        assert_eq!(login, BookmarkLogin::Direct);
        assert_eq!(link.authority(), "192.168.0.13:7443");
        assert_eq!(link.mode(), crate::link::ServerMode::Pinned);
        assert_eq!(link.fingerprint_hex(), fingerprint);
    }

    #[test]
    fn a_direct_dns_target_uses_web_pki_and_records_the_probe() {
        let (core, _dir) = test_core();
        let (link, login) = core
            .prepare_target(&target_direct("voice.example.com", None))
            .expect("dns target");
        assert_eq!(login, BookmarkLogin::Direct);
        assert_eq!(link.mode(), crate::link::ServerMode::WebPki);
        assert_eq!(link.port, crate::link::DEFAULT_PORT);

        // A fingerprint from the probe is kept for the bookmark even though
        // Web PKI does not need it.
        let fingerprint = "cd".repeat(32);
        let (link, _) = core
            .prepare_target(&target_direct("voice.example.com:8443", Some(&fingerprint)))
            .expect("dns target with fingerprint");
        assert_eq!(link.port, 8443);
        assert_eq!(link.fingerprint_hex(), fingerprint);
    }

    #[test]
    fn a_link_target_keeps_the_fingerprint_from_the_link() {
        let (core, _dir) = test_core();
        let fingerprint = "ef".repeat(32);
        let request = ConnectRequest {
            target: ConnectTarget::Link {
                link: format!("rostalk://join?host=10.0.0.1:7443&fp={fingerprint}&invite=tok"),
            },
            nickname: "alice".to_owned(),
            password: None,
            accept_new_certificate: false,
        };
        let (link, login) = core.prepare_target(&request).expect("link target");
        assert_eq!(login, BookmarkLogin::Invite);
        assert_eq!(link.fingerprint_hex(), fingerprint);
        assert_eq!(link.invite, "tok");
    }

    #[test]
    fn a_bad_fingerprint_is_reported_as_a_fingerprint_error() {
        let (core, _dir) = test_core();
        let error = core
            .prepare_target(&target_direct("192.168.0.13", Some("not-hex")))
            .expect_err("bad fingerprint");
        assert_eq!(error.code, CoreErrorCode::InvalidFingerprint);
    }

    #[test]
    fn the_nickname_comes_from_the_request_then_the_profile() {
        let (core, _dir) = test_core();
        core.persist_nickname("bob").expect("store nickname");

        // An explicit request always wins.
        assert_eq!(
            core.resolve_nickname(" alice ", "10.0.0.1:7443")
                .expect("requested"),
            "alice"
        );
        // An empty request falls back to the saved profile.
        assert_eq!(
            core.resolve_nickname("", "10.0.0.1:7443").expect("profile"),
            "bob"
        );
    }

    #[test]
    fn an_empty_nickname_without_a_profile_is_rejected() {
        let (core, _dir) = test_core();
        let error = core
            .resolve_nickname("   ", "10.0.0.1:7443")
            .expect_err("no nickname");
        assert_eq!(error.code, CoreErrorCode::InvalidRequest);
    }

    #[test]
    fn a_bookmark_nickname_wins_over_the_profile() {
        let dir = tempfile::tempdir().expect("tempdir");
        // A saved server with its own nickname, as a return visit would find.
        let bookmarks = serde_json::json!({
            "version": 2,
            "active": "10.0.0.1:7443",
            "servers": [{
                "id": "10.0.0.1:7443",
                "name": "RosTalk",
                "host": "10.0.0.1:7443",
                "fingerprint": "aa".repeat(32),
                "mode": "pinned",
                "login": "direct",
                "nickname": "carol",
                "serverId": null,
                "lastConnectedUnixMs": 1,
                "link": "rostalk://join?host=10.0.0.1:7443&fp=aa"
            }]
        });
        std::fs::write(
            dir.path().join(crate::state::BOOKMARKS_FILE),
            serde_json::to_vec(&bookmarks).expect("json"),
        )
        .expect("write");
        let profile = serde_json::json!({ "version": 1, "nickname": "bob" });
        std::fs::write(
            dir.path().join(crate::settings::LEGACY_PROFILE_FILE),
            serde_json::to_vec(&profile).expect("json"),
        )
        .expect("write");

        let vault = IdentityVault::new("rostalk-core-test", MemoryStore::new());
        let core = CoreHandle::new(Arc::new(vault), dir.path(), Arc::new(|_| {})).expect("core");
        assert_eq!(
            core.resolve_nickname("", "10.0.0.1:7443")
                .expect("bookmark nickname"),
            "carol"
        );
        // Another server has no bookmark and uses the profile default.
        assert_eq!(
            core.resolve_nickname("", "10.0.0.2:7443")
                .expect("profile nickname"),
            "bob"
        );
    }

    #[test]
    fn a_stored_nickname_survives_a_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        {
            let vault = IdentityVault::new("rostalk-core-test", MemoryStore::new());
            let core =
                CoreHandle::new(Arc::new(vault), dir.path(), Arc::new(|_| {})).expect("core");
            core.persist_nickname("alice").expect("store");
        }
        let vault = IdentityVault::new("rostalk-core-test", MemoryStore::new());
        let core = CoreHandle::new(Arc::new(vault), dir.path(), Arc::new(|_| {})).expect("core");
        assert_eq!(core.state().profile.nickname, "alice");
    }

    /// Records the events the UI would receive.
    #[derive(Default)]
    struct Recorder {
        snapshots: std::sync::atomic::AtomicUsize,
        resets: parking_lot::Mutex<Vec<Option<CoreError>>>,
    }

    impl Recorder {
        fn record(&self, event: &CoreEvent) {
            match event {
                CoreEvent::Snapshot(_) => {
                    self.snapshots.fetch_add(1, Ordering::SeqCst);
                }
                CoreEvent::Delta(StateDelta::Reset(reset)) => {
                    self.resets.lock().push(reset.error.clone());
                }
                CoreEvent::Delta(_) => {}
            }
        }

        fn snapshots(&self) -> usize {
            self.snapshots.load(Ordering::SeqCst)
        }

        fn resets(&self) -> Vec<Option<CoreError>> {
            self.resets.lock().clone()
        }
    }

    fn recorded_core() -> (CoreHandle, Arc<Recorder>, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault = IdentityVault::new("rostalk-core-test", MemoryStore::new());
        let recorder = Arc::new(Recorder::default());
        let sink = recorder.clone();
        let core = CoreHandle::new(
            Arc::new(vault),
            dir.path(),
            Arc::new(move |event| sink.record(&event)),
        )
        .expect("core");
        (core, recorder, dir)
    }

    async fn wait_for<F: Fn() -> bool>(core: &CoreHandle, what: &str, check: F) {
        let deadline = Instant::now() + Duration::from_secs(25);
        loop {
            if check() {
                return;
            }
            if Instant::now() > deadline {
                panic!("timed out waiting for {what}; state: {:?}", core.state());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// A TLS server that speaks just enough of the protocol to open sessions.
    ///
    /// It mirrors the one behaviour the race depends on: `Register` replaces
    /// the previous session of the same key and answers it with
    /// `SESSION_REPLACED`, while a handshake can be delayed and register after
    /// the client already gave up on it.
    mod fake_server {
        use super::*;
        use futures_util::{SinkExt, StreamExt};
        use prost::Message as _;
        use std::sync::atomic::AtomicUsize;
        use tokio::sync::mpsc;
        use tokio_rustls::TlsAcceptor;
        use tokio_tungstenite::tungstenite::Message;
        use tokio_tungstenite::WebSocketStream;

        const SERVER_ID: [u8; 32] = [9u8; 32];
        const USER_ID: u64 = 7;

        enum Command {
            Frame(Box<proto::ServerFrame>),
            Close,
        }

        #[derive(Default)]
        struct State {
            live: Option<mpsc::UnboundedSender<Command>>,
            slow_next: bool,
            connections: AtomicUsize,
        }

        pub struct FakeServer {
            port: u16,
            fingerprint: String,
            state: Arc<Mutex<State>>,
        }

        impl FakeServer {
            pub async fn start(slow_delay: Duration) -> Self {
                let key = rcgen::KeyPair::generate().expect("key");
                let params =
                    rcgen::CertificateParams::new(vec!["127.0.0.1".to_owned()]).expect("params");
                let certificate = params.self_signed(&key).expect("certificate");
                let der = rustls::pki_types::CertificateDer::from(certificate.der().to_vec());
                let private = rustls::pki_types::PrivateKeyDer::Pkcs8(
                    rustls::pki_types::PrivatePkcs8KeyDer::from(key.serialize_der()),
                );
                let fingerprint = hex::encode(crate::link::leaf_fingerprint(der.as_ref()));
                let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
                    rustls::crypto::ring::default_provider(),
                ))
                .with_safe_default_protocol_versions()
                .expect("protocol versions")
                .with_no_client_auth()
                .with_single_cert(vec![der], private)
                .expect("server certificate");
                config.alpn_protocols = vec![b"http/1.1".to_vec()];
                let acceptor = TlsAcceptor::from(Arc::new(config));

                let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                    .await
                    .expect("bind");
                let port = listener.local_addr().expect("address").port();
                let state = Arc::new(Mutex::new(State::default()));
                let accept_state = state.clone();
                tokio::spawn(async move {
                    while let Ok((tcp, _)) = listener.accept().await {
                        let acceptor = acceptor.clone();
                        let state = accept_state.clone();
                        tokio::spawn(async move {
                            let Ok(tls) = acceptor.accept(tcp).await else {
                                return;
                            };
                            let Ok(ws) = tokio_tungstenite::accept_async(tls).await else {
                                return;
                            };
                            serve(ws, state, slow_delay).await;
                        });
                    }
                });

                Self {
                    port,
                    fingerprint,
                    state,
                }
            }

            pub fn link(&self) -> String {
                format!(
                    "rostalk://join?host=127.0.0.1:{}&fp={}",
                    self.port, self.fingerprint
                )
            }

            /// Drops the current session and makes the next handshake slow, so
            /// the client reconnects once before the slow one registers.
            pub fn drop_live_and_stall_next_handshake(&self) {
                let mut state = self.state.lock();
                state.slow_next = true;
                if let Some(live) = state.live.as_ref() {
                    let _ = live.send(Command::Close);
                }
            }

            /// Answers the current session as if another device had registered.
            pub fn replace_live(&self) {
                let mut state = self.state.lock();
                if let Some(live) = state.live.take() {
                    let _ = live.send(Command::Frame(Box::new(session_replaced())));
                }
            }

            pub fn connections(&self) -> usize {
                self.state.lock().connections.load(Ordering::SeqCst)
            }

            /// How many sessions the fake server currently considers online.
            pub fn live_sessions(&self) -> usize {
                usize::from(self.state.lock().live.is_some())
            }
        }

        fn session_replaced() -> proto::ServerFrame {
            proto::ServerFrame {
                reply_to: 0,
                payload: Some(proto::server_frame::Payload::Error(proto::Error {
                    code: proto::ErrorCode::SessionReplaced as i32,
                    message: "another connection with the same key replaced this session"
                        .to_owned(),
                    retryable: false,
                    action_url: String::new(),
                })),
            }
        }

        fn welcome() -> proto::ServerFrame {
            proto::ServerFrame {
                reply_to: 2,
                payload: Some(proto::server_frame::Payload::Welcome(proto::Welcome {
                    snapshot: Some(proto::ServerSnapshot {
                        server: Some(proto::ServerInfo {
                            name: "fake".to_owned(),
                            version: "test".to_owned(),
                            protocol_version: crate::PROTOCOL_VERSION,
                            id: SERVER_ID.to_vec(),
                            ..Default::default()
                        }),
                        users: vec![proto::User {
                            id: USER_ID,
                            nickname: "alice".to_owned(),
                            ..Default::default()
                        }],
                        ..Default::default()
                    }),
                    self_user_id: USER_ID,
                    http_token: String::new(),
                    http_token_expires_in_seconds: 0,
                })),
            }
        }

        async fn serve<S>(
            mut ws: WebSocketStream<S>,
            state: Arc<Mutex<State>>,
            slow_delay: Duration,
        ) where
            S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
        {
            // Hello -> Challenge
            let Some(Ok(Message::Binary(data))) = ws.next().await else {
                return;
            };
            let Ok(hello) = proto::ClientFrame::decode(data.as_ref()) else {
                return;
            };
            let challenge = proto::ServerFrame {
                reply_to: hello.request_id,
                payload: Some(proto::server_frame::Payload::Challenge(proto::Challenge {
                    nonce: vec![3u8; 32],
                    server_id: SERVER_ID.to_vec(),
                })),
            };
            if ws
                .send(Message::Binary(challenge.encode_to_vec().into()))
                .await
                .is_err()
            {
                return;
            }
            // Authenticate. From here the server owns the handshake: it can
            // register this connection even if the client stops waiting.
            let Some(Ok(Message::Binary(_))) = ws.next().await else {
                return;
            };
            let slow = {
                let mut state = state.lock();
                std::mem::take(&mut state.slow_next)
            };
            if slow {
                tokio::time::sleep(slow_delay).await;
            }
            let (tx, mut rx) = mpsc::unbounded_channel();
            let previous = {
                let mut state = state.lock();
                state.connections.fetch_add(1, Ordering::SeqCst);
                state.live.replace(tx.clone())
            };
            if let Some(previous) = previous {
                let _ = previous.send(Command::Frame(Box::new(session_replaced())));
            }
            if ws
                .send(Message::Binary(welcome().encode_to_vec().into()))
                .await
                .is_err()
            {
                clear_live(&state, &tx);
                return;
            }
            loop {
                tokio::select! {
                    incoming = ws.next() => match incoming {
                        Some(Ok(Message::Ping(payload))) => {
                            let _ = ws.send(Message::Pong(payload)).await;
                        }
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        Some(Ok(_)) => {}
                    },
                    command = rx.recv() => match command {
                        Some(Command::Frame(frame)) => {
                            if ws.send(Message::Binary(frame.encode_to_vec().into())).await.is_err() {
                                break;
                            }
                        }
                        Some(Command::Close) | None => break,
                    }
                }
            }
            let _ = ws.close(None).await;
            clear_live(&state, &tx);
        }

        fn clear_live(state: &Arc<Mutex<State>>, tx: &mpsc::UnboundedSender<Command>) {
            let mut state = state.lock();
            if state
                .live
                .as_ref()
                .is_some_and(|live| live.same_channel(tx))
            {
                state.live = None;
            }
        }
    }

    async fn connect_to_fake(core: &CoreHandle, link: &str) -> CoreState {
        core.connect(ConnectRequest {
            target: ConnectTarget::Link {
                link: link.to_owned(),
            },
            nickname: "alice".to_owned(),
            password: None,
            accept_new_certificate: false,
        })
        .await
        .expect("connect to the fake server")
    }

    #[test]
    fn a_late_handshake_is_trusted_only_inside_the_server_budget() {
        // The window must outlast the server's own handshake deadline, or a
        // leftover could still register after the client stopped trusting it.
        assert!(LATE_HANDSHAKE_GRACE > protocol::SERVER_HANDSHAKE_BUDGET);
        let (core, _dir) = test_core();
        assert!(!core.inner.take_recent_late_handshake());
        core.inner.note_late_handshake();
        // One abandoned handshake can register once, so one recovery.
        assert!(core.inner.take_recent_late_handshake());
        assert!(!core.inner.take_recent_late_handshake());
        core.inner.note_late_handshake();
        *core.inner.late_handshakes.lock() =
            vec![Instant::now() - LATE_HANDSHAKE_GRACE - Duration::from_secs(1)];
        assert!(!core.inner.take_recent_late_handshake());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_leftover_handshake_replacement_reconnects_instead_of_failing() {
        let server = fake_server::FakeServer::start(Duration::from_secs(6)).await;
        let (core, recorder, _dir) = recorded_core();
        // Shorten the handshake deadline so the race is exercised in seconds.
        core.inner.handshake_timeout_ms.store(700, Ordering::SeqCst);
        let state = connect_to_fake(&core, &server.link()).await;
        assert_eq!(state.connection, ConnectionPhase::Connected);
        let snapshots_before = recorder.snapshots();

        // The server drops the session and the next handshake is delayed, so
        // the client gives up on it and reconnects before it is registered.
        // That leftover then replaces the fresh session, exactly as in the
        // playtest report.
        server.drop_live_and_stall_next_handshake();

        wait_for(&core, "two snapshots after the stale replacement", || {
            recorder.snapshots() >= snapshots_before + 2
        })
        .await;
        assert_eq!(core.state().connection, ConnectionPhase::Connected);
        assert!(
            recorder.resets().is_empty(),
            "the stale replacement must not stop the client: {:?}",
            recorder.resets()
        );
        // Initial session, first retry, the late leftover and the recovery:
        // never two live sessions at once.
        assert_eq!(server.connections(), 4);
        assert_eq!(server.live_sessions(), 1);
        core.disconnect().await.ok();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_replacement_without_a_leftover_handshake_stays_fatal() {
        let server = fake_server::FakeServer::start(Duration::from_secs(1)).await;
        let (core, recorder, _dir) = recorded_core();
        core.inner.handshake_timeout_ms.store(700, Ordering::SeqCst);
        let state = connect_to_fake(&core, &server.link()).await;
        assert_eq!(state.connection, ConnectionPhase::Connected);

        // Another device registered: no handshake of ours is in flight, so the
        // client must stop instead of fighting for the session.
        server.replace_live();
        wait_for(&core, "the reset", || !recorder.resets().is_empty()).await;
        let state = core.state();
        assert_eq!(state.connection, ConnectionPhase::Disconnected);
        let error = state.error.expect("fatal error");
        assert_eq!(error.server_code, Some(ServerErrorCode::SessionReplaced));
        assert!(!error.retryable);
        core.disconnect().await.ok();
    }
}
