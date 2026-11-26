import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { coreApi } from "@/core";
import type { VoiceState } from "@/core/api";
import { i18n } from "@/i18n";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useVoiceStore } from "@/store/voiceStore";

import { useGlobalHotkeys } from "./useGlobalHotkeys";

/** The hook has no markup; the stores are the observable result. */
function Harness() {
  useGlobalHotkeys();
  return null;
}

function press(init: KeyboardEventInit) {
  fireEvent.keyDown(window, init);
}

function bind(action: string, accelerator: string | null) {
  const settings = structuredClone(fixtureSettings);
  settings.voice.hotkeys = settings.voice.hotkeys.map((binding) =>
    binding.action === action ? { ...binding, accelerator } : binding,
  );
  useSettingsStore.setState({ settings, loaded: true, error: null });
}

function voiceWithHook(
  hook: VoiceState["pushToTalk"]["hook"],
  global?: Partial<VoiceState["globalInput"]>,
) {
  const registered = hook === "active";
  useVoiceStore.setState({
    state: {
      media: "idle",
      publishing: false,
      publishAllowed: false,
      channelId: 0,
      selfMuted: false,
      deafened: false,
      micTest: false,
      gate: { mode: "voiceActivation", threshold_db: -45, hold_ms: 300 },
      pushToTalk: { hook, binding: "X1/X2", error: null },
      globalInput: {
        registered,
        keyboardCaptured: false,
        pushToTalk: registered,
        toggleMute: registered,
        toggleDeafen: registered,
        ...global,
      },
      inputDevice: null,
      outputDevice: null,
      error: null,
    },
    levels: null,
    stats: null,
    previousStats: null,
    devices: null,
  });
}

describe("useGlobalHotkeys", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    useSettingsStore.setState({
      settings: structuredClone(fixtureSettings),
      loaded: true,
      error: null,
    });
    useCoreStore.setState({ state: structuredClone(fixtureState) });
    voiceWithHook("active");
    useAppStore.setState({
      paletteOpen: false,
      settingsOpen: false,
      wizardOpen: false,
    });
    vi.restoreAllMocks();
  });

  it("opens the palette with Ctrl+K in the Russian layout", () => {
    render(<Harness />);

    // Windows reports the physical key in `code` and the Cyrillic character in
    // `key`; playtest-1 showed the shortcut ignoring the second one.
    press({ code: "KeyK", key: "л", ctrlKey: true });

    expect(useAppStore.getState().paletteOpen).toBe(true);
  });

  it("opens the palette with Ctrl+K in the English layout", () => {
    render(<Harness />);

    press({ code: "KeyK", key: "k", ctrlKey: true });

    expect(useAppStore.getState().paletteOpen).toBe(true);
  });

  it("still ignores an unbound key", () => {
    render(<Harness />);

    press({ code: "KeyJ", key: "о", ctrlKey: true });

    expect(useAppStore.getState().paletteOpen).toBe(false);
  });

  it("opens the settings window with Ctrl+Comma in the Russian layout", () => {
    render(<Harness />);

    press({ code: "Comma", key: "б", ctrlKey: true });

    expect(useAppStore.getState().settingsOpen).toBe(true);
  });

  it("toggles a window-local chord once per press, not on every auto-repeat", () => {
    const toggleVoiceState = vi
      .spyOn(coreApi, "toggleVoiceState")
      .mockResolvedValue(undefined);
    bind("toggleMute", "Ctrl+F8");
    // A combination without the background opt-in is delivered here.
    voiceWithHook("active", {
      registered: true,
      toggleMute: false,
      toggleDeafen: false,
    });
    render(<Harness />);

    press({ code: "F8", key: "F8", ctrlKey: true });
    press({ code: "F8", key: "F8", ctrlKey: true, repeat: true });
    press({ code: "F8", key: "F8", ctrlKey: true, repeat: true });

    expect(toggleVoiceState).toHaveBeenCalledTimes(1);
    expect(toggleVoiceState).toHaveBeenCalledWith("mute");
  });

  it("leaves a globally delivered key to the Raw Input layer", () => {
    const toggleVoiceState = vi
      .spyOn(coreApi, "toggleVoiceState")
      .mockResolvedValue(undefined);
    bind("toggleMute", "F8");
    voiceWithHook("active");
    render(<Harness />);

    press({ code: "F8", key: "F8" });

    // The Rust router toggles it; a local toggle here would undo it.
    expect(toggleVoiceState).not.toHaveBeenCalled();
  });

  it("keeps mute global when push-to-talk alone failed", () => {
    const toggleVoiceState = vi
      .spyOn(coreApi, "toggleVoiceState")
      .mockResolvedValue(undefined);
    bind("toggleMute", "F8");
    // The PTT binding is invalid (hook unavailable) but the toggles were
    // registered independently; the window must not toggle a second time.
    voiceWithHook("unavailable", {
      registered: true,
      pushToTalk: false,
      toggleMute: true,
      toggleDeafen: true,
    });
    render(<Harness />);

    press({ code: "F8", key: "F8" });

    expect(toggleVoiceState).not.toHaveBeenCalled();
  });

  it("falls back to the window handler when Raw Input is unavailable", () => {
    const toggleVoiceState = vi
      .spyOn(coreApi, "toggleVoiceState")
      .mockResolvedValue(undefined);
    bind("toggleMute", "F8");
    voiceWithHook("unavailable");
    render(<Harness />);

    press({ code: "F8", key: "F8" });

    expect(toggleVoiceState).toHaveBeenCalledTimes(1);
  });

  it("ignores a local mute while the server mutes the user", () => {
    const state = structuredClone(fixtureState);
    const self = state.users.find((user) => user.id === state.selfUserId);
    if (!self) {
      throw new Error("fixture self");
    }
    self.voice.serverMuted = true;
    useCoreStore.setState({ state });
    const toggleVoiceState = vi
      .spyOn(coreApi, "toggleVoiceState")
      .mockResolvedValue(undefined);
    bind("toggleMute", "Ctrl+F8");
    voiceWithHook("active", {
      registered: true,
      toggleMute: false,
      toggleDeafen: false,
    });
    render(<Harness />);

    press({ code: "F8", key: "F8", ctrlKey: true });

    expect(toggleVoiceState).not.toHaveBeenCalled();
  });

  it("matches a mouse side button while the window is focused when Raw Input is off", () => {
    const toggleVoiceState = vi
      .spyOn(coreApi, "toggleVoiceState")
      .mockResolvedValue(undefined);
    bind("toggleDeafen", "Mouse4");
    voiceWithHook("unavailable");
    render(<Harness />);

    fireEvent.mouseDown(window, { button: 3 });

    expect(toggleVoiceState).toHaveBeenCalledTimes(1);
    expect(toggleVoiceState).toHaveBeenCalledWith("deafen");
  });
});
