//! Password protected identity export (design 4.2).
//!
//! Format (all integers little endian):
//!
//! ```text
//! magic          8 bytes   "ROSTALID" (files written before the rename
//!                           carry "HEARTHID" and still import)
//! format version 1 byte    currently 1
//! m_cost         4 bytes   argon2id memory, KiB
//! t_cost         4 bytes   argon2id iterations
//! p_cost         4 bytes   argon2id parallelism
//! salt          16 bytes   random
//! nonce         24 bytes   random XChaCha20 nonce
//! ciphertext    48 bytes   32-byte Ed25519 seed + 16-byte AEAD tag
//! ```
//!
//! The header (everything before the nonce) is authenticated as associated
//! data, so an attacker cannot weaken the KDF parameters without the password.
//! The key derived from the password is used once and dropped; the seed is
//! zeroized after the identity is rebuilt.

use std::path::Path;

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

use crate::identity::Identity;
use crate::PlatformError;

/// Magic prefix of an exported identity file.
pub const EXPORT_MAGIC: [u8; 8] = *b"ROSTALID";

/// Magic written by releases before the RosTalk rename (ADR 0033). Imports
/// accept it so an identity exported from an old client keeps working; the
/// header is authenticated as written, so nothing else changes.
pub const LEGACY_EXPORT_MAGIC: [u8; 8] = *b"HEARTHID";

/// Current export format version.
pub const EXPORT_FORMAT_VERSION: u8 = 1;

/// Argon2id parameters used for new exports (memory KiB, iterations,
/// parallelism). They are written into the file so an old export keeps
/// importing after the defaults change.
pub const EXPORT_PARAMS: (u32, u32, u32) = (64 * 1024, 3, 1);

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const SEED_LEN: usize = 32;
const TAG_LEN: usize = 16;
const HEADER_LEN: usize = 8 + 1 + 12 + SALT_LEN;

// Bounds accepted on import. They stop a malicious file from asking for
// terabytes of memory or thousands of iterations.
const MAX_M_COST_KIB: u32 = 1024 * 1024;
const MAX_T_COST: u32 = 10;
const MAX_P_COST: u32 = 8;
const MIN_M_COST_KIB: u32 = 8 * 1024;

/// Encrypts `identity` with `password` and returns the export file bytes.
pub fn export_identity(identity: &Identity, password: &str) -> Result<Vec<u8>, PlatformError> {
    export_with_magic(identity, password, &EXPORT_MAGIC)
}

fn export_with_magic(
    identity: &Identity,
    password: &str,
    magic: &[u8; 8],
) -> Result<Vec<u8>, PlatformError> {
    if password.is_empty() {
        return Err(PlatformError::InvalidPassword);
    }
    let (m_cost, t_cost, p_cost) = EXPORT_PARAMS;

    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    OsRng
        .try_fill_bytes(&mut salt)
        .map_err(|_| PlatformError::Random)?;
    OsRng
        .try_fill_bytes(&mut nonce)
        .map_err(|_| PlatformError::Random)?;

    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(magic);
    header.push(EXPORT_FORMAT_VERSION);
    header.extend_from_slice(&m_cost.to_le_bytes());
    header.extend_from_slice(&t_cost.to_le_bytes());
    header.extend_from_slice(&p_cost.to_le_bytes());
    header.extend_from_slice(&salt);

    let mut aes_key = derive_key(password, &salt, m_cost, t_cost, p_cost)?;
    let cipher = XChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(&*aes_key));
    let seed = identity.seed();
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &seed[..],
                aad: &header,
            },
        )
        .map_err(|_| PlatformError::InvalidParameters)?;
    aes_key.zeroize_secret();

    let mut out = Vec::with_capacity(HEADER_LEN + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypts an export file and rebuilds the identity.
pub fn import_identity(data: &[u8], password: &str) -> Result<Identity, PlatformError> {
    if password.is_empty() {
        return Err(PlatformError::InvalidPassword);
    }
    if data.len() < HEADER_LEN + NONCE_LEN + SEED_LEN + TAG_LEN {
        return Err(PlatformError::InvalidFile);
    }
    let magic = &data[..EXPORT_MAGIC.len()];
    if magic != EXPORT_MAGIC && magic != LEGACY_EXPORT_MAGIC {
        return Err(PlatformError::InvalidFile);
    }
    let version = data[EXPORT_MAGIC.len()];
    if version != EXPORT_FORMAT_VERSION {
        return Err(PlatformError::UnsupportedVersion(version));
    }

    let p = EXPORT_MAGIC.len() + 1;
    let m_cost = u32::from_le_bytes(fixed4(data, p)?);
    let t_cost = u32::from_le_bytes(fixed4(data, p + 4)?);
    let p_cost = u32::from_le_bytes(fixed4(data, p + 8)?);
    if !(MIN_M_COST_KIB..=MAX_M_COST_KIB).contains(&m_cost)
        || !(1..=MAX_T_COST).contains(&t_cost)
        || !(1..=MAX_P_COST).contains(&p_cost)
    {
        return Err(PlatformError::InvalidParameters);
    }
    let header = &data[..HEADER_LEN];
    let salt = &data[HEADER_LEN - SALT_LEN..HEADER_LEN];
    let nonce = &data[HEADER_LEN..HEADER_LEN + NONCE_LEN];
    let ciphertext = &data[HEADER_LEN + NONCE_LEN..];

    let mut aes_key = derive_key(password, salt, m_cost, t_cost, p_cost)?;
    let cipher = XChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(&*aes_key));
    let seed = cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: header,
            },
        )
        .map_err(|_| PlatformError::InvalidPassword)?;
    aes_key.zeroize_secret();

    if seed.len() != SEED_LEN {
        return Err(PlatformError::InvalidFile);
    }
    let mut raw = [0u8; SEED_LEN];
    raw.copy_from_slice(&seed);
    let identity = Identity::from_seed(raw);
    raw.zeroize_secret();
    Ok(identity)
}

/// Writes an encrypted identity to `path` atomically.
pub fn export_identity_to_file(
    path: &Path,
    identity: &Identity,
    password: &str,
) -> Result<(), PlatformError> {
    let data = export_identity(identity, password)?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let tmp = path.with_extension("rostalkkey.tmp");
    std::fs::write(&tmp, &data)?;
    std::fs::rename(&tmp, path).map_err(|err| {
        let _ = std::fs::remove_file(&tmp);
        PlatformError::Io(err.to_string())
    })?;
    Ok(())
}

/// Reads and decrypts an identity export from `path`.
pub fn import_identity_from_file(path: &Path, password: &str) -> Result<Identity, PlatformError> {
    let data = std::fs::read(path)?;
    import_identity(&data, password)
}

fn fixed4(data: &[u8], offset: usize) -> Result<[u8; 4], PlatformError> {
    data.get(offset..offset + 4)
        .and_then(|slice| slice.try_into().ok())
        .ok_or(PlatformError::InvalidFile)
}

fn derive_key(
    password: &str,
    salt: &[u8],
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<Zeroizing<[u8; 32]>, PlatformError> {
    let params = Params::new(m_cost, t_cost, p_cost, Some(32))
        .map_err(|_| PlatformError::InvalidParameters)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, &mut *key)
        .map_err(|_| PlatformError::InvalidParameters)?;
    Ok(key)
}

/// Zeroizes a byte buffer without pulling `zeroize` into every caller.
trait ZeroizeSecret {
    fn zeroize_secret(&mut self);
}

impl ZeroizeSecret for Zeroizing<[u8; 32]> {
    fn zeroize_secret(&mut self) {
        use zeroize::Zeroize;
        (**self).zeroize();
    }
}

impl ZeroizeSecret for [u8; 32] {
    fn zeroize_secret(&mut self) {
        use zeroize::Zeroize;
        self.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> Identity {
        Identity::from_seed([9u8; 32])
    }

    #[test]
    fn export_import_round_trip() {
        let original = identity();
        let data = export_identity(&original, "correct horse battery staple").expect("export");
        let restored = import_identity(&data, "correct horse battery staple").expect("import");
        assert_eq!(original.public_key(), restored.public_key());
        assert_eq!(data[..8], EXPORT_MAGIC);
        assert_eq!(data[8], EXPORT_FORMAT_VERSION);
    }

    #[test]
    fn legacy_export_still_imports() {
        // A file written before the RosTalk rename (ADR 0033) carries the old
        // magic in its authenticated header and must keep importing.
        let original = identity();
        let data = export_with_magic(&original, "secret", &LEGACY_EXPORT_MAGIC).expect("export");
        assert_eq!(data[..8], LEGACY_EXPORT_MAGIC);
        let restored = import_identity(&data, "secret").expect("import");
        assert_eq!(original.public_key(), restored.public_key());
    }

    #[test]
    fn swapping_the_magic_breaks_the_tag() {
        // The magic is part of the associated data: relabelling a file is
        // detected instead of silently accepted.
        let mut data = export_identity(&identity(), "secret").expect("export");
        data[..8].copy_from_slice(&LEGACY_EXPORT_MAGIC);
        assert!(matches!(
            import_identity(&data, "secret"),
            Err(PlatformError::InvalidPassword)
        ));
    }

    #[test]
    fn wrong_password_is_rejected() {
        let data = export_identity(&identity(), "right").expect("export");
        assert!(matches!(
            import_identity(&data, "wrong"),
            Err(PlatformError::InvalidPassword)
        ));
    }

    #[test]
    fn tampering_is_detected() {
        let mut data = export_identity(&identity(), "secret").expect("export");
        let last = data.len() - 1;
        data[last] ^= 0xff;
        assert!(matches!(
            import_identity(&data, "secret"),
            Err(PlatformError::InvalidPassword)
        ));
    }

    #[test]
    fn header_is_authenticated() {
        let mut data = export_identity(&identity(), "secret").expect("export");
        // Changing the salt changes the derived key, so the tag no longer
        // matches even though the password is right.
        data[21] ^= 0x01;
        assert!(matches!(
            import_identity(&data, "secret"),
            Err(PlatformError::InvalidPassword)
        ));
    }

    #[test]
    fn rejects_short_and_foreign_files() {
        assert!(matches!(
            import_identity(b"nope", "secret"),
            Err(PlatformError::InvalidFile)
        ));
        let mut data = export_identity(&identity(), "secret").expect("export");
        data[0] = b'X';
        assert!(matches!(
            import_identity(&data, "secret"),
            Err(PlatformError::InvalidFile)
        ));
    }

    #[test]
    fn rejects_unknown_version() {
        let mut data = export_identity(&identity(), "secret").expect("export");
        data[8] = 99;
        assert!(matches!(
            import_identity(&data, "secret"),
            Err(PlatformError::UnsupportedVersion(99))
        ));
    }

    #[test]
    fn rejects_empty_password() {
        assert!(matches!(
            export_identity(&identity(), ""),
            Err(PlatformError::InvalidPassword)
        ));
    }

    #[test]
    fn file_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("identity.rostalkkey");
        export_identity_to_file(&path, &identity(), "pw").expect("write");
        let restored = import_identity_from_file(&path, "pw").expect("read");
        assert_eq!(identity().public_key(), restored.public_key());
        assert!(!dir.path().join("identity.rostalkkey.tmp").exists());
    }
}
