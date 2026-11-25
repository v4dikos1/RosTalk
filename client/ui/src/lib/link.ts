/**
 * Parsing of `rostalk://join?host=...&fp=...&invite=...` in the UI.
 *
 * The link is authoritative: the host is never rewritten and `localhost` /
 * `127.0.0.1` are never substituted (ADR 0001, stage 2.4 requirement 1). The
 * core parses the same link again; this only drives the wizard's validation
 * and the summary it shows to the user.
 */
export interface InviteLinkView {
  /** `host:port` exactly as written in the link. */
  host: string;
  /** Lowercase SHA-256 of the TLS leaf certificate. */
  fingerprint: string;
  /** Present on invitation links, absent on a saved server. */
  invite: string | null;
  /** Present when the server uses password login. */
  password: string | null;
  raw: string;
}

export type InviteLinkError =
  | "invalidLink"
  | "invalidFingerprint"
  | "missingHost";

export type InviteLinkResult =
  | { ok: true; link: InviteLinkView }
  | { ok: false; error: InviteLinkError };

const FINGERPRINT = /^[0-9a-f]{64}$/i;

export function parseInviteLink(raw: string): InviteLinkResult {
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, error: "invalidLink" };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "invalidLink" };
  }
  // `hearth:` is the scheme of links printed before the RosTalk rename
  // (ADR 0033); the core accepts both, so the dialog does too.
  if (url.protocol !== "rostalk:" && url.protocol !== "hearth:") {
    return { ok: false, error: "invalidLink" };
  }
  // Both `rostalk://join?...` and `rostalk:join?...` are accepted by Windows.
  const action = url.hostname || url.pathname.replace(/^\/+/, "");
  if (action !== "join") {
    return { ok: false, error: "invalidLink" };
  }
  const host = url.searchParams.get("host")?.trim() ?? "";
  if (host.length === 0) {
    return { ok: false, error: "missingHost" };
  }
  const fingerprint = url.searchParams.get("fp")?.trim() ?? "";
  if (!FINGERPRINT.test(fingerprint)) {
    return { ok: false, error: "invalidFingerprint" };
  }
  const invite = url.searchParams.get("invite");
  const password = url.searchParams.get("password");
  return {
    ok: true,
    link: {
      host,
      fingerprint: fingerprint.toLowerCase(),
      invite: invite && invite.length > 0 ? invite : null,
      password: password && password.length > 0 ? password : null,
      raw: value,
    },
  };
}

/** Short form for a fingerprint chip: first 8 and last 8 hex characters. */
export function shortFingerprint(fingerprint: string): string {
  if (fingerprint.length <= 20) {
    return fingerprint;
  }
  return `${fingerprint.slice(0, 8)}…${fingerprint.slice(-8)}`;
}

/**
 * True when the host points at the local machine. The UI warns about it but
 * never replaces it: the invitation may legitimately target a local server on
 * Linux, and on Windows the LAN address is the supported one (ADR 0001).
 */
export function isLoopbackHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1" || name === "[::1]";
}
