import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import { fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";

import { ServerMenu } from "./ServerMenu";

function prepare(admin: boolean) {
  const state = structuredClone(fixtureState);
  state.permissions = state.permissions
    ? {
        ...state.permissions,
        server: admin ? state.permissions.server : ["changeNickname"],
      }
    : null;
  useCoreStore.setState({
    state,
    hydrated: true,
    pending: [],
    actionError: null,
  });
  useAppStore.setState({
    serverMenu: { x: 20, y: 40 },
    inviteOpen: false,
    serverSettingsOpen: false,
  });
}

describe("ServerMenu", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
  });

  it("offers invite, server settings and leaving to an admin", async () => {
    prepare(true);
    render(<ServerMenu />);
    expect(screen.getByTestId("server-actions-menu")).toHaveTextContent(
      "Очаг друзей",
    );
    expect(screen.getByTestId("server-menu-invite")).toBeInTheDocument();
    expect(screen.getByTestId("server-menu-settings")).toBeInTheDocument();
    expect(screen.getByTestId("server-menu-leave")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("server-menu-settings"));
    expect(useAppStore.getState().serverSettingsOpen).toBe(true);
    expect(useAppStore.getState().serverMenu).toBeNull();
  });

  it("hides server settings without administration rights", () => {
    prepare(false);
    render(<ServerMenu />);
    expect(screen.getByTestId("server-menu-invite")).toBeInTheDocument();
    expect(screen.queryByTestId("server-menu-settings")).toBeNull();
  });

  it("opens the invite dialog instead of leaving the menu in place", async () => {
    prepare(true);
    render(<ServerMenu />);
    await userEvent.click(screen.getByTestId("server-menu-invite"));
    expect(useAppStore.getState().inviteOpen).toBe(true);
    expect(useAppStore.getState().serverMenu).toBeNull();
  });
});
