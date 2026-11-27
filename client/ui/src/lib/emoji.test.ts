import { describe, expect, it } from "vitest";

import { COMMON_EMOJI, filterEmoji } from "./emoji";

describe("emoji search", () => {
  it("opens on the whole compact set", () => {
    expect(filterEmoji("")).toHaveLength(COMMON_EMOJI.length);
  });

  it("finds entries by Russian and English keywords", () => {
    const catByRu = filterEmoji("кот").map((entry) => entry.char);
    const catByEn = filterEmoji("cat").map((entry) => entry.char);
    expect(catByRu).toContain("🐱");
    expect(catByEn).toContain("🐱");
    expect(filterEmoji("праздник").map((entry) => entry.char)).toContain("🎉");
    expect(filterEmoji("party").map((entry) => entry.char)).toContain("🎉");
  });

  it("is case-insensitive and reports no matches", () => {
    expect(filterEmoji("FIRE").map((entry) => entry.char)).toContain("🔥");
    expect(filterEmoji("нет такой подписи")).toEqual([]);
  });
});
