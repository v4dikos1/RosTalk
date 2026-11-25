import { useEffect } from "react";

import { coreApi } from "@/core";
import { DEFAULT_SETTINGS, matchesAccelerator } from "@/lib/settings";
import { useAppStore } from "@/store/appStore";
import { runCoreAction, useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * Local hotkeys (stage 2.4). Global low-level hooks belong to the voice
 * engine; here the same accelerators work while the window has focus, which
 * is enough for the palette, mute, deafen, settings and leaving a channel.
 */
export function useGlobalHotkeys(): void {
  useEffect(() => {
    function bindings() {
      return (
        useSettingsStore.getState().settings?.voice.hotkeys ??
        DEFAULT_SETTINGS.voice.hotkeys
      );
    }

    function accelerator(action: string): string | null {
      return (
        bindings().find((binding) => binding.action === action)?.accelerator ??
        null
      );
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

    function onKeyDown(event: KeyboardEvent) {
      const app = useAppStore.getState();
      if (app.paletteOpen || app.settingsOpen || app.wizardOpen) {
        return;
      }
      if (matchesAccelerator(accelerator("commandPalette"), event)) {
        event.preventDefault();
        app.openPalette();
        return;
      }
      if (matchesAccelerator(accelerator("openSettings"), event)) {
        event.preventDefault();
        app.openSettings();
        return;
      }
      if (isTyping(event.target)) {
        return;
      }
      if (matchesAccelerator(accelerator("toggleMute"), event)) {
        event.preventDefault();
        const state = useCoreStore.getState().state;
        const self = state?.users.find((user) => user.id === state.selfUserId);
        if (state?.connection === "connected" && self) {
          void runCoreAction(() =>
            coreApi.setVoiceState({ selfMuted: !self.voice.selfMuted }),
          );
        }
        return;
      }
      if (matchesAccelerator(accelerator("toggleDeafen"), event)) {
        event.preventDefault();
        const state = useCoreStore.getState().state;
        const self = state?.users.find((user) => user.id === state.selfUserId);
        if (state?.connection === "connected" && self) {
          void runCoreAction(() =>
            coreApi.setVoiceState({ selfDeafened: !self.voice.selfDeafened }),
          );
        }
        return;
      }
      if (matchesAccelerator(accelerator("leaveChannel"), event)) {
        event.preventDefault();
        void runCoreAction(() => coreApi.leaveChannel());
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
