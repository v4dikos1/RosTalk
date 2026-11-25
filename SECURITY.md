# Security policy

## Supported versions

Only the latest release receives fixes. The client checks for updates from
**Settings → Updates**; servers update with the same `install.sh` command they
were installed with.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on
<https://github.com/v4dikos1/RosTalk/security/advisories/new>.

Do not open a public issue. Include what you found, how to reproduce it and
which version you tested. You will get an answer within a week; a fix and an
advisory follow once the issue is confirmed.

In scope: the server (`rostalk-server`), the Windows client, the server setup
wizard, the installers and the release signing chain. Out of scope: attacks
that need an already compromised machine or a malicious server owner (the
owner of a self-hosted server can read everything that passes through it —
there is no end-to-end encryption, see `docs/TECHNICAL_DESIGN.md`).

## How releases are protected

- Every file of a release is listed in `SHA256SUMS`, signed with the project's
  Ed25519 release key (`SHA256SUMS.sig`). `install.sh` and the server setup
  wizard verify that signature before touching the system; the public key is
  in `deploy/release.pub`.
- The client updater accepts only installers signed with the minisign key
  whose public half is built into the client (`tauri.conf.json`).
- Windows binaries are not Authenticode-signed yet; see the README for what
  that means and how to verify a download.
