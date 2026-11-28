import type { GlobalInputStatus, HotkeyAction } from "@/core/api";

/** The three actions whose effective scope the keys settings show. */
export type ScopedHotkeyAction = Extract<
  HotkeyAction,
  "pushToTalk" | "toggleMute" | "toggleDeafen"
>;

export const SCOPED_ACTIONS: readonly ScopedHotkeyAction[] = [
  "pushToTalk",
  "toggleMute",
  "toggleDeafen",
];

export type HotkeyScope = "global" | "window" | "unset" | "unavailable";

const MODIFIERS = new Set(["ctrl", "control", "shift", "alt", "meta", "win"]);

export function isScopedAction(
  action: HotkeyAction,
): action is ScopedHotkeyAction {
  return (SCOPED_ACTIONS as readonly string[]).includes(action);
}

/**
 * A binding must end in a real key, not only in modifiers: `Ctrl+Shift` can be
 * captured by the editor but neither the core nor the window can fire it.
 */
export function isUsableAccelerator(
  accelerator: string | null | undefined,
): boolean {
  const value = accelerator?.trim();
  if (!value) {
    return false;
  }
  const key = value.split("+").at(-1)?.trim().toLowerCase() ?? "";
  return key.length > 0 && !MODIFIERS.has(key);
}

interface HotkeyScopeInput {
  action: ScopedHotkeyAction;
  accelerator: string | null | undefined;
  globalInput: GlobalInputStatus | null | undefined;
}

/**
 * Effective scope of one background action (P33), mirroring the core's
 * `action_scopes`:
 *
 * - `global` — Raw Input reports this action installed. A chord reaches this
 *   state only after the explicit `backgroundHotkeys` opt-in.
 * - `window` — the focused-window handler owns it: a mute/deafen chord without
 *   the opt-in (ADR 0012), or a toggle binding the registration did not
 *   deliver.
 * - `unset` / `unavailable` — no binding, or a binding that cannot fire.
 *
 * Push-to-talk has no window fallback (`useGlobalHotkeys.runAction` returns
 * false for it), so unless Raw Input confirms it, the badge is `unavailable`.
 * That includes the `unknown` hook and a missing status snapshot: the keys
 * section waits for the core's install report instead of promising an
 * in-window PTT that the code never handles.
 */
export function hotkeyScope({
  action,
  accelerator,
  globalInput,
}: HotkeyScopeInput): HotkeyScope {
  if (!accelerator?.trim()) {
    return "unset";
  }
  if (!isUsableAccelerator(accelerator)) {
    return "unavailable";
  }
  if (globalInput?.registered === true && globalInput[action]) {
    return "global";
  }
  if (action === "pushToTalk") {
    // Raw Input is the only owner of push-to-talk.
    return "unavailable";
  }
  return "window";
}
