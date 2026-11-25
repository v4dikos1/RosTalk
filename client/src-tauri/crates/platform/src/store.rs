//! Storage of the local identity: the OS keychain on Windows, an in-memory
//! store for tests.
//!
//! The private key is stored as base64 of the 32-byte Ed25519 seed. The
//! keychain protects it with the user's Windows login, so the client never
//! writes the key to the disk itself (design 4.2).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use zeroize::Zeroizing;

use crate::export::{export_identity_to_file, import_identity_from_file};
use crate::identity::Identity;
use crate::PlatformError;

/// Account name used for the desktop client identity in the OS keychain.
pub const IDENTITY_ACCOUNT: &str = "identity";

/// A small key/value secret store. The only production implementation is the
/// OS keychain; tests use [`MemoryStore`].
pub trait SecretStore: Send + Sync {
    /// Reads a secret, or `None` when nothing was stored under this account.
    fn get(&self, account: &str) -> Result<Option<Vec<u8>>, PlatformError>;

    /// Writes or replaces a secret.
    fn set(&self, account: &str, secret: &[u8]) -> Result<(), PlatformError>;

    /// Removes a secret. Removing a missing entry is not an error.
    fn delete(&self, account: &str) -> Result<(), PlatformError>;
}

/// Stores the identity in the operating system keychain.
///
/// On Windows this is the Credential Manager. The client is Windows-first; on
/// other platforms the type exists only so the workspace builds, and every
/// operation reports [`PlatformError::Unsupported`].
pub struct KeyringStore {
    service: String,
}

impl KeyringStore {
    /// Creates a store bound to a keychain service name.
    #[must_use]
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }
}

impl std::fmt::Debug for KeyringStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyringStore")
            .field("service", &self.service)
            .finish_non_exhaustive()
    }
}

#[cfg(windows)]
impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<Vec<u8>>, PlatformError> {
        let entry = keyring::Entry::new(&self.service, account)
            .map_err(|err| PlatformError::Keychain(err.to_string()))?;
        match entry.get_password() {
            Ok(value) => BASE64
                .decode(value)
                .map(Some)
                .map_err(|_| PlatformError::Corrupted),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(PlatformError::Keychain(err.to_string())),
        }
    }

    fn set(&self, account: &str, secret: &[u8]) -> Result<(), PlatformError> {
        let entry = keyring::Entry::new(&self.service, account)
            .map_err(|err| PlatformError::Keychain(err.to_string()))?;
        entry
            .set_password(&BASE64.encode(secret))
            .map_err(|err| PlatformError::Keychain(err.to_string()))
    }

    fn delete(&self, account: &str) -> Result<(), PlatformError> {
        let entry = keyring::Entry::new(&self.service, account)
            .map_err(|err| PlatformError::Keychain(err.to_string()))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(PlatformError::Keychain(err.to_string())),
        }
    }
}

#[cfg(not(windows))]
impl SecretStore for KeyringStore {
    fn get(&self, _account: &str) -> Result<Option<Vec<u8>>, PlatformError> {
        Err(PlatformError::Unsupported)
    }

    fn set(&self, _account: &str, _secret: &[u8]) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported)
    }

    fn delete(&self, _account: &str) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported)
    }
}

/// In-memory store used by unit and integration tests.
#[derive(Debug, Default)]
pub struct MemoryStore {
    secrets: Mutex<HashMap<String, Vec<u8>>>,
}

impl MemoryStore {
    /// Creates an empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<Vec<u8>>, PlatformError> {
        let secrets = self.secrets.lock().map_err(|_| PlatformError::Corrupted)?;
        Ok(secrets.get(account).cloned())
    }

    fn set(&self, account: &str, secret: &[u8]) -> Result<(), PlatformError> {
        let mut secrets = self.secrets.lock().map_err(|_| PlatformError::Corrupted)?;
        secrets.insert(account.to_owned(), secret.to_vec());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), PlatformError> {
        let mut secrets = self.secrets.lock().map_err(|_| PlatformError::Corrupted)?;
        secrets.remove(account);
        Ok(())
    }
}

/// Loads, creates, saves and exports the local identity.
pub struct IdentityVault<S: SecretStore> {
    store: S,
    account: String,
    service: String,
}

impl<S: SecretStore> std::fmt::Debug for IdentityVault<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IdentityVault")
            .field("service", &self.service)
            .field("account", &self.account)
            .finish_non_exhaustive()
    }
}

impl<S: SecretStore> IdentityVault<S> {
    /// Creates a vault over the given secret store.
    #[must_use]
    pub fn new(service: impl Into<String>, store: S) -> Self {
        Self {
            store,
            account: IDENTITY_ACCOUNT.to_owned(),
            service: service.into(),
        }
    }

    /// Loads the stored identity, or `None` when this machine has none yet.
    pub fn load(&self) -> Result<Option<Identity>, PlatformError> {
        let Some(bytes) = self.store.get(&self.account)? else {
            return Ok(None);
        };
        if bytes.len() != 32 {
            return Err(PlatformError::Corrupted);
        }
        let mut seed = Zeroizing::new([0u8; 32]);
        seed.copy_from_slice(&bytes);
        Ok(Some(Identity::from_seed(*seed)))
    }

    /// Loads the identity, generating and storing a new one on first run.
    pub fn load_or_create(&self) -> Result<Identity, PlatformError> {
        if let Some(identity) = self.load()? {
            return Ok(identity);
        }
        let identity = Identity::generate()?;
        self.save(&identity)?;
        Ok(identity)
    }

    /// Replaces the stored identity. Used by the import command.
    pub fn save(&self, identity: &Identity) -> Result<(), PlatformError> {
        let seed = identity.seed();
        self.store.set(&self.account, &seed[..])
    }

    /// Keychain account the identity is stored under.
    #[must_use]
    pub fn account(&self) -> &str {
        &self.account
    }

    /// Stores a raw 32-byte seed. Used to adopt a legacy identity (ADR 0033)
    /// without rebuilding it first; the caller validates the length.
    pub(crate) fn store_seed(&self, seed: &[u8]) -> Result<(), PlatformError> {
        self.store.set(&self.account, seed)
    }

    /// Removes the stored identity from the keychain.
    ///
    /// Used by the uninstaller's `--purge-data` path (stage 6.2): a clean
    /// removal must not leave the private key behind. Removing a missing
    /// identity is not an error.
    pub fn forget(&self) -> Result<(), PlatformError> {
        self.store.delete(&self.account)
    }

    /// Encrypts the current identity into `path` with `password`.
    pub fn export_to_file(&self, path: &Path, password: &str) -> Result<(), PlatformError> {
        let identity = self.load()?.ok_or(PlatformError::NoIdentity)?;
        export_identity_to_file(path, &identity, password)
    }

    /// Decrypts `path` and stores the imported identity, replacing the old one.
    pub fn import_from_file(&self, path: &Path, password: &str) -> Result<Identity, PlatformError> {
        let identity = import_identity_from_file(path, password)?;
        self.save(&identity)?;
        Ok(identity)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trips_and_deletes() {
        let store = MemoryStore::new();
        assert!(store.get("identity").expect("get").is_none());
        store.set("identity", b"secret").expect("set");
        assert_eq!(
            store.get("identity").expect("get"),
            Some(b"secret".to_vec())
        );
        store.delete("identity").expect("delete");
        assert!(store.get("identity").expect("get").is_none());
        store.delete("identity").expect("delete is idempotent");
    }

    #[test]
    fn forget_removes_the_stored_identity() {
        let store = MemoryStore::new();
        let vault = IdentityVault::new("rostalk-test", store);
        vault.load_or_create().expect("create");
        vault.forget().expect("forget");
        assert!(vault.load().expect("load").is_none());
        vault.forget().expect("forget is idempotent");
    }

    #[test]
    fn vault_creates_once_and_reloads_the_same_key() {
        let store = MemoryStore::new();
        let vault = IdentityVault::new("rostalk-test", store);
        let first = vault.load_or_create().expect("create");
        let second = vault.load_or_create().expect("load");
        assert_eq!(first.public_key(), second.public_key());
    }

    #[test]
    fn vault_rejects_a_corrupted_secret() {
        let store = MemoryStore::new();
        store.set(IDENTITY_ACCOUNT, b"too-short").expect("set");
        let vault = IdentityVault::new("rostalk-test", store);
        assert!(matches!(vault.load(), Err(PlatformError::Corrupted)));
    }

    #[test]
    fn export_and_import_replace_the_identity() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("me.rostalkkey");
        let source = IdentityVault::new("rostalk-source", MemoryStore::new());
        let identity = source.load_or_create().expect("source");
        source.export_to_file(&path, "pw").expect("export");

        let target = IdentityVault::new("rostalk-target", MemoryStore::new());
        let imported = target.import_from_file(&path, "pw").expect("import");
        assert_eq!(identity.public_key(), imported.public_key());
        let loaded = target.load().expect("load").expect("present");
        assert_eq!(identity.public_key(), loaded.public_key());
    }

    /// Manual check of the Windows Credential Manager backend. Ignored by
    /// default because it writes to the user's keychain, even though the entry
    /// is deleted afterwards.
    #[cfg(windows)]
    #[test]
    #[ignore = "writes to the Windows Credential Manager"]
    fn keyring_store_round_trip() {
        let store = KeyringStore::new("dev.rostalk.desktop.test");
        let account = "integration-identity";
        store.delete(account).expect("cleanup");
        store.set(account, b"seed").expect("set");
        assert_eq!(store.get(account).expect("get"), Some(b"seed".to_vec()));
        store.delete(account).expect("delete");
        assert!(store.get(account).expect("get").is_none());
    }
}
