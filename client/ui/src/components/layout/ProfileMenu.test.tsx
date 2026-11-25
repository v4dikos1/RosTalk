import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

import { ProfileMenu } from "./ProfileMenu";

function prepare(admin = true) {
  const state = structuredClone(fixtureState);
  if (!admin) {
    state.permissions = state.permissions
      ? { ...state.permissions, server: [] }
      : null;
  }
  useCoreStore.setState({
    state,
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
    settingsOpen: false,
    settingsSection: "general",
    serverListOpen: false,
    serverMenu: null,
  });
}

describe("ProfileMenu", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    delete window.__ROSTALK_WINDOW__;
    prepare();
  });

  it("shows the nickname and status and opens the profile settings", async () => {
    render(<ProfileMenu />);
    expect(screen.getByTestId("profile-panel")).toHaveTextContent("Alex");
    await userEvent.click(screen.getByTestId("profile-panel"));
    expect(screen.getByTestId("profile-menu")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("profile-menu-profile"));
    expect(useAppStore.getState().settingsOpen).toBe(true);
    expect(useAppStore.getState().settingsSection).toBe("profile");
  });

  it("opens the general settings from its own item", async () => {
    render(<ProfileMenu />);
    await userEvent.click(screen.getByTestId("profile-panel"));
    await userEvent.click(screen.getByTestId("profile-menu-settings"));
    expect(useAppStore.getState().settingsOpen).toBe(true);
    expect(useAppStore.getState().settingsSection).toBe("general");
  });

  it("opens the saved-server list for switching", async () => {
    render(<ProfileMenu />);
    await userEvent.click(screen.getByTestId("profile-panel"));
    await userEvent.click(screen.getByTestId("profile-menu-switch-server"));
    expect(useAppStore.getState().serverListOpen).toBe(true);
  });

  it("quits through the window API", async () => {
    render(<ProfileMenu />);
    await userEvent.click(screen.getByTestId("profile-panel"));
    await userEvent.click(screen.getByTestId("profile-menu-quit"));
    expect(window.__ROSTALK_WINDOW__?.actions).toEqual(["quit"]);
  });
});
