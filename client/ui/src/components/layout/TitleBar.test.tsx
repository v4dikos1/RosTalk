import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

import { TitleBar } from "./TitleBar";

describe("TitleBar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    delete window.__ROSTALK_WINDOW__;
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
    useAppStore.setState({
      paletteOpen: false,
      serverMenu: null,
      settingsOpen: false,
    });
  });

  it("does not repeat the server identity in the window title bar", () => {
    render(<TitleBar />);
    expect(screen.getByTestId("title-bar-brand")).toBeInTheDocument();
    expect(screen.queryByText("Очаг друзей")).toBeNull();
    expect(screen.queryByText("7 в сети")).toBeNull();
    expect(screen.queryByTestId("title-bar-server")).toBeNull();
  });

  it("passes the window buttons to the window API", async () => {
    render(<TitleBar />);
    await userEvent.click(screen.getByTestId("title-bar-minimize"));
    await userEvent.click(screen.getByTestId("title-bar-maximize"));
    await userEvent.click(screen.getByTestId("title-bar-close"));

    expect(window.__ROSTALK_WINDOW__?.actions).toEqual([
      "minimize",
      "toggleMaximize",
      "close",
    ]);
  });

  it("opens the command palette from its field", async () => {
    render(<TitleBar />);
    await userEvent.click(screen.getByTestId("title-bar-search"));
    expect(useAppStore.getState().paletteOpen).toBe(true);
  });

  it("changes the maximize icon after the window reports a restore", async () => {
    render(<TitleBar />);
    const button = screen.getByTestId("title-bar-maximize");
    expect(button).toHaveAttribute("aria-label", "Развернуть");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-label", "Восстановить");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-label", "Развернуть");
  });
});
