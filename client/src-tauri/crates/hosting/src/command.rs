//! Remote command construction.
//!
//! A command is always an argv vector. Each argument is POSIX-shell-quoted
//! before it reaches `exec`, because the SSH server passes the request string to
//! the user's shell. User input never gets concatenated into a shell fragment.
//! `sudo -S` reads its password from stdin, never from argv.

use crate::secret::Secret;

/// Quotes one argument for a POSIX shell.
///
/// Safe characters are passed through; everything else is wrapped in single
/// quotes, with embedded single quotes closed, escaped and reopened.
#[must_use]
pub fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_owned();
    }
    if value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'_' | b'-' | b'.' | b'/' | b':' | b'@' | b'%' | b'+' | b',' | b'='
            )
    }) {
        return value.to_owned();
    }
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

/// Joins an argv vector into one shell command line.
#[must_use]
pub fn shell_join(argv: &[String]) -> String {
    argv.iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

/// One command to run over an existing SSH session.
#[derive(Debug, Clone)]
pub struct RemoteCommand {
    /// Program and arguments, never a shell fragment.
    pub argv: Vec<String>,
    /// Bytes for the remote stdin (sudo password and, optionally, data).
    pub stdin: Vec<u8>,
    /// Whether the command needs root.
    pub root: bool,
    /// True when a sudo password was prepended to `stdin`.
    pub sudo_password: bool,
}

impl RemoteCommand {
    /// A command that runs as the SSH user.
    #[must_use]
    pub fn user(argv: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            argv: argv.into_iter().map(Into::into).collect(),
            stdin: Vec::new(),
            root: false,
            sudo_password: false,
        }
    }

    /// A command that runs as root: sudo on a normal user, direct as root.
    #[must_use]
    pub fn root(argv: impl IntoIterator<Item = impl Into<String>>, sudo: Option<&Secret>) -> Self {
        let mut command = Self::user(argv);
        command.root = true;
        if let Some(password) = sudo {
            command
                .stdin
                .extend_from_slice(password.expose().as_bytes());
            command.stdin.push(b'\n');
            command.sudo_password = true;
        }
        command
    }

    /// Appends data read by the remote command from stdin.
    #[must_use]
    pub fn with_stdin(mut self, data: impl AsRef<[u8]>) -> Self {
        self.stdin.extend_from_slice(data.as_ref());
        self
    }

    /// Builds the command line for a session that may be root or sudo.
    ///
    /// `is_root` comes from `id -u`. A non-root session without a sudo password
    /// is rejected before anything runs.
    pub fn command_line(&self, is_root: bool) -> crate::error::Result<String> {
        if !self.root || is_root {
            return Ok(shell_join(&self.argv));
        }
        if !self.sudo_password {
            return Err(crate::error::HostingError::new(
                crate::error::HostingErrorCode::SudoDenied,
                "This user is not root and no sudo password was supplied.",
            ));
        }
        let mut argv = vec![
            "sudo".to_owned(),
            "-S".to_owned(),
            "-p".to_owned(),
            String::new(),
            "--".to_owned(),
        ];
        argv.extend(self.argv.iter().cloned());
        Ok(shell_join(&argv))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_arguments_are_untouched() {
        assert_eq!(shell_quote("install.sh"), "install.sh");
        assert_eq!(shell_quote("/var/lib/rostalk"), "/var/lib/rostalk");
        assert_eq!(shell_quote("rostalk.example.com"), "rostalk.example.com");
        assert_eq!(
            shell_quote("--public-host=1.2.3.4"),
            "--public-host=1.2.3.4"
        );
    }

    #[test]
    fn spaces_and_quotes_are_escaped() {
        assert_eq!(shell_quote("two words"), "'two words'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote("$(reboot)"), "'$(reboot)'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn argv_is_joined_without_a_shell_fragment() {
        let line = shell_join(&[
            "sh".to_owned(),
            "/tmp/install.sh".to_owned(),
            "--public-host".to_owned(),
            "1.2.3.4; reboot".to_owned(),
        ]);
        assert_eq!(line, "sh /tmp/install.sh --public-host '1.2.3.4; reboot'");
    }

    #[test]
    fn sudo_command_puts_the_password_on_stdin_only() {
        let password = Secret::new("hunter2");
        let command = RemoteCommand::root(
            ["install", "-m", "0755", "a", "/usr/local/bin/a"],
            Some(&password),
        );
        let line = command.command_line(false).expect("line");
        assert!(line.starts_with("sudo -S -p '' -- install"));
        assert!(!line.contains("hunter2"));
        assert_eq!(command.stdin, b"hunter2\n");
    }

    #[test]
    fn root_needs_no_sudo() {
        let command = RemoteCommand::root(["uname", "-m"], None);
        assert_eq!(command.command_line(true).expect("line"), "uname -m");
    }

    #[test]
    fn non_root_without_sudo_is_rejected() {
        let command = RemoteCommand::root(["uname", "-m"], None);
        assert!(command.command_line(false).is_err());
    }
}
