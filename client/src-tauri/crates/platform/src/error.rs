//! Errors of the platform crate.
//!
//! Messages are deliberately coarse: a caller maps them to a user-visible
//! error code, and no variant ever carries key material, a password or file
//! contents.

/// Something went wrong while handling the local identity.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlatformError {
    /// The operating system keychain refused the operation.
    #[error("OS keychain is unavailable: {0}")]
    Keychain(String),

    /// The keychain backend is not implemented on this platform.
    #[error("identity storage is only implemented on Windows")]
    Unsupported,

    /// A key stored earlier cannot be decoded (corrupted or written by another
    /// version of the client).
    #[error("stored identity is corrupted")]
    Corrupted,

    /// The export file has a bad magic, a bad shape or a truncated body.
    #[error("identity file is not a RosTalk identity export")]
    InvalidFile,

    /// The export file was produced by a newer, unsupported format version.
    #[error("identity file version {0} is not supported")]
    UnsupportedVersion(u8),

    /// The password does not open this file (or the file was modified).
    #[error("wrong password or damaged identity file")]
    InvalidPassword,

    /// The KDF parameters in the file are outside the accepted bounds.
    #[error("identity file uses unacceptable key derivation parameters")]
    InvalidParameters,

    /// The keychain has no identity for this machine yet.
    #[error("no identity is stored on this machine")]
    NoIdentity,

    /// A filesystem operation failed. The path is included, never the contents.
    #[error("file operation failed: {0}")]
    Io(String),

    /// The random number generator failed.
    #[error("could not obtain secure randomness")]
    Random,

    /// The imported seed is not a valid Ed25519 seed.
    #[error("identity seed is malformed")]
    InvalidSeed,

    /// The global input hook could not be installed or was already installed.
    #[error("global input hook: {0}")]
    InputHook(String),
}

impl From<std::io::Error> for PlatformError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}
