import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guards the bundled emoji font (P33).
 *
 * Windows 10 WebView2 ships Segoe UI Emoji from the Emoji 12 generation, so
 * the client carries Noto Color Emoji locally and puts the family right after
 * Golos Text. The CSP is `font-src 'self'`: every url() in the generated CSS
 * must resolve to a committed woff2 file, and nothing may point at a CDN.
 */
const src = path.resolve(process.cwd(), "src");
const indexCss = readFileSync(path.join(src, "index.css"), "utf8");
const fontDir = path.join(src, "assets/fonts/noto-emoji");
const generatedCss = readFileSync(path.join(fontDir, "emoji-font.css"), "utf8");
const indexCssWithoutComments = indexCss.replace(/\/\*[\s\S]*?\*\//g, "");

const faces = [...generatedCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(
  (match) => match[1] ?? "",
);

function declaration(body: string, name: string): string | null {
  return (
    body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`, "i"))?.[1]?.trim() ?? null
  );
}

/** True when `codepoint` falls inside a `unicode-range` value. */
function covers(unicodeRange: string, codepoint: number): boolean {
  return unicodeRange.split(",").some((part) => {
    const bounds = part.trim().replace(/^U\+/i, "").split("-");
    const from = parseInt(bounds[0] ?? "", 16);
    const to = bounds.length > 1 ? parseInt(bounds[1] ?? "", 16) : from;
    return codepoint >= from && codepoint <= to;
  });
}

describe("bundled emoji font", () => {
  it("imports the generated font CSS after Tailwind and before any rule", () => {
    const tailwindAt = indexCss.indexOf('@import "tailwindcss";');
    const emojiAt = indexCss.indexOf(
      '@import "./assets/fonts/noto-emoji/emoji-font.css";',
    );
    expect(tailwindAt).toBeGreaterThanOrEqual(0);
    expect(emojiAt).toBeGreaterThan(tailwindAt);
    // CSS requires @import first; the generated sheet must not land after a
    // normal rule such as @custom-variant.
    expect(emojiAt).toBeLessThan(indexCss.indexOf("@custom-variant"));
  });

  it('puts "RosTalk Emoji" right after "Golos Text" in --font-sans', () => {
    // Drop comments: the prose above the import also mentions --font-sans:.
    const fontSans = indexCssWithoutComments
      .match(/--font-sans:\s*([^;]+);/s)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
    expect(fontSans).toMatch(/^"Golos Text", "RosTalk Emoji",/);
    // Text keeps Golos first; the emoji family is a fallback, not a replacement.
    expect(fontSans).toMatch(/^"Golos Text"/);
  });

  it("keeps every generated url local and backed by a committed woff2", () => {
    // No runtime network: a remote url would be blocked by the CSP anyway.
    expect(generatedCss).not.toMatch(/url\((?:'|")?https?:/i);

    const urls = [
      ...generatedCss.matchAll(/url\("\.\/(noto-emoji-\d{2}\.woff2)"\)/g),
    ].map((match) => match[1] ?? "");
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls).size).toBe(urls.length);

    const committed = readdirSync(fontDir).filter((file) =>
      /^noto-emoji-\d{2}\.woff2$/.test(file),
    );
    expect([...committed].sort()).toEqual([...urls].sort());

    for (const file of urls) {
      const filePath = path.join(fontDir, file);
      const bytes = readFileSync(filePath);
      expect(bytes.length, file).toBeGreaterThan(0);
      // woff2 magic, so the response was a font and not an error page.
      expect(bytes.subarray(0, 4).toString("ascii"), file).toBe("wOF2");
    }
  });

  it("declares every face as the RosTalk Emoji family with swapped display", () => {
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(declaration(face, "font-family")).toBe('"RosTalk Emoji"');
      expect(declaration(face, "font-display")).toBe("swap");
      expect(declaration(face, "unicode-range")).not.toBeNull();
    }
  });

  it("covers the post-Emoji-12 glyph used by the browser check", () => {
    // 🫠 U+1FAE0 (melting face, Emoji 14) is unknown to the Windows 10 font.
    expect(
      faces.some((face) =>
        covers(declaration(face, "unicode-range") ?? "", 0x1fae0),
      ),
    ).toBe(true);
  });

  it("fills the U+1F46A gap with a committed local single-glyph face", () => {
    // 👪 U+1F46A is in emojiData, but Google's ranges jump from
    // U+1F466-1F469 to U+1F46B, so a local subset has to cover it.
    const fallback = indexCssWithoutComments.match(
      /@font-face\s*\{[^}]*noto-emoji-1f46a\.woff2[^}]*\}/s,
    )?.[0];
    expect(fallback, "U+1F46A @font-face in index.css").toBeTruthy();
    expect(declaration(fallback ?? "", "font-family")).toBe('"RosTalk Emoji"');
    expect(declaration(fallback ?? "", "font-style")).toBe("normal");
    expect(declaration(fallback ?? "", "font-weight")).toBe("400");
    expect(declaration(fallback ?? "", "font-display")).toBe("swap");
    expect(declaration(fallback ?? "", "unicode-range")).toBe("U+1F46A");
    expect(fallback).toContain(
      'url("./assets/fonts/noto-emoji/noto-emoji-1f46a.woff2") format("woff2")',
    );

    const file = path.join(fontDir, "noto-emoji-1f46a.woff2");
    const bytes = readFileSync(file);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("wOF2");

    // The point of the face: the Google subsets really do skip the codepoint.
    expect(
      faces.some((face) =>
        covers(declaration(face, "unicode-range") ?? "", 0x1f46a),
      ),
    ).toBe(false);
    // And the generated sheet must not own it, or a font refresh would drop it.
    expect(generatedCss).not.toContain("1f46a");
  });

  it("records the source and generation date in the generated header", () => {
    expect(generatedCss).toMatch(
      /Source: https:\/\/fonts\.googleapis\.com\/css2\?family=Noto\+Color\+Emoji/,
    );
    expect(generatedCss).toMatch(/Generated: \d{4}-\d{2}-\d{2}/);
    expect(generatedCss).toMatch(/SIL OFL 1\.1/);
  });
});
