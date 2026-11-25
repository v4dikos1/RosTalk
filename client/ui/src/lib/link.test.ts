import { describe, expect, it } from "vitest";

import { isLoopbackHost, parseInviteLink, shortFingerprint } from "./link";

const fingerprint = "ab".repeat(32);

describe("parseInviteLink", () => {
  it("keeps the host and fingerprint exactly as given", () => {
    const result = parseInviteLink(
      `rostalk://join?host=192.168.0.13:7443&fp=${fingerprint}&invite=token`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.link.host).toBe("192.168.0.13:7443");
      expect(result.link.fingerprint).toBe(fingerprint);
      expect(result.link.invite).toBe("token");
      expect(result.link.password).toBeNull();
    }
  });

  it("trims the host and the fingerprint and keeps an empty invite as null", () => {
    const result = parseInviteLink(
      `rostalk://join?host=%20192.168.0.13:7443%20&fp=%20${fingerprint}%20&invite=`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.link.host).toBe("192.168.0.13:7443");
      expect(result.link.fingerprint).toBe(fingerprint);
      expect(result.link.invite).toBeNull();
    }
  });

  it("carries a password when the server uses password login", () => {
    const result = parseInviteLink(
      `rostalk://join?host=rostalk.example&fp=${fingerprint}&password=s3cret`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.link.password).toBe("s3cret");
      expect(result.link.invite).toBeNull();
    }
  });

  it("rejects a non-rostalk URL even when the rest looks like an invite", () => {
    // The protocol check must run on its own: a URL with a valid join host,
    // host and fingerprint would otherwise be accepted.
    expect(
      parseInviteLink(
        `https://join?host=192.168.0.13:7443&fp=${fingerprint}`,
      ),
    ).toEqual({ ok: false, error: "invalidLink" });
  });

  it("accepts a hearth:// link printed before the rename", () => {
    // ADR 0033: invites already sent in messengers keep working.
    const result = parseInviteLink(
      `hearth://join?host=192.168.0.13:7443&fp=${fingerprint}&invite=token`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.link.host).toBe("192.168.0.13:7443");
      expect(result.link.invite).toBe("token");
    }
    expect(
      parseInviteLink(`hearth://other?host=192.168.0.13:7443&fp=${fingerprint}`),
    ).toEqual({ ok: false, error: "invalidLink" });
  });

  it("rejects a rostalk link for another action", () => {
    expect(
      parseInviteLink(
        `rostalk://other?host=192.168.0.13:7443&fp=${fingerprint}`,
      ),
    ).toEqual({ ok: false, error: "invalidLink" });
  });

  it("never rewrites localhost", () => {
    const result = parseInviteLink(
      `rostalk://join?host=localhost:7443&fp=${fingerprint}`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.link.host).toBe("localhost:7443");
    }
  });

  it("accepts the Windows form without slashes", () => {
    const result = parseInviteLink(
      `rostalk:join?host=rostalk.example&fp=${fingerprint}`,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a non-rostalk link", () => {
    expect(parseInviteLink("https://example.com")).toEqual({
      ok: false,
      error: "invalidLink",
    });
  });

  it("rejects a missing or malformed fingerprint", () => {
    expect(parseInviteLink("rostalk://join?host=host:7443")).toEqual({
      ok: false,
      error: "invalidFingerprint",
    });
    expect(
      parseInviteLink("rostalk://join?host=host:7443&fp=abcd"),
    ).toEqual({ ok: false, error: "invalidFingerprint" });
    // The anchors matter: 64 hex characters inside a longer string are not a
    // SHA-256 digest.
    for (const value of [`a${fingerprint}`, `${fingerprint}a`, `x${fingerprint}x`]) {
      expect(
        parseInviteLink(`rostalk://join?host=host:7443&fp=${value}`),
      ).toEqual({ ok: false, error: "invalidFingerprint" });
    }
  });

  it("rejects a missing host", () => {
    expect(
      parseInviteLink(`rostalk://join?fp=${fingerprint}`),
    ).toEqual({ ok: false, error: "missingHost" });
  });
});

describe("link helpers", () => {
  it("detects loopback hosts", () => {
    expect(isLoopbackHost("localhost:7443")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:7443")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("[::1]:7443")).toBe(true);
    expect(isLoopbackHost("LOCALHOST:7443")).toBe(true);
    expect(isLoopbackHost("192.168.0.13:7443")).toBe(false);
    expect(isLoopbackHost("rostalk.example")).toBe(false);
  });

  it("shortens a fingerprint without losing the ends", () => {
    expect(shortFingerprint(fingerprint)).toBe("abababab…abababab");
    // Up to 20 characters the value is shown whole; the 21st starts the chip.
    expect(shortFingerprint("a".repeat(20))).toBe("a".repeat(20));
    expect(shortFingerprint("a".repeat(21))).toBe(
      `${"a".repeat(8)}…${"a".repeat(8)}`,
    );
  });
});
