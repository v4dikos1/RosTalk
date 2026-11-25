//! Access to the local Ed25519 identity.
//!
//! The core talks to the keychain through a small trait so tests can use an
//! in-memory vault and the Tauri shell can plug in the real Windows keychain.

use std::path::Path;

use rostalk_platform::{Identity, IdentityVault, PlatformError, SecretStore};

/// Provides the local identity and its import/export operations.
pub trait IdentityProvider: Send + Sync {
    /// Loads the stored identity or creates one on first run.
    fn load_or_create(&self) -> Result<Identity, PlatformError>;

    /// Loads the identity without creating one.
    fn load(&self) -> Result<Option<Identity>, PlatformError>;

    /// Replaces the stored identity.
    fn save(&self, identity: &Identity) -> Result<(), PlatformError>;

    /// Encrypts the stored identity into `path`.
    fn export_to_file(&self, path: &Path, password: &str) -> Result<(), PlatformError>;

    /// Decrypts `path` and replaces the stored identity.
    fn import_from_file(&self, path: &Path, password: &str) -> Result<Identity, PlatformError>;
}

impl<S: SecretStore + 'static> IdentityProvider for IdentityVault<S> {
    fn load_or_create(&self) -> Result<Identity, PlatformError> {
        IdentityVault::load_or_create(self)
    }

    fn load(&self) -> Result<Option<Identity>, PlatformError> {
        IdentityVault::load(self)
    }

    fn save(&self, identity: &Identity) -> Result<(), PlatformError> {
        IdentityVault::save(self, identity)
    }

    fn export_to_file(&self, path: &Path, password: &str) -> Result<(), PlatformError> {
        IdentityVault::export_to_file(self, path, password)
    }

    fn import_from_file(&self, path: &Path, password: &str) -> Result<Identity, PlatformError> {
        IdentityVault::import_from_file(self, path, password)
    }
}
