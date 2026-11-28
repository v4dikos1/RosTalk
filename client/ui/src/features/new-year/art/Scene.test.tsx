import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Ornament, ornamentUrls } from "./Ornament";
import { growthScale, isWithinCrown, Scene } from "./Scene";

describe("New Year art", () => {
  it("maps every sprite locally and falls back for unknown and inherited ids", () => {
    expect(Object.keys(ornamentUrls).sort()).toEqual(readdirSync(resolve("src/assets/newyear/ornaments")).map((name) => name.replace(/\.webp$/, "")).sort());
    expect(Object.keys(ornamentUrls)).toHaveLength(16);
    for (const id of Object.keys(ornamentUrls)) {
      const { unmount } = render(<Ornament itemId={id} locale="en" />);
      expect(screen.getByRole("img")).toHaveAttribute("src", expect.stringContaining(`${id}.webp`));
      unmount();
    }
    render(<Ornament itemId="toString" locale="ru" />);
    const fallback = screen.getByRole("img", { name: "Неизвестная игрушка" });
    expect(fallback).not.toHaveTextContent("?");
    expect(fallback.querySelector("svg")).not.toBeNull();
  });
  it("uses the six growth stages and exact crown boundary", () => {
    expect([0, 1, 7, 8, 15, 16, 23, 24, 30, 31].map(growthScale)).toEqual([.5, .6, .6, .7, .7, .8, .8, .92, .92, 1]);
    expect(isWithinCrown(523, 140)).toBe(true);
    expect(isWithinCrown(524, 140)).toBe(false);
    expect(isWithinCrown(500, 139)).toBe(false);
    expect(isWithinCrown(500, 931)).toBe(false);
    expect(isWithinCrown(145, 930)).toBe(true);
    expect(isWithinCrown(144, 930)).toBe(false);
    expect(isWithinCrown(855, 930)).toBe(true);
    expect(isWithinCrown(856, 930)).toBe(false);
  });
  it("preserves overlap order, read-only mode and optional selection", () => {
    const placements = ["ball-red", "ball-blue"].map((itemId) => ({ itemId, x: 500, y: 600, scale: 100, rotation: 0 }));
    const select = vi.fn();
    const { container, rerender } = render(<Scene growthDays={8} background="aurora" placements={placements} locale="en" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect([...container.querySelectorAll(".ny-placement img")].map((img) => img.getAttribute("alt"))).toEqual(["Red bauble", "Blue bauble"]);
    rerender(<Scene growthDays={8} background="aurora" placements={placements} locale="en" onSelect={select} />);
    fireEvent.click(screen.getByRole("button", { name: "Blue bauble" }));
    expect(select).toHaveBeenCalledWith(1);
  });
});

