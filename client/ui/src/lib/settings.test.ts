import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  YCUKEN_TO_QWERTY,
  acceleratorFromEvent,
  matchesAccelerator,
  migrateAccelerator,
  normalizeHotkeys,
} from "./settings";

/** A keyboard event; `key` is the character the layout produced. */
function keyEvent(
  code: string,
  key: string,
  modifiers: {
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
  } = {},
) {
  return {
    code,
    key,
    ctrlKey: modifiers.ctrlKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    altKey: modifiers.altKey ?? false,
    metaKey: modifiers.metaKey ?? false,
  };
}

describe("normalizeHotkeys", () => {
  it("keeps every action once, in UI order", () => {
    const bindings = normalizeHotkeys([
      { action: "leaveChannel", accelerator: "Ctrl+Shift+L" },
      { action: "pushToTalk", accelerator: "F8" },
    ]);
    expect(bindings.map((item) => item.action)).toEqual([
      "pushToTalk",
      "toggleMute",
      "toggleDeafen",
      "commandPalette",
      "openSettings",
      "leaveChannel",
    ]);
    expect(bindings[0]?.accelerator).toBe("F8");
    expect(bindings.find((item) => item.action === "leaveChannel")?.accelerator).toBe(
      "Ctrl+Shift+L",
    );
    expect(bindings.find((item) => item.action === "toggleMute")?.accelerator).toBeNull();
  });

  it("unbinds a duplicate accelerator but keeps the first action", () => {
    const bindings = normalizeHotkeys([
      { action: "pushToTalk", accelerator: "F8" },
      { action: "toggleMute", accelerator: "f8" },
    ]);
    expect(bindings[0]?.accelerator).toBe("F8");
    expect(bindings[1]?.accelerator).toBeNull();
  });
});

describe("physical hotkeys", () => {
  it("builds Latin combinations while the Russian layout is active", () => {
    expect(acceleratorFromEvent(keyEvent("KeyK", "л", { ctrlKey: true }))).toBe(
      "Ctrl+K",
    );
    expect(
      acceleratorFromEvent(keyEvent("KeyM", "ь", { ctrlKey: true, shiftKey: true })),
    ).toBe("Ctrl+Shift+M");
  });

  it("matches a saved accelerator by the physical key, not the character", () => {
    expect(
      matchesAccelerator("Ctrl+K", keyEvent("KeyK", "л", { ctrlKey: true })),
    ).toBe(true);
    expect(
      matchesAccelerator("Ctrl+K", keyEvent("KeyL", "д", { ctrlKey: true })),
    ).toBe(false);
    // The same event in the English layout still matches.
    expect(
      matchesAccelerator("Ctrl+K", keyEvent("KeyK", "k", { ctrlKey: true })),
    ).toBe(true);
  });

  it("maps digits and function keys independently of the layout", () => {
    expect(acceleratorFromEvent(keyEvent("Digit1", "1", { ctrlKey: true }))).toBe(
      "Ctrl+1",
    );
    expect(acceleratorFromEvent(keyEvent("F8", "F8"))).toBe("F8");
    expect(acceleratorFromEvent(keyEvent("F24", "F24", { altKey: true }))).toBe(
      "Alt+F24",
    );
  });

  it("keeps the stored names of comma and period", () => {
    expect(acceleratorFromEvent(keyEvent("Comma", "б", { ctrlKey: true }))).toBe(
      "Ctrl+Comma",
    );
    expect(acceleratorFromEvent(keyEvent("Period", "ю", { ctrlKey: true }))).toBe(
      "Ctrl+Period",
    );
    expect(
      matchesAccelerator("Ctrl+Comma", keyEvent("Comma", "б", { ctrlKey: true })),
    ).toBe(true);
  });

  it("ignores modifiers alone and Escape", () => {
    expect(
      acceleratorFromEvent(keyEvent("ControlLeft", "Control", { ctrlKey: true })),
    ).toBeNull();
    expect(acceleratorFromEvent(keyEvent("ShiftLeft", "Shift"))).toBeNull();
    expect(acceleratorFromEvent(keyEvent("Escape", "Escape"))).toBeNull();
  });

  it("falls back to the character for synthetic events without a code", () => {
    const modifiers = {
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    };
    expect(acceleratorFromEvent({ key: "F8", ...modifiers })).toBe("F8");
    // An event that only carries the Russian character still migrates.
    expect(
      acceleratorFromEvent({ key: "л", ...modifiers, ctrlKey: true }),
    ).toBe("Ctrl+K");
  });
});

describe("ЙЦУКЕН -> QWERTY migration", () => {
  it("covers the whole Russian alphabet", () => {
    expect(Object.keys(YCUKEN_TO_QWERTY)).toHaveLength(33);
    for (const [cyrillic, latin] of Object.entries(YCUKEN_TO_QWERTY)) {
      expect(migrateAccelerator(`Ctrl+${cyrillic}`)).toBe(`Ctrl+${latin}`);
      // Saved accelerators uppercase a single character.
      expect(migrateAccelerator(`Ctrl+Shift+${cyrillic.toUpperCase()}`)).toBe(
        `Ctrl+Shift+${latin}`,
      );
    }
  });

  it("migrates the palette binding from a saved settings file", () => {
    const bindings = normalizeHotkeys([
      { action: "commandPalette", accelerator: "Ctrl+Л" },
    ]);
    expect(
      bindings.find((binding) => binding.action === "commandPalette")?.accelerator,
    ).toBe("Ctrl+K");
  });

  it("migrates a single-key push-to-talk binding", () => {
    expect(migrateAccelerator("Л")).toBe("K");
    expect(migrateAccelerator(" V ")).toBe("V");
  });

  it("leaves mouse and already-Latin accelerators alone", () => {
    expect(migrateAccelerator("X1/X2")).toBe("X1/X2");
    expect(migrateAccelerator("Ctrl+Shift+M")).toBe("Ctrl+Shift+M");
    expect(migrateAccelerator("Mouse5")).toBe("Mouse5");
  });
});

describe("default settings", () => {
  it("match the Rust defaults and bind push-to-talk to X1/X2", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("dark");
    expect(DEFAULT_SETTINGS.locale).toBe("ru");
    expect(DEFAULT_SETTINGS.closeToTray).toBe(true);
    expect(
      DEFAULT_SETTINGS.voice.hotkeys.find(
        (item) => item.action === "commandPalette",
      )?.accelerator,
    ).toBe("Ctrl+K");
    expect(
      DEFAULT_SETTINGS.voice.hotkeys.find(
        (item) => item.action === "pushToTalk",
      )?.accelerator,
    ).toBe("X1/X2");
  });
});
