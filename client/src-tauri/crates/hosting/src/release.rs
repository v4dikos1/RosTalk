//! The server bundle shipped with the client.
//!
//! `make server-bundle` cross-compiles the server from the same commit, signs
//! `SHA256SUMS` with the release key and copies the artefacts next to the
//! client. The installer verifies the signature and the checksums **before**
//! anything is sent, and `install.sh --from-file --sums` verifies them again on
//! the remote machine (ADR 0021).

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use flate2::write::GzEncoder;
use flate2::Compression;
use ring::signature;
use sha2::{Digest, Sha256};

use crate::error::{HostingError, HostingErrorCode, Result};

/// Public half of the release key, the same file `deploy/install.sh` embeds.
const RELEASE_PUB_PEM: &str = include_str!("../../../../../deploy/release.pub");

/// CPU architecture of the remote machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Arch {
    Amd64,
    Arm64,
}

impl Arch {
    /// Maps `uname -m` to a release architecture.
    #[must_use]
    pub fn from_uname(value: &str) -> Option<Self> {
        match value.trim() {
            "x86_64" | "amd64" => Some(Self::Amd64),
            "aarch64" | "arm64" => Some(Self::Arm64),
            _ => None,
        }
    }

    /// Suffix used by `deploy/release.sh`.
    #[must_use]
    pub fn release_name(self) -> &'static str {
        match self {
            Self::Amd64 => "amd64",
            Self::Arm64 => "arm64",
        }
    }
}

/// Verified files of one bundle.
#[derive(Debug, Clone)]
pub struct Bundle {
    pub directory: PathBuf,
    pub version: String,
    pub arch: Arch,
    /// `rostalk-server_<version>_linux_<arch>`.
    pub binary_name: String,
    pub binary: PathBuf,
    pub install_sh: PathBuf,
    pub sums: PathBuf,
    pub sums_sig: PathBuf,
    pub release_pub: Option<PathBuf>,
}

impl Bundle {
    /// Opens and verifies a bundle directory.
    ///
    /// Local verification happens here, before the tar stream is built, so a
    /// corrupted or unsigned bundle never reaches the VPS.
    pub fn open(directory: &Path, arch: Arch) -> Result<Self> {
        if !directory.is_dir() {
            return Err(HostingError::new(
                HostingErrorCode::BundleMissing,
                "The client has no server bundle. Build it with `make server-bundle` or set ROSTALK_SERVER_BUNDLE.",
            )
            .with_detail(format!("missing directory {}", directory.display())));
        }

        let sums = directory.join("SHA256SUMS");
        let sums_sig = directory.join("SHA256SUMS.sig");
        let install_sh = directory.join("install.sh");
        for required in [&sums, &sums_sig, &install_sh] {
            if !required.is_file() {
                return Err(HostingError::new(
                    HostingErrorCode::BundleMissing,
                    "The server bundle is incomplete. Rebuild it with `make server-bundle`.",
                )
                .with_detail(format!("missing {}", required.display())));
            }
        }

        let sums_bytes = fs::read(&sums)?;
        let signature = fs::read(&sums_sig)?;
        verify_release_signature(&sums_bytes, &signature)?;

        let listed = parse_sums(&sums_bytes)?;
        let version = listed
            .keys()
            .find_map(|name| version_from_asset(name, arch))
            .ok_or_else(|| {
                HostingError::new(
                    HostingErrorCode::BundleMissing,
                    "The server bundle has no binary for this architecture.",
                )
                .with_detail(format!("no rostalk-server_*_linux_{}", arch.release_name()))
            })?;
        let binary_name = format!("rostalk-server_{version}_linux_{}", arch.release_name());
        let binary = directory.join(&binary_name);
        if !binary.is_file() {
            return Err(HostingError::new(
                HostingErrorCode::BundleMissing,
                "The server bundle is incomplete. Rebuild it with `make server-bundle`.",
            )
            .with_detail(format!("missing {}", binary.display())));
        }

        // The signature covers the checksum file; the checksums cover every
        // file we send, including install.sh and the public-key copy.
        for (name, path) in [(binary_name.as_str(), &binary), ("install.sh", &install_sh)] {
            verify_checksum(&listed, name, path)?;
        }
        let release_pub = directory.join("release.pub");
        let release_pub = if release_pub.is_file() {
            verify_checksum(&listed, "release.pub", &release_pub)?;
            Some(release_pub)
        } else {
            None
        };

        Ok(Self {
            directory: directory.to_owned(),
            version,
            arch,
            binary_name,
            binary,
            install_sh,
            sums,
            sums_sig,
            release_pub,
        })
    }

    /// Builds the gzip-compressed tar stream for one `exec` channel.
    ///
    /// Paths are plain file names, never absolute, so `tar` cannot write outside
    /// the temporary directory chosen by the remote side.
    pub fn tar_stream(&self) -> Result<Vec<u8>> {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut builder = tar::Builder::new(encoder);

        let mut files: Vec<(&str, &Path, u32)> = vec![
            ("install.sh", self.install_sh.as_path(), 0o755),
            (self.binary_name.as_str(), self.binary.as_path(), 0o755),
            ("SHA256SUMS", self.sums.as_path(), 0o644),
            ("SHA256SUMS.sig", self.sums_sig.as_path(), 0o644),
        ];
        if let Some(path) = &self.release_pub {
            files.push(("release.pub", path.as_path(), 0o644));
        }

        for (name, path, mode) in files {
            let data = fs::read(path)?;
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(mode);
            header.set_mtime(0);
            header.set_cksum();
            builder
                .append_data(&mut header, name, data.as_slice())
                .map_err(|error| {
                    HostingError::new(
                        HostingErrorCode::Internal,
                        "Could not assemble the upload archive.",
                    )
                    .with_detail(error.to_string())
                })?;
        }

        let encoder = builder.into_inner().map_err(|error| {
            HostingError::new(
                HostingErrorCode::Internal,
                "Could not assemble the upload archive.",
            )
            .with_detail(error.to_string())
        })?;
        let data = encoder.finish().map_err(|error| {
            HostingError::new(
                HostingErrorCode::Internal,
                "Could not compress the upload archive.",
            )
            .with_detail(error.to_string())
        })?;
        Ok(data)
    }
}

/// Verifies an Ed25519 signature over the checksum file with the embedded key.
pub fn verify_release_signature(sums: &[u8], signature: &[u8]) -> Result<()> {
    let key = embedded_release_key()?;
    signature::UnparsedPublicKey::new(&signature::ED25519, key)
        .verify(sums, signature)
        .map_err(|_| {
            HostingError::new(
                HostingErrorCode::ReleaseInvalid,
                "The server bundle signature is not valid for the built-in RosTalk release key. Refusing to install.",
            )
        })
}

/// Parses the embedded `deploy/release.pub` into a raw 32-byte Ed25519 key.
fn embedded_release_key() -> Result<[u8; 32]> {
    parse_release_public_key(RELEASE_PUB_PEM)
}

/// Parses an Ed25519 SubjectPublicKeyInfo PEM into the raw key.
pub fn parse_release_public_key(pem: &str) -> Result<[u8; 32]> {
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    let der = base64::engine::general_purpose::STANDARD
        .decode(body.trim())
        .map_err(|error| {
            HostingError::new(
                HostingErrorCode::ReleaseInvalid,
                "The built-in release public key is not valid.",
            )
            .with_detail(error.to_string())
        })?;
    // SubjectPublicKeyInfo for Ed25519: 12-byte prefix, then the 32-byte key.
    const PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    if der.len() != 44 || der[..12] != PREFIX {
        return Err(HostingError::new(
            HostingErrorCode::ReleaseInvalid,
            "The built-in release public key is not an Ed25519 key.",
        ));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&der[12..]);
    Ok(key)
}

fn parse_sums(data: &[u8]) -> Result<std::collections::BTreeMap<String, String>> {
    let text = std::str::from_utf8(data).map_err(|error| {
        HostingError::new(
            HostingErrorCode::ReleaseInvalid,
            "SHA256SUMS is not valid UTF-8.",
        )
        .with_detail(error.to_string())
    })?;
    let mut map = std::collections::BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(hash) = parts.next() else { continue };
        let Some(name) = parts.next() else { continue };
        let name = name.trim_start_matches('*');
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(HostingError::new(
                HostingErrorCode::ReleaseInvalid,
                "SHA256SUMS contains a malformed line.",
            ));
        }
        map.insert(name.to_owned(), hash.to_ascii_lowercase());
    }
    if map.is_empty() {
        return Err(HostingError::new(
            HostingErrorCode::ReleaseInvalid,
            "SHA256SUMS is empty.",
        ));
    }
    Ok(map)
}

fn verify_checksum(
    listed: &std::collections::BTreeMap<String, String>,
    name: &str,
    path: &Path,
) -> Result<()> {
    let expected = listed.get(name).ok_or_else(|| {
        HostingError::new(
            HostingErrorCode::ReleaseInvalid,
            "The server bundle is signed but a file is not listed in SHA256SUMS.",
        )
        .with_detail(name.to_owned())
    })?;
    let data = fs::read(path)?;
    let actual = hex::encode(Sha256::digest(&data));
    if &actual != expected {
        return Err(HostingError::new(
            HostingErrorCode::ReleaseInvalid,
            "A server bundle file does not match its checksum. Refusing to install.",
        )
        .with_detail(format!("{name}: expected {expected}, got {actual}")));
    }
    Ok(())
}

fn version_from_asset(name: &str, arch: Arch) -> Option<String> {
    let rest = name.strip_prefix("rostalk-server_")?;
    let version = rest.strip_suffix(&format!("_linux_{}", arch.release_name()))?;
    // The version becomes part of the remote file name, which is embedded in
    // the installer shell fragment. Releases use a commit hash or a semver, so
    // anything else is refused instead of being quoted.
    if version.is_empty()
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'+'))
    {
        None
    } else {
        Some(version.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEM: &str = include_str!("../../../../../deploy/release.pub");

    #[test]
    fn embedded_key_is_ed25519() {
        let key = parse_release_public_key(PEM).expect("key");
        assert_eq!(key.len(), 32);
        assert_eq!(
            hex::encode(key),
            "f03a7aef7434963da856855653f66d60d3a59ea3123eaf044e9a5b73bb5ab1b7"
        );
    }

    #[test]
    fn bad_signature_is_rejected() {
        let error = verify_release_signature(b"not sums", b"not a signature").unwrap_err();
        assert_eq!(error.code, HostingErrorCode::ReleaseInvalid);
    }

    #[test]
    fn architecture_names() {
        assert_eq!(Arch::from_uname("x86_64"), Some(Arch::Amd64));
        assert_eq!(Arch::from_uname("aarch64"), Some(Arch::Arm64));
        assert_eq!(Arch::from_uname("riscv64"), None);
        assert_eq!(
            version_from_asset("rostalk-server_1.2.3_linux_amd64", Arch::Amd64),
            Some("1.2.3".to_owned())
        );
        assert_eq!(
            version_from_asset("rostalk-server_dev_linux_arm64", Arch::Arm64),
            Some("dev".to_owned())
        );
        assert_eq!(
            version_from_asset("rostalk-server_1.2.3_linux_arm64", Arch::Amd64),
            None
        );
        // The version is embedded in a remote shell fragment: no separators.
        for hostile in [
            "rostalk-server_../x_linux_amd64",
            "rostalk-server_a b_linux_amd64",
            "rostalk-server_a;id_linux_amd64",
            "rostalk-server_$(id)_linux_amd64",
        ] {
            assert_eq!(version_from_asset(hostile, Arch::Amd64), None, "{hostile}");
        }
    }

    #[test]
    fn checksum_parser_rejects_malformed_lines() {
        assert!(parse_sums(b"abc file\n").is_err());
        let map = parse_sums(format!("{}  install.sh\n", "a".repeat(64)).as_bytes()).expect("map");
        assert!(map.contains_key("install.sh"));
    }
}
