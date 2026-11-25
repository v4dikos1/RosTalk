/**
 * Where RosTalk releases live (P13, ADR 0026). The repository is fixed at build
 * time (`make release RELEASE_REPO=owner/name`); the client never opens these
 * addresses itself: it shows them with a Copy button (ADR 0023).
 */
export const RELEASE_REPO: string = __ROSTALK_RELEASE_REPO__;

/** The page with the newest release and its downloads. */
export const RELEASES_URL = `https://github.com/${RELEASE_REPO}/releases/latest`;

/** One-line server installation on a Linux machine (docs/INSTALL.md). */
export const LINUX_INSTALL_COMMAND = `curl -fsSL https://github.com/${RELEASE_REPO}/releases/latest/download/install.sh | sudo sh`;

/**
 * The updater manifest used when no source is configured; the Rust shell
 * builds the same URL (`updates::default_source`).
 */
export function defaultUpdateSource(): string {
  return `https://github.com/${RELEASE_REPO}/releases/latest/download/latest.json`;
}
