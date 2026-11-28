import { describe, expect, it } from "vitest";
import { gameEn } from "./game.en";
import { gameRu } from "./game.ru";

function flatten(value: unknown, prefix = ""): Map<string, string> {
  const leaves = new Map<string, string>();
  if (typeof value === "string") return leaves.set(prefix, value);
  for (const [key, child] of Object.entries(value as object)) {
    for (const [path, leaf] of flatten(child, prefix ? `${prefix}.${key}` : key)) leaves.set(path, leaf);
  }
  return leaves;
}
const tokens = (text: string) => [...text.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)].map((m) => m[1]).sort().join(",");

describe("game locales", () => {
  it("have the same keys and placeholders in ru and en", () => {
    const ru = flatten(gameRu);
    const en = flatten(gameEn);
    expect([...ru.keys()].sort()).toEqual([...en.keys()].sort());
    expect([...ru].filter(([key, text]) => tokens(text) !== tokens(en.get(key) ?? "")).map(([key]) => key)).toEqual([]);
    expect([...ru.values(), ...en.values()].every((text) => text.trim() !== "")).toBe(true);
  });
});
