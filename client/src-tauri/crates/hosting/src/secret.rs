//! Secrets that live only for the duration of one operation.
//!
//! The wrapper has no `Debug`, `Display`, `Serialize` or `Clone`, so a password
//! cannot reach a log line, an IPC event or the UI by accident. Memory is
//! zeroed on drop. Callers pass secrets to exactly one place: the SSH password
//! method, the sudo stdin or the remote admin stdin.

use zeroize::Zeroizing;

/// A password or passphrase kept in zeroing memory.
pub struct Secret(Zeroizing<String>);

impl Secret {
    /// Wraps a secret. Accepts an empty value; callers validate.
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(Zeroizing::new(value.into()))
    }

    /// Borrows the value for the one call that needs it.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// True when no secret was supplied.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret([redacted])")
    }
}

/// Replaces known secrets inside remote output before it reaches a log or the
/// UI. Also drops invite links: a progress journal must never carry a token.
#[derive(Default)]
pub struct Redactor {
    secrets: Vec<String>,
}

impl Redactor {
    /// Registers a secret value. Empty values are ignored.
    pub fn add(&mut self, secret: &str) {
        if !secret.is_empty() {
            self.secrets.push(secret.to_owned());
        }
    }

    /// Redacts secrets and invite links, trims whitespace and caps the length.
    #[must_use]
    pub fn redact(&self, text: &str) -> String {
        let mut value = text.replace('\r', "");
        // A token is a bearer credential even when it is single-use.
        if value.to_ascii_lowercase().contains("rostalk://") {
            let kept: Vec<&str> = value
                .lines()
                .filter(|line| !line.to_ascii_lowercase().contains("rostalk://"))
                .collect();
            value = kept.join("\n");
        }
        for secret in &self.secrets {
            if !secret.is_empty() {
                value = value.replace(secret, "[redacted]");
            }
        }
        value = value.trim().to_owned();
        const MAX: usize = 8_000;
        if value.chars().count() > MAX {
            value = value.chars().take(MAX).collect::<String>() + "…";
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_is_not_printed_by_debug() {
        let secret = Secret::new("hunter2");
        assert_eq!(format!("{secret:?}"), "Secret([redacted])");
        assert!(!format!("{secret:?}").contains("hunter2"));
    }

    #[test]
    fn redactor_removes_secrets_and_links() {
        let mut redactor = Redactor::default();
        redactor.add("hunter2");
        let text = "password hunter2\nrostalk://join?host=x&invite=abc\nok";
        let clean = redactor.redact(text);
        assert!(!clean.contains("hunter2"));
        assert!(!clean.contains("rostalk://"));
        assert!(clean.contains("ok"));
    }
}
