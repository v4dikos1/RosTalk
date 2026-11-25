//! Loopback WebSocket proxy for the screen-share signalling (stage 5.1).
//!
//! The WebView cannot verify the pinned self-signed certificate of a LAN
//! server, and the media token must not become a long-lived value in the page.
//! This proxy listens on `127.0.0.1:<random>`, requires the per-process proxy
//! token on the upgrade, and forwards the LiveKit signalling stream to
//! `wss://<gateway>/rtc` over pinned TLS. The media token is injected here, from
//! the credentials the core received over the control plane: the page only
//! ever sees `ws://127.0.0.1:<port>/rtc?pt=<proxy token>` and a placeholder
//! access token.
//!
//! Only `/rtc` exists and every upgrade needs the proxy token, so the page
//! cannot turn this into a generic WebSocket client for the server.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::server::{
    ErrorResponse, Request as WsRequest, Response as WsResponse,
};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use crate::error::CoreError;
use crate::link::InviteLink;
use crate::tls;

/// One media credential the page may connect with.
#[derive(Clone)]
struct MediaCredential {
    token: String,
    expires_at: Instant,
}

/// A running loopback WebSocket proxy.
pub struct StreamProxy {
    addr: SocketAddr,
    token: String,
    credential: Arc<Mutex<Option<MediaCredential>>>,
    shutdown: Option<oneshot::Sender<()>>,
}

impl StreamProxy {
    /// Starts the proxy for one authenticated session. It does not need a
    /// media token yet; [`StreamProxy::set_credential`] installs it before the
    /// page connects.
    pub async fn start(link: InviteLink, fingerprint: [u8; 32]) -> Result<Self, CoreError> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|err| {
            CoreError::internal(format!("could not start the stream proxy: {err}"))
        })?;
        let addr = listener.local_addr().map_err(|err| {
            CoreError::internal(format!("could not read the stream proxy address: {err}"))
        })?;
        let token = random_token()?;
        let credential = Arc::new(Mutex::new(None));
        let (shutdown, mut stopped) = oneshot::channel::<()>();

        let state = ProxyState {
            link,
            fingerprint,
            token: token.clone(),
            credential: credential.clone(),
        };
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _peer)) = accepted else { break };
                        let state = state.clone();
                        tokio::spawn(async move {
                            if let Err(err) = handle(stream, state).await {
                                // Never include the URL or the token.
                                log::debug!("stream proxy connection failed: {err}");
                            }
                        });
                    }
                }
            }
        });

        Ok(Self {
            addr,
            token,
            credential,
            shutdown: Some(shutdown),
        })
    }

    /// `ws://127.0.0.1:<port>?pt=<token>` for `room.connect`.
    ///
    /// `livekit-client` appends the signalling path (`/rtc` or `/rtc/v1`)
    /// itself. The proxy accepts exactly `/rtc` (and `/rtc/v1` falls back), so
    /// the base URL must not carry a path of its own.
    #[must_use]
    pub fn url(&self) -> String {
        format!("ws://{}?pt={}", self.addr, self.token)
    }

    /// Installs the current stream token. A later call replaces it, so a
    /// reconnect after an expiry never reuses the old credential.
    pub fn set_credential(&self, token: String, ttl: Duration) {
        *self.credential.lock() = Some(MediaCredential {
            token,
            expires_at: Instant::now() + ttl,
        });
    }

    /// Drops the credential (leave channel, disconnect, session reset).
    pub fn clear_credential(&self) {
        *self.credential.lock() = None;
    }
}

impl Drop for StreamProxy {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

#[derive(Clone)]
struct ProxyState {
    link: InviteLink,
    fingerprint: [u8; 32],
    token: String,
    credential: Arc<Mutex<Option<MediaCredential>>>,
}

// The tungstenite upgrade callback returns `Result<Response, ErrorResponse>`;
// the rejection type is a full HTTP response, which Clippy considers large. The
// signature is fixed by the library.
#[allow(clippy::result_large_err)]
async fn handle(mut stream: TcpStream, state: ProxyState) -> Result<(), CoreError> {
    let _ = stream.set_nodelay(true);
    // `livekit-client` probes its HTTP `validate` endpoint when the first
    // WebSocket attempt fails (it always tries `/rtc/v1` first against this
    // server). Answering that probe with a CORS 404 makes the client fall back
    // to `/rtc`; letting the WebSocket handshake reject it would look like an
    // unreachable proxy and abort the connection.
    if let Some(response) = probe_response(&stream).await? {
        use tokio::io::AsyncWriteExt as _;
        stream
            .write_all(response.as_bytes())
            .await
            .map_err(|err| CoreError::internal(format!("stream proxy probe failed: {err}")))?;
        let _ = stream.shutdown().await;
        return Ok(());
    }
    // The callback decides whether the upgrade is allowed and which media
    // token to inject. Any other path or a missing/incorrect proxy token is a
    // 401/404 before a WebSocket is established.
    let expected = state.token.clone();
    let credential = state.credential.clone();
    let media = Arc::new(Mutex::new(None::<String>));
    let captured = media.clone();
    let query = Arc::new(Mutex::new(None::<String>));
    let captured_query = query.clone();
    let client = tokio_tungstenite::accept_hdr_async(
        stream,
        move |request: &WsRequest, response: WsResponse| {
            if request.uri().path() != "/rtc" {
                return Err(reject(StatusCode::NOT_FOUND, "not found"));
            }
            if !query_token_matches(request.uri().query(), &expected) {
                return Err(reject(StatusCode::UNAUTHORIZED, "unauthenticated"));
            }
            let current = credential.lock().clone();
            match current {
                Some(credential) if credential.expires_at > Instant::now() => {
                    *captured.lock() = Some(credential.token);
                    *captured_query.lock() = request.uri().query().map(str::to_owned);
                    Ok(response)
                }
                Some(_) => Err(reject(StatusCode::UNAUTHORIZED, "media token expired")),
                None => Err(reject(StatusCode::CONFLICT, "no stream credentials")),
            }
        },
    )
    .await
    .map_err(|err| CoreError::internal(format!("stream proxy upgrade failed: {err}")))?;

    let token = media
        .lock()
        .clone()
        .ok_or_else(|| CoreError::internal("stream proxy has no media token"))?;
    let client_query = query.lock().clone();
    let upstream = upstream_url(&state.link, &token, client_query.as_deref())?;
    let setup = tls::tls_setup(state.link.mode(), state.fingerprint).map_err(|err| {
        CoreError::internal(format!("stream proxy TLS setup failed: {}", err.message))
    })?;
    let authority = state.link.authority();
    let tcp = TcpStream::connect(&authority).await.map_err(|_| {
        CoreError::new(
            crate::error::CoreErrorCode::ConnectionFailed,
            "could not reach the media signalling gateway",
        )
    })?;
    let _ = tcp.set_nodelay(true);
    let server_name = tls::server_name(&state.link.hostname)
        .map_err(|err| CoreError::internal(format!("stream proxy hostname: {}", err.message)))?;
    let tls_stream = TlsConnector::from(setup.config)
        .connect(server_name, tcp)
        .await
        .map_err(|_| {
            CoreError::new(
                crate::error::CoreErrorCode::Tls,
                "could not verify the media signalling certificate",
            )
        })?;
    let request = upstream
        .as_str()
        .into_client_request()
        .map_err(|err| CoreError::internal(format!("stream proxy request failed: {err}")))?;
    let (server, _) = tokio_tungstenite::client_async(request, tls_stream)
        .await
        .map_err(|_| {
            CoreError::new(
                crate::error::CoreErrorCode::ConnectionFailed,
                "could not open the media signalling connection",
            )
        })?;

    relay(client, server).await;
    Ok(())
}

/// Answers the HTTP validation probe used by `livekit-client` when its first
/// WebSocket attempt fails. A WebSocket upgrade returns `None` and continues to
/// the normal handshake.
async fn probe_response(stream: &TcpStream) -> Result<Option<&'static str>, CoreError> {
    let mut buffer = [0u8; 8192];
    let read = stream
        .peek(&mut buffer)
        .await
        .map_err(|err| CoreError::internal(format!("stream proxy peek failed: {err}")))?;
    if read == 0 {
        return Ok(None);
    }
    let head = String::from_utf8_lossy(&buffer[..read]);
    let lower = head.to_ascii_lowercase();
    if lower.contains("upgrade: websocket") {
        return Ok(None);
    }
    let request_line = head.lines().next().unwrap_or_default();
    if request_line.starts_with("OPTIONS ") {
        return Ok(Some(
            "HTTP/1.1 204 No Content\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Access-Control-Allow-Methods: GET, OPTIONS\r\n\
             Access-Control-Allow-Headers: *\r\n\
             Content-Length: 0\r\n\
             Connection: close\r\n\r\n",
        ));
    }
    Ok(Some(
        "HTTP/1.1 404 Not Found\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: *\r\n\
         Content-Length: 0\r\n\
         Connection: close\r\n\r\n",
    ))
}

/// Builds the upstream signalling URL: the gateway path, the caller's other
/// query parameters (LiveKit adds `auto_subscribe`, `sdk`, reconnect hints and
/// so on) and the real media token instead of the page's placeholder. The
/// proxy's own `pt` parameter and the placeholder `access_token` are dropped.
fn upstream_url(
    link: &InviteLink,
    token: &str,
    client_query: Option<&str>,
) -> Result<Url, CoreError> {
    let mut url = Url::parse(&format!("wss://{}/rtc", link.authority()))
        .map_err(|err| CoreError::internal(format!("stream gateway URL is invalid: {err}")))?;
    if let Some(query) = client_query {
        for (name, value) in url::form_urlencoded::parse(query.as_bytes()) {
            if name != "pt" && name != "access_token" {
                url.query_pairs_mut().append_pair(&name, &value);
            }
        }
    }
    url.query_pairs_mut().append_pair("access_token", token);
    Ok(url)
}

async fn relay<C, S>(client: C, server: S)
where
    C: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
{
    let (mut client_tx, mut client_rx) = client.split();
    let (mut server_tx, mut server_rx) = server.split();
    let client_to_server = async {
        while let Some(message) = client_rx.next().await {
            let Ok(message) = message else { break };
            let closing = matches!(message, Message::Close(_));
            if server_tx.send(message).await.is_err() {
                break;
            }
            if closing {
                break;
            }
        }
    };
    let server_to_client = async {
        while let Some(message) = server_rx.next().await {
            let Ok(message) = message else { break };
            let closing = matches!(message, Message::Close(_));
            if client_tx.send(message).await.is_err() {
                break;
            }
            if closing {
                break;
            }
        }
    };
    tokio::join!(client_to_server, server_to_client);
}

fn reject(status: StatusCode, message: &'static str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(message.to_owned()));
    *response.status_mut() = status;
    response
}

fn query_token_matches(query: Option<&str>, token: &str) -> bool {
    let Some(query) = query else {
        return false;
    };
    for (name, value) in url::form_urlencoded::parse(query.as_bytes()) {
        if name == "pt" && constant_time_eq(value.as_bytes(), token.as_bytes()) {
            return true;
        }
    }
    false
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
    fn proxy_token_is_read_from_pt_only() {
        assert!(query_token_matches(Some("pt=abc&x=1"), "abc"));
        assert!(!query_token_matches(Some("x=1"), "abc"));
        assert!(!query_token_matches(Some("pt=abcd"), "abc"));
        assert!(!query_token_matches(None, "abc"));
    }

    #[test]
    fn upstream_url_carries_the_media_token_not_the_placeholder() {
        let link = InviteLink::parse(&format!(
            "rostalk://join?host=192.168.0.13:7443&fp={}&invite=x",
            "ab".repeat(32)
        ))
        .expect("link");
        let url = upstream_url(
            &link,
            "media-secret",
            Some("pt=proxy&access_token=placeholder&auto_subscribe=0&sdk=js"),
        )
        .expect("url");
        assert_eq!(url.scheme(), "wss");
        assert_eq!(url.path(), "/rtc");
        let pairs: Vec<_> = url.query_pairs().collect();
        assert_eq!(
            pairs,
            vec![
                ("auto_subscribe".into(), "0".into()),
                ("sdk".into(), "js".into()),
                ("access_token".into(), "media-secret".into()),
            ]
        );
    }
}
