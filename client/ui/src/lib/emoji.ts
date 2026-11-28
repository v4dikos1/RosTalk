/**
 * Emoji search over the generated Unicode set.
 *
 * The generated module (`emojiData`) is large and is loaded lazily by the
 * picker; this module only holds the types and pure filters, so importing it
 * never pulls the data into the initial bundle. Names and keywords are data,
 * not interface copy: the picker shows only the glyph and localizes the
 * category labels through i18n.
 */
import type { EmojiEntry, EmojiGroup } from "./emojiData";

export type { EmojiEntry, EmojiGroup };

/** The generated data, passed in by the picker after its dynamic import. */
export interface EmojiSource {
  readonly groups: readonly EmojiGroup[];
  readonly keywords: readonly (readonly string[])[];
}

/** One glyph with its resolved keywords and category. */
export interface EmojiMatch {
  readonly char: string;
  readonly keywords: readonly string[];
  readonly groupId: string;
  readonly groupIndex: number;
}

/** Resolves the keyword pool slot of one generated entry. */
export function emojiKeywords(
  entry: EmojiEntry,
  keywords: EmojiSource["keywords"],
): readonly string[] {
  return keywords[entry[1]] ?? [];
}

/** Entries of one group, in the Unicode emoji-test order. */
export function groupEmoji(
  group: EmojiGroup,
  keywords: EmojiSource["keywords"],
  groupIndex = 0,
): EmojiMatch[] {
  return group.entries.map((entry) => ({
    char: entry[0],
    keywords: emojiKeywords(entry, keywords),
    groupId: group.id,
    groupIndex,
  }));
}

/**
 * Filters across all groups by glyph or by a Russian/English keyword.
 *
 * An empty query returns the whole set; the picker only calls this with a
 * non-empty query and shows the active category tab otherwise.
 */
export function filterEmoji(
  query: string,
  source: EmojiSource,
): EmojiMatch[] {
  const needle = query.trim().toLowerCase();
  const result: EmojiMatch[] = [];
  source.groups.forEach((group, groupIndex) => {
    for (const entry of group.entries) {
      const char = entry[0];
      if (
        char === needle ||
        (needle.length > 0 &&
          emojiKeywords(entry, source.keywords).some((keyword) =>
            keyword.includes(needle),
          ))
      ) {
        result.push({
          char,
          keywords: emojiKeywords(entry, source.keywords),
          groupId: group.id,
          groupIndex,
        });
      }
    }
  });
  return result;
}
