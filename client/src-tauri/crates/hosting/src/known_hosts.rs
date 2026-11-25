//! Trust-on-first-use host-key storage.
//!
//! The file lives next to the other client state (`ssh_known_hosts.json` in the
//! application data directory). It maps `host:port` to the SHA-256 fingerprint
//! of the SSH host key. A changed key is a hard error: the client never offers
//! "continue anyway" (ADR 0021).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{HostingError, HostingErrorCode, Result};

/// File name inside the application data directory.
pub const KNOWN_HOSTS_FILE: &str = "ssh_known_hosts.json";

/// One saved host key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KnownHost {
    /// Lowercase SHA-256 of the SSH public-key blob.
    pub fingerprint: String,
    /// OpenSSH key type, for example `ssh-ed25519`.
    pub algorithm: String,
    /// Unix time of the confirmation.
    pub added_unix: u64,
}

/// The on-disk map. A missing file is an empty map, not an error.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct KnownHosts {
    #[serde(default)]
    hosts: BTreeMap<String, KnownHost>,
}

/// Which trust decision the caller has to make.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyStatus {
    /// The key matches the saved one.
    Known,
    /// No key is saved for this host yet.
    New,
    /// A different key is saved.
    Mismatch,
}

impl KnownHosts {
    /// Loads the map; anything unreadable or corrupt is reported, never ignored
    /// silently: a corrupt file must not weaken a pinned host.
    pub fn load(path: &Path) -> Result<Self> {
        match std::fs::read(path) {
            Ok(data) => serde_json::from_slice(&data).map_err(|error| {
                HostingError::new(
                    HostingErrorCode::Internal,
                    "The saved SSH host keys file is damaged. Delete it and confirm the key again.",
                )
                .with_detail(format!("{}: {error}", path.display()))
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(HostingError::from(error)),
        }
    }

    /// Looks a host up and classifies the presented key.
    #[must_use]
    pub fn check(&self, host: &str, fingerprint: &str) -> HostKeyStatus {
        match self.hosts.get(host) {
            None => HostKeyStatus::New,
            Some(saved) if saved.fingerprint == fingerprint => HostKeyStatus::Known,
            Some(_) => HostKeyStatus::Mismatch,
        }
    }

    /// Returns the saved fingerprint, if any.
    #[must_use]
    pub fn saved(&self, host: &str) -> Option<&KnownHost> {
        self.hosts.get(host)
    }

    /// Saves a confirmed key. Only called after a successful authentication.
    pub fn remember(&mut self, host: &str, fingerprint: &str, algorithm: &str, now_unix: u64) {
        self.hosts.insert(
            host.to_owned(),
            KnownHost {
                fingerprint: fingerprint.to_owned(),
                algorithm: algorithm.to_owned(),
                added_unix: now_unix,
            },
        );
    }

    /// Writes the map atomically (temporary file + rename).
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_vec_pretty(self)?;
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, data)?;
        if let Err(error) = std::fs::rename(&temporary, path) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.into());
        }
        Ok(())
    }
}

/// Path of the known-hosts file inside the app data directory.
#[must_use]
pub fn known_hosts_path(data_dir: &Path) -> PathBuf {
    data_dir.join(KNOWN_HOSTS_FILE)
}

/// Convenience: fingerprint hex of an OpenSSH public key blob.
#[must_use]
pub fn fingerprint_of(blob: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(blob))
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn new_known_and_mismatch() {
        let mut hosts = KnownHosts::default();
        assert_eq!(hosts.check("vps:22", A), HostKeyStatus::New);
        hosts.remember("vps:22", A, "ssh-ed25519", 1);
        assert_eq!(hosts.check("vps:22", A), HostKeyStatus::Known);
        assert_eq!(hosts.check("vps:22", B), HostKeyStatus::Mismatch);
        assert_eq!(hosts.check("other:22", A), HostKeyStatus::New);
    }

    #[test]
    fn round_trip_and_missing_file() {
        let directory = tempfile::tempdir().expect("temp");
        let path = known_hosts_path(directory.path());
        assert!(KnownHosts::load(&path)
            .expect("missing is empty")
            .saved("vps")
            .is_none());
        let mut hosts = KnownHosts::load(&path).expect("load");
        hosts.remember("vps:22", A, "ssh-ed25519", 42);
        hosts.save(&path).expect("save");
        let loaded = KnownHosts::load(&path).expect("load");
        assert_eq!(loaded.check("vps:22", A), HostKeyStatus::Known);
        assert_eq!(
            loaded.saved("vps:22").map(|h| h.algorithm.as_str()),
            Some("ssh-ed25519")
        );
    }

    #[test]
    fn corrupt_file_is_an_error() {
        let directory = tempfile::tempdir().expect("temp");
        let path = known_hosts_path(directory.path());
        std::fs::write(&path, b"{not json").expect("write");
        assert!(KnownHosts::load(&path).is_err());
    }

    #[test]
    fn fingerprints_are_sha256_hex() {
        let value = fingerprint_of(b"hello");
        assert_eq!(value.len(), 64);
        assert_eq!(
            value,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }
}
