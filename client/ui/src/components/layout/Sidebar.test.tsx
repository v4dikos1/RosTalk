import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useCoreStore, useVoiceStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

import { Sidebar } from "./Sidebar";

function renderSidebar() {
  return render(
    <TooltipProvider delayDuration={0}>
      <Sidebar />
    </TooltipProvider>,
  );
}

describe("Sidebar", () => {
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
    useVoiceStore.setState({
      state: {
        media: "connected",
        publishing: true,
        publishAllowed: true,
        channelId: 3,
        selfMuted: false,
        deafened: false,
        micTest: false,
        gate: { mode: "voiceActivation", threshold_db: -45, hold_ms: 300 },
        pushToTalk: { hook: "active", binding: "X1/X2", error: null },
        globalInput: {
          registered: true,
          keyboardCaptured: false,
          pushToTalk: true,
          toggleMute: false,
          toggleDeafen: false,
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
    useAppStore.setState({ selectedChannelId: 3 });
  });

  it("keeps the active server and the online count in its own header", () => {
    renderSidebar();

    expect(screen.getByTestId("server-name")).toHaveTextContent("Очаг друзей");
    expect(screen.getByTestId("server-name")).toHaveTextContent("7 в сети");
    expect(screen.getByTestId("server-switcher")).toBeInTheDocument();
    expect(screen.getAllByTestId("quality-indicator").length).toBeGreaterThan(0);
  });

  it("shows a long server name in one truncated line with the full title", () => {
    const state = structuredClone(fixtureState);
    const longName =
      "Сервер друзей и очень длинное название, которое не должно ломать шапку";
    if (state.server) {
      state.server.name = longName;
    }
    useCoreStore.setState({ state, hydrated: true, pending: [], actionError: null });
    renderSidebar();

    expect(screen.getByTestId("server-name")).toHaveTextContent(longName);
    expect(screen.getByTestId("server-name")).toHaveAttribute(
      "title",
      `${longName} · 7 в сети`,
    );
  });

  it("puts the voice group in the footer and moves invite to the server menu", () => {
    renderSidebar();

    expect(screen.getByTestId("voice-controls")).toBeInTheDocument();
    expect(screen.getByTestId("control-mic")).toBeInTheDocument();
    expect(screen.getByTestId("control-leave")).toBeInTheDocument();
    expect(screen.queryByTestId("invite-open")).toBeNull();
    expect(screen.getByTestId("open-palette")).toBeInTheDocument();
  });

  it("keeps the identity and a quiet voice state without a connection", () => {
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
        pushToTalk: { hook: "active", binding: "X1/X2", error: null },
        globalInput: {
          registered: true,
          keyboardCaptured: false,
          pushToTalk: true,
          toggleMute: false,
          toggleDeafen: false,
        },
        inputDevice: null,
        outputDevice: null,
        error: null,
      },
    });
    const state = structuredClone(fixtureState);
    state.connection = "disconnected";
    state.server = null;
    state.users = [];
    state.selfUserId = 0;
    useCoreStore.setState({ state, hydrated: true, pending: [], actionError: null });
    renderSidebar();

    expect(screen.getByTestId("server-name")).toHaveTextContent("Очаг друзей");
    expect(screen.getByTestId("server-name")).toHaveTextContent(
      "192.168.0.13:7443",
    );
    expect(screen.getByTestId("voice-idle")).toHaveTextContent("Не в канале");
    expect(screen.queryByTestId("control-leave")).toBeNull();
  });
});
