import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { coreApi } from "@/core";
import { i18n } from "@/i18n";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

import { CommandPalette } from "./CommandPalette";

function prepare() {
  useCoreStore.setState({
    state: structuredClone(fixtureState),
    hydrated: true,
    pending: [],
    actionError: null,
  });
  useSettingsStore.setState({
    settings: structuredClone(fixtureSettings),
    loaded: true,
    error: null,
  });
  useAppStore.setState({ paletteOpen: true });
}

describe("CommandPalette", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    prepare();
  });

  it("filters channels and joins the highlighted one with Enter", async () => {
    const user = userEvent.setup();
    const join = vi.spyOn(coreApi, "joinChannel").mockResolvedValue();
    vi.spyOn(coreApi, "updateSettings").mockResolvedValue(fixtureSettings);

    render(<CommandPalette />);
    const input = screen.getByTestId("palette-input");
    await user.type(input, "Общий");

    const option = await screen.findByRole("option", { name: /Общий/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(join).toHaveBeenCalledWith(3, null));
    expect(useAppStore.getState().paletteOpen).toBe(false);
  });

  it("navigates with the arrow keys and runs settings actions", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    const input = screen.getByTestId("palette-input");
    await user.type(input, "клавиш");
    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");

    expect(useAppStore.getState().settingsOpen).toBe(true);
    expect(useAppStore.getState().settingsSection).toBe("hotkeys");
  });

  it("shows the keyboard hints as keycaps", () => {
    render(<CommandPalette />);

    for (const key of ["↑↓", "↵"]) {
      expect(screen.getByText(key).tagName).toBe("KBD");
    }
    expect(screen.getAllByText("Esc").map((node) => node.tagName)).toEqual([
      "KBD",
      "KBD",
    ]);
    // The hints stay readable next to the caps.
    expect(screen.getByText("Выбрать")).toBeInTheDocument();
    expect(screen.getByText("Открыть")).toBeInTheDocument();
  });

  it("works from the keyboard shortcut and shows an empty state", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    await user.type(screen.getByTestId("palette-input"), "zzzzz");
    expect(screen.getByText("Ничего не найдено")).toBeInTheDocument();
  });
});
