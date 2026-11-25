//! TLS configuration for the control-plane WebSocket.
//!
//! Two trust modes (ADR 0001, ADR 0004):
//!
//! - **Pinned** (no domain, the default for a LAN server): `fp` from the invite
//!   link is the SHA-256 of the TLS **leaf** certificate. The verifier compares
//!   the DER bytes the server presents with that digest. It never treats the
//!   server's CA certificate as an end entity: a CA certificate simply does not
//!   match the leaf fingerprint. This is the rustls-safe equivalent of what Go
//!   accepts, and it is why the server signs a separate leaf.
//! - **Web PKI** (a DNS name, `--domain` deployments): ordinary certificate
//!   chain and hostname verification against the system/Mozilla roots.
//!
//! The pinned path deliberately does not check the hostname: a LAN IP usually
//! has no SAN, and the fingerprint already binds the connection to the exact
//! certificate in the invitation.
//!
//! A direct login by `host:port` has no fingerprint from an out-of-band
//! channel. [`probe_setup`] builds a verifier that *captures* the leaf
//! certificate so the user can confirm its SHA-256 before anything is sent
//! (trust on first use, ADR 0008). The probe itself never authenticates and
//! never sends the public key or a password; the real connection still uses
//! one of the two verifiers above.

use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error as RustlsError, RootCertStore};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, CoreErrorCode};
use crate::link::ServerMode;

/// A configured TLS client and the flag that tells a fingerprint mismatch
/// apart from other TLS failures.
pub struct TlsSetup {
    /// Ready-to-use rustls configuration.
    pub config: Arc<ClientConfig>,
    /// Set by the pinned verifier when the leaf digest differs from `fp`.
    pub mismatch: Arc<AtomicBool>,
    /// Leaf digest recorded during the handshake. For a pinned connection it
    /// equals `fp`; for Web PKI it is the certificate the server actually
    /// presented and is what the media proxy pins (ADR 0006).
    pub captured: Arc<Mutex<Option<[u8; 32]>>>,
}

/// A TLS client that accepts the certificate it is shown and records its
/// SHA-256, for the first direct login (ADR 0008).
///
/// It is only used by [`crate::protocol::probe_certificate`], before any
/// credential is sent, and never by a real session.
#[derive(Debug, Default)]
pub struct CertificateProbe {
    fingerprint: Mutex<Option<[u8; 32]>>,
}

impl CertificateProbe {
    /// SHA-256 of the leaf certificate the server presented, once the
    /// handshake finished.
    #[must_use]
    pub fn fingerprint(&self) -> Option<[u8; 32]> {
        *self.fingerprint.lock()
    }
}

/// Builds the TLS configuration for one connection.
pub fn tls_setup(mode: ServerMode, fingerprint: [u8; 32]) -> Result<TlsSetup, CoreError> {
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|err| CoreError::new(CoreErrorCode::Tls, format!("TLS setup: {err}")))?;

    let mismatch = Arc::new(AtomicBool::new(false));
    let captured: Arc<Mutex<Option<[u8; 32]>>> = Arc::new(Mutex::new(None));
    let mut config = match mode {
        ServerMode::Pinned => {
            let verifier = PinnedVerifier {
                expected: fingerprint,
                mismatch: mismatch.clone(),
                captured: captured.clone(),
                provider,
            };
            builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(verifier))
                .with_no_client_auth()
        }
        ServerMode::WebPki => {
            let verifier = WebPkiCapturingVerifier {
                captured: captured.clone(),
                inner: WebPkiServerVerifier::builder_with_provider(
                    Arc::new(web_pki_roots()),
                    provider.clone(),
                )
                .build()
                .map_err(|err| {
                    CoreError::new(
                        CoreErrorCode::Tls,
                        format!("could not build the Web PKI verifier: {err}"),
                    )
                })?,
            };
            builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(verifier))
                .with_no_client_auth()
        }
    };
    // The control plane speaks HTTP/1.1 WebSocket (design 4.6).
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(TlsSetup {
        config: Arc::new(config),
        mismatch,
        captured,
    })
}

/// Builds the capture-only configuration used before a direct login.
///
/// In [`ServerMode::Pinned`] (an IP address) the certificate is accepted as
/// `the` identity candidate and only its digest is recorded: this is the
/// trust-on-first-use step the user confirms. In [`ServerMode::WebPki`] (a DNS
/// name) the chain still has to verify against Web PKI; the digest is recorded
/// for display. A CA certificate used as a server leaf is always rejected
/// (ADR 0001).
pub fn probe_setup(
    mode: ServerMode,
) -> Result<(Arc<ClientConfig>, Arc<CertificateProbe>), CoreError> {
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|err| CoreError::new(CoreErrorCode::Tls, format!("TLS setup: {err}")))?;

    let capture = Arc::new(CertificateProbe::default());
    let inner = match mode {
        ServerMode::Pinned => None,
        ServerMode::WebPki => Some(
            WebPkiServerVerifier::builder_with_provider(
                Arc::new(web_pki_roots()),
                provider.clone(),
            )
            .build()
            .map_err(|err| {
                CoreError::new(
                    CoreErrorCode::Tls,
                    format!("could not build the Web PKI verifier: {err}"),
                )
            })?,
        ),
    };
    let verifier = ProbeVerifier {
        capture: capture.clone(),
        provider,
        inner,
    };
    let mut config = builder
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok((Arc::new(config), capture))
}

/// Converts a link host into a rustls server name.
///
/// IP literals become `ServerName::IpAddress` (no SNI, matching what the
/// development server expects); DNS names are validated by rustls.
pub fn server_name(hostname: &str) -> Result<ServerName<'static>, CoreError> {
    if let Ok(ip) = hostname.parse::<IpAddr>() {
        return Ok(ServerName::IpAddress(ip.into()));
    }
    ServerName::try_from(hostname.to_owned())
        .map_err(|_| CoreError::new(CoreErrorCode::InvalidLink, "invalid server hostname"))
}

fn web_pki_roots() -> RootCertStore {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    // The Windows store can contain corporate or local roots that a domain
    // deployment may use; failures to read it are not fatal.
    let native = rustls_native_certs::load_native_certs();
    for cert in native.certs {
        let _ = roots.add(cert);
    }
    roots
}

fn provider() -> Arc<CryptoProvider> {
    static PROVIDER: OnceLock<Arc<CryptoProvider>> = OnceLock::new();
    PROVIDER
        .get_or_init(|| {
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            // Installing the process default keeps `ClientConfig::builder`
            // usable for tests; a second install is harmless.
            let _ = (*provider).clone().install_default();
            provider
        })
        .clone()
}

/// Verifier for the no-domain mode: pin the leaf certificate bytes.
#[derive(Debug)]
struct PinnedVerifier {
    expected: [u8; 32],
    mismatch: Arc<AtomicBool>,
    captured: Arc<Mutex<Option<[u8; 32]>>>,
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
    ) -> Result<ServerCertVerified, RustlsError> {
        // A CA certificate must never be used as the server leaf (ADR 0001):
        // the development server signs a separate leaf, and Go accepts a CA
        // while rustls/webpki would reject it with CaUsedAsEndEntity. The
        // pinned path does not run webpki, so it checks BasicConstraints itself.
        if presented_leaf_is_ca(end_entity.as_ref()) {
            return Err(ca_as_leaf_error());
        }

        let digest = Sha256::digest(end_entity.as_ref());
        if digest.as_slice() != self.expected {
            self.mismatch.store(true, Ordering::SeqCst);
            return Err(RustlsError::General(
                "rostalk: server certificate fingerprint mismatch".to_owned(),
            ));
        }
        let mut fingerprint = [0u8; 32];
        fingerprint.copy_from_slice(digest.as_slice());
        *self.captured.lock() = Some(fingerprint);
        // The fingerprint is the identity, exactly like an SSH host key. The
        // certificate's validity dates and SAN are not needed for pinning.
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Web PKI verifier that also records the leaf digest, so a domain deployment
/// can pin its media signalling proxy and save the fingerprint in a bookmark.
#[derive(Debug)]
struct WebPkiCapturingVerifier {
    captured: Arc<Mutex<Option<[u8; 32]>>>,
    inner: Arc<WebPkiServerVerifier>,
}

impl ServerCertVerifier for WebPkiCapturingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        self.inner.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        )?;
        let digest = Sha256::digest(end_entity.as_ref());
        let mut fingerprint = [0u8; 32];
        fingerprint.copy_from_slice(digest.as_slice());
        *self.captured.lock() = Some(fingerprint);
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// Verifier used only to read the leaf certificate before a direct login.
#[derive(Debug)]
struct ProbeVerifier {
    capture: Arc<CertificateProbe>,
    provider: Arc<CryptoProvider>,
    /// Web PKI verifier for a DNS host; `None` for an IP host (TOFU).
    inner: Option<Arc<WebPkiServerVerifier>>,
}

impl ServerCertVerifier for ProbeVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        if presented_leaf_is_ca(end_entity.as_ref()) {
            return Err(ca_as_leaf_error());
        }
        if let Some(inner) = &self.inner {
            inner.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)?;
        }
        let digest = Sha256::digest(end_entity.as_ref());
        let mut fingerprint = [0u8; 32];
        fingerprint.copy_from_slice(digest.as_slice());
        *self.capture.fingerprint.lock() = Some(fingerprint);
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        if let Some(inner) = &self.inner {
            return inner.verify_tls12_signature(message, cert, dss);
        }
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        if let Some(inner) = &self.inner {
            return inner.verify_tls13_signature(message, cert, dss);
        }
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        match &self.inner {
            Some(inner) => inner.supported_verify_schemes(),
            None => self
                .provider
                .signature_verification_algorithms
                .supported_schemes(),
        }
    }
}

/// Whether the presented end entity is a CA certificate.
fn presented_leaf_is_ca(der: &[u8]) -> bool {
    x509_parser::parse_x509_certificate(der)
        .ok()
        .and_then(|(_, cert)| {
            cert.basic_constraints()
                .ok()
                .flatten()
                .map(|constraints| constraints.value.ca)
        })
        .unwrap_or(false)
}

fn ca_as_leaf_error() -> RustlsError {
    RustlsError::General("rostalk: the server presented a CA certificate as its leaf".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_setup_builds_and_reports_mismatch_later() {
        let setup = tls_setup(ServerMode::Pinned, [1u8; 32]).expect("tls");
        assert!(!setup.mismatch.load(Ordering::SeqCst));
        assert_eq!(*setup.captured.lock(), None);
        assert_eq!(setup.config.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    #[test]
    fn web_pki_setup_builds() {
        let setup = tls_setup(ServerMode::WebPki, [0u8; 32]).expect("tls");
        assert!(!setup.mismatch.load(Ordering::SeqCst));
    }

    #[test]
    fn server_name_accepts_ip_and_dns() {
        assert!(matches!(
            server_name("192.168.0.13").expect("ip"),
            ServerName::IpAddress(_)
        ));
        assert!(matches!(
            server_name("voice.example.com").expect("dns"),
            ServerName::DnsName(_)
        ));
        assert!(server_name("not a host").is_err());
    }

    #[test]
    fn pinned_verifier_rejects_a_ca_certificate_as_the_leaf() {
        // The server must sign a separate leaf (ADR 0001). The pinned path does
        // not run webpki, so the verifier refuses a CA on its own.
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("params");
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let key = rcgen::KeyPair::generate().expect("key");
        let certificate = params.self_signed(&key).expect("certificate");
        let der = certificate.der().clone();
        let expected = crate::link::leaf_fingerprint(der.as_ref());

        let verifier = PinnedVerifier {
            expected,
            mismatch: Arc::new(AtomicBool::new(false)),
            captured: Arc::new(Mutex::new(None)),
            provider: provider(),
        };
        let name = server_name("localhost").expect("name");
        let result = verifier.verify_server_cert(&der, &[], &name, &[], UnixTime::now());
        assert!(result.is_err());
        // This is not a fingerprint mismatch: the link fingerprint matched the
        // CA and the CA role is the problem.
        assert!(!verifier.mismatch.load(Ordering::SeqCst));
    }

    #[test]
    fn probe_captures_the_leaf_digest_without_pinning_it() {
        let params = rcgen::CertificateParams::new(vec!["localhost".to_owned()]).expect("params");
        let key = rcgen::KeyPair::generate().expect("key");
        let certificate = params.self_signed(&key).expect("certificate");
        let der = certificate.der().clone();
        let expected = crate::link::leaf_fingerprint(der.as_ref());

        let capture = Arc::new(CertificateProbe::default());
        let verifier = ProbeVerifier {
            capture: capture.clone(),
            provider: provider(),
            inner: None,
        };
        let name = server_name("localhost").expect("name");
        assert!(verifier
            .verify_server_cert(&der, &[], &name, &[], UnixTime::now())
            .is_ok());
        assert_eq!(capture.fingerprint(), Some(expected));
    }

    #[test]
    fn probe_rejects_a_ca_leaf_without_recording_it() {
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("params");
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let key = rcgen::KeyPair::generate().expect("key");
        let certificate = params.self_signed(&key).expect("certificate");
        let der = certificate.der().clone();

        let capture = Arc::new(CertificateProbe::default());
        let verifier = ProbeVerifier {
            capture: capture.clone(),
            provider: provider(),
            inner: None,
        };
        let name = server_name("localhost").expect("name");
        assert!(verifier
            .verify_server_cert(&der, &[], &name, &[], UnixTime::now())
            .is_err());
        assert_eq!(capture.fingerprint(), None);
    }
}
