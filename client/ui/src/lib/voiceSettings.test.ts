import { describe, expect, it } from "vitest";

import { clampSettings, DEFAULT_SETTINGS } from "./settings";

/**
 * Stage P25: the voice-activation threshold must survive a switch to
 * push-to-talk or continuous mode, and quiet voices are leveled by default.
 */
describe("voice settings after the playtest", () => {
  it("levels incoming voices by default", () => {
    expect(DEFAULT_SETTINGS.voice.levelVoices).toBe(true);
    expect(DEFAULT_SETTINGS.voice.activationThresholdDb).toBe(-45);
  });

  it("keeps the activation threshold while another gate mode is selected", () => {
    const pushToTalk = structuredClone(DEFAULT_SETTINGS);
    pushToTalk.voice.gate = { mode: "pushToTalk" };
    pushToTalk.voice.activationThresholdDb = -61;
    const clamped = clampSettings(pushToTalk);
    expect(clamped.voice.activationThresholdDb).toBe(-61);

    const continuous = structuredClone(clamped);
    continuous.voice.gate = { mode: "continuous" };
    expect(clampSettings(continuous).voice.activationThresholdDb).toBe(-61);
  });

  it("takes the threshold from voice activation while it is active", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.voice.gate = {
      mode: "voiceActivation",
      threshold_db: -58,
      hold_ms: 300,
    };
    // A stale separate value must not win over the active gate.
    settings.voice.activationThresholdDb = -30;
    expect(clampSettings(settings).voice.activationThresholdDb).toBe(-58);
  });
});
