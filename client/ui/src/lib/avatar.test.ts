import { describe, expect, it } from "vitest";

import { avatarColors, AVATAR_HUES, avatarIndex, avatarPalette } from "./avatar";

describe("avatar colours", () => {
  it("is stable for the same server and user", () => {
    const first = avatarColors("server-a", 42);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(avatarColors("server-a", 42)).toEqual(first);
      expect(avatarIndex("server-a", 42)).toBe(avatarIndex("server-a", 42));
    }
    // A nickname is not part of the seed: the id alone decides.
    expect(avatarColors("server-a", 42)).toEqual(first);
  });

  it("gives different people different colours", () => {
    // The first eight ids cover the whole palette, so a person without a
    // coloured role is never painted with a neighbour's accent.
    const indexes = Array.from({ length: 8 }, (_, index) =>
      avatarIndex("server-a", index + 1),
    );
    expect(new Set(indexes).size).toBe(8);
    expect(avatarIndex("server-a", 7)).not.toBe(avatarIndex("server-b", 7));
    expect(avatarIndex(null, 7)).toBe(avatarIndex(undefined, 7));
  });

  it("covers all eight hues", () => {
    expect(new Set(AVATAR_HUES).size).toBe(8);
    expect(new Set(AVATAR_HUES.map((_, index) => avatarPalette(index).background)).size).toBe(8);
  });

  it("takes lightness from the theme tokens and the hue from the palette", () => {
    // Contrast of every hue in every preset is checked in tokens.test.ts.
    AVATAR_HUES.forEach((hue, index) => {
      const palette = avatarPalette(index);
      expect(palette.background).toBe(
        `oklch(var(--avatar-fill-l) var(--avatar-fill-c) ${hue})`,
      );
      expect(palette.foreground).toBe(
        `oklch(var(--avatar-ink-l) var(--avatar-ink-c) ${hue})`,
      );
    });
  });
});
