import type {
  AppearanceAccent,
  AppearanceDensity,
  AppearanceFontScale,
  AppearancePreset,
  AppearanceRadius,
  AppearanceSettings,
  ChatBackground,
  ThemePreference,
} from "@/core/api";

/**
 * Presets in the order shown in the settings window. Stage P9 retired
 * `graphite` (it duplicated «Очаг»): the core migrates a stored value to
 * `rostalk`, and `normalizeAppearance` does the same for an older core.
 */
export const APPEARANCE_PRESETS: readonly AppearancePreset[] = [
  "rostalk",
  "paper",
  "amoled",
  "contrast",
] as const;

/** Accents in the order shown in the settings window. */
export const APPEARANCE_ACCENTS: readonly AppearanceAccent[] = [
  "auto",
  "ember",
  "ice",
  "violet",
  "moss",
  "rose",
  "mono",
] as const;

export const APPEARANCE_DENSITIES: readonly AppearanceDensity[] = [
  "comfortable",
  "compact",
] as const;

export const APPEARANCE_RADII: readonly AppearanceRadius[] = [
  "sharp",
  "default",
  "round",
] as const;

export const APPEARANCE_FONT_SCALES: readonly AppearanceFontScale[] = [
  100,
  112,
  125,
] as const;

/**
 * Stage P9 removed the feed patterns: the feed is a plain surface. `dots` and
 * `grid` still parse (older settings files) and are normalised to `none`.
 */
export const CHAT_BACKGROUNDS: readonly ChatBackground[] = ["none"] as const;

/** Each preset owns its dark/light choice; `theme` is written from this. */
export const PRESET_THEME: Record<AppearancePreset, ThemePreference> = {
  rostalk: "dark",
  graphite: "dark",
  paper: "light",
  amoled: "dark",
  contrast: "dark",
};

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  preset: "rostalk",
  accent: "auto",
  density: "comfortable",
  radius: "default",
  fontScale: 100,
  chatBackground: "none",
};

/** Theme of a preset, without trusting the stored `theme` field. */
export function presetTheme(preset: AppearancePreset): ThemePreference {
  return PRESET_THEME[preset] ?? "dark";
}

/** The preset a pre-appearance theme maps to. */
export function presetForTheme(theme: ThemePreference): AppearancePreset {
  return theme === "light" ? "paper" : "rostalk";
}

function isOneOf<T extends string | number>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return allowed.some((item) => item === value);
}

/**
 * Makes an appearance section safe to render.
 *
 * A settings file from a newer build or a damaged value must not leave the UI
 * with an unknown preset or a scale the stylesheet does not implement. A
 * missing section (an older core) is reconstructed from the saved theme.
 */
export function normalizeAppearance(
  value: Partial<AppearanceSettings> | null | undefined,
  theme: ThemePreference = "dark",
): AppearanceSettings {
  const source = value ?? {};
  return {
    preset: isOneOf(source.preset, APPEARANCE_PRESETS)
      ? source.preset
      : presetForTheme(theme),
    accent: isOneOf(source.accent, APPEARANCE_ACCENTS)
      ? source.accent
      : "auto",
    density: isOneOf(source.density, APPEARANCE_DENSITIES)
      ? source.density
      : "comfortable",
    radius: isOneOf(source.radius, APPEARANCE_RADII)
      ? source.radius
      : "default",
    fontScale: isOneOf(source.fontScale, APPEARANCE_FONT_SCALES)
      ? source.fontScale
      : 100,
    chatBackground: isOneOf(source.chatBackground, CHAT_BACKGROUNDS)
      ? source.chatBackground
      : "none",
  };
}

/** Applies a partial appearance patch and keeps every value valid. */
export function mergeAppearance(
  current: AppearanceSettings,
  patch: Partial<AppearanceSettings>,
): AppearanceSettings {
  return normalizeAppearance({ ...current, ...patch }, presetTheme(current.preset));
}
