import type {
  AppearanceSettings,
  ClientSettings,
  HotkeyAction,
  HotkeyBinding,
  ParticipantSettings,
  PluginSettings,
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
  version: 4,
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
  plugins: { newYear: "absent" },
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
    activationThresholdDb: -45,
    levelVoices: true,
    backgroundHotkeys: false,
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
  "appearance" | "plugins" | "voice"
> & {
  appearance?: Partial<AppearanceSettings>;
  plugins?: Partial<PluginSettings>;
  voice?: Partial<VoiceSettings>;
};

/** Applies a patch while preserving unchanged nested settings. */
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
    plugins: { ...current.plugins, ...patch.plugins },
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
  // While voice activation is active its threshold is the source of truth;
  // otherwise the separate field remembers it for the next switch (P25).
  const activationThresholdDb =
    gate.mode === "voiceActivation"
      ? gate.threshold_db
      : Math.min(
          0,
          Math.max(-80, Math.round(settings.voice.activationThresholdDb ?? -45)),
        );
  const appearance = normalizeAppearance(settings.appearance, settings.theme);
  const newYear = settings.plugins?.newYear;
  return {
    ...settings,
    // The appearance section is the source of truth; these two stay for the
    // tray, the window title and an older UI bundle.
    appearance,
    plugins: {
      newYear: newYear === "enabled" || newYear === "disabled" ? newYear : "absent",
    },
    theme: presetTheme(appearance.preset),
    compact: appearance.density === "compact",
    nickname: settings.nickname.trim().slice(0, 64),
    updateSource: settings.updateSource?.trim().slice(0, 2048) || null,
    voice: {
      ...settings.voice,
      gate,
      activationThresholdDb,
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
    const occupants = acceleratorOccupants(accelerator);
    if (occupants.some((input) => used.includes(input))) {
      return { action, accelerator: null };
    }
    used.push(...occupants);
    return { action, accelerator };
  });
}

/**
 * Physical inputs one accelerator claims. `X1/X2` is the side-button pair, so
 * it occupies both `Mouse4` and `Mouse5`; a single side button occupies one.
 * Keyboard accelerators occupy their own name.
 *
 * Push-to-talk's implicit side buttons are deliberately not claimed: an
 * explicit mute/deafen binding on `Mouse4` wins over the default pair, and the
 * engine keeps the remaining button for push-to-talk (stage P24).
 */
export function acceleratorOccupants(accelerator: string): string[] {
  const value = accelerator.trim();
  if (/^x1\/x2$/i.test(value)) {
    return ["mouse4", "mouse5"];
  }
  if (/^(mouse4|x1)$/i.test(value)) {
    return ["mouse4"];
  }
  if (/^(mouse5|x2)$/i.test(value)) {
    return ["mouse5"];
  }
  return [value.toLowerCase()];
}

/**
 * True when the accelerator is a modifier combination. A combination needs the
 * explicit `backgroundHotkeys` opt-in to work while another window is focused.
 */
export function needsBackgroundOptIn(accelerator: string | null): boolean {
  return accelerator?.includes("+") === true;
}

/**
 * Assigns one accelerator, last edit wins.
 *
 * A clash clears the other action. When the new binding takes one side button
 * from the push-to-talk pair, push-to-talk keeps the other button instead of
 * losing the pair entirely; assigning a whole pair takes both buttons back.
 */
export function assignHotkey(
  bindings: HotkeyBinding[],
  action: HotkeyAction,
  accelerator: string | null,
): HotkeyBinding[] {
  const occupants = accelerator ? acceleratorOccupants(accelerator) : [];
  const next = bindings.map((binding) => {
    if (binding.action === action || !binding.accelerator) {
      return { ...binding };
    }
    const other = acceleratorOccupants(binding.accelerator);
    if (!other.some((input) => occupants.includes(input))) {
      return { ...binding };
    }
    if (
      binding.action === "pushToTalk" &&
      /^x1\/x2$/i.test(binding.accelerator) &&
      (occupants.includes("mouse4") || occupants.includes("mouse5"))
    ) {
      const takesX1 = occupants.includes("mouse4");
      const takesX2 = occupants.includes("mouse5");
      return {
        ...binding,
        accelerator: takesX1 && !takesX2 ? "Mouse5" : takesX2 && !takesX1 ? "Mouse4" : null,
      };
    }
    return { ...binding, accelerator: null };
  });
  const target = next.find((binding) => binding.action === action);
  if (target) {
    target.accelerator = accelerator;
  } else {
    next.push({ action, accelerator });
  }
  return normalizeHotkeys(next);
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

/**
 * True when a mouse event matches an accelerator on a side button.
 *
 * Browser button 3 is the first side button (X1, the settings name `Mouse4`),
 * 4 is the second (X2, `Mouse5`). Left, middle and right are not offered by
 * the picker and are not matched here.
 */
export function matchesMouseAccelerator(
  accelerator: string | null,
  button: number,
): boolean {
  if (!accelerator) {
    return false;
  }
  const value = accelerator.trim().toLowerCase();
  if (value === "x1/x2") {
    return button === 3 || button === 4;
  }
  const x1 = value === "mouse4" || value === "x1";
  const x2 = value === "mouse5" || value === "x2";
  return (x1 && button === 3) || (x2 && button === 4);
}
