import { create } from "zustand";

import { coreApi } from "@/core";
import type {
  ClientSettings,
  CoreError,
  NewYearPluginState,
  VoiceSettings,
} from "@/core/api";
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
  /** Last New Year state confirmed by the core. */
  persistedNewYear: NewYearPluginState;
  /** A pending enable waits for persistence while an optimistic off acts immediately. */
  newYearUpdatePending: boolean;
  hydrate: () => Promise<void>;
  update: (patch: SettingsPatch) => Promise<void>;
  updateVoice: (patch: Partial<VoiceSettings>) => Promise<void>;
  setParticipant: (key: string, volume: number, muted: boolean) => Promise<void>;
  completeOnboarding: (nickname: string) => Promise<void>;
  resetOnboarding: () => Promise<void>;
  replaceLocal: (settings: ClientSettings) => void;
}

let writeChain: Promise<void> = Promise.resolve();
let pendingNewYear: ClientSettings | null = null;

function setAndSync(next: ClientSettings) {
  useSettingsStore.setState({ settings: next, error: null });
}

export const useSettingsStore = create<SettingsMirror>()((set, get) => ({
  settings: null,
  loaded: false,
  error: null,
  persistedNewYear: "absent",
  newYearUpdatePending: false,

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
      set({
        settings,
        persistedNewYear: settings.plugins.newYear,
        loaded: true,
        error: null,
      });
    } catch (error) {
      // A broken settings file must not block the interface; the defaults are
      // the same values the Rust core uses.
      set({
        settings: applyDebugSettings(structuredClone(DEFAULT_SETTINGS)),
        persistedNewYear: "absent",
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
    const newYear = patch.plugins?.newYear;
    if (newYear !== undefined) {
      pendingNewYear = next;
    }
    set({ settings: next, newYearUpdatePending: pendingNewYear !== null, error: null });
    await enqueue(next, newYear);
  },

  updateVoice: async (patch) => {
    const current = get().settings;
    if (!current) {
      return;
    }
    const next = mergeSettings(current, { voice: { ...current.voice, ...patch } });
    setAndSync(next);
    await enqueue(next);
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
  newYear?: NewYearPluginState,
): Promise<void> {
  writeChain = writeChain.then(async () => {
    const { getState, setState } = useSettingsStore;
    try {
      // A queued edit to another setting must not retry a rejected enable.
      const remote = await coreApi.updateSettings({
        ...next,
        plugins: { newYear: newYear ?? getState().persistedNewYear },
      });
      const saved = clampSettings(remote);
      const latest = getState().settings;
      if (pendingNewYear === next) {
        pendingNewYear = null;
      }
      // Keep newer optimistic edits that happened while the write was running.
      setState({
        settings: latest && latest !== next ? latest : saved,
        persistedNewYear: saved.plugins.newYear,
        newYearUpdatePending: pendingNewYear !== null,
        error: null,
      });
    } catch (error) {
      const failure = asCoreError(error);
      setState({ error: failure });
      const remote = await coreApi.getSettings().catch(() => null);
      const latest = getState();
      const saved = remote ? applyDebugSettings(clampSettings(remote)) : null;
      const persistedNewYear = saved?.plugins.newYear ?? latest.persistedNewYear;
      if (pendingNewYear === next) {
        pendingNewYear = null;
      }
      let settings = latest.settings;
      if (settings === next && saved) {
        settings = saved;
      } else if (settings && pendingNewYear === null && settings.plugins.newYear !== persistedNewYear) {
        settings = { ...settings, plugins: { newYear: persistedNewYear } };
      }
      setState({
        settings,
        persistedNewYear,
        newYearUpdatePending: pendingNewYear !== null,
        error: failure,
      });
    }
  });
  await writeChain;
}
