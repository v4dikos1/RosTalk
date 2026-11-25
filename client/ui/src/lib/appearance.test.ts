import { describe, expect, it } from "vitest";

import type { ClientSettings } from "@/core/api";
import {
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  presetForTheme,
  presetTheme,
} from "./appearance";
import { clampSettings, DEFAULT_SETTINGS, mergeSettings } from "./settings";

function settingsWith(
  appearance: ClientSettings["appearance"] | undefined,
  theme: ClientSettings["theme"] = "dark",
): ClientSettings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  if (appearance === undefined) {
    delete (settings as { appearance?: unknown }).appearance;
  } else {
    settings.appearance = appearance;
  }
  settings.theme = theme;
  return settings;
}

describe("appearance", () => {
  it("maps presets to the derived theme", () => {
    expect(presetTheme("rostalk")).toBe("dark");
    expect(presetTheme("paper")).toBe("light");
    expect(presetForTheme("light")).toBe("paper");
    expect(presetForTheme("dark")).toBe("rostalk");
  });

  it("reconstructs a missing section from the saved theme", () => {
    expect(normalizeAppearance(undefined, "light").preset).toBe("paper");
    expect(normalizeAppearance(null, "dark")).toEqual(DEFAULT_APPEARANCE);
  });

  it("drops unknown values instead of rendering an invalid preset", () => {
    const appearance = normalizeAppearance(
      {
        preset: "neon" as never,
        accent: "lime" as never,
        density: "wide" as never,
        radius: "square" as never,
        fontScale: 90 as never,
        chatBackground: "stripes" as never,
      },
      "light",
    );
    expect(appearance).toEqual({
      preset: "paper",
      accent: "auto",
      density: "comfortable",
      radius: "default",
      fontScale: 100,
      chatBackground: "none",
    });
  });

  it("migrates the retired graphite preset and feed patterns", () => {
    const appearance = normalizeAppearance(
      {
        ...DEFAULT_APPEARANCE,
        preset: "graphite",
        chatBackground: "dots",
      },
      "dark",
    );
    expect(appearance.preset).toBe("rostalk");
    expect(appearance.chatBackground).toBe("none");
    expect(
      normalizeAppearance({ ...DEFAULT_APPEARANCE, chatBackground: "grid" })
        .chatBackground,
    ).toBe("none");
  });

  it("derives theme and compact in clampSettings", () => {
    const clamped = clampSettings(
      settingsWith(
        {
          preset: "amoled",
          accent: "ice",
          density: "compact",
          radius: "round",
          fontScale: 125,
          chatBackground: "grid",
        },
        "light",
      ),
    );
    expect(clamped.theme).toBe("dark");
    expect(clamped.compact).toBe(true);
    expect(clamped.appearance.accent).toBe("ice");
  });

  it("fills a legacy payload without an appearance section", () => {
    const clamped = clampSettings(settingsWith(undefined, "light"));
    expect(clamped.appearance.preset).toBe("paper");
    expect(clamped.theme).toBe("light");
  });

  it("keeps the section when a patch does not touch it", () => {
    const current = clampSettings(
      settingsWith({
        preset: "paper",
        accent: "rose",
        density: "compact",
        radius: "round",
        fontScale: 112,
        chatBackground: "dots",
      }),
    );
    const next = mergeSettings(current, { locale: "en" });
    expect(next.appearance).toEqual(current.appearance);
    expect(next.theme).toBe("light");

    const merged = mergeSettings(current, {
      appearance: { accent: "moss" },
    });
    expect(merged.appearance.preset).toBe("paper");
    expect(merged.appearance.accent).toBe("moss");
    expect(merged.appearance.fontScale).toBe(112);
  });
});
