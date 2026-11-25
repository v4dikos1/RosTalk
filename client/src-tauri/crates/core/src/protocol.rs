//! WebSocket transport and the `Hello -> Challenge -> Authenticate -> Welcome`
//! handshake (design 4.2, 4.6; ADR 0001, ADR 0004).
//!
//! One binary Protobuf frame per WebSocket message. Requests use a strictly
//! increasing non-zero `request_id`; the server answers with a frame whose
//! `reply_to` repeats it. Frames with `reply_to = 0` are events.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{client_async_with_config, WebSocketStream};

use crate::error::{CoreError, CoreErrorCode};
use crate::link::InviteLink;
use crate::proto;
use crate::tls;
use crate::PROTOCOL_VERSION;

/// Upper bound for the TCP/TLS/WebSocket/handshake sequence.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the server keeps a handshake alive from the WebSocket upgrade
/// (`server/internal/auth`: `handshakeTimeout`).
///
/// The client gives up earlier on purpose (`HANDSHAKE_TIMEOUT`), so a
/// connection abandoned between `Authenticate` and `Welcome` can still be
/// registered by the server later. The engine uses this figure to recognise a
/// replacement caused by that leftover attempt (see `engine::open`).
pub const SERVER_HANDSHAKE_BUDGET: Duration = Duration::from_secs(30);
/// Upper bound for one write.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// The server caps frames at 1 MiB; the client keeps the same limit.
pub const MAX_FRAME_SIZE: usize = 1 << 20;

type WsStream = WebSocketStream<tokio_rustls::client::TlsStream<TcpStream>>;

/// Optional credentials carried by `Hello`. No `Debug`: it carries a password.
#[derive(Default, Clone, Copy)]
pub struct HelloParams<'a> {
    /// Desired display name.
    pub nickname: &'a str,
    /// Server password for password-login servers, empty otherwise.
    pub password: &'a str,
}

/// An open authenticated control-plane connection.
pub struct Session {
    ws: WsStream,
    link: InviteLink,
    server_id: [u8; 32],
    /// SHA-256 of the leaf certificate this session is pinned to.
    tls_fingerprint: [u8; 32],
    welcome: proto::Welcome,
    next_request_id: u64,
}

/// A message the worker must look at. Pings are answered inside [`Session`].
#[derive(Debug)]
pub enum Incoming {
    /// A decoded server frame.
    Frame(Box<proto::ServerFrame>),
    /// A pong for a client ping; proves the connection is alive.
    Pong,
}

impl Session {
    /// Parsed link of this session.
    #[must_use]
    pub fn link(&self) -> &InviteLink {
        &self.link
    }

    /// `Challenge.server_id`: the server's long-lived Ed25519 fingerprint.
    #[must_use]
    pub fn server_id(&self) -> [u8; 32] {
        self.server_id
    }

    /// SHA-256 of the TLS leaf certificate the session was established with.
    #[must_use]
    pub fn tls_fingerprint(&self) -> [u8; 32] {
        self.tls_fingerprint
    }

    /// The `Welcome` frame that opened this session.
    #[must_use]
    pub fn welcome(&self) -> &proto::Welcome {
        &self.welcome
    }

    /// Sends one request and returns its `request_id`.
    pub async fn send(&mut self, payload: proto::client_frame::Payload) -> Result<u64, CoreError> {
        let request_id = self.next_request_id;
        self.next_request_id = self
            .next_request_id
            .checked_add(1)
            .ok_or_else(|| CoreError::internal("request id space exhausted"))?;
        self.send_frame(proto::ClientFrame {
            request_id,
            payload: Some(payload),
        })
        .await?;
        Ok(request_id)
    }

    async fn send_frame(&mut self, frame: proto::ClientFrame) -> Result<(), CoreError> {
        let data = frame.encode_to_vec();
        tokio::time::timeout(WRITE_TIMEOUT, self.ws.send(Message::Binary(data.into())))
            .await
            .map_err(|_| CoreError::new(CoreErrorCode::Timeout, "sending a frame timed out"))?
            .map_err(|err| transport_error(&err))
    }

    /// Sends a WebSocket ping.
    pub async fn ping(&mut self) -> Result<(), CoreError> {
        tokio::time::timeout(
            WRITE_TIMEOUT,
            self.ws.send(Message::Ping(Vec::new().into())),
        )
        .await
        .map_err(|_| CoreError::new(CoreErrorCode::Timeout, "sending a ping timed out"))?
        .map_err(|err| transport_error(&err))
    }

    /// Reads the next frame, answering server pings on the way.
    pub async fn next(&mut self) -> Result<Incoming, CoreError> {
        loop {
            let message = self
                .ws
                .next()
                .await
                .ok_or_else(|| disconnected("connection closed"))?
                .map_err(|err| transport_error(&err))?;
            match message {
                Message::Binary(data) => {
                    let frame = proto::ServerFrame::decode(data.as_ref()).map_err(|err| {
                        CoreError::new(
                            CoreErrorCode::InvalidRequest,
                            format!("server sent a malformed frame: {err}"),
                        )
                    })?;
                    return Ok(Incoming::Frame(Box::new(frame)));
                }
                Message::Ping(payload) => {
                    // Answer explicitly: the server closes a silent client.
                    self.ws
                        .send(Message::Pong(payload))
                        .await
                        .map_err(|err| transport_error(&err))?;
                }
                Message::Pong(_) => return Ok(Incoming::Pong),
                Message::Close(_) => return Err(disconnected("server closed the connection")),
                Message::Text(_) => {
                    return Err(CoreError::new(
                        CoreErrorCode::InvalidRequest,
                        "server sent a text frame, expected binary",
                    ))
                }
                Message::Frame(_) => {}
            }
        }
    }

    /// Closes the WebSocket without waiting for the close handshake.
    pub async fn close(mut self) {
        let _ = self.ws.close(None).await;
    }
}

/// Opens the WebSocket, pins the certificate and performs the handshake.
///
/// `authenticate_sent` is raised once the client has proved possession of its
/// key. From that point on the server may finish the handshake on its own even
/// if this future is dropped, so the caller records the abandoned attempt when
/// no `Welcome` follows.
pub async fn connect(
    link: InviteLink,
    identity: &rostalk_platform::Identity,
    params: HelloParams<'_>,
    timeout: Duration,
    authenticate_sent: &AtomicBool,
) -> Result<Session, CoreError> {
    let setup = tls::tls_setup(link.mode(), link.fingerprint)?;
    let mismatch = setup.mismatch.clone();
    let captured = setup.captured.clone();
    let server_name = tls::server_name(&link.hostname)?;

    tokio::time::timeout(timeout, async move {
        let tcp = TcpStream::connect(link.authority())
            .await
            .map_err(|err| {
                CoreError::new(
                    CoreErrorCode::ConnectionFailed,
                    format!("could not reach {}: {err}", link.authority()),
                )
                .retryable(true)
            })?;
        let _ = tcp.set_nodelay(true);

        let tls_stream = TlsConnector::from(setup.config)
            .connect(server_name, tcp)
            .await
            .map_err(|err| {
                if mismatch.load(std::sync::atomic::Ordering::SeqCst) {
                    CoreError::new(
                        CoreErrorCode::TlsFingerprintMismatch,
                        "the server certificate does not match the fingerprint in the invite link",
                    )
                } else {
                    CoreError::new(
                        CoreErrorCode::Tls,
                        format!("TLS handshake failed: {err}"),
                    )
                    .retryable(true)
                }
            })?;

        let request = link
            .ws_url()
            .into_client_request()
            .map_err(|err| CoreError::new(CoreErrorCode::InvalidLink, err.to_string()))?;
        let mut ws_config = WebSocketConfig::default();
        ws_config.max_message_size = Some(MAX_FRAME_SIZE);
        ws_config.max_frame_size = Some(MAX_FRAME_SIZE);

        let (mut ws, _response) = client_async_with_config(request, tls_stream, Some(ws_config))
            .await
            .map_err(|err| {
                CoreError::new(
                    CoreErrorCode::ConnectionFailed,
                    format!("WebSocket handshake failed: {err}"),
                )
                .retryable(true)
            })?;

        // Hello (request 1).
        let hello = proto::ClientFrame {
            request_id: 1,
            payload: Some(proto::client_frame::Payload::Hello(proto::Hello {
                protocol_version: PROTOCOL_VERSION,
                client_version: format!("rostalk-desktop/{}", env!("CARGO_PKG_VERSION")),
                public_key: identity.public_key().to_vec(),
                nickname: params.nickname.to_owned(),
                invite: link.invite.clone(),
                password: params.password.to_owned(),
            })),
        };
        write(&mut ws, &hello).await?;

        let frame = read_frame(&mut ws).await?;
        expect_reply(&frame, 1)?;
        let challenge = match frame.payload {
            Some(proto::server_frame::Payload::Challenge(challenge)) => challenge,
            _ => {
                return Err(CoreError::new(
                    CoreErrorCode::InvalidRequest,
                    "server did not answer Hello with Challenge",
                ))
            }
        };
        if challenge.nonce.len() < 32 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidRequest,
                "server sent a short challenge nonce",
            ));
        }
        if challenge.server_id.len() != 32 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidRequest,
                "server sent a malformed server id",
            ));
        }
        let mut server_id = [0u8; 32];
        server_id.copy_from_slice(&challenge.server_id);

        // Sign nonce || server_id. The TLS fingerprint is not signed (ADR 0004).
        let mut signed = Vec::with_capacity(challenge.nonce.len() + server_id.len());
        signed.extend_from_slice(&challenge.nonce);
        signed.extend_from_slice(&server_id);
        let signature = identity.sign(&signed);

        let authenticate = proto::ClientFrame {
            request_id: 2,
            payload: Some(proto::client_frame::Payload::Authenticate(
                proto::Authenticate {
                    signature: signature.to_vec(),
                },
            )),
        };
        write(&mut ws, &authenticate).await?;
        // The server can now register this connection without any further
        // input from the client: remember that from here on a dropped
        // handshake may still appear as a second session.
        authenticate_sent.store(true, Ordering::SeqCst);

        let frame = read_frame(&mut ws).await?;
        expect_reply(&frame, 2)?;
        let welcome = match frame.payload {
            Some(proto::server_frame::Payload::Welcome(welcome)) => welcome,
            _ => {
                return Err(CoreError::new(
                    CoreErrorCode::InvalidRequest,
                    "server did not answer Authenticate with Welcome",
                ))
            }
        };

        let snapshot = welcome.snapshot.as_ref().ok_or_else(|| {
            CoreError::new(CoreErrorCode::InvalidRequest, "Welcome has no snapshot")
        })?;
        let info = snapshot.server.as_ref().ok_or_else(|| {
            CoreError::new(CoreErrorCode::InvalidRequest, "Welcome has no server info")
        })?;
        if info.protocol_version != PROTOCOL_VERSION {
            return Err(CoreError::new(
                CoreErrorCode::ProtocolVersionUnsupported,
                format!(
                    "the server speaks protocol version {}, this client implements {}. Update the client.",
                    info.protocol_version, PROTOCOL_VERSION
                ),
            )
            .with_action("https://github.com/v4dikos1/RosTalk/releases"));
        }
        if !info.id.is_empty() && info.id != challenge.server_id {
            return Err(CoreError::new(
                CoreErrorCode::ServerIdMismatch,
                "Welcome.server.id does not match Challenge.server_id",
            ));
        }

        let tls_fingerprint = (*captured.lock()).unwrap_or(link.fingerprint);

        Ok(Session {
            ws,
            link,
            server_id,
            tls_fingerprint,
            welcome,
            next_request_id: 3,
        })
    })
    .await
    .map_err(|_| {
        CoreError::new(CoreErrorCode::Timeout, "connecting to the server timed out").retryable(true)
    })?
}

/// Reads the TLS leaf certificate of `hostname:port` without sending anything.
///
/// This is the first half of a direct login (ADR 0008): the client needs the
/// SHA-256 of the certificate to show it to the user before it can pin it. The
/// probe performs a TLS handshake and closes it immediately: no `Hello`, no
/// public key, no password, no invite. The certificate itself is not trusted:
/// for an IP host any non-CA leaf is accepted only as a *candidate* and its
/// digest is returned; for a DNS host the chain must verify against Web PKI.
/// The real connection is still made by [`connect`] with a strict verifier, so
/// a certificate that changes after the confirmation never slips through.
pub async fn probe_certificate(hostname: &str, port: u16) -> Result<[u8; 32], CoreError> {
    let mode = crate::link::mode_for_host(hostname);
    let (config, capture) = tls::probe_setup(mode)?;
    let server_name = tls::server_name(hostname)?;
    let authority = crate::link::authority(hostname, port);

    tokio::time::timeout(HANDSHAKE_TIMEOUT, async move {
        let tcp = TcpStream::connect(&authority).await.map_err(|err| {
            CoreError::new(
                CoreErrorCode::ConnectionFailed,
                format!("could not reach {authority}: {err}"),
            )
            .retryable(true)
        })?;
        let _ = tcp.set_nodelay(true);
        let tls_stream = TlsConnector::from(config)
            .connect(server_name, tcp)
            .await
            .map_err(|err| {
                // The text never contains a certificate body, only the reason.
                CoreError::new(
                    CoreErrorCode::Tls,
                    format!("TLS handshake with {authority} failed: {err}"),
                )
            })?;
        // Closing without a request is deliberate: the probe must not reveal
        // the local identity or any credential.
        drop(tls_stream);
        capture.fingerprint().ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::Tls,
                "the server did not present a certificate",
            )
        })
    })
    .await
    .map_err(|_| {
        CoreError::new(
            CoreErrorCode::Timeout,
            "reading the server certificate timed out",
        )
        .retryable(true)
    })?
}

fn expect_reply(frame: &proto::ServerFrame, expected_id: u64) -> Result<(), CoreError> {
    match frame.payload.as_ref() {
        None => Err(CoreError::new(
            CoreErrorCode::InvalidRequest,
            "server sent an empty frame",
        )),
        Some(proto::server_frame::Payload::Error(error)) => Err(CoreError::from_server(error)),
        Some(_) if frame.reply_to != expected_id => Err(CoreError::new(
            CoreErrorCode::InvalidRequest,
            format!(
                "server answered request {} while {} was expected",
                frame.reply_to, expected_id
            ),
        )),
        Some(_) => Ok(()),
    }
}

async fn write(ws: &mut WsStream, frame: &proto::ClientFrame) -> Result<(), CoreError> {
    let data = frame.encode_to_vec();
    tokio::time::timeout(WRITE_TIMEOUT, ws.send(Message::Binary(data.into())))
        .await
        .map_err(|_| CoreError::new(CoreErrorCode::Timeout, "handshake write timed out"))?
        .map_err(|err| transport_error(&err))
}

async fn read_frame(ws: &mut WsStream) -> Result<proto::ServerFrame, CoreError> {
    loop {
        let message = ws
            .next()
            .await
            .ok_or_else(|| disconnected("connection closed during the handshake"))?
            .map_err(|err| transport_error(&err))?;
        match message {
            Message::Binary(data) => {
                return proto::ServerFrame::decode(data.as_ref()).map_err(|err| {
                    CoreError::new(
                        CoreErrorCode::InvalidRequest,
                        format!("server sent a malformed frame: {err}"),
                    )
                });
            }
            Message::Ping(payload) => {
                ws.send(Message::Pong(payload))
                    .await
                    .map_err(|err| transport_error(&err))?;
            }
            Message::Pong(_) | Message::Frame(_) => {}
            Message::Close(_) => return Err(disconnected("server closed during the handshake")),
            Message::Text(_) => {
                return Err(CoreError::new(
                    CoreErrorCode::InvalidRequest,
                    "server sent a text frame during the handshake",
                ))
            }
        }
    }
}

fn disconnected(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::ConnectionFailed, message).retryable(true)
}

fn transport_error(err: &tokio_tungstenite::tungstenite::Error) -> CoreError {
    CoreError::new(
        CoreErrorCode::ConnectionFailed,
        format!("connection error: {err}"),
    )
    .retryable(true)
}
