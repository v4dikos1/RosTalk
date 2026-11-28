#!/usr/bin/env node
/* global Buffer, console, fetch, process */
/**
 * Fetch Noto Color Emoji for the bundled client font (P33).
 *
 * Source: https://fonts.googleapis.com/css2?family=Noto+Color+Emoji
 * Generated assets: src/assets/fonts/noto-emoji/emoji-font.css and the
 * `noto-emoji-NN.woff2` subsets it points to.
 *
 * Why a local copy: the client must render the full Unicode 18 emoji set the
 * same way on Windows 10 and Windows 11. Windows 10 ships Segoe UI Emoji from
 * the Emoji 12 era and knows nothing about later glyphs, so the system font is
 * not enough. The CSP allows `font-src 'self'` only, so the woff2 files are
 * committed and served from the bundle; there is no runtime network request
 * and no CDN. The font is licensed under the SIL OFL 1.1 (OFL.txt next to the
 * files).
 *
 * Google Fonts splits the family into unicode-range subsets. This script asks
 * for the same CSS a current Chrome would get, keeps every `@font-face`, and
 * rewrites the remote urls to stable local names. Re-run it to refresh the
 * subsets:
 *
 *   node scripts/fetch-emoji-font.mjs
 *
 * Only Node built-ins are used: the UI has no tooling dependency for this and
 * must not grow one. The generation date is written into the CSS header.
 *
 * One face is maintained by hand: `noto-emoji-1f46a.woff2` covers U+1F46A,
 * which Google's ranges skip. It lives outside the generated CSS and the
 * cleanup below intentionally only removes `noto-emoji-NN.woff2` files.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://fonts.googleapis.com/css2?family=Noto+Color+Emoji";

// A current desktop Chrome UA makes Google Fonts answer with woff2 subsets
// (the Chromium in WebView2 understands them). The exact version does not
// change the layout of the answer; it only picks the modern format.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

const FAMILY = "RosTalk Emoji";
const FONT_FACE = /@font-face\s*\{([^}]*)\}/g;

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../src/assets/fonts/noto-emoji");
const cssPath = path.join(outDir, "emoji-font.css");

/** Reads one declaration out of an `@font-face` body. */
function declaration(body, name) {
  const match = body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`, "i"));
  return match?.[1].trim() ?? null;
}

/** Parses the Google Fonts answer into font-face records. */
export function parseFontFaces(css) {
  const faces = [];
  for (const match of css.matchAll(FONT_FACE)) {
    const body = match[1];
    const source = body.match(/url\((['"]?)(https:\/\/[^)'"]+)\1\)/i);
    if (!source || !source[2].includes(".woff2")) {
      continue;
    }
    const unicodeRange = declaration(body, "unicode-range");
    if (!unicodeRange) {
      throw new Error(`@font-face without unicode-range: ${body.trim()}`);
    }
    faces.push({
      url: source[2],
      unicodeRange,
      fontStyle: declaration(body, "font-style") ?? "normal",
      fontWeight: declaration(body, "font-weight") ?? "400",
    });
  }
  return faces;
}

/** `noto-emoji-00.woff2`, `noto-emoji-01.woff2`, ... */
function localName(index) {
  return `noto-emoji-${String(index).padStart(2, "0")}.woff2`;
}

async function download(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
  });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const response = await fetch(SOURCE_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/css,*/*;q=0.1",
    },
  });
  if (!response.ok) {
    throw new Error(`Google Fonts answered ${response.status}`);
  }
  const source = await response.text();
  const faces = parseFontFaces(source);
  if (faces.length === 0) {
    throw new Error(`No woff2 @font-face rules in the answer from ${SOURCE_URL}`);
  }

  await mkdir(outDir, { recursive: true });

  let total = 0;
  for (const [index, face] of faces.entries()) {
    const file = localName(index);
    const bytes = await download(face.url);
    await writeFile(path.join(outDir, file), bytes);
    total += bytes.length;
    console.log(`${file}  ${(bytes.length / 1024).toFixed(1)} KiB`);
    console.log(`  from ${face.url}`);
  }

  // A refresh must not leave an old subset behind: the CSS below is the list.
  const expected = new Set(faces.map((_, index) => localName(index)));
  for (const entry of await readdir(outDir)) {
    if (/^noto-emoji-\d+\.woff2$/.test(entry) && !expected.has(entry)) {
      await rm(path.join(outDir, entry));
      console.log(`removed stale ${entry}`);
    }
  }

  const generated = new Date().toISOString().slice(0, 10);
  const rules = faces
    .map((face, index) => {
      return [
        "@font-face {",
        `  font-family: "${FAMILY}";`,
        `  font-style: ${face.fontStyle};`,
        `  font-weight: ${face.fontWeight};`,
        "  font-display: swap;",
        `  src: url("./${localName(index)}") format("woff2");`,
        `  unicode-range: ${face.unicodeRange};`,
        "}",
      ].join("\n");
    })
    .join("\n\n");

  const css = `/*
 * Noto Color Emoji (Google LLC, SIL OFL 1.1, OFL.txt in this directory).
 * Generated by scripts/fetch-emoji-font.mjs; do not edit by hand.
 *
 * Source: ${SOURCE_URL}
 * Generated: ${generated}
 * Subsets: ${faces.length} woff2 files, ${(total / 1024 / 1024).toFixed(2)} MiB total.
 *
 * The client bundles this font locally (CSP: font-src 'self') so the full
 * Unicode emoji set looks the same on Windows 10 (Segoe UI Emoji stops at
 * Emoji 12) and Windows 11. The family is a text fallback right after Golos
 * Text in --font-sans: Golos covers letters, this font covers emoji.
 */
${rules}
`;

  await writeFile(cssPath, css, "utf8");
  console.log(`\nwrote ${path.relative(process.cwd(), cssPath)}`);
  console.log(`${faces.length} subsets, ${(total / 1024 / 1024).toFixed(2)} MiB`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
