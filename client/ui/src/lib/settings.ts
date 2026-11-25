import type {
  AppearanceSettings,
  ClientSettings,
  HotkeyAction,
  HotkeyBinding,
  ParticipantSettings,
  VoiceSettings,
} from "@/core/api";
import {
  DEFAULT_APPEARANCE,
  mergeAppearance,
  normalizeAppearance,
  presetTheme,
} from "@/lib/appearance";

/** Mirrors the Rust defaults so a failed `getSettings` still renders. */
export const DEFAULT_SETTINGS: ClientSettings = {
  version: 3,
  theme: "dark",
  locale: "ru",
  compact: false,
  closeToTray: true,
  economyMode: true,
  economyModeIdleMinutes: 5,
  membersPaneOpen: true,
  onboardingComplete: false,
  nickname: "",
  defaultChannelId: null,
  selfMuted: false,
  selfDeafened: false,
  appearance: DEFAULT_APPEARANCE,
  diagnostics: { consent: "undecided" },
  updateSource: null,
  autostart: false,
  voice: {
    inputDevice: null,
    outputDevice: null,
    gate: { mode: "voiceActivation", threshold_db: -45, hold_ms: 300 },
    processing: {
      echoCancellation: true,
      noiseSuppression: true,
      noiseModel: "rnNoise",
      gainControl: false,
      highPassFilter: true,
    },
    outputVolume: 100,
    levelVoices: false,
    sounds: {
      enabled: true,
      volume: 70,
      set: "soft",
      channel: true,
      microphone: true,
      sound: true,
      streams: true,
      messages: true,
      connection: true,
      pushToTalk: false,
    },
    hotkeys: [
      { action: "pushToTalk", accelerator: "X1/X2" },
      { action: "toggleMute", accelerator: "Ctrl+Shift+M" },
      { action: "toggleDeafen", accelerator: "Ctrl+Shift+D" },
      { action: "commandPalette", accelerator: "Ctrl+K" },
      { action: "openSettings", accelerator: "Ctrl+Comma" },
      { action: "leaveChannel", accelerator: "Ctrl+Shift+L" },
    ],
  },
  participants: [],
};

/** Order in the settings window and the editor. */
export const HOTKEY_ACTIONS: HotkeyAction[] = [
  "pushToTalk",
  "toggleMute",
  "toggleDeafen",
  "commandPalette",
  "openSettings",
  "leaveChannel",
];

/**
 * Human label of a stored accelerator. The core reports push-to-talk as
 * `X1/X2`, which says nothing to most people, and `Ctrl+Comma` reads worse
 * than the key cap it represents.
 */
export function formatAccelerator(
  accelerator: string,
  mouseSideLabel = "Mouse side button (X1/X2)",
): string {
  const parts = accelerator.split("+");
  return parts
    .map((part) => {
      const value = part.trim();
      if (value === "X1/X2") {
        return mouseSideLabel;
      }
      if (value === "Comma") {
        return ",";
      }
      if (value === "Period") {
        return ".";
      }
      return value;
    })
    .join("+");
}

/**
 * "Show the wizard again" must survive until the next launch: resetting the
 * core flag immediately would open the wizard behind the still-open settings
 * dialog. The flag is UI-only and never leaves this machine.
 */
export const ONBOARDING_RESET_KEY = "rostalk.onboardingReset";

export function markOnboardingReset(): void {
  try {
    window.localStorage.setItem(ONBOARDING_RESET_KEY, "1");
  } catch {
    // A locked storage only means the wizard opens next time it is reset.
  }
}

export function takeOnboardingReset(): boolean {
  try {
    const pending = window.localStorage.getItem(ONBOARDING_RESET_KEY) === "1";
    if (pending) {
      window.localStorage.removeItem(ONBOARDING_RESET_KEY);
    }
    return pending;
  } catch {
    return false;
  }
}

/** Stable preference key: user ids are only unique per server. */
export function participantKey(
  serverId: string | null | undefined,
  userId: number,
): string {
  return `${serverId ?? "local"}:${userId}`;
}

/** A patch of the settings; the nested sections are merged, not replaced. */
export type SettingsPatch = Omit<
  Partial<ClientSettings>,
  "appearance" | "voice"
> & {
  appearance?: Partial<AppearanceSettings>;
  voice?: Partial<VoiceSettings>;
};

/** Applies a shallow patch, merging `appearance` and `voice` deeply. */
export function mergeSettings(
  current: ClientSettings,
  patch: SettingsPatch,
): ClientSettings {
  const next: ClientSettings = {
    ...current,
    ...patch,
    appearance: patch.appearance
      ? mergeAppearance(current.appearance, patch.appearance)
      : current.appearance,
    voice: patch.voice
      ? mergeVoiceSettings(current.voice, patch.voice)
      : current.voice,
  };
  return clampSettings(next);
}

/** Applies a voice patch, merging `processing` and `sounds` deeply. */
export function mergeVoiceSettings(
  current: VoiceSettings,
  patch: Partial<VoiceSettings>,
): VoiceSettings {
  return {
    ...current,
    ...patch,
    processing: patch.processing
      ? { ...current.processing, ...patch.processing }
      : current.processing,
    sounds: patch.sounds
      ? { ...current.sounds, ...patch.sounds }
      : current.sounds,
    hotkeys: patch.hotkeys ? normalizeHotkeys(patch.hotkeys) : current.hotkeys,
  };
}

/** Keeps the same invariants as the Rust store. */
export function clampSettings(settings: ClientSettings): ClientSettings {
  const gate =
    settings.voice.gate.mode === "voiceActivation"
      ? {
          mode: "voiceActivation" as const,
          threshold_db: Math.min(
            0,
            Math.max(-80, Math.round(settings.voice.gate.threshold_db ?? -45)),
          ),
          hold_ms: Math.min(2000, Math.max(0, settings.voice.gate.hold_ms ?? 300)),
        }
      : settings.voice.gate;
  const appearance = normalizeAppearance(settings.appearance, settings.theme);
  return {
    ...settings,
    // The appearance section is the source of truth; these two stay for the
    // tray, the window title and an older UI bundle.
    appearance,
    theme: presetTheme(appearance.preset),
    compact: appearance.density === "compact",
    nickname: settings.nickname.trim().slice(0, 64),
    updateSource: settings.updateSource?.trim().slice(0, 2048) || null,
    voice: {
      ...settings.voice,
      gate,
      outputVolume: Math.min(200, Math.max(0, settings.voice.outputVolume)),
      sounds: {
        ...settings.voice.sounds,
        volume: Math.min(100, Math.max(0, settings.voice.sounds.volume)),
      },
      hotkeys: normalizeHotkeys(settings.voice.hotkeys),
    },
    participants: settings.participants.map((entry) => ({
      ...entry,
      volume: Math.min(200, Math.max(0, entry.volume)),
    })),
  };
}

/** Every action exactly once, in UI order; the first binding wins a clash. */
export function normalizeHotkeys(bindings: HotkeyBinding[]): HotkeyBinding[] {
  const used: string[] = [];
  return HOTKEY_ACTIONS.map((action) => {
    const found = bindings.find((binding) => binding.action === action);
    const trimmed = found?.accelerator?.trim();
    const accelerator = trimmed ? migrateAccelerator(trimmed) : null;
    if (accelerator === null) {
      return { action, accelerator: null };
    }
    if (used.some((item) => item.toLowerCase() === accelerator.toLowerCase())) {
      return { action, accelerator: null };
    }
    used.push(accelerator);
    return { action, accelerator };
  });
}

/** Replaces one user's volume and mute without touching the rest. */
export function withParticipant(
  settings: ClientSettings,
  key: string,
  volume: number,
  muted: boolean,
): ParticipantSettings[] {
  const next = settings.participants
    .filter((entry) => entry.key !== key)
    .concat({ key, volume: Math.min(200, Math.max(0, volume)), muted })
    .sort((a, b) => a.key.localeCompare(b.key));
  return next;
}

/** Volume and mute of one user, defaulting to 100 % and unmuted. */
export function participantPreference(
  settings: ClientSettings | null,
  key: string,
): { volume: number; muted: boolean } {
  const found = settings?.participants.find((entry) => entry.key === key);
  return { volume: found?.volume ?? 100, muted: found?.muted ?? false };
}

/**
 * Layout-independent key names of the physical keys RosTalk can bind. The
 * values are the canonical accelerator names already stored in `settings.json`:
 * letters, digits and function keys are their own names, punctuation keeps the
 * names the old picker produced (`Comma`, `Period`) or the bare character it
 * produced for the remaining keys.
 */
const CODE_KEYS: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: "Comma",
  Period: "Period",
  Slash: "/",
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "NumpadEnter",
  Tab: "Tab",
  Backspace: "Backspace",
  CapsLock: "CapsLock",
  NumLock: "NumLock",
  ScrollLock: "ScrollLock",
  Insert: "Insert",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  PrintScreen: "PrintScreen",
  ContextMenu: "ContextMenu",
  NumpadAdd: "NumpadAdd",
  NumpadSubtract: "NumpadSubtract",
  NumpadMultiply: "NumpadMultiply",
  NumpadDivide: "NumpadDivide",
  NumpadDecimal: "NumpadDecimal",
  Numpad0: "Numpad0",
  Numpad1: "Numpad1",
  Numpad2: "Numpad2",
  Numpad3: "Numpad3",
  Numpad4: "Numpad4",
  Numpad5: "Numpad5",
  Numpad6: "Numpad6",
  Numpad7: "Numpad7",
  Numpad8: "Numpad8",
  Numpad9: "Numpad9",
};

/**
 * ЙЦУКЕН letter on the same physical key as a QWERTY one (playtest-1, P4).
 * A saved `Ctrl+Л` was recorded from the character, not from the key, and is
 * unusable in the English layout. The values are canonical accelerator names.
 */
export const YCUKEN_TO_QWERTY: Record<string, string> = {
  й: "Q",
  ц: "W",
  у: "E",
  к: "R",
  е: "T",
  н: "Y",
  г: "U",
  ш: "I",
  щ: "O",
  з: "P",
  х: "[",
  ъ: "]",
  ф: "A",
  ы: "S",
  в: "D",
  а: "F",
  п: "G",
  р: "H",
  о: "J",
  л: "K",
  д: "L",
  ж: ";",
  э: "'",
  я: "Z",
  ч: "X",
  с: "C",
  м: "V",
  и: "B",
  т: "N",
  ь: "M",
  б: "Comma",
  ю: "Period",
  ё: "`",
};

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/**
 * Canonical key name of a `KeyboardEvent.code`, which does not depend on the
 * active layout: `KeyK` stays `K` while `event.key` says `л`.
 */
export function keyFromCode(code: string): string | null {
  if (!code) {
    return null;
  }
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) {
    return letter[1] ?? null;
  }
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) {
    return digit[1] ?? null;
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    return code;
  }
  return CODE_KEYS[code] ?? null;
}

/** Canonical spelling of a bare Cyrillic key recorded before physical keys. */
function latinKey(value: string): string {
  if (value.length !== 1) {
    return value;
  }
  return YCUKEN_TO_QWERTY[value.toLowerCase()] ?? value;
}

/**
 * Key of a keyboard event, independent of the layout.
 *
 * `code` is the physical key and is always present in WebView2. The character
 * fallback keeps synthetic events (tests, some IMEs) working; a Cyrillic
 * character is mapped to the QWERTY key in the same place.
 */
export function physicalKey(event: {
  code?: string;
  key: string;
}): string | null {
  const code = event.code?.trim();
  if (code) {
    if (MODIFIER_CODES.has(code) || code === "Escape") {
      return null;
    }
    const physical = keyFromCode(code);
    if (physical !== null) {
      return physical;
    }
  }
  if (!event.key || MODIFIER_KEYS.has(event.key) || event.key === "Escape") {
    return null;
  }
  return latinKey(canonicalKey(event.key));
}

/**
 * Rewrites a saved accelerator to the physical key: `Ctrl+Л` -> `Ctrl+K`.
 *
 * The migration runs on every load (`normalizeHotkeys`), so a settings file
 * written before P4 becomes usable without the user rebinding it.
 */
export function migrateAccelerator(accelerator: string): string {
  const trimmed = accelerator.trim();
  const separator = trimmed.lastIndexOf("+");
  const modifiers = separator === -1 ? "" : trimmed.slice(0, separator + 1);
  const key = separator === -1 ? trimmed : trimmed.slice(separator + 1);
  if (!key) {
    return trimmed;
  }
  return `${modifiers}${latinKey(key)}`;
}

/** Canonical accelerator of a keyboard or mouse event. */
export function acceleratorFromEvent(event: {
  code?: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): string | null {
  const key = physicalKey(event);
  if (key === null) {
    return null;
  }
  const parts: string[] = [];
  if (event.ctrlKey) {
    parts.push("Ctrl");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.metaKey) {
    parts.push("Meta");
  }
  parts.push(key);
  return parts.join("+");
}

/** Canonical accelerator of a mouse button (0 = left, 1 = middle, 2 = right). */
export function acceleratorFromMouse(button: number): string | null {
  if (button < 3) {
    return null;
  }
  // Browser numbering: 3 = back, 4 = forward; call them Mouse4/Mouse5 like
  // the usual gaming mice.
  return `Mouse${button + 1}`;
}

function canonicalKey(key: string): string {
  if (key === " ") {
    return "Space";
  }
  if (key === ",") {
    return "Comma";
  }
  if (key === ".") {
    return "Period";
  }
  if (key.length === 1) {
    return key.toUpperCase();
  }
  return key;
}

/** True when a keyboard event matches an accelerator on its physical key. */
export function matchesAccelerator(
  accelerator: string | null,
  event: {
    key: string;
    code?: string;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  },
): boolean {
  if (!accelerator) {
    return false;
  }
  const parts = accelerator.split("+");
  const key = parts.pop();
  if (!key) {
    return false;
  }
  const ctrl = parts.includes("Ctrl");
  const shift = parts.includes("Shift");
  const alt = parts.includes("Alt");
  const meta = parts.includes("Meta");
  if (
    ctrl !== event.ctrlKey ||
    shift !== event.shiftKey ||
    alt !== event.altKey ||
    meta !== event.metaKey
  ) {
    return false;
  }
  const eventKey = physicalKey(event);
  return eventKey !== null && eventKey.toLowerCase() === key.toLowerCase();
}
