import { create } from "zustand";

import { coreApi } from "@/core";
import type { ClientSettings, CoreError, VoiceSettings } from "@/core/api";
import { asCoreError } from "@/lib/coreError";
import { applyDebugSettings } from "@/lib/debug";
import {
  DEFAULT_SETTINGS,
  clampSettings,
  mergeSettings,
  takeOnboardingReset,
  withParticipant,
  type SettingsPatch,
} from "@/lib/settings";

/**
 * Mirror of the settings owned by the core (stage 2.4 requirement 8).
 *
 * Writes are optimistic so sliders stay responsive, then serialized: two
 * quick changes cannot reorder the persisted file. The core sanitises the
 * value and the reply replaces the optimistic copy.
 */
interface SettingsMirror {
  settings: ClientSettings | null;
  loaded: boolean;
  error: CoreError | null;
  /** Last successfully persisted settings, used to roll back a failure. */
  hydrate: () => Promise<void>;
  update: (patch: SettingsPatch) => Promise<void>;
  updateVoice: (patch: Partial<VoiceSettings>) => Promise<void>;
  setParticipant: (key: string, volume: number, muted: boolean) => Promise<void>;
  completeOnboarding: (nickname: string) => Promise<void>;
  resetOnboarding: () => Promise<void>;
  replaceLocal: (settings: ClientSettings) => void;
}

let writeChain: Promise<void> = Promise.resolve();

function setAndSync(next: ClientSettings) {
  useSettingsStore.setState({ settings: next, error: null });
}

export const useSettingsStore = create<SettingsMirror>()((set, get) => ({
  settings: null,
  loaded: false,
  error: null,

  hydrate: async () => {
    try {
      const remote = await coreApi.getSettings();
      let settings = applyDebugSettings(clampSettings(remote));
      // The settings screen asked for the wizard on the next launch.
      if (takeOnboardingReset()) {
        try {
          settings = clampSettings(await coreApi.resetOnboarding());
        } catch {
          // Keep the loaded settings; the button can be pressed again.
        }
      }
      set({ settings, loaded: true, error: null });
    } catch (error) {
      // A broken settings file must not block the interface; the defaults are
      // the same values the Rust core uses.
      set({
        settings: applyDebugSettings(structuredClone(DEFAULT_SETTINGS)),
        loaded: true,
        error: asCoreError(error),
      });
    }
  },

  update: async (patch) => {
    const current = get().settings;
    if (!current) {
      return;
    }
    const next = mergeSettings(current, patch);
    setAndSync(next);
    await enqueue(next, next.voice, set);
  },

  updateVoice: async (patch) => {
    const current = get().settings;
    if (!current) {
      return;
    }
    const next = mergeSettings(current, { voice: { ...current.voice, ...patch } });
    setAndSync(next);
    await enqueue(next, next.voice, set);
  },

  setParticipant: async (key, volume, muted) => {
    const current = get().settings;
    if (!current) {
      return;
    }
    const participants = withParticipant(current, key, volume, muted);
    setAndSync({ ...current, participants });
    try {
      const saved = await coreApi.setParticipantPreference(key, volume, muted);
      const latest = get().settings;
      if (latest) {
        set({ settings: { ...latest, participants: saved }, error: null });
      }
    } catch (error) {
      set({ error: asCoreError(error) });
    }
  },

  completeOnboarding: async (nickname) => {
    try {
      const saved = await coreApi.completeOnboarding(nickname);
      set({ settings: clampSettings(saved), loaded: true, error: null });
    } catch (error) {
      set({ error: asCoreError(error) });
    }
  },

  resetOnboarding: async () => {
    try {
      const saved = await coreApi.resetOnboarding();
      set({ settings: clampSettings(saved), error: null });
    } catch (error) {
      set({ error: asCoreError(error) });
    }
  },

  replaceLocal: (settings) => set({ settings: clampSettings(settings) }),
}));

async function enqueue(
  next: ClientSettings,
  _voice: VoiceSettings,
  set: (partial: Partial<SettingsMirror>) => void,
): Promise<void> {
  writeChain = writeChain.then(async () => {
    try {
      const saved = await coreApi.updateSettings(next);
      const latest = useSettingsStore.getState().settings;
      // Keep newer optimistic edits that happened while the write was running.
      if (latest && latest !== next) {
        useSettingsStore.setState({ settings: { ...latest }, error: null });
      } else {
        useSettingsStore.setState({ settings: clampSettings(saved), error: null });
      }
    } catch (error) {
      set({ error: asCoreError(error) });
      // The core rejected the value: resynchronise instead of keeping a
      // configuration that was never persisted.
      void useSettingsStore.getState().hydrate();
    }
  });
  await writeChain;
}
