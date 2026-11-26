import { useEffect } from "react";

import { coreApi } from "@/core";
import type { HotkeyAction } from "@/core/api";
import { DEFAULT_SETTINGS, matchesAccelerator, matchesMouseAccelerator } from "@/lib/settings";
import { useAppStore } from "@/store/appStore";
import { runCoreAction, useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useVoiceStore } from "@/store/voiceStore";

/**
 * Window-local hotkeys and the focused-window half of the global ones.
 *
 * Push-to-talk, mute and deafen also run in the background through Raw Input
 * (`src-tauri/src/ptt.rs`, ADR 0012); here the same accelerators — including
 * modifier combinations, which cannot be global without polling the keyboard —
 * work while the RosTalk window has focus.
 *
 * One action per deliberate press: a held key must not toggle mute on every
 * auto-repeat, and the keys held at the moment focus leaves are forgotten so
 * the next press is not swallowed.
 */
export function useGlobalHotkeys(): void {
  useEffect(() => {
    function bindings() {
      return (
        useSettingsStore.getState().settings?.voice.hotkeys ??
        DEFAULT_SETTINGS.voice.hotkeys
      );
    }

    function accelerator(action: HotkeyAction): string | null {
      return (
        bindings().find((binding) => binding.action === action)?.accelerator ??
        null
      );
    }

    /**
     * True when the Raw Input layer owns this action on this machine. The core
     * reports each action separately: an invalid push-to-talk binding must not
     * make a valid mute/deafen toggle look window-only. A combination is global
     * only after the explicit `backgroundHotkeys` opt-in; otherwise the window
     * handler owns it.
     */
    function handledGlobally(action: HotkeyAction): boolean {
      const global = useVoiceStore.getState().state?.globalInput;
      if (!global?.registered) {
        return false;
      }
      switch (action) {
        case "pushToTalk":
          return global.pushToTalk;
        case "toggleMute":
          return global.toggleMute;
        case "toggleDeafen":
          return global.toggleDeafen;
        default:
          return false;
      }
    }

    function isTyping(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      return (
        target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT"
      );
    }

    /**
     * Runs one action if the server state allows it. A moderator mute/deafen
     * and the idle channel (ADR 0009) are stronger than a local shortcut, so
     * the toggle is ignored instead of fighting the server.
     */
    function runAction(action: HotkeyAction): boolean {
      if (action === "pushToTalk") {
        // The background router owns push-to-talk; a local copy would fight it.
        return false;
      }
      if (action === "commandPalette") {
        useAppStore.getState().openPalette();
        return true;
      }
      if (action === "openSettings") {
        useAppStore.getState().openSettings();
        return true;
      }
      const state = useCoreStore.getState().state;
      if (state?.connection !== "connected") {
        return false;
      }
      if (action === "leaveChannel") {
        void runCoreAction(() => coreApi.leaveChannel());
        return true;
      }
      const self = state.users.find((user) => user.id === state.selfUserId);
      if (!self) {
        return false;
      }
      const idleChannel =
        state.channels.find((channel) => channel.id === self.channelId)?.afk ===
        true;
      if (action === "toggleMute") {
        if (self.voice.serverMuted || idleChannel) {
          return false;
        }
        void runCoreAction(() => coreApi.toggleVoiceState("mute"));
        return true;
      }
      if (action === "toggleDeafen") {
        if (self.voice.serverDeafened) {
          return false;
        }
        void runCoreAction(() => coreApi.toggleVoiceState("deafen"));
        return true;
      }
      return false;
    }

    /** Keys currently down, so auto-repeat is not a new press. */
    const held = new Set<string>();

    function isBlocked(): boolean {
      const app = useAppStore.getState();
      return app.paletteOpen || app.settingsOpen || app.wizardOpen;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (isBlocked()) {
        return;
      }
      const id = event.code || event.key;
      if (held.has(id) || event.repeat) {
        return;
      }
      if (matchesAccelerator(accelerator("commandPalette"), event)) {
        event.preventDefault();
        held.add(id);
        runAction("commandPalette");
        return;
      }
      if (matchesAccelerator(accelerator("openSettings"), event)) {
        event.preventDefault();
        held.add(id);
        runAction("openSettings");
        return;
      }
      if (isTyping(event.target)) {
        return;
      }
      for (const action of [
        "toggleMute",
        "toggleDeafen",
        "leaveChannel",
      ] as const) {
        if (handledGlobally(action)) {
          continue;
        }
        if (matchesAccelerator(accelerator(action), event)) {
          event.preventDefault();
          held.add(id);
          runAction(action);
          return;
        }
      }
    }

    function onKeyUp(event: KeyboardEvent) {
      held.delete(event.code || event.key);
    }

    function clearHeld() {
      held.clear();
    }

    function onMouseDown(event: MouseEvent) {
      if (isBlocked()) {
        return;
      }
      for (const action of [
        "toggleMute",
        "toggleDeafen",
        "leaveChannel",
      ] as const) {
        if (handledGlobally(action)) {
          continue;
        }
        if (matchesMouseAccelerator(accelerator(action), event.button)) {
          event.preventDefault();
          event.stopPropagation();
          runAction(action);
          return;
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousedown", onMouseDown);
    // A release that happens after focus left never reaches this window; a
    // stale "held" entry would swallow the next press.
    window.addEventListener("blur", clearHeld);
    document.addEventListener("visibilitychange", clearHeld);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("blur", clearHeld);
      document.removeEventListener("visibilitychange", clearHeld);
    };
  }, []);
}
