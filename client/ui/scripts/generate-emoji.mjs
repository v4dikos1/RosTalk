#!/usr/bin/env node
/* global URL, console, fetch, process */
/**
 * Generates `src/lib/emojiData.ts` from the pinned Unicode and CLDR sources.
 *
 * Node only, no npm packages: the file is generated at development time and
 * committed, so the application never fetches emoji data at runtime. Re-run
 * with `node scripts/generate-emoji.mjs` when the sources move; the script
 * prints the URLs and the generation date it writes into the header.
 */

const SOURCES = {
  emojiTest: "https://unicode.org/Public/emoji/latest/emoji-test.txt",
  ru: "https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-annotations-full/annotations/ru/annotations.json",
  en: "https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-annotations-full/annotations/en/annotations.json",
  // Flags and other derived annotations live in a separate CLDR package.
  derivedRu: "https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-annotations-derived-full/annotationsDerived/ru/annotations.json",
  derivedEn: "https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-annotations-derived-full/annotationsDerived/en/annotations.json",
};

const OUTPUT = new URL("../src/lib/emojiData.ts", import.meta.url);

/** Stable ids of the emoji-test groups; the picker labels them through i18n. */
const GROUP_IDS = {
  "Smileys & Emotion": "smileys",
  "People & Body": "people",
  "Animals & Nature": "nature",
  "Food & Drink": "food",
  "Travel & Places": "travel",
  "Activities": "activities",
  "Objects": "objects",
  "Symbols": "symbols",
  "Flags": "flags",
};

/** Components (skin-tone swatches, hair) are not standalone picker entries. */
const EXCLUDED_GROUPS = new Set(["Component"]);

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.text();
}

/**
 * CLDR keys and emoji-test sequences disagree on the variation selector, and
 * the same emoji may also be keyed without it. Comparing codepoint arrays with
 * U+FE0F removed makes both sides meet.
 */
function normalizeSequence(text) {
  return [...text]
    .filter((codePoint) => codePoint !== "\uFE0F")
    .join("");
}

/**
 * The CLDR full annotation uses `default` for the keyword list and `tts` for
 * the spoken name; some distributions also expose `keywords`. Merge all of
 * them so search works in both languages.
 */
function annotationWords(annotation) {
  if (!annotation || typeof annotation !== "object") {
    return [];
  }
  const words = [];
  for (const value of [annotation.default, annotation.tts, annotation.keywords]) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const word of value) {
      if (typeof word === "string") {
        words.push(word);
      }
    }
  }
  return words;
}

/**
 * Both the direct and the derived annotation trees carry usable keywords.
 *
 * The CLDR file wraps its map as `{ annotations: { identity, annotations } }`;
 * a plain `{ <glyph>: annotation }` tree is accepted too.
 */
function collectAnnotations(json) {
  const bySequence = new Map();
  const trees = [
    json.annotations?.annotations ?? json.annotations,
    json.annotationsDerived?.annotations ?? json.annotationsDerived,
  ];
  for (const tree of trees) {
    if (!tree || typeof tree !== "object") {
      continue;
    }
    for (const [glyph, annotation] of Object.entries(tree)) {
      if (glyph === "identity") {
        continue;
      }
      const key = normalizeSequence(glyph);
      const merged = bySequence.get(key) ?? [];
      merged.push(...annotationWords(annotation));
      bySequence.set(key, merged);
    }
  }
  return bySequence;
}

/**
 * Base annotations win on a glyph that has usable words; derived annotations
 * (flags, region names) fill the glyphs the base package does not describe.
 * CLDR keeps them in `cldr-annotations-derived-full`, a separate download.
 */
function mergeAnnotations(base, derived) {
  const merged = new Map(base);
  for (const [glyph, words] of derived) {
    if ((merged.get(glyph) ?? []).length === 0) {
      merged.set(glyph, words);
    }
  }
  return merged;
}

function parseEmojiTest(text) {
  const groups = [];
  let version = "unknown";
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    const versionMatch = /^# Version: (.+)$/.exec(line);
    if (versionMatch) {
      version = versionMatch[1].trim();
      continue;
    }
    const groupMatch = /^# group: (.+)$/.exec(line);
    if (groupMatch) {
      const name = groupMatch[1].trim();
      if (EXCLUDED_GROUPS.has(name)) {
        current = null;
        continue;
      }
      const id = GROUP_IDS[name] ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      current = { id, entries: [] };
      groups.push(current);
      continue;
    }
    if (line.startsWith("# subgroup:")) {
      continue;
    }
    if (!line || line.startsWith("#")) {
      continue;
    }

    const [sequencePart, statusPart] = line.split(";");
    if (!sequencePart || !statusPart) {
      continue;
    }
    if (!/^\s*fully-qualified\b/.test(statusPart)) {
      continue;
    }
    const glyph = String.fromCodePoint(
      ...sequencePart
        .trim()
        .split(/\s+/)
        .map((hex) => Number.parseInt(hex, 16)),
    );
    if (!current || !glyph) {
      continue;
    }
    current.entries.push(glyph);
  }

  return { version, groups };
}

const SKIN_TONE_MODIFIERS = new Set([
  "\u{1F3FB}",
  "\u{1F3FC}",
  "\u{1F3FD}",
  "\u{1F3FE}",
  "\u{1F3FF}",
]);

/** Drops skin-tone modifiers so variants can reuse the base emoji keywords. */
function withoutSkinTone(sequence) {
  return [...sequence]
    .filter((codePoint) => !SKIN_TONE_MODIFIERS.has(codePoint))
    .join("");
}

function mergeKeywords(glyph, ru, en) {
  const key = normalizeSequence(glyph);
  const baseKey = withoutSkinTone(key);
  const pick = (map) => {
    const own = map.get(key) ?? [];
    if (own.length > 0 || baseKey === key) {
      return own;
    }
    return map.get(baseKey) ?? [];
  };
  const words = new Set();
  for (const word of [...pick(ru), ...pick(en)]) {
    const normalized = word.trim().toLowerCase();
    if (normalized) {
      words.add(normalized);
    }
  }
  return [...words];
}

function render({ version, groups }, ru, en) {
  const date = new Date().toISOString().slice(0, 10);
  const total = groups.reduce((sum, group) => sum + group.entries.length, 0);

  // Identical keyword lists are shared through a pool: skin-tone variants copy
  // their base emoji's words, and writing them inline would multiply the file.
  const keywords = [[]];
  const keywordIndex = new Map([["[]", 0]]);
  const indexedGroups = groups.map((group) => ({
    id: group.id,
    entries: group.entries.map((glyph) => {
      const words = mergeKeywords(glyph, ru, en);
      const serialized = JSON.stringify(words);
      let index = keywordIndex.get(serialized);
      if (index === undefined) {
        index = keywords.length;
        keywords.push(words);
        keywordIndex.set(serialized, index);
      }
      return [glyph, index];
    }),
  }));

  const lines = [
    "/**",
    " * Generated emoji data. Do not edit by hand:",
    " * `node scripts/generate-emoji.mjs` in `client/ui`.",
    " *",
    ` * Sources (pinned):`,
    ` *   ${SOURCES.emojiTest}`,
    ` *   ${SOURCES.ru}`,
    ` *   ${SOURCES.en}`,
    ` *   ${SOURCES.derivedRu}`,
    ` *   ${SOURCES.derivedEn}`,
    ` * Unicode Emoji version: ${version}`,
    ` * Generated: ${date}`,
    ` * Entries: ${total} fully-qualified glyphs, components excluded.`,
    " */",
    "",
    "export interface EmojiGroup {",
    "  readonly id: string;",
    "  readonly entries: readonly EmojiEntry[];",
    "}",
    "",
    "/** `[glyph, index into EMOJI_KEYWORDS]`; data only, no behaviour. */",
    "export type EmojiEntry = readonly [char: string, keywordIndex: number];",
    "",
    "/** Lowercase ru/en search keywords, shared between related glyphs. */",
    "export const EMOJI_KEYWORDS: readonly (readonly string[])[] = [",
  ];

  for (const words of keywords) {
    lines.push(`  ${JSON.stringify(words)},`);
  }
  lines.push("];", "");

  lines.push("export const EMOJI_GROUPS: readonly EmojiGroup[] = [");
  for (const group of indexedGroups) {
    lines.push("  {");
    lines.push(`    id: ${JSON.stringify(group.id)},`);
    lines.push("    entries: [");
    for (const [glyph, index] of group.entries) {
      lines.push(`      [${JSON.stringify(glyph)}, ${index}],`);
    }
    lines.push("    ],");
    lines.push("  },");
  }

  lines.push("];", "");
  return lines.join("\n");
}

async function main() {
  const [emojiTestText, ruText, enText, ruDerivedText, enDerivedText] =
    await Promise.all([
      fetchText(SOURCES.emojiTest),
      fetchText(SOURCES.ru),
      fetchText(SOURCES.en),
      fetchText(SOURCES.derivedRu),
      fetchText(SOURCES.derivedEn),
    ]);
  const emoji = parseEmojiTest(emojiTestText);
  const ru = mergeAnnotations(
    collectAnnotations(JSON.parse(ruText)),
    collectAnnotations(JSON.parse(ruDerivedText)),
  );
  const en = mergeAnnotations(
    collectAnnotations(JSON.parse(enText)),
    collectAnnotations(JSON.parse(enDerivedText)),
  );
  const output = render(emoji, ru, en);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(OUTPUT, output, "utf8");
  const count = emoji.groups.reduce((sum, group) => sum + group.entries.length, 0);
  console.log(
    `wrote ${OUTPUT.pathname} — ${count} entries in ${emoji.groups.length} groups, Unicode Emoji ${emoji.version}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
