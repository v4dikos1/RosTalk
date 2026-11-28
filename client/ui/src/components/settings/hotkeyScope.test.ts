import { describe, expect, it } from "vitest";

import type { GlobalInputStatus } from "@/core/api";

import { hotkeyScope, isUsableAccelerator } from "./hotkeyScope";

function globalInput(
  overrides: Partial<GlobalInputStatus> = {},
): GlobalInputStatus {
  return {
    registered: true,
    keyboardCaptured: false,
    pushToTalk: false,
    toggleMute: false,
    toggleDeafen: false,
    ...overrides,
  };
}

describe("hotkeyScope", () => {
  it("keeps an empty binding unset for every action", () => {
    for (const action of ["pushToTalk", "toggleMute", "toggleDeafen"] as const) {
      expect(
        hotkeyScope({ action, accelerator: null, globalInput: globalInput() }),
      ).toBe("unset");
      expect(
        hotkeyScope({ action, accelerator: "  ", globalInput: globalInput() }),
      ).toBe("unset");
    }
  });

  it("marks a modifiers-only binding unusable", () => {
    expect(isUsableAccelerator("Ctrl+Shift")).toBe(false);
    expect(isUsableAccelerator("Ctrl+Shift+M")).toBe(true);
    expect(isUsableAccelerator("X1/X2")).toBe(true);
    expect(
      hotkeyScope({
        action: "toggleMute",
        accelerator: "Ctrl+Shift",
        globalInput: globalInput(),
      }),
    ).toBe("unavailable");
  });

  it("has no window fallback for push-to-talk without a confirmed install", () => {
    for (const global of [
      globalInput(),
      globalInput({ registered: false, pushToTalk: true }),
      null,
      undefined,
    ]) {
      expect(
        hotkeyScope({
          action: "pushToTalk",
          accelerator: "Ctrl+Shift+P",
          globalInput: global,
        }),
      ).toBe("unavailable");
    }
  });

  it("reports push-to-talk background only when Raw Input confirms it", () => {
    expect(
      hotkeyScope({
        action: "pushToTalk",
        accelerator: "X1/X2",
        globalInput: globalInput({ pushToTalk: true }),
      }),
    ).toBe("global");
  });

  it("keeps a mute or deafen chord window-only until it is installed", () => {
    for (const action of ["toggleMute", "toggleDeafen"] as const) {
      expect(
        hotkeyScope({
          action,
          accelerator: "Ctrl+Shift+M",
          globalInput: globalInput(),
        }),
      ).toBe("window");
      expect(
        hotkeyScope({
          action,
          accelerator: "Ctrl+Shift+M",
          globalInput: globalInput({ registered: false }),
        }),
      ).toBe("window");
    }
  });

  it("reports mute and deafen background when the registration delivers them", () => {
    expect(
      hotkeyScope({
        action: "toggleMute",
        accelerator: "Ctrl+Shift+M",
        globalInput: globalInput({ toggleMute: true }),
      }),
    ).toBe("global");
    expect(
      hotkeyScope({
        action: "toggleDeafen",
        accelerator: "F9",
        globalInput: globalInput({ toggleDeafen: true }),
      }),
    ).toBe("global");
  });
});
