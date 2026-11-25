import { describe, expect, it } from "vitest";

import { roleNameStyle } from "./roles";

describe("roleNameStyle", () => {
  it("mixes a role colour with the theme foreground", () => {
    expect(roleNameStyle("#e0a030")).toEqual({
      color: "color-mix(in oklch, #e0a030 75%, var(--foreground))",
    });
  });

  it("ignores a missing or malformed colour", () => {
    expect(roleNameStyle(null)).toBeUndefined();
    expect(roleNameStyle("")).toBeUndefined();
    expect(roleNameStyle("red; background: url(x)")).toBeUndefined();
    expect(roleNameStyle("#fff")).toBeUndefined();
  });
});
