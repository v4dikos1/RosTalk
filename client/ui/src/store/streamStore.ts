import { create } from "zustand";

import { coreApi, isDesktop } from "@/core";
import {
  StreamEngine,
  type StreamAudioBridge,
  type StreamEngineSnapshot,
  type StreamPresetName,
  type StreamQualityMode,
} from "@/features/streams/engine";

/**
 * Stream audio through the core (stage P15, ADR 0027). Only the desktop shell
 * has a core; the browser preview keeps the WebView audio path.
 */
const coreStreamAudio: StreamAudioBridge | undefined = isDesktop
  ? {
      start: () => coreApi.startStreamAudio(),
      stop: () => coreApi.stopStreamAudio(),
      watch: (userId, watching) => coreApi.watchStreamAudio(userId, watching),
      setVolume: (userId, volume, muted) =>
        coreApi.setStreamAudioVolume(userId, volume, muted),
    }
  : undefined;

/**
 * Mirror of the screen-share engine (stage 5.1).
 *
 * The engine owns the LiveKit room and the media tracks; the UI only reads a
 * snapshot and calls its methods. Media tokens stay in the Rust core.
 */
export const streamEngine = new StreamEngine({
  requestStreamCredentials: (channelId) =>
    coreApi.requestStreamCredentials(channelId),
  ...(coreStreamAudio ? { audio: coreStreamAudio } : {}),
  setWatching: (streamerIds) => coreApi.setWatching(streamerIds),
});

interface StreamMirror extends StreamEngineSnapshot {
  start: (options: {
    preset: StreamPresetName;
    includeAudio: boolean;
  }) => Promise<void>;
  stop: () => Promise<void>;
  watch: (userId: number) => Promise<void>;
  unwatch: (userId: number) => void;
  unwatchAll: () => void;
  setQuality: (
    userId: number,
    quality: StreamQualityMode,
    size?: { width: number; height: number },
  ) => void;
  setVisible: (visible: boolean) => Promise<void>;
  setChannel: (channelId: number) => void;
  shutdown: () => Promise<void>;
}

const initial = streamEngine.getSnapshot();

export const useStreamStore = create<StreamMirror>()(() => ({
  ...initial,
  start: async (options) => {
    await streamEngine.startLocal(options);
  },
  stop: async () => {
    await streamEngine.stopLocal();
  },
  watch: async (userId) => {
    await streamEngine.watch(userId);
  },
  unwatch: (userId) => streamEngine.unwatch(userId),
  unwatchAll: () => streamEngine.unwatchAll(),
  setQuality: (userId, quality, size) => {
    streamEngine.setQuality(userId, quality, size);
  },
  setVisible: async (visible) => {
    await streamEngine.setVisible(visible);
  },
  setChannel: (channelId) => streamEngine.setChannel(channelId),
  shutdown: async () => {
    await streamEngine.shutdown();
  },
}));

/** Starts the mirror; returns the unsubscribe function. */
export function startStreamMirror(): () => void {
  const unsubscribe = streamEngine.subscribe((snapshot) => {
    useStreamStore.setState({ ...snapshot });
  });
  if (!coreStreamAudio) {
    return unsubscribe;
  }
  // Which remote streams carry audio, and which the core plays (P15).
  const unsubscribeVoice = coreApi.subscribeVoice((event) => {
    if (event.type === "streamAudio") {
      streamEngine.setCoreAudio(event.payload);
    }
  });
  void coreApi
    .getStreamAudioState()
    .then((state) => streamEngine.setCoreAudio(state))
    .catch(() => {});
  return () => {
    unsubscribe();
    unsubscribeVoice();
  };
}
