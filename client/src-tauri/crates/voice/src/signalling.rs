//! Local WebSocket proxy for LiveKit signalling with certificate pinning.
//!
//! The `livekit` SDK verifies the signalling TLS certificate against the OS
//! trust store and offers no hook for a pinned certificate. RosTalk servers use
//! a private CA (ADR 0001), so the SDK would reject them. The voice engine
//! therefore exposes the gateway through a loopback WebSocket proxy:
//!
//! ```text
//! livekit SDK ── ws://127.0.0.1:<port> ── proxy ── wss://host:7443/rtc (pinned)
//! ```
//!
//! The proxy verifies the SHA-256 of the server's leaf certificate against the
//! fingerprint from the invitation (ADR 0006), forwards the access token only
//! inside the TLS stream, and never logs the URL or the token. Media (ICE/DTLS)
//! does not pass through the proxy.
//!
//! TODO(security): unlike `stream_proxy`, this loopback listener has no
//! per-process token, so any local process (or a web page that scans loopback
//! ports) can use it as a relay to the pinned gateway. It injects no secret and
//! the gateway still requires the media token, which only the SDK sends to this
//! URL, so the practical exposure is low. Do not bolt a token onto the URL
//! without checking how the Rust SDK joins its signalling path: `room.connect`
//! appends `/rtc` (or `/rtc/v1`) to the base URL, so a naive `?pt=` query or a
//! path prefix can produce `…?pt=…/rtc` or a replaced path. Add the token as a
//! path segment only after a live handshake test against the pinned gateway,
//! and keep the local host `127.0.0.1`.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::Uri;
use tokio_tungstenite::tungstenite::ClientRequestBuilder;
use tokio_tungstenite::{accept_hdr_async, connect_async_tls_with_config, Connector};

use crate::error::VoiceError;

/// A running loopback proxy.
pub struct SignallingProxy {
    local_url: String,
    task: JoinHandle<()>,
}

impl SignallingProxy {
    /// Starts the proxy for one gateway URL and pinned leaf fingerprint.
    ///
    /// `gateway` is the URL from `MediaCredentials`, for example
    /// `wss://192.168.0.13:7443/rtc`; `fingerprint` is the lowercase hex
    /// SHA-256 of the server certificate from the invitation link.
    pub async fn start(gateway: &str, fingerprint: &str) -> Result<Self, VoiceError> {
        let target = parse_gateway(gateway)?;
        let expected = parse_fingerprint(fingerprint)?;
        let tls = pinned_tls_config(expected)?;
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| VoiceError::Media(format!("signalling proxy bind: {error}")))?;
        let address = listener
            .local_addr()
            .map_err(|error| VoiceError::Media(format!("signalling proxy address: {error}")))?;
        let local_url = format!("ws://{address}");
        let task = tokio::spawn(accept_loop(listener, target, tls));
        Ok(Self { local_url, task })
    }

    /// Loopback URL to hand to `Room::connect`.
    #[must_use]
    pub fn local_url(&self) -> &str {
        &self.local_url
    }
}

impl Drop for SignallingProxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Gateway {
    /// `wss://host:port`.
    authority: String,
    /// Path of the gateway from `MediaCredentials`, normally `/rtc`.
    path: String,
}

fn parse_gateway(gateway: &str) -> Result<Gateway, VoiceError> {
    let url = url::Url::parse(gateway)
        .map_err(|error| VoiceError::Media(format!("invalid media URL: {error}")))?;
    if url.scheme() != "wss" {
        return Err(VoiceError::Media(
            "media signalling must use wss://".to_owned(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| VoiceError::Media("media URL has no host".to_owned()))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| VoiceError::Media("media URL has no port".to_owned()))?;
    let path = if url.path().is_empty() {
        "/rtc".to_owned()
    } else {
        url.path().trim_end_matches('/').to_owned()
    };
    // An IPv6 literal is bracketed in the authority; `host_str` may or may not
    // keep the brackets depending on the `url` version, so only add missing
    // ones. Without them `wss://2001:db8::1:7443` is ambiguous.
    let host = if host.starts_with('[') {
        host.to_owned()
    } else if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    Ok(Gateway {
        authority: format!("wss://{host}:{port}"),
        path,
    })
}

fn parse_fingerprint(fingerprint: &str) -> Result<[u8; 32], VoiceError> {
    let decoded = hex::decode(fingerprint.trim().replace([':', ' '], ""))
        .map_err(|_| VoiceError::Media("invalid certificate fingerprint".to_owned()))?;
    decoded
        .try_into()
        .map_err(|_| VoiceError::Media("invalid certificate fingerprint length".to_owned()))
}

async fn accept_loop(listener: TcpListener, gateway: Gateway, tls: Arc<rustls::ClientConfig>) {
    loop {
        let (socket, _) = match listener.accept().await {
            Ok(value) => value,
            Err(error) => {
                log::debug!("signalling proxy accept failed: {error}");
                continue;
            }
        };
        let gateway = Gateway {
            authority: gateway.authority.clone(),
            path: gateway.path.clone(),
        };
        let tls = tls.clone();
        tokio::spawn(async move {
            if let Err(error) = serve(socket, gateway, tls).await {
                log::debug!("signalling proxy connection ended: {error}");
            }
        });
    }
}

#[allow(clippy::result_large_err)]
async fn serve(
    socket: tokio::net::TcpStream,
    gateway: Gateway,
    tls: Arc<rustls::ClientConfig>,
) -> Result<(), String> {
    let captured: Arc<parking_lot_lite::Slot> = Arc::new(parking_lot_lite::Slot::default());
    let capture = captured.clone();
    let mut client = accept_hdr_async(socket, move |request: &Request, response: Response| {
        capture.set(CapturedRequest {
            query: request
                .uri()
                .query()
                .map(|value| value.to_owned())
                .unwrap_or_default(),
            headers: forwardable_headers(request),
        });
        Ok(response)
    })
    .await
    .map_err(|error| format!("local handshake: {error}"))?;

    // The SDK may ask for `/rtc` or `/rtc/v1`; the embedded gateway serves only
    // the path from the credentials, so the proxy always uses that path and
    // forwards the query and the authentication header unchanged.
    let request = captured.take().unwrap_or_default();
    let mut target = format!("{}{}", gateway.authority, gateway.path);
    if !request.query.is_empty() {
        target.push('?');
        target.push_str(&request.query);
    }
    let uri: Uri = target
        .parse()
        .map_err(|error| format!("gateway URI: {error}"))?;
    let mut builder = ClientRequestBuilder::new(uri);
    for (name, value) in request.headers {
        builder = builder.with_header(name, value);
    }
    let (mut server, _) =
        connect_async_tls_with_config(builder, None, false, Some(Connector::Rustls(tls)))
            .await
            // The error text can include the full target URL; it never reaches a
            // log. The caller gets a generic message instead.
            .map_err(|_| "gateway handshake failed".to_owned())?;

    pump(&mut client, &mut server).await;
    Ok(())
}

async fn pump<A, B>(
    client: &mut tokio_tungstenite::WebSocketStream<A>,
    server: &mut tokio_tungstenite::WebSocketStream<B>,
) where
    A: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    B: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        tokio::select! {
            message = client.next() => {
                match message {
                    Some(Ok(message)) => {
                        let close = message.is_close();
                        if server.send(message).await.is_err() || close {
                            break;
                        }
                    }
                    _ => break,
                }
            }
            message = server.next() => {
                match message {
                    Some(Ok(message)) => {
                        let close = message.is_close();
                        if client.send(message).await.is_err() || close {
                            break;
                        }
                    }
                    _ => break,
                }
            }
        }
    }
    let _ = client.close(None).await;
    let _ = server.close(None).await;
}

/// Tiny once-slot without pulling another dependency into the crate.
mod parking_lot_lite {
    use std::sync::Mutex;

    use super::CapturedRequest;

    #[derive(Default)]
    pub struct Slot(Mutex<Option<CapturedRequest>>);

    impl Slot {
        pub fn set(&self, value: CapturedRequest) {
            if let Ok(mut guard) = self.0.lock() {
                *guard = Some(value);
            }
        }

        pub fn take(&self) -> Option<CapturedRequest> {
            self.0.lock().ok().and_then(|mut guard| guard.take())
        }
    }
}

/// What the proxy needs from the local handshake.
#[derive(Default)]
struct CapturedRequest {
    query: String,
    headers: Vec<(String, String)>,
}

/// Hop-by-hop and WebSocket handshake headers belong to tungstenite; the rest
/// (notably `Authorization: Bearer <token>`) must reach the gateway.
fn forwardable_headers(request: &Request) -> Vec<(String, String)> {
    const SKIPPED: &[&str] = &[
        "host",
        "connection",
        "upgrade",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-extensions",
        "sec-websocket-protocol",
        "sec-websocket-accept",
        "origin",
    ];
    request
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            let name = name.as_str();
            if SKIPPED.contains(&name.to_ascii_lowercase().as_str()) {
                return None;
            }
            value
                .to_str()
                .ok()
                .map(|value| (name.to_owned(), value.to_owned()))
        })
        .collect()
}

/// Certificate verifier that accepts exactly one leaf fingerprint.
#[derive(Debug)]
struct PinnedVerifier {
    expected: [u8; 32],
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let digest = Sha256::digest(end_entity.as_ref());
        if digest.as_slice() == self.expected {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "media certificate fingerprint mismatch".to_owned(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            certificate,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            certificate,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn pinned_tls_config(expected: [u8; 32]) -> Result<Arc<rustls::ClientConfig>, VoiceError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|error| VoiceError::Media(format!("TLS configuration: {error}")))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedVerifier { expected, provider }))
        .with_no_client_auth();
    Ok(Arc::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_url_keeps_host_port_and_path() {
        let gateway = parse_gateway("wss://192.168.0.13:7443/rtc").expect("gateway");
        assert_eq!(gateway.authority, "wss://192.168.0.13:7443");
        assert_eq!(gateway.path, "/rtc");
    }

    #[test]
    fn gateway_url_brackets_an_ipv6_host() {
        let gateway = parse_gateway("wss://[2001:db8::1]:7443/rtc").expect("gateway");
        assert_eq!(gateway.authority, "wss://[2001:db8::1]:7443");
        assert_eq!(gateway.path, "/rtc");
    }

    #[test]
    fn plain_websocket_is_rejected() {
        assert!(parse_gateway("ws://192.168.0.13:7443/rtc").is_err());
    }

    #[test]
    fn fingerprint_accepts_colons_and_rejects_garbage() {
        let fingerprint = "6b:d0:8a:af:51:92:27:21:b7:24:95:09:89:b9:76:72:7a:4f:64:9e:2f:0d:56:64:9a:77:c7:fb:92:ea:ad:9c";
        let parsed = parse_fingerprint(fingerprint).expect("fingerprint");
        assert_eq!(parsed[0], 0x6b);
        assert!(parse_fingerprint("not-hex").is_err());
        assert!(parse_fingerprint("aabb").is_err());
    }

    #[test]
    fn authentication_header_is_forwarded_but_handshake_headers_are_not() {
        let request = tokio_tungstenite::tungstenite::http::Request::builder()
            .uri("/rtc/v1?access_token=ignored")
            .header("authorization", "Bearer token")
            .header("user-agent", "rostalk")
            .header("host", "127.0.0.1")
            .header("sec-websocket-key", "abc")
            .body(())
            .expect("request");
        let headers = forwardable_headers(&request);
        assert!(headers
            .iter()
            .any(|(name, value)| name == "authorization" && value == "Bearer token"));
        assert!(headers.iter().any(|(name, _)| name == "user-agent"));
        assert!(!headers.iter().any(|(name, _)| name == "host"));
        assert!(!headers.iter().any(|(name, _)| name == "sec-websocket-key"));
    }
}
