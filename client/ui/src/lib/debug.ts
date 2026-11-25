import type {
  AppearanceAccent,
  AppearanceDensity,
  AppearanceFontScale,
  AppearancePreset,
  AppearanceRadius,
  ChatBackground,
  ClientSettings,
} from "@/core/api";
import type { SettingsSection } from "@/store/appStore";
import {
  APPEARANCE_ACCENTS,
  APPEARANCE_FONT_SCALES,
  APPEARANCE_PRESETS,
  CHAT_BACKGROUNDS,
  normalizeAppearance,
  presetForTheme,
  presetTheme,
} from "@/lib/appearance";

/**
 * Query-string overrides for the component gallery and Playwright screenshots.
 * They are read in every build, but the desktop window never has a query
 * string, so production behaviour is unchanged.
 */
export interface DebugFlags {
  onboarding: boolean;
  hosting: boolean;
  settingsSection: SettingsSection | null;
  /** Standalone server administration dialog (old `settings=server`). */
  serverSettings: boolean;
  /** Saved-server list, normally opened from the profile menu. */
  serverList: boolean;
  palette: boolean;
  userMenuUserId: number | null;
  /** Prefilled invitation link for the onboarding screenshots. */
  link: string | null;
  gate: string | null;
  channelId: number | null;
  view: "chat" | "streams" | null;
  /** Open a direct conversation, for screenshots. */
  dmPeerId: number | null;
  /** Show the developer gallery link in the settings window. */
  gallery: boolean;
}

function params(): URLSearchParams {
  if (typeof window === "undefined") {
    return new URLSearchParams();
  }
  return new URLSearchParams(window.location.search);
}

function oneOf(
  value: string | null,
  allowed: readonly (string | number)[],
): boolean {
  return value !== null && allowed.some((item) => String(item) === value);
}

/** Applies theme, appearance, language and density overrides to a snapshot. */
export function applyDebugSettings(settings: ClientSettings): ClientSettings {
  const query = params();
  const theme = query.get("theme");
  const preset = query.get("preset");
  const accent = query.get("accent");
  const radius = query.get("radius");
  const scale = query.get("scale");
  const background = query.get("background");
  const lang = query.get("lang");
  const compact = query.get("compact");
  const gate = query.get("gate");

  let nextPreset: AppearancePreset | undefined = oneOf(
    preset,
    APPEARANCE_PRESETS,
  )
    ? (preset as AppearancePreset)
    : undefined;
  if (!nextPreset && (theme === "light" || theme === "dark")) {
    nextPreset = presetForTheme(theme);
  }
  const appearance = normalizeAppearance(
    {
      ...settings.appearance,
      ...(nextPreset ? { preset: nextPreset } : {}),
      ...(oneOf(accent, APPEARANCE_ACCENTS)
        ? { accent: accent as AppearanceAccent }
        : {}),
      ...(oneOf(radius, ["sharp", "default", "round"] as const)
        ? { radius: radius as AppearanceRadius }
        : {}),
      ...(oneOf(scale, APPEARANCE_FONT_SCALES)
        ? { fontScale: Number(scale) as AppearanceFontScale }
        : {}),
      ...(oneOf(background, CHAT_BACKGROUNDS)
        ? { chatBackground: background as ChatBackground }
        : {}),
      ...(compact === "1" || compact === "0"
        ? {
            density: (compact === "1"
              ? "compact"
              : "comfortable") as AppearanceDensity,
          }
        : {}),
    },
    settings.theme,
  );

  return {
    ...settings,
    appearance,
    theme: presetTheme(appearance.preset),
    compact: appearance.density === "compact",
    locale: lang === "ru" || lang === "en" ? lang : settings.locale,
    voice:
      gate === "pushToTalk" || gate === "continuous"
        ? { ...settings.voice, gate: { mode: gate } }
        : gate === "voiceActivation"
          ? {
              ...settings.voice,
              gate: {
                mode: "voiceActivation",
                threshold_db: -45,
                hold_ms: 300,
              },
            }
          : settings.voice,
  };
}

/** UI-only flags for screenshots. */
export function readDebugFlags(): DebugFlags {
  const query = params();
  const section = query.get("settings");
  const userMenu = query.get("userMenu");
  const userId = userMenu ? Number.parseInt(userMenu, 10) : Number.NaN;
  const channel = query.get("channel");
  const channelId = channel ? Number.parseInt(channel, 10) : Number.NaN;
  const view = query.get("view");
  const dm = query.get("dm");
  const dmPeerId = dm ? Number.parseInt(dm, 10) : Number.NaN;
  return {
    onboarding: query.has("onboarding") || query.has("wizard"),
    hosting: query.has("hosting"),
    settingsSection:
      section === "profile" ||
      section === "general" ||
      section === "appearance" ||
      section === "voice" ||
      section === "hotkeys" ||
      section === "identity" ||
      section === "about"
        ? section
        : null,
    serverSettings: section === "server" || query.has("serverSettings"),
    serverList: query.has("serverList"),
    palette: query.has("palette"),
    userMenuUserId: Number.isFinite(userId) ? userId : null,
    link: query.get("link"),
    gate: query.get("gate"),
    channelId: Number.isFinite(channelId) ? channelId : null,
    // `view=members` was the voice-channel tab before P8. The pane on the
    // right replaced it; old screenshot URLs now open the chat of the channel.
    view: view === "chat" || view === "streams" ? view : null,
    dmPeerId: Number.isFinite(dmPeerId) ? dmPeerId : null,
    gallery: query.has("gallery") || query.has("galleryLink"),
  };
}
