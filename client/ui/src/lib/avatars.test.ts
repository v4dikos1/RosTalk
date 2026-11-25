import { describe, expect, it } from "vitest";

import type { ChatProxyView } from "@/core/api";
import {
  AvatarHttpError,
  avatarCrop,
  avatarErrorKey,
  avatarMaxOffset,
  avatarUrl,
} from "./avatars";

describe("avatar crop", () => {
  it("takes the largest square in the middle without zoom or pan", () => {
    expect(avatarCrop(800, 400, 240, 1, 0, 0)).toEqual({
      sx: 200,
      sy: 0,
      size: 400,
    });
    expect(avatarCrop(400, 800, 240, 1, 0, 0)).toEqual({
      sx: 0,
      sy: 200,
      size: 400,
    });
    expect(avatarCrop(300, 300, 240, 1, 0, 0)).toEqual({
      sx: 0,
      sy: 0,
      size: 300,
    });
  });

  it("zooms into the centre", () => {
    const half = avatarCrop(1000, 500, 240, 2, 0, 0);
    expect(half.size).toBe(250);
    expect(half.sx).toBe(375);
    expect(half.sy).toBe(125);
  });

  it("pans within the available edges and clamps the rest", () => {
    const max = avatarMaxOffset(800, 400, 240, 1);
    expect(max.x).toBeGreaterThan(0);
    expect(max.y).toBe(0);
    const left = avatarCrop(800, 400, 240, 1, max.x, 0);
    expect(left.sx).toBeCloseTo(0, 6);
    const pushed = avatarCrop(800, 400, 240, 1, max.x + 500, 0);
    expect(pushed.sx).toBe(0);
    const right = avatarCrop(800, 400, 240, 1, -max.x, 0);
    expect(right.sx).toBeCloseTo(400, 6);
  });

  it("never returns an empty or out-of-bounds square", () => {
    for (const [width, height] of [
      [1, 1],
      [4000, 3],
      [3, 4000],
      [0, 10],
      [10, 0],
    ] as const) {
      const crop = avatarCrop(width, height, 240, 3, 999, -999);
      expect(crop.size).toBeGreaterThanOrEqual(0);
      if (crop.size > 0) {
        expect(crop.sx).toBeGreaterThanOrEqual(0);
        expect(crop.sy).toBeGreaterThanOrEqual(0);
        expect(crop.sx + crop.size).toBeLessThanOrEqual(width + 1e-9);
        expect(crop.sy + crop.size).toBeLessThanOrEqual(height + 1e-9);
      }
    }
  });
});

describe("avatar URLs", () => {
  const proxy: ChatProxyView = {
    baseUrl: "http://127.0.0.1:7777",
    token: "secret token",
  };

  it("carries the proxy token as the only query parameter", () => {
    const url = new URL(avatarUrl(proxy, "a".repeat(64)));
    expect(url.pathname).toBe(`/avatars/${"a".repeat(64)}`);
    expect(url.searchParams.get("pt")).toBe("secret token");
    expect([...url.searchParams.keys()]).toEqual(["pt"]);
  });

  it("returns an empty string without a hash", () => {
    expect(avatarUrl(proxy, "")).toBe("");
  });
});

describe("avatar error mapping", () => {
  it("maps the codes the server sends", () => {
    expect(avatarErrorKey(new AvatarHttpError(413, "file_too_large", ""))).toBe(
      "avatar.errors.tooLarge",
    );
    expect(avatarErrorKey(new AvatarHttpError(415, "unsupported_type", ""))).toBe(
      "avatar.errors.unsupported",
    );
    expect(avatarErrorKey(new AvatarHttpError(400, "invalid_image", ""))).toBe(
      "avatar.errors.invalid",
    );
    expect(avatarErrorKey(new AvatarHttpError(429, "rate_limited", ""))).toBe(
      "avatar.errors.rate",
    );
    expect(avatarErrorKey(new AvatarHttpError(0, "network", ""))).toBe(
      "avatar.errors.network",
    );
    expect(avatarErrorKey(new AvatarHttpError(403, "permission_denied", ""))).toBe(
      "avatar.errors.denied",
    );
    expect(avatarErrorKey(new Error("boom"))).toBe("avatar.errors.failed");
  });
});
