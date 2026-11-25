import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatNotices } from "@/components/chat/ChatNotices";
import { coreApi } from "@/core";
import { i18n } from "@/i18n";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useChatStore } from "@/store/chatStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

import { UserContextMenu } from "./UserContextMenu";

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
  useAppStore.setState({ userMenu: { userId: 2, x: 120, y: 80 } });
}

describe("UserContextMenu", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await i18n.changeLanguage("ru");
    prepare();
    useChatStore.setState({ notices: [] });
  });

  it("shows the saved local volume and mutes for the current user only", async () => {
    const spy = vi
      .spyOn(coreApi, "setParticipantPreference")
      .mockResolvedValue([
        { key: "fixture-server:2", volume: 150, muted: true },
      ]);

    render(<UserContextMenu />);

    // The fixture stores 130 % for this user.
    expect(screen.getByTestId("user-menu-volume")).toHaveTextContent("130%");
    const slider = screen.getByTestId("user-menu-slider");
    fireEvent.change(slider, { target: { value: "150" } });
    expect(screen.getByTestId("user-menu-volume")).toHaveTextContent("150%");

    fireEvent.click(screen.getByTestId("user-menu-mute"));

    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith("fixture-server:2", 150, true);
    });
    expect(useSettingsStore.getState().settings?.participants).toContainEqual({
      key: "fixture-server:2",
      volume: 150,
      muted: true,
    });
  });

  it("resets to 100 % and unmuted", async () => {
    const spy = vi
      .spyOn(coreApi, "setParticipantPreference")
      .mockResolvedValue([
        { key: "fixture-server:2", volume: 100, muted: false },
      ]);
    render(<UserContextMenu />);

    fireEvent.click(screen.getByText("Громкость по умолчанию"));
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith("fixture-server:2", 100, false);
    });
  });

  it("shows your own row without volume, mute or reset", async () => {
    // User 1 is the fixture self.
    useAppStore.setState({ userMenu: { userId: 1, x: 120, y: 80 } });
    render(<UserContextMenu />);

    expect(screen.getByText("Вы")).toBeInTheDocument();
    expect(screen.queryByTestId("user-menu-volume")).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-menu-slider")).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-menu-mute")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Громкость по умолчанию"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-menu-dm")).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-menu-kick")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("user-menu-audio-settings"));
    expect(useAppStore.getState().settingsOpen).toBe(true);
    expect(useAppStore.getState().settingsSection).toBe("voice");
    expect(useAppStore.getState().userMenu).toBeNull();
  });

  it("uses switches for the ban scope instead of native checkboxes", async () => {
    const user = userEvent.setup();
    render(<UserContextMenu />);

    await user.click(screen.getByTestId("user-menu-ban"));

    const byKey = screen.getByTestId("user-menu-by-key");
    expect(byKey).toHaveAttribute("role", "switch");
    expect(byKey).toHaveAccessibleName("По ключу");
    expect(byKey).toBeChecked();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    await user.click(byKey);
    expect(byKey).not.toBeChecked();
    // The scope must not become empty: the confirm button disables itself.
    await user.click(screen.getByTestId("user-menu-by-ip"));
    expect(screen.getByTestId("user-menu-confirm")).toBeEnabled();
  });

  it("closes on Escape", () => {
    render(<UserContextMenu />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().userMenu).toBeNull();
  });

  it("offers to join the voice channel of another user", () => {
    useAppStore.setState({ userMenu: { userId: 5, x: 120, y: 80 } });
    render(<UserContextMenu />);

    const item = screen.getByTestId("user-menu-join");
    expect(item).toHaveTextContent("Войти в «Игры»");
    expect(item).toHaveAttribute(
      "aria-label",
      "Войти в «Игры»",
    );
    expect(item).toHaveAttribute(
      "title",
      "Войти в канал, где сейчас Dima",
    );
  });

  it("does not offer a join when the user is in your own channel", () => {
    // Anya sits in channel 3 together with the self user.
    render(<UserContextMenu />);
    expect(screen.queryByTestId("user-menu-join")).not.toBeInTheDocument();
  });

  it("does not offer a join into a text channel", () => {
    const state = structuredClone(fixtureState);
    const user = state.users.find((item) => item.id === 5);
    if (user) {
      user.channelId = 1; // "Правила", a text channel
    }
    useCoreStore.setState({ state, hydrated: true });
    useAppStore.setState({ userMenu: { userId: 5, x: 120, y: 80 } });

    render(<UserContextMenu />);
    expect(screen.queryByTestId("user-menu-join")).not.toBeInTheDocument();
  });

  it("hides the join when the channel rights deny joinChannel", () => {
    const state = structuredClone(fixtureState);
    const channel = state.permissions?.channels.find(
      (entry) => entry.channelId === 4,
    );
    if (channel) {
      channel.permissions = channel.permissions.filter(
        (name) => name !== "joinChannel",
      );
    }
    useCoreStore.setState({ state, hydrated: true });
    useAppStore.setState({ userMenu: { userId: 5, x: 120, y: 80 } });

    render(<UserContextMenu />);
    expect(screen.queryByTestId("user-menu-join")).not.toBeInTheDocument();
  });

  it("joins the friend's channel and reports the move", async () => {
    const join = vi.spyOn(coreApi, "joinChannel").mockResolvedValue();
    vi.spyOn(coreApi, "updateSettings").mockImplementation(
      async (settings) => settings,
    );
    useAppStore.setState({ userMenu: { userId: 5, x: 120, y: 80 } });

    render(<UserContextMenu />);
    fireEvent.click(screen.getByTestId("user-menu-join"));

    await vi.waitFor(() => {
      expect(join).toHaveBeenCalledWith(4, null);
    });
    await vi.waitFor(() => {
      expect(useChatStore.getState().notices).toHaveLength(1);
    });
    const notice = useChatStore.getState().notices[0];
    expect(notice?.title).toBe("Вы в «Игры»");
    expect(notice?.body).toBe("Перешли из «Общий» в «Игры»");
    expect(notice?.voice).toBe(true);
    expect(useAppStore.getState().userMenu).toBeNull();

    render(<ChatNotices />);
    expect(screen.getByTestId("chat-notice")).toHaveTextContent(
      "Перешли из «Общий» в «Игры»",
    );
  });
});
