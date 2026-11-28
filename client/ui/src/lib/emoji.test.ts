import { describe, expect, it } from "vitest";

import { EMOJI_GROUPS, EMOJI_KEYWORDS } from "./emojiData";
import { emojiKeywords, filterEmoji, groupEmoji, type EmojiSource } from "./emoji";

const source: EmojiSource = {
  groups: EMOJI_GROUPS,
  keywords: EMOJI_KEYWORDS,
};

function chars(query: string): string[] {
  return filterEmoji(query, source).map((entry) => entry.char);
}

describe("emoji data", () => {
  it("covers the full Unicode set in emoji-test order without components", () => {
    expect(EMOJI_GROUPS.map((group) => group.id)).toEqual([
      "smileys",
      "people",
      "nature",
      "food",
      "travel",
      "activities",
      "objects",
      "symbols",
      "flags",
    ]);
    const total = EMOJI_GROUPS.reduce(
      (sum, group) => sum + group.entries.length,
      0,
    );
    expect(total).toBeGreaterThan(1900);
    expect(total).toBeLessThanOrEqual(4000);
  });

  it("keeps skin-tone variants and resolves their shared keywords", () => {
    const people = EMOJI_GROUPS.find((group) => group.id === "people")!;
    const thumbs = people.entries.find((entry) => entry[0] === "👍🏻");
    expect(thumbs).toBeDefined();
    const words = emojiKeywords(thumbs!, EMOJI_KEYWORDS);
    expect(words).toContain("like");
    expect(words).toContain("нравится");
  });

  it("takes flag names from the CLDR derived annotations", () => {
    const flags = EMOJI_GROUPS.find((group) => group.id === "flags")!;
    expect(flags.entries).toHaveLength(270);
    expect(
      flags.entries.every(
        ([, index]) => (EMOJI_KEYWORDS[index] ?? []).length > 0,
      ),
    ).toBe(true);

    const zambia = flags.entries.find((entry) => entry[0] === "🇿🇲");
    expect(zambia).toBeDefined();
    const words = emojiKeywords(zambia!, EMOJI_KEYWORDS);
    expect(words.some((word) => word.includes("замбия"))).toBe(true);
    expect(words.some((word) => word.includes("zambia"))).toBe(true);
    expect(words).toContain("флаг");
    expect(words).toContain("flag");
  });
});

describe("emoji search", () => {
  it("opens on a category in emoji-test order", () => {
    const smileys = EMOJI_GROUPS[0]!;
    const items = groupEmoji(smileys, EMOJI_KEYWORDS);
    expect(items.length).toBe(smileys.entries.length);
    expect(items[0]?.char).toBe("😀");
  });

  it("finds entries by Russian and English keywords", () => {
    expect(chars("кот")).toContain("🐱");
    expect(chars("cat")).toContain("🐱");
    expect(chars("праздник")).toContain("🎉");
    expect(chars("party")).toContain("🎉");
  });

  it("finds flags by localized country name and by the word flag", () => {
    expect(chars("замбия")).toContain("🇿🇲");
    expect(chars("zambia")).toContain("🇿🇲");
    expect(chars("флаг")).toContain("🇿🇲");
    expect(chars("flag")).toContain("🇿🇲");
    expect(chars("флаг").length).toBeGreaterThan(100);
  });

  it("is case-insensitive, finds a glyph and reports no matches", () => {
    expect(chars("FIRE")).toContain("🔥");
    expect(chars("🔥")).toEqual(["🔥"]);
    expect(chars("нет такой подписи")).toEqual([]);
  });

  it("does not return matches for an empty query without a category", () => {
    expect(filterEmoji("   ", { ...source, groups: [] })).toEqual([]);
  });
});
