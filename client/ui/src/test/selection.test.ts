import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guards for two P31 decisions that live in the global stylesheet: interface
 * chrome is not selectable, and interactive controls are flat (Windows 10
 * WebView2 draws a native shadow under themed buttons otherwise). The tokens
 * test next door protects contrast; this one protects the rules themselves.
 */
const css = readFileSync(path.resolve(process.cwd(), "src/index.css"), "utf8");

describe("global selection and control surface rules", () => {
  it("keeps the interface chrome unselectable but leaves values copyable", () => {
    expect(css).toMatch(/body\s*\{[^}]*user-select:\s*none;/s);
    const copyable = css.match(
      /input,\s*textarea,\s*select,\s*\[contenteditable="true"\],\s*code,\s*pre\s*\{([^}]*)\}/s,
    );
    expect(copyable?.[1]).toMatch(/user-select:\s*text;/);
  });

  it("pins buttons to the flat control-shadow token", () => {
    expect(css).toMatch(/--control-shadow:\s*0 0 #0000;/);
    const buttons = css.match(/button,\s*\[role="button"\]\s*\{([^}]*)\}/s);
    expect(buttons?.[1]).toMatch(/appearance:\s*none;/);
    expect(buttons?.[1]).toMatch(/box-shadow:\s*var\(--control-shadow\);/);
  });

  it("keeps panel elevation in its own tokens", () => {
    // The flat control rule must not swallow intentional sheet/popover depth.
    expect(css).toMatch(/--shadow-panel:\s*0 12px 32px/);
    expect(css).toMatch(/--sheet-shadow:/);
  });
});
