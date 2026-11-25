//! One-time adoption of data left by releases published as "Hearth" (ADR 0033).
//!
//! The rename changed the application identifier (`dev.hearth.*` →
//! `dev.rostalk.*`) and with it the keychain service and the `%APPDATA%`
//! folders. On first start a RosTalk client copies what an old install left so
//! the user keeps their identity, servers and settings.
//!
//! Everything here **copies** and never deletes: the old client may still be
//! installed (its uninstaller owns its data), and a user who rolls back finds
//! their data untouched. Nothing is copied when the new location already has
//! data, so a fresh RosTalk identity is never overwritten.

use std::fs;
use std::io;
use std::path::Path;

use zeroize::Zeroizing;

use crate::store::{IdentityVault, SecretStore};
use crate::PlatformError;

/// Application identifier of the desktop client before the rename.
pub const LEGACY_CLIENT_IDENTIFIER: &str = "dev.hearth.desktop";

/// Application identifier of the server installer before the rename.
pub const LEGACY_SERVER_SETUP_IDENTIFIER: &str = "dev.hearth.server-setup";

/// Copies the identity stored by an old client into `vault`.
///
/// Returns `Ok(true)` when an identity was adopted. Does nothing when the
/// vault already holds an identity or the legacy store has none; a legacy
/// secret of the wrong size is ignored rather than copied.
pub fn adopt_identity<S: SecretStore, L: SecretStore>(
    vault: &IdentityVault<S>,
    legacy: &L,
) -> Result<bool, PlatformError> {
    if vault.load()?.is_some() {
        return Ok(false);
    }
    let Some(seed) = legacy.get(vault.account())?.map(Zeroizing::new) else {
        return Ok(false);
    };
    if seed.len() != 32 {
        return Ok(false);
    }
    vault.store_seed(&seed)?;
    Ok(true)
}

/// Copies the directory `legacy` to `target` when `target` does not exist yet.
///
/// Returns `Ok(true)` when something was copied. The copy goes to a sibling
/// temporary folder first and is renamed into place, so a crash halfway never
/// leaves a half-filled `target` that would block the next attempt.
pub fn adopt_dir(legacy: &Path, target: &Path) -> io::Result<bool> {
    if target.exists() || !legacy.is_dir() {
        return Ok(false);
    }
    let Some(parent) = target.parent() else {
        return Ok(false);
    };
    fs::create_dir_all(parent)?;
    let mut staging = target.as_os_str().to_owned();
    staging.push(".adopting");
    let staging = Path::new(&staging).to_path_buf();
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    copy_tree(legacy, &staging)?;
    fs::rename(&staging, target)?;
    Ok(true)
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &dest)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &dest)?;
        }
        // Symlinks are skipped: the client never creates them, and following
        // one could copy data from outside the old folder.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::Identity;
    use crate::store::MemoryStore;

    #[test]
    fn identity_is_adopted_once_and_never_overwrites() {
        let legacy = MemoryStore::new();
        let old = Identity::from_seed([7u8; 32]);
        legacy
            .set(crate::store::IDENTITY_ACCOUNT, &old.seed()[..])
            .expect("seed");

        let vault = IdentityVault::new("new", MemoryStore::new());
        assert!(adopt_identity(&vault, &legacy).expect("adopt"));
        let loaded = vault.load().expect("load").expect("identity");
        assert_eq!(loaded.public_key(), old.public_key());
        // The legacy copy stays for the old client and for a rollback.
        assert!(legacy
            .get(crate::store::IDENTITY_ACCOUNT)
            .expect("get")
            .is_some());

        // A second run, or a vault with its own identity, is left alone.
        let fresh = IdentityVault::new("fresh", MemoryStore::new());
        let mine = fresh.load_or_create().expect("create");
        assert!(!adopt_identity(&fresh, &legacy).expect("adopt"));
        assert_eq!(
            fresh.load().expect("load").expect("identity").public_key(),
            mine.public_key()
        );
    }

    #[test]
    fn empty_or_bad_legacy_identity_is_ignored() {
        let vault = IdentityVault::new("new", MemoryStore::new());
        assert!(!adopt_identity(&vault, &MemoryStore::new()).expect("empty"));
        let bad = MemoryStore::new();
        bad.set(crate::store::IDENTITY_ACCOUNT, b"short")
            .expect("set");
        assert!(!adopt_identity(&vault, &bad).expect("bad"));
        assert!(vault.load().expect("load").is_none());
    }

    #[test]
    fn dir_is_copied_only_into_a_missing_target() {
        let root = tempfile::tempdir().expect("tempdir");
        let legacy = root.path().join("dev.hearth.desktop");
        fs::create_dir_all(legacy.join("nested")).expect("mkdir");
        fs::write(legacy.join("settings.json"), b"{\"v\":1}").expect("write");
        fs::write(legacy.join("nested").join("servers.json"), b"[]").expect("write");
        let target = root.path().join("dev.rostalk.desktop");

        assert!(adopt_dir(&legacy, &target).expect("adopt"));
        assert_eq!(
            fs::read(target.join("settings.json")).expect("read"),
            b"{\"v\":1}"
        );
        assert_eq!(
            fs::read(target.join("nested").join("servers.json")).expect("read"),
            b"[]"
        );
        assert!(legacy.join("settings.json").exists(), "source must stay");

        fs::write(target.join("settings.json"), b"{\"v\":2}").expect("write");
        assert!(!adopt_dir(&legacy, &target).expect("second run"));
        assert_eq!(
            fs::read(target.join("settings.json")).expect("read"),
            b"{\"v\":2}"
        );
    }

    #[test]
    fn missing_legacy_dir_is_not_an_error() {
        let root = tempfile::tempdir().expect("tempdir");
        let target = root.path().join("new");
        assert!(!adopt_dir(&root.path().join("absent"), &target).expect("adopt"));
        assert!(!target.exists());
    }

    #[test]
    fn leftover_staging_from_a_crash_is_replaced() {
        let root = tempfile::tempdir().expect("tempdir");
        let legacy = root.path().join("old");
        fs::create_dir_all(&legacy).expect("mkdir");
        fs::write(legacy.join("a"), b"1").expect("write");
        let target = root.path().join("new");
        let staging = root.path().join("new.adopting");
        fs::create_dir_all(&staging).expect("mkdir");
        fs::write(staging.join("partial"), b"x").expect("write");

        assert!(adopt_dir(&legacy, &target).expect("adopt"));
        assert!(target.join("a").exists());
        assert!(!target.join("partial").exists());
        assert!(!staging.exists());
    }
}
