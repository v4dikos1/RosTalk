//! Errors of the voice engine.
//!
//! Messages never contain media tokens or URLs: they are logged and, in a
//! shortened form, shown to the user.

use thiserror::Error;

/// Everything the voice engine can fail with.
#[derive(Debug, Error)]
pub enum VoiceError {
    /// No audio backend or no device matches the selection.
    #[error("audio device error: {0}")]
    Device(String),
    /// The capture or playback stream could not be built.
    #[error("audio stream error: {0}")]
    Stream(String),
    /// The access point to the media server failed.
    #[error("media connection error: {0}")]
    Media(String),
    /// The media token does not allow publishing a microphone track.
    #[error("the server does not allow publishing audio")]
    PublishNotAllowed,
    /// An operation was requested before the engine was started.
    #[error("the voice engine is not running")]
    NotRunning,
    /// A test-audio file could not be used.
    #[error("test audio error: {0}")]
    TestAudio(String),
    /// Anything the engine could not classify.
    #[error("voice engine error: {0}")]
    Internal(String),
}

impl VoiceError {
    /// Short, token-free description for the UI.
    #[must_use]
    pub fn user_message(&self) -> String {
        self.to_string()
    }
}
