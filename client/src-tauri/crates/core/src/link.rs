//! Parsing of `rostalk://join?host=...&fp=...&invite=...` invite links and of
//! bare `host:port` addresses for direct login (design 4.3, ADR 0001, ADR 0004,
//! ADR 0008).
//!
//! `fp` is the SHA-256 of the server's TLS **leaf** certificate in lowercase
//! hex. It is not the server identity from `Challenge.server_id`: that one is
//! the fingerprint of the server's long-lived Ed25519 key and lives in the
//! snapshot.
//!
//! A direct address carries no invite and, unlike a link, no fingerprint from
//! an out-of-band channel. The first login therefore establishes one by
//! trust-on-first-use: the user confirms the SHA-256 shown by the client and it
//! is saved in the bookmark (ADR 0008).

use std::net::IpAddr;

use sha2::{Digest, Sha256};
use url::Url;

use crate::error::{CoreError, CoreErrorCode};

/// Default control-plane port (design 4.1).
pub const DEFAULT_PORT: u16 = 7443;

/// How the TLS certificate is trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ServerMode {
    /// No domain: the leaf certificate is pinned by `fp` from the link. This is
    /// the mode used by the development server on a LAN IP.
    Pinned,
    /// A DNS name: ordinary Web PKI verification, as for any HTTPS server.
    WebPki,
}

/// A parsed and validated invite link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteLink {
    /// Host part without the port, without brackets for IPv6.
    pub hostname: String,
    /// Port the control plane listens on, 7443 by default.
    pub port: u16,
    /// SHA-256 of the TLS leaf certificate.
    pub fingerprint: [u8; 32],
    /// One-time invite token, possibly empty when reconnecting a known key.
    pub invite: String,
    /// Original link, trimmed.
    pub raw: String,
}

/// Scheme of invite links printed by servers before the RosTalk rename.
pub const LEGACY_SCHEME: &str = "hearth";

impl InviteLink {
    /// Parses and validates a link.
    ///
    /// The parser is deliberately strict about the host and the fingerprint:
    /// a link that would silently connect somewhere else is rejected instead of
    /// being "fixed".
    pub fn parse(raw: &str) -> Result<Self, CoreError> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err(invalid("invite link is empty"));
        }
        let url =
            Url::parse(raw).map_err(|err| invalid(format!("invite link is malformed: {err}")))?;
        // `hearth://` is the scheme of links printed before the RosTalk
        // rename (ADR 0033); they keep working when pasted or opened.
        if !matches!(url.scheme(), "rostalk" | LEGACY_SCHEME) {
            return Err(invalid(format!(
                "invite link must use the rostalk:// scheme, got {}",
                url.scheme()
            )));
        }
        if url.host_str() != Some("join") {
            return Err(invalid("invite link must be rostalk://join?..."));
        }
        if !matches!(url.path(), "" | "/") {
            return Err(invalid("invite link must not have a path"));
        }
        if url.username() != "" || url.password().is_some() {
            return Err(invalid("invite link must not contain credentials"));
        }

        let mut host = None;
        let mut fp = None;
        let mut invite = String::new();
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "host" => host = Some(value.trim().to_owned()),
                "fp" => fp = Some(value.trim().to_owned()),
                "invite" => invite = value.trim().to_owned(),
                // Future parameters are ignored on purpose: adding one must be
                // backward compatible (CONTRIBUTING.md).
                _ => {}
            }
        }

        let host = host.ok_or_else(|| invalid("invite link has no host parameter"))?;
        let (hostname, port) = parse_host(&host)?;

        let fp = fp.ok_or_else(|| invalid("invite link has no fp parameter"))?;
        let fingerprint = parse_fingerprint_hex(&fp)?;

        Ok(Self {
            hostname,
            port,
            fingerprint,
            invite,
            raw: raw.to_owned(),
        })
    }

    /// `host:port`, bracketed for IPv6, for TCP connects and the `Host` header.
    #[must_use]
    pub fn authority(&self) -> String {
        authority(&self.hostname, self.port)
    }

    /// Control-plane WebSocket URL, always `wss://<authority>/ws`.
    #[must_use]
    pub fn ws_url(&self) -> String {
        format!("wss://{}/ws", self.authority())
    }

    /// SHA-256 of the leaf certificate in lowercase hex.
    #[must_use]
    pub fn fingerprint_hex(&self) -> String {
        hex::encode(self.fingerprint)
    }

    /// True when the host is an IP literal (pinned mode).
    #[must_use]
    pub fn is_ip_host(&self) -> bool {
        self.hostname.parse::<IpAddr>().is_ok()
    }

    /// Trust mode derived from the host: IP → pinned leaf, DNS → Web PKI.
    #[must_use]
    pub fn mode(&self) -> ServerMode {
        mode_for_host(&self.hostname)
    }

    /// Connection descriptor for a direct login (ADR 0008).
    ///
    /// There is no invite and no link: the address was typed by the user. For
    /// an IP host `fingerprint` is the certificate the user confirmed (TOFU or
    /// typed in manually). For a DNS host it is only recorded for display and
    /// the connection uses ordinary Web PKI; the zero digest is used there
    /// because [`ServerMode::WebPki`] does not read it.
    #[must_use]
    pub fn direct(hostname: String, port: u16, fingerprint: Option<[u8; 32]>) -> Self {
        Self {
            hostname,
            port,
            fingerprint: fingerprint.unwrap_or([0u8; 32]),
            invite: String::new(),
            raw: String::new(),
        }
    }

    /// Direct login address without an invite, for the bookmark list.
    #[must_use]
    pub fn canonical_link(&self) -> String {
        format!(
            "rostalk://join?host={}&fp={}",
            self.authority(),
            self.fingerprint_hex()
        )
    }

    /// Canonical link without the invite token. Bookmarks use this form: a
    /// returning key does not need an invite, and a consumed token is useless.
    #[must_use]
    pub fn without_invite(&self) -> String {
        self.canonical_link()
    }
}

/// `host:port`, bracketed for IPv6.
#[must_use]
pub fn authority(hostname: &str, port: u16) -> String {
    if hostname.contains(':') {
        format!("[{hostname}]:{port}")
    } else {
        format!("{hostname}:{port}")
    }
}

/// Trust mode derived from a host name (ADR 0001: no domain → pinned leaf).
#[must_use]
pub fn mode_for_host(hostname: &str) -> ServerMode {
    if hostname.parse::<IpAddr>().is_ok() {
        ServerMode::Pinned
    } else {
        ServerMode::WebPki
    }
}

/// Parses a bare `host` or `host:port` typed by the user for a direct login.
///
/// The same strict validation as an invite link applies: a value that would
/// silently connect elsewhere is rejected, never "fixed".
pub fn parse_authority(input: &str) -> Result<(String, u16), CoreError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(invalid("the server address is empty"));
    }
    if input.contains("://") {
        return Err(invalid(
            "the server address must be host or host:port, not a URL",
        ));
    }
    parse_host(input)
}

fn parse_host(input: &str) -> Result<(String, u16), CoreError> {
    if input.is_empty() {
        return Err(invalid("the server host is empty"));
    }
    if input.contains(char::is_whitespace)
        || input.contains("://")
        || input.contains(['/', '?', '#', '@'])
    {
        return Err(invalid("the server host is not a plain host or host:port"));
    }

    let (host, port) = if let Some(rest) = input.strip_prefix('[') {
        // Bracketed IPv6, with an optional port.
        let (inside, after) = rest
            .split_once(']')
            .ok_or_else(|| invalid("the server host has an unterminated IPv6 address"))?;
        let port = match after {
            "" => DEFAULT_PORT,
            value => {
                let value = value.strip_prefix(':').ok_or_else(|| {
                    invalid("the server address has an unexpected suffix after the host")
                })?;
                parse_port(value)?
            }
        };
        (inside.to_owned(), port)
    } else if input.matches(':').count() == 1 {
        let (host, port) = input
            .split_once(':')
            .ok_or_else(|| invalid("the server host is malformed"))?;
        (host.to_owned(), parse_port(port)?)
    } else if input.contains(':') {
        return Err(invalid(
            "the server host contains ':' but is not a bracketed IPv6 address",
        ));
    } else {
        (input.to_owned(), DEFAULT_PORT)
    };

    if host.is_empty() {
        return Err(invalid("the server host is empty"));
    }
    validate_hostname(&host)?;
    Ok((host, port))
}

fn parse_port(value: &str) -> Result<u16, CoreError> {
    let port: u16 = value
        .parse()
        .map_err(|_| invalid("the server port is not a number"))?;
    if port == 0 {
        return Err(invalid("the server port must not be zero"));
    }
    Ok(port)
}

fn validate_hostname(host: &str) -> Result<(), CoreError> {
    if host.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    if host.len() > 253 {
        return Err(invalid("the server host is too long"));
    }
    for label in host.split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err(invalid("the server host is not a valid DNS name"));
        }
        let bytes = label.as_bytes();
        for (index, byte) in bytes.iter().enumerate() {
            let allowed = byte.is_ascii_alphanumeric()
                || (*byte == b'-' && index != 0 && index != bytes.len() - 1);
            if !allowed {
                return Err(invalid("the server host is not a valid DNS name"));
            }
        }
    }
    Ok(())
}

/// Parses a 64-character lowercase or uppercase hex SHA-256 digest.
///
/// Used for the `fp` parameter of an invite link and for a fingerprint typed
/// by the user in the direct login form.
pub fn parse_fingerprint_hex(value: &str) -> Result<[u8; 32], CoreError> {
    if value.len() != 64 {
        return Err(CoreError::new(
            CoreErrorCode::InvalidFingerprint,
            format!(
                "certificate fingerprint must be 64 hex characters, got {}",
                value.len()
            ),
        ));
    }
    let bytes = hex::decode(value).map_err(|_| {
        CoreError::new(
            CoreErrorCode::InvalidFingerprint,
            "certificate fingerprint is not hexadecimal",
        )
    })?;
    if bytes.len() != 32 {
        return Err(CoreError::new(
            CoreErrorCode::InvalidFingerprint,
            "certificate fingerprint must be a SHA-256 digest",
        ));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// SHA-256 of a DER certificate body, used by the TLS verifier.
#[must_use]
pub fn leaf_fingerprint(der: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(der);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(CoreErrorCode::InvalidLink, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn parse(query: &str) -> Result<InviteLink, CoreError> {
        InviteLink::parse(&format!("rostalk://join?{query}"))
    }

    #[test]
    fn parses_a_lan_ip_link_with_explicit_port() {
        let link = parse(&format!("host=192.168.0.13:7443&fp={FP}&invite=tok")).expect("link");
        assert_eq!(link.hostname, "192.168.0.13");
        assert_eq!(link.port, 7443);
        assert_eq!(link.invite, "tok");
        assert_eq!(link.ws_url(), "wss://192.168.0.13:7443/ws");
        assert_eq!(link.mode(), ServerMode::Pinned);
        assert!(link.is_ip_host());
        assert_eq!(link.fingerprint_hex(), FP);
        assert_eq!(
            link.without_invite(),
            format!("rostalk://join?host=192.168.0.13:7443&fp={FP}")
        );
    }

    #[test]
    fn defaults_to_7443_and_allows_no_invite_for_a_known_key() {
        let link = parse(&format!("host=203.0.113.5&fp={FP}")).expect("link");
        assert_eq!(link.port, DEFAULT_PORT);
        assert!(link.invite.is_empty());
    }

    #[test]
    fn a_dns_name_uses_web_pki() {
        let link = parse(&format!("host=voice.example.com&fp={FP}")).expect("link");
        assert_eq!(link.mode(), ServerMode::WebPki);
        assert!(!link.is_ip_host());
    }

    #[test]
    fn supports_ipv6_with_and_without_a_port() {
        let link = parse(&format!("host=[2001:db8::1]:8443&fp={FP}")).expect("link");
        assert_eq!(link.hostname, "2001:db8::1");
        assert_eq!(link.port, 8443);
        assert_eq!(link.ws_url(), "wss://[2001:db8::1]:8443/ws");

        let link = parse(&format!("host=[2001:db8::1]&fp={FP}")).expect("link");
        assert_eq!(link.port, DEFAULT_PORT);
    }

    #[test]
    fn normalises_uppercase_fingerprints() {
        let link = parse(&format!("host=10.0.0.1&fp={}", FP.to_uppercase())).expect("link");
        assert_eq!(link.fingerprint_hex(), FP);
    }

    #[test]
    fn rejects_missing_parameters() {
        assert_eq!(
            parse("host=10.0.0.1").expect_err("fp").code,
            CoreErrorCode::InvalidLink
        );
        assert_eq!(
            parse(&format!("fp={FP}")).expect_err("host").code,
            CoreErrorCode::InvalidLink
        );
    }

    #[test]
    fn rejects_a_short_or_non_hex_fingerprint() {
        for fp in ["abc", &"z".repeat(64), &"0".repeat(66)] {
            let error = parse(&format!("host=10.0.0.1&fp={fp}")).expect_err("fingerprint");
            assert_eq!(error.code, CoreErrorCode::InvalidFingerprint);
        }
    }

    #[test]
    fn accepts_links_printed_before_the_rename() {
        let link = InviteLink::parse(&format!("hearth://join?host=10.0.0.1:7443&fp={FP}"))
            .expect("legacy scheme");
        assert_eq!(link.hostname, "10.0.0.1");
        assert_eq!(link.port, 7443);
        assert!(InviteLink::parse(&format!("hearth://other?host=10.0.0.1&fp={FP}")).is_err());
    }

    #[test]
    fn rejects_the_wrong_scheme_and_path() {
        let error =
            InviteLink::parse(&format!("https://join?host=10.0.0.1&fp={FP}")).expect_err("scheme");
        assert_eq!(error.code, CoreErrorCode::InvalidLink);

        let error =
            InviteLink::parse(&format!("rostalk://other?host=10.0.0.1&fp={FP}")).expect_err("host");
        assert_eq!(error.code, CoreErrorCode::InvalidLink);

        let error = InviteLink::parse(&format!("rostalk://join/x?host=10.0.0.1&fp={FP}"))
            .expect_err("path");
        assert_eq!(error.code, CoreErrorCode::InvalidLink);
    }

    #[test]
    fn rejects_hosts_that_smuggle_a_url_or_credentials() {
        for host in [
            "https://example.com",
            "user@example.com",
            "example.com/path",
            "example.com?x",
            "exa mple.com",
        ] {
            let error = InviteLink::parse(&format!("rostalk://join?host={host}&fp={FP}"))
                .expect_err("host");
            assert_eq!(error.code, CoreErrorCode::InvalidLink, "host {host}");
        }
    }

    #[test]
    fn rejects_bad_ports_and_ipv6_without_brackets() {
        for host in [
            "10.0.0.1:0",
            "10.0.0.1:99999",
            "10.0.0.1:abc",
            "2001:db8::1",
        ] {
            assert!(
                InviteLink::parse(&format!("rostalk://join?host={host}&fp={FP}")).is_err(),
                "host {host}"
            );
        }
    }

    #[test]
    fn ignores_unknown_query_parameters() {
        let link = parse(&format!("host=10.0.0.1&fp={FP}&future=1")).expect("link");
        assert_eq!(link.hostname, "10.0.0.1");
    }

    #[test]
    fn leaf_fingerprint_matches_sha256() {
        let digest = leaf_fingerprint(b"certificate");
        assert_eq!(hex::encode(digest).len(), 64);
        assert_ne!(digest, [0u8; 32]);
    }

    #[test]
    fn parses_a_direct_address_for_adr_0008() {
        assert_eq!(
            parse_authority("192.168.0.13").expect("host"),
            ("192.168.0.13".to_owned(), DEFAULT_PORT)
        );
        assert_eq!(
            parse_authority(" voice.example.com:8443 ").expect("host"),
            ("voice.example.com".to_owned(), 8443)
        );
        assert_eq!(
            parse_authority("[2001:db8::1]:7443").expect("host"),
            ("2001:db8::1".to_owned(), 7443)
        );
        assert_eq!(mode_for_host("192.168.0.13"), ServerMode::Pinned);
        assert_eq!(mode_for_host("voice.example.com"), ServerMode::WebPki);
    }

    #[test]
    fn a_direct_address_rejects_urls_credentials_and_bad_ports() {
        for address in [
            "",
            "https://192.168.0.13",
            "user@192.168.0.13",
            "192.168.0.13/path",
            "192.168.0.13?x",
            "192.168.0.13:0",
            "192.168.0.13:99999",
            "2001:db8::1",
        ] {
            let error = parse_authority(address).expect_err(address);
            assert_eq!(error.code, CoreErrorCode::InvalidLink, "address {address}");
        }
    }

    #[test]
    fn a_direct_link_has_no_invite_and_a_canonical_form() {
        let link = InviteLink::direct("192.168.0.13".to_owned(), 7443, Some([7u8; 32]));
        assert!(link.invite.is_empty());
        assert_eq!(link.authority(), "192.168.0.13:7443");
        assert_eq!(link.mode(), ServerMode::Pinned);
        assert_eq!(
            link.canonical_link(),
            format!(
                "rostalk://join?host=192.168.0.13:7443&fp={}",
                "07".repeat(32)
            )
        );

        let dns = InviteLink::direct("voice.example.com".to_owned(), 7443, None);
        assert_eq!(dns.mode(), ServerMode::WebPki);
    }

    #[test]
    fn rejects_credentials_before_the_host_in_either_form() {
        // A link with a username or a password would connect somewhere the
        // invite did not name. Both halves of the check matter on their own.
        for raw in [
            format!("rostalk://user@join?host=10.0.0.1&fp={FP}"),
            format!("rostalk://:secret@join?host=10.0.0.1&fp={FP}"),
        ] {
            let error = InviteLink::parse(&raw).expect_err("credentials");
            assert_eq!(error.code, CoreErrorCode::InvalidLink, "link {raw}");
        }
    }

    #[test]
    fn validates_dns_labels_at_their_boundaries() {
        let label63 = "a".repeat(63);
        // 63 + 1 + 63 + 1 + 63 + 1 + 61 = 253, the DNS limit.
        let host253 = format!("{label63}.{label63}.{label63}.{}", "a".repeat(61));
        assert_eq!(host253.len(), 253);
        parse(&format!("host={host253}&fp={FP}")).expect("253-character host");
        // A hyphen inside a label is valid.
        parse(&format!("host=voice-hq.example.com&fp={FP}")).expect("hyphen");

        let label64 = "a".repeat(64);
        let host254 = format!("{host253}a");
        assert_eq!(host254.len(), 254);
        for host in [
            label64.as_str(),
            host254.as_str(),
            "-leading.example",
            "trailing-.example",
            "double..dot",
            "under_score.example",
            "exämple.com",
        ] {
            let error = parse(&format!("host={host}&fp={FP}")).expect_err(host);
            assert_eq!(error.code, CoreErrorCode::InvalidLink, "host {host}");
        }
    }

    #[test]
    fn rejects_a_suffix_after_a_bracketed_ipv6_host() {
        for address in ["[2001:db8::1]x", "[2001:db8::1]:", "[2001:db8::1]:0"] {
            let error = parse_authority(address).expect_err(address);
            assert_eq!(error.code, CoreErrorCode::InvalidLink, "address {address}");
        }
    }
}
