import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useChatStore } from "@/store/chatStore";

import { MainScreen } from "./MainScreen";

function renderScreen() {
  return render(
    <TooltipProvider>
      <MainScreen />
    </TooltipProvider>,
  );
}

describe("MainScreen", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
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
    useAppStore.setState({ selectedChannelId: 3 });
  });

  it("shows channels and users from the core snapshot", () => {
    renderScreen();

    expect(screen.getByTestId("main-screen")).toBeInTheDocument();
    expect(screen.getByTestId("channel-3")).toBeInTheDocument();
    expect(screen.getByTestId("user-1")).toBeInTheDocument();
    expect(screen.getAllByText("Общий").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("quality-indicator").length).toBeGreaterThan(0);
  });

  it("keeps the microphone control disabled in the idle channel", () => {
    const state = structuredClone(fixtureState);
    state.users = state.users.map((user) =>
      user.id === state.selfUserId
        ? { ...user, channelId: 5, voice: { ...user.voice, selfMuted: true } }
        : user,
    );
    useCoreStore.setState({
      state,
      hydrated: true,
      pending: [],
      actionError: null,
    });
    renderScreen();

    const mic = screen.getByTestId("control-mic");
    expect(mic).toBeDisabled();
    expect(mic).toHaveAccessibleName(
      "АФК-канал: микрофон выключает сервер",
    );
  });

  it("clears the tree and users after a reset delta but keeps saved servers", () => {
    renderScreen();
    expect(screen.getByTestId("channel-3")).toBeInTheDocument();

    act(() => {
      useCoreStore.getState().delta({
        type: "reset",
        payload: {
          servers: fixtureState.servers,
          activeServerId: "192.168.0.13:7443",
          profile: fixtureState.profile,
          error: null,
          protocolVersion: 1,
          clientVersion: "0.1.0",
        },
      });
    });

    expect(screen.queryByTestId("channel-3")).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("state-welcome")).toBeInTheDocument();
    // Saved servers survive the reset and are offered for the next connect.
    expect(screen.getAllByText("Очаг друзей").length).toBeGreaterThan(0);
  });

  it("shows a ban as human text with a way to another server", () => {
    useCoreStore.setState((store) =>
      store.state
        ? {
            state: {
              ...store.state,
              connection: "disconnected",
              server: null,
              channels: [],
              users: [],
              selfUserId: 0,
              error: {
                code: "serverError",
                message: "server rejected the handshake: banned",
                retryable: false,
                actionUrl: null,
                serverCode: "banned",
              },
            },
          }
        : store,
    );
    renderScreen();

    expect(screen.getByTestId("state-error")).toBeInTheDocument();
    expect(
      screen.getAllByText("Доступ запрещён (блокировка)").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("banned")).not.toBeInTheDocument();
    expect(screen.getByTestId("state-other-server")).toBeInTheDocument();
  });

  it("shows an outdated client as human text", () => {
    useCoreStore.setState((store) =>
      store.state
        ? {
            state: {
              ...store.state,
              connection: "disconnected",
              server: null,
              channels: [],
              users: [],
              selfUserId: 0,
              error: {
                code: "protocolVersionUnsupported",
                message: "server speaks 2",
                retryable: false,
                actionUrl: null,
                serverCode: "protocolVersionUnsupported",
              },
            },
          }
        : store,
    );
    renderScreen();

    expect(
      screen.getAllByText(
        "Протокол не поддерживается — обновите клиент",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("shows one live marker in the channel header instead of a badge per row", () => {
    useAppStore.setState({ selectedChannelId: 4 });
    renderScreen();

    const live = screen.getByTestId("channel-live");
    expect(live).toHaveTextContent("В эфире");
    expect(live).toHaveTextContent("1");
    // The tree row no longer repeats the word: only the stream tile keeps it.
    expect(screen.queryByTestId("live-6")).not.toBeInTheDocument();
    expect(screen.getAllByText("В эфире")).toHaveLength(1);
  });

  it("marks the current channel with an ember presence dot, not a green pill", () => {
    renderScreen();

    const here = screen.getByTestId("channel-you-are-here");
    expect(here).toHaveTextContent("Вы здесь");
    expect(here.className).not.toContain("bg-success");
    expect(here.querySelector(".bg-accent")).not.toBeNull();
  });

  it("keeps the tree and shows a countdown while reconnecting", () => {
    useCoreStore.setState((store) =>
      store.state
        ? {
            state: {
              ...store.state,
              connection: "reconnecting",
              reconnect: { attempt: 2, delayMs: 4000 },
            },
          }
        : store,
    );
    renderScreen();

    expect(screen.getByRole("status")).toHaveTextContent(
      "Связь с сервером потеряна",
    );
    expect(screen.getByText(/Попытка 2/)).toBeInTheDocument();
    expect(screen.getByTestId("channel-3")).toBeInTheDocument();
  });

  it("drops the draft and attachments when another conversation opens", async () => {
    useChatStore.setState({
      conversations: {},
      activeKey: null,
      proxy: null,
      notices: [],
    });
    renderScreen();

    fireEvent.click(screen.getByTestId("channel-2"));
    const first = await screen.findByTestId("chat-input");
    fireEvent.change(first, { target: { value: "не туда" } });
    expect(first).toHaveValue("не туда");

    fireEvent.click(screen.getByTestId("channel-1"));
    await waitFor(() =>
      expect(screen.getByTestId("chat-input")).toHaveValue(""),
    );
  });

  it("shows only the messages of the conversation that is open", async () => {
    const cached = (id: number, channelId: number) => ({
      id,
      channelId,
      senderId: 2,
      recipientId: 0,
      senderNickname: "Аня",
      body: `сообщение ${id}`,
      createdAtUnixMs: 1_700_000_000_000 + id,
      editedAtUnixMs: 0,
      attachments: [],
      mentionUserIds: [],
    });
    useChatStore.setState({
      conversations: {
        "channel:1": {
          key: "channel:1",
          target: { kind: "channel", channelId: 1 },
          messages: [cached(100, 1)],
          nextCursor: "",
          hasMore: false,
          loaded: true,
          loading: false,
          error: null,
          stale: false,
        },
        "channel:2": {
          key: "channel:2",
          target: { kind: "channel", channelId: 2 },
          messages: [cached(200, 2)],
          nextCursor: "",
          hasMore: false,
          loaded: true,
          loading: false,
          error: null,
          stale: false,
        },
      },
      activeKey: null,
      proxy: null,
      notices: [],
    });
    renderScreen();

    fireEvent.click(screen.getByTestId("channel-1"));
    const first = await screen.findByTestId("message-list");
    expect(first).toHaveAttribute("data-conversation", "channel:1");

    fireEvent.click(screen.getByTestId("channel-2"));
    await waitFor(() => {
      const list = screen.getByTestId("message-list");
      expect(list).toHaveAttribute("data-conversation", "channel:2");
    });
  });
});
