import { expect, it } from "vitest";
import { clampCrown, isWithinCrown, validRotation } from "./placement";

it("clamps to the server crown boundary", () => {
  expect(isWithinCrown(523, 140)).toBe(true);
  expect(isWithinCrown(524, 140)).toBe(false);
  expect(isWithinCrown(500, 139)).toBe(false);
  for (const [x, y] of [[0, 0], [1000, 1000], [0, 930], [1000, 140]]) {
    const p = clampCrown(x!, y!);
    expect(isWithinCrown(p.x, p.y)).toBe(true);
  }
});
it("accepts only integer server rotation bounds", () => {
  expect([-46, 46, 0.5, NaN].map(validRotation)).toEqual([false, false, false, false]);
  expect([-45, 0, 45].map(validRotation)).toEqual([true, true, true]);
});
