import { create } from "zustand";

import { coreApi } from "@/core";
import type {
  DeviceList,
  VoiceEvent,
  VoiceLevels,
  VoiceState,
  VoiceStats,
} from "@/core/api";

/**
 * Mirror of the stage 2.3 voice engine: state, levels, statistics and devices.
 *
 * The engine owns the microphone tract for the lifetime of the process; the UI
 * only reads snapshots and sends commands. Speaking is measured by the engine,
 * never received from the control plane (design 4.6).
 */
interface VoiceMirror {
  state: VoiceState | null;
  levels: VoiceLevels | null;
  stats: VoiceStats | null;
  /** Previous statistics snapshot, for per-second counter deltas. */
  previousStats: VoiceStats | null;
  devices: DeviceList | null;

  hydrate: (state: VoiceState, devices: DeviceList) => void;
  refresh: () => Promise<void>;
  apply: (event: VoiceEvent) => void;
}

export const useVoiceStore = create<VoiceMirror>()((set) => ({
  state: null,
  levels: null,
  stats: null,
  previousStats: null,
  devices: null,

  hydrate: (state, devices) => set({ state, devices }),

  refresh: async () => {
    try {
      const [state, devices] = await Promise.all([
        coreApi.getVoiceState(),
        coreApi.getVoiceDevices(),
      ]);
      set({ state, devices });
    } catch {
      // The device list is optional: a machine without audio hardware still
      // gets the full interface with an explanatory empty state.
    }
  },

  apply: (event) => {
    switch (event.type) {
      case "state":
        set({ state: event.payload });
        break;
      case "levels":
        set({ levels: event.payload });
        break;
      case "stats":
        set((current) => ({
          stats: event.payload,
          previousStats: current.stats,
        }));
        break;
      case "devices":
        set({ devices: event.payload });
        break;
    }
  },
}));

/** Media identity of a user is `<user id>:voice`; the UI knows only the id. */
export function voiceLevelForUser(
  levels: VoiceLevels | null,
  userId: number,
): { speaking: boolean; levelDb: number } | null {
  if (!levels) {
    return null;
  }
  const entry = levels.participants.find((participant) =>
    participant.identity.startsWith(`${userId}:`),
  );
  if (!entry) {
    return null;
  }
  return { speaking: entry.speaking, levelDb: entry.levelDb ?? -90 };
}

/** Starts the mirror: engine events plus one hydration call. */
export function startVoiceMirror(): () => void {
  const unsubscribe = coreApi.subscribeVoice((event) => {
    useVoiceStore.getState().apply(event);
  });
  void useVoiceStore.getState().refresh();
  return unsubscribe;
}
