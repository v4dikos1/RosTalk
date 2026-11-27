import { describe, expect, it } from "vitest";

import { COMPOSER_MAX_HEIGHT, composerMetrics } from "./composer";

describe("composer height", () => {
  it("grows with the content and does not overflow a single line", () => {
    expect(composerMetrics(32)).toEqual({ height: 32, overflowing: false });
    expect(composerMetrics(80)).toEqual({ height: 80, overflowing: false });
  });

  it("keeps the one-pixel tolerance of WebView2 on Windows 10", () => {
    expect(composerMetrics(COMPOSER_MAX_HEIGHT + 1)).toEqual({
      height: COMPOSER_MAX_HEIGHT,
      overflowing: false,
    });
  });

  it("caps the height and only then allows a scrollbar", () => {
    expect(composerMetrics(COMPOSER_MAX_HEIGHT + 2)).toEqual({
      height: COMPOSER_MAX_HEIGHT,
      overflowing: true,
    });
    expect(composerMetrics(400).height).toBe(COMPOSER_MAX_HEIGHT);
  });
});
