import { describe, expect, it } from "vitest";

import type { AudioCounters, VoiceStats } from "@/core/api";

import { counterDelta, qualityFor } from "./quality";

function counters(patch: Partial<AudioCounters> = {}): AudioCounters {
  return {
    captureUnderruns: 0,
    partialCaptureFrames: 0,
    inputOverflows: 0,
    resamplerOverflows: 0,
    publishOverflows: 0,
    publishUnderruns: 0,
    playbackUnderruns: 0,
    mixerUnderruns: 0,
    trackTrims: 0,
    referenceTrims: 0,
    apmErrors: 0,
    ...patch,
  };
}

function stats(patch: Partial<VoiceStats> = {}): VoiceStats {
  return {
    pingMs: 12,
    packetLossPercent: 0.2,
    jitterMs: 6,
    audio: counters(),
    ...patch,
  };
}

const inVoice = {
  connection: "connected" as const,
  voiceChannelId: 7,
};

describe("qualityFor", () => {
  it("is offline before the first snapshot and when disconnected", () => {
    expect(
      qualityFor({
        connection: null,
        voiceChannelId: 0,
        stats: null,
        previous: null,
      }),
    ).toBe("offline");
    expect(
      qualityFor({
        connection: "disconnected",
        voiceChannelId: 0,
        stats: null,
        previous: null,
      }),
    ).toBe("offline");
  });

  it("is fair while the control connection is being established", () => {
    for (const connection of ["connecting", "reconnecting"] as const) {
      expect(
        qualityFor({
          connection,
          voiceChannelId: 0,
          stats: null,
          previous: null,
        }),
      ).toBe("fair");
    }
  });

  it("says online outside a voice channel, even with stale voice stats", () => {
    expect(
      qualityFor({
        connection: "connected",
        voiceChannelId: 0,
        stats: stats({ packetLossPercent: 40, jitterMs: 200 }),
        previous: null,
      }),
    ).toBe("online");
  });

  it("is good in a channel until the first statistics snapshot", () => {
    expect(
      qualityFor({ ...inVoice, stats: null, previous: null }),
    ).toBe("good");
  });

  it("gives the top bucket to a clean LAN session", () => {
    expect(
      qualityFor({ ...inVoice, stats: stats(), previous: null }),
    ).toBe("excellent");
    // Missing optional metrics are not treated as loss.
    expect(
      qualityFor({
        ...inVoice,
        stats: stats({
          pingMs: null,
          packetLossPercent: null,
          jitterMs: null,
        }),
        previous: null,
      }),
    ).toBe("excellent");
  });

  it("uses loss, jitter and ping for the middle and the low bucket", () => {
    expect(
      qualityFor({
        ...inVoice,
        stats: stats({ packetLossPercent: 2 }),
        previous: null,
      }),
    ).toBe("good");
    for (const bad of [
      stats({ packetLossPercent: 5 }),
      stats({ jitterMs: 40 }),
      stats({ pingMs: 200 }),
    ]) {
      expect(qualityFor({ ...inVoice, stats: bad, previous: null })).toBe("fair");
    }
  });

  it("counts playback gaps and publish overflows between snapshots", () => {
    const before = stats({ audio: counters({ playbackUnderruns: 10 }) });
    const after = stats({ audio: counters({ playbackUnderruns: 14 }) });
    expect(qualityFor({ ...inVoice, stats: after, previous: before })).toBe(
      "fair",
    );

    const overflow = stats({ audio: counters({ publishOverflows: 1 }) });
    expect(
      qualityFor({ ...inVoice, stats: overflow, previous: stats() }),
    ).toBe("fair");
  });

  it("ignores mixer starvation and counter resets", () => {
    // A silent remote participant starves the mixer by design; that is not a
    // quality problem.
    const starved = stats({ audio: counters({ mixerUnderruns: 5_000 }) });
    expect(
      qualityFor({ ...inVoice, stats: starved, previous: stats() }),
    ).toBe("excellent");

    // A restarted audio tract resets the counters to zero.
    expect(counterDelta(10, 0)).toBe(0);
    expect(counterDelta(10, 11)).toBe(1);
  });
});
