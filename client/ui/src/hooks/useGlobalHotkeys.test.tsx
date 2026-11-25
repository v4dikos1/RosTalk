import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import { fixtureSettings } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useSettingsStore } from "@/store/settingsStore";

import { useGlobalHotkeys } from "./useGlobalHotkeys";

/** The hook has no markup; the stores are the observable result. */
function Harness() {
  useGlobalHotkeys();
  return null;
}

function press(init: KeyboardEventInit) {
  fireEvent.keyDown(window, init);
}

describe("useGlobalHotkeys", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    useSettingsStore.setState({
      settings: structuredClone(fixtureSettings),
      loaded: true,
      error: null,
    });
    useAppStore.setState({
      paletteOpen: false,
      settingsOpen: false,
      wizardOpen: false,
    });
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
});
