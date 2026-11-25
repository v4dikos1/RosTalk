//! The client's Ed25519 identity.
//!
//! A user is their public key (design 4.2); the private key is used only to
//! answer the server's challenge. It is stored in the OS keychain by
//! [`crate::IdentityVault`] and can be exported as a password protected file.

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::PlatformError;

/// Ed25519 key pair of the local user.
///
/// `Debug` intentionally prints only the public key: an accidental
/// `{:?}` must not reveal the seed.
#[derive(Clone)]
pub struct Identity {
    signing: SigningKey,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("public_key", &self.fingerprint())
            .finish_non_exhaustive()
    }
}

impl Identity {
    /// Generates a new identity from the operating system RNG.
    pub fn generate() -> Result<Self, PlatformError> {
        let mut seed = Zeroizing::new([0u8; 32]);
        OsRng
            .try_fill_bytes(&mut *seed)
            .map_err(|_| PlatformError::Random)?;
        Ok(Self::from_seed(*seed))
    }

    /// Rebuilds an identity from its 32-byte Ed25519 seed.
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            signing: SigningKey::from_bytes(&seed),
        }
    }

    /// Returns the seed for storage or export.
    ///
    /// The caller owns the returned buffer and is expected to zeroize it.
    pub fn seed(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.signing.to_bytes())
    }

    /// Raw 32-byte public key sent in `Hello.public_key`.
    #[must_use]
    pub fn public_key(&self) -> [u8; 32] {
        self.verifying_key().to_bytes()
    }

    /// Public key in lowercase hex, safe to show and log.
    #[must_use]
    pub fn public_key_hex(&self) -> String {
        hex_encode(&self.public_key())
    }

    /// SHA-256 of the public key in lowercase hex. Identifies the user in
    /// diagnostics; it is not the user id the server assigns.
    #[must_use]
    pub fn fingerprint(&self) -> String {
        let digest = Sha256::digest(self.public_key());
        hex_encode(&digest)
    }

    /// Signs a challenge. The caller composes `nonce || server_id`, exactly as
    /// design 4.2/ADR 0004 specify: the TLS fingerprint is never signed.
    #[must_use]
    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.signing.sign(message).to_bytes()
    }

    /// Verifies a signature with this identity's public key. Used by tests and
    /// by the import path to make sure the stored seed is usable.
    #[must_use]
    pub fn verify(&self, message: &[u8], signature: &[u8; 64]) -> bool {
        let signature = ed25519_dalek::Signature::from_bytes(signature);
        self.verifying_key()
            .verify_strict(message, &signature)
            .is_ok()
    }

    fn verifying_key(&self) -> VerifyingKey {
        self.signing.verifying_key()
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_verifies_and_debug_hides_the_seed() {
        let identity = Identity::generate().expect("identity");
        let message = b"nonce-server-id";
        let signature = identity.sign(message);
        assert!(identity.verify(message, &signature));
        assert!(!identity.verify(b"other", &signature));

        let debug = format!("{identity:?}");
        assert!(debug.contains(&identity.fingerprint()));
        assert!(!debug.contains("signing"));
    }

    #[test]
    fn seed_round_trips() {
        let identity = Identity::generate().expect("identity");
        let seed = identity.seed();
        let restored = Identity::from_seed(*seed);
        assert_eq!(identity.public_key(), restored.public_key());
    }

    #[test]
    fn public_key_fingerprint_is_sha256_hex() {
        let identity = Identity::from_seed([7u8; 32]);
        assert_eq!(identity.public_key_hex().len(), 64);
        assert_eq!(identity.fingerprint().len(), 64);
        assert_ne!(identity.public_key_hex(), identity.fingerprint());
    }
}
