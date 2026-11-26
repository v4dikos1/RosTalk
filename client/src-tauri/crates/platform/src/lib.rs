//! RosTalk platform glue.
//!
//! Stage 2.2 adds the part that is platform-specific in the desktop client:
//! the Ed25519 identity that lives in the OS keychain and its password
//! protected export file (design 4.2). The hotkey hook and the loopback stream
//! proxy arrive in the stages that need them (design 5.1, 5.3) behind the same
//! crate.
//!
//! Security notes:
//! - the private key is never logged and never leaves the machine in clear;
//! - [`Identity`]'s `Debug` implementation prints only the public part;
//! - the export file is authenticated encryption, not a plain key dump.

pub mod clipboard;
pub mod error;
pub mod export;
pub mod hotkey;
pub mod identity;
pub mod legacy;
pub mod store;

pub use error::PlatformError;
pub use export::{
    export_identity, import_identity, EXPORT_FORMAT_VERSION, EXPORT_MAGIC, EXPORT_PARAMS,
};
pub use hotkey::{
    code_name_for_scan, install as install_input_hook, is_supported as input_hook_supported,
    key_name_for_scan, scan_code_for_code_name, scan_code_for_key_name, DeviceId, InputEvent,
    InputHandler, InputHook, MouseButton, SCAN_EXTENDED,
};
pub use identity::Identity;
pub use store::{IdentityVault, KeyringStore, MemoryStore, SecretStore};
