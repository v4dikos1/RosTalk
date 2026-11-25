import { readFileSync } from "node:fs";
import path from "node:path";

import { contrast, parseOklch } from "./oklch";

/**
 * WCAG AA guard for the design tokens.
 *
 * The palette lives in `index.css` as five presets and six accents; a visual
 * tweak is easy to make and easy to break. This test parses the real file,
 * resolves every preset/accent pair exactly like the browser does (preset
 * tokens, then the accent block for the preset's light/dark scheme) and fails
 * on a contrast regression instead of waiting for a screenshot review.
 */

const css = readFileSync(path.resolve(process.cwd(), "src/index.css"), "utf8");

interface Block {
  selector: string;
  vars: Map<string, string>;
  css: string;
}

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = blockRe.exec(source); match; match = blockRe.exec(source)) {
    const selector = match[1]?.trim() ?? "";
    const body = match[2] ?? "";
    if (!selector.includes("[data-")) {
      continue;
    }
    const vars = new Map<string, string>();
    const varRe = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
    for (let item = varRe.exec(body); item; item = varRe.exec(body)) {
      vars.set(item[1] ?? "", (item[2] ?? "").trim());
    }
    blocks.push({ selector, vars, css: body });
  }
  return blocks;
}

function attr(selector: string, name: string): string | null {
  const match = selector.match(new RegExp(`\\[${name}="([^"]+)"\\]`));
  return match?.[1] ?? null;
}

const blocks = parseBlocks(css);
const presets = new Map<string, Block>();
const accents = new Map<string, Block>();

for (const block of blocks) {
  const preset = attr(block.selector, "data-preset");
  const accent = attr(block.selector, "data-accent");
  if (preset) {
    presets.set(preset, block);
  }
  if (accent) {
    const theme = attr(block.selector, "data-theme") ?? "dark";
    accents.set(`${theme}:${accent}`, block);
  }
}

// Stage P9: «Очаг» and «Бумага» (direction A+C), AMOLED and «Контраст».
const presetNames = ["rostalk", "paper", "amoled", "contrast"];
const accentNames = ["ember", "ice", "violet", "moss", "rose", "mono"];
const tokenNames = [
  "chrome",
  "background",
  "surface",
  "surface-raised",
  "surface-hover",
  "surface-active",
  "border",
  "border-strong",
  "foreground",
  "muted-foreground",
  "faint-foreground",
  "accent",
  "accent-strong",
  "accent-foreground",
  "danger",
  "danger-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "avatar-fill-l",
  "avatar-fill-c",
  "avatar-ink-l",
  "avatar-ink-c",
] as const;

function themeOf(block: Block): "dark" | "light" {
  return /color-scheme\s*:\s*light/.test(block.css) ? "light" : "dark";
}

function resolve(
  presetName: string,
  accentName: string,
): { vars: Map<string, string>; theme: "dark" | "light" } | null {
  const preset = presets.get(presetName);
  if (!preset) {
    return null;
  }
  const theme = themeOf(preset);
  const vars = new Map(preset.vars);
  if (accentName !== "auto") {
    const accent = accents.get(`${theme}:${accentName}`);
    if (!accent) {
      return null;
    }
    for (const [name, value] of accent.vars) {
      vars.set(name, value);
    }
  }
  return { vars, theme };
}

describe("design tokens", () => {
  it("defines all presets, accents and required tokens", () => {
    expect([...presets.keys()].sort()).toEqual([...presetNames].sort());
    for (const preset of presetNames) {
      const block = presets.get(preset);
      expect(block, preset).toBeDefined();
      for (const token of tokenNames) {
        expect(block?.vars.has(token), `${preset}: --${token}`).toBe(true);
      }
      expect(block?.css).toMatch(/color-scheme\s*:\s*(light|dark)/);
    }
    for (const accent of accentNames) {
      expect(accents.has(`dark:${accent}`), `dark ${accent}`).toBe(true);
      expect(accents.has(`light:${accent}`), `light ${accent}`).toBe(true);
    }
  });

  it("keeps every preset and accent pair at WCAG AA", () => {
    const failures: string[] = [];
    for (const presetName of presetNames) {
      for (const accentName of ["auto", ...accentNames]) {
        const resolved = resolve(presetName, accentName);
        if (!resolved) {
          failures.push(`${presetName}/${accentName}: missing accent block`);
          continue;
        }
        const { vars } = resolved;
        const color = (name: string) => {
          const value = vars.get(name);
          if (!value) {
            throw new Error(`${presetName}/${accentName}: --${name} is missing`);
          }
          return parseOklch(value);
        };
        const label = `${presetName}/${accentName}`;
        const check = (name: string, a: string, b: string, min: number) => {
          const ratio = contrast(color(a), color(b));
          if (ratio < min) {
            failures.push(
              `${label}: ${name} ${ratio.toFixed(2)} < ${min.toFixed(2)}`,
            );
          }
        };
        check("foreground/background", "foreground", "background", 11);
        check("muted/background", "muted-foreground", "background", 5);
        check("faint/background", "faint-foreground", "background", 4.5);
        check("accent/background", "accent", "background", 4.5);
        check(
          "accent-foreground/accent",
          "accent-foreground",
          "accent",
          4.5,
        );
        check(
          "accent-foreground/accent-strong",
          "accent-foreground",
          "accent-strong",
          4.5,
        );
        for (const semantic of ["danger", "success", "warning"] as const) {
          check(`${semantic}/background`, semantic, "background", 4.5);
          check(
            `${semantic}-foreground/${semantic}`,
            `${semantic}-foreground`,
            semantic,
            4.5,
          );
        }
        check(
          "border-strong/background",
          "border-strong",
          "background",
          3,
        );
        // Side panels and the window chrome carry text too (A+C frame).
        for (const surface of ["surface", "chrome", "surface-raised"] as const) {
          check(`foreground/${surface}`, "foreground", surface, 11);
          check(`muted/${surface}`, "muted-foreground", surface, 4.5);
          check(`faint/${surface}`, "faint-foreground", surface, 4.5);
        }
        check("muted/surface-active", "muted-foreground", "surface-active", 4.5);
        // The presence dot is a non-text indicator: 3:1 on the panels.
        check("success/surface", "success", "surface", 3);
        check("danger/surface", "danger", "surface", 4.5);
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps initials readable on every avatar hue of every preset", () => {
    // Fills are oklch(var(--avatar-fill-l) var(--avatar-fill-c) <hue>), see
    // lib/avatar.ts; the hue list is the same eight steps.
    const hues = [28, 55, 95, 150, 195, 225, 275, 330];
    const failures: string[] = [];
    for (const presetName of presetNames) {
      const vars = presets.get(presetName)?.vars;
      const num = (name: string) => Number(vars?.get(name));
      for (const hue of hues) {
        const ratio = contrast(
          [num("avatar-ink-l"), num("avatar-ink-c"), hue],
          [num("avatar-fill-l"), num("avatar-fill-c"), hue],
        );
        if (!(ratio >= 4.5)) {
          failures.push(`${presetName}/hue ${hue}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("uses the accent on every surface, not only the page background", () => {
    // Accent text appears on cards and selected rows; a pair that only passes
    // against `--background` would still be unreadable there.
    const failures: string[] = [];
    for (const presetName of presetNames) {
      for (const accentName of ["auto", ...accentNames]) {
        const resolved = resolve(presetName, accentName);
        if (!resolved) {
          continue;
        }
        const { vars } = resolved;
        const accent = parseOklch(vars.get("accent") ?? "");
        for (const surface of [
          "chrome",
          "surface",
          "surface-raised",
          "surface-hover",
          "surface-active",
        ]) {
          const ratio = contrast(
            accent,
            parseOklch(vars.get(surface) ?? ""),
          );
          if (ratio < 4.5) {
            failures.push(
              `${presetName}/${accentName}: accent/${surface} ${ratio.toFixed(2)}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
