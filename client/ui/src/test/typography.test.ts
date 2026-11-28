import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Typography guard for the unslop pass.
 *
 * The client used to carry fourteen ad-hoc font sizes between 8.5 and 13.5 px.
 * The scale is now seven steps (10/11/12/13/14/15/18) plus the 8 px avatar
 * initials, and every size below 10 px is a readability regression. Scanning
 * the sources keeps a stray `text-[9.5px]` from creeping back in review.
 */

const root = path.resolve(process.cwd(), "src");
const SCALE = new Set([10, 11, 12, 13, 14, 15, 18]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return /\.(tsx?|ts)$/.test(entry.name) ? [full] : [];
  });
}

const files = sourceFiles(root).filter(
  (file) => !/\.test\.tsx?$/.test(file), // Tests quote what they assert about.
);

/**
 * Generated data is not hand-written UI: emoji keywords legitimately contain
 * words such as "uppercase" (the CLDR annotation of 🔠), and scanning them
 * would turn the typography guard into a false positive.
 */
const isGenerated = (relative: string) => relative === "lib/emojiData.ts";

describe("typography", () => {
  it("uses only the seven-step scale, with 8 px allowed for initials", () => {
    const unexpected: string[] = [];
    for (const file of files) {
      const relative = path.relative(root, file).replaceAll("\\", "/");
      if (isGenerated(relative)) {
        continue;
      }
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          for (const match of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
            const size = Number(match[1]);
            const initials =
              relative === "components/common/UserAvatar.tsx" &&
              line.includes("sm: \"size-5");
            if (!SCALE.has(size) && !(size === 8 && initials)) {
              unexpected.push(`${relative}:${index + 1}: ${match[0]}`);
            }
          }
        });
    }
    expect(unexpected).toEqual([]);
  });

  it("uses sentence case instead of uppercase tracked labels", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(root, file).replaceAll("\\", "/");
      if (isGenerated(relative)) {
        continue;
      }
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (line.includes("uppercase")) {
            offenders.push(`${relative}:${index + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it("keeps a looping pulse only in the chat skeleton", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(root, file).replaceAll("\\", "/");
      if (isGenerated(relative)) {
        continue;
      }
      if (relative === "components/chat/MessageList.tsx") {
        continue;
      }
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (line.includes("animate-pulse")) {
            offenders.push(`${relative}:${index + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
