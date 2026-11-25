import { describe, expect, it } from "vitest";

import { en } from "./en";
import { ru } from "./ru";

/** Every leaf key in dotted form, so the two locales can be compared. */
function flatten(value: unknown, prefix = ""): Map<string, string> {
  const leaves = new Map<string, string>();
  if (typeof value === "string") {
    leaves.set(prefix, value);
    return leaves;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      for (const [path, leaf] of flatten(child, prefix ? `${prefix}.${key}` : key)) {
        leaves.set(path, leaf);
      }
    }
  }
  return leaves;
}

const ruKeys = flatten(ru);
const enKeys = flatten(en);

describe("i18n locales", () => {
  it("ru and en have exactly the same keys", () => {
    const onlyRu = [...ruKeys.keys()].filter((key) => !enKeys.has(key)).sort();
    const onlyEn = [...enKeys.keys()].filter((key) => !ruKeys.has(key)).sort();
    expect({ onlyRu, onlyEn }).toEqual({ onlyRu: [], onlyEn: [] });
  });

  it("every key keeps the same interpolation placeholders", () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)]
        .map((match) => match[1])
        .sort();
    const mismatched = [...ruKeys.entries()]
      .filter(([key]) => enKeys.has(key))
      .filter(
        ([key, text]) =>
          placeholders(text).join(",") !==
          placeholders(enKeys.get(key) ?? "").join(","),
      )
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });
});
