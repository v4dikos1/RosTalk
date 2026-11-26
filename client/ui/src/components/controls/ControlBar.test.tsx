import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { PttStatus, VoiceState } from "@/core/api";
import { i18n } from "@/i18n";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useCoreStore, useVoiceStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

import { ControlBar } from "./ControlBar";

function voiceState(pushToTalk: PttStatus): VoiceState {
  return {
    media: "connected",
    publishing: true,
    publishAllowed: true,
    channelId: 3,
    selfMuted: false,
    deafened: false,
    micTest: false,
    gate: { mode: "pushToTalk" },
    pushToTalk,
    globalInput: {
      registered: true,
      keyboardCaptured: false,
      pushToTalk: true,
      toggleMute: false,
      toggleDeafen: false,
    },
    inputDevice: "fixture-mic",
    outputDevice: "fixture-headphones",
    error: null,
  };
}

function renderBar(pushToTalk: PttStatus) {
  useVoiceStore.setState({
    state: voiceState(pushToTalk),
    levels: null,
    stats: null,
    previousStats: null,
    devices: null,
  });
  return render(
    <TooltipProvider>
      <ControlBar />
    </TooltipProvider>,
  );
}

describe("ControlBar push-to-talk status", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    useCoreStore.setState({
      state: structuredClone(fixtureState),
      hydrated: true,
      pending: [],
      actionError: null,
    });
    useAppStore.setState({ selectedChannelId: 3 });
  });

  it("says the disconnected state once in the bottom bar", () => {
    useSettingsStore.setState({
      settings: structuredClone(fixtureSettings),
      loaded: true,
      error: null,
    });
    useCoreStore.setState((store) =>
      store.state
        ? {
            state: {
              ...store.state,
              connection: "disconnected",
              server: null,
              users: [],
              selfUserId: 0,
            },
          }
        : store,
    );
    renderBar({ hook: "active", binding: "X1/X2", error: null });

    // The nickname is known before connecting; the state is named once.
    expect(screen.getAllByText("Нет связи")).toHaveLength(1);
    expect(screen.getByText("Не в канале")).toBeInTheDocument();
    expect(screen.queryByText("Не подключено")).not.toBeInTheDocument();
  });

  it("shows the binding when Raw Input is running", () => {
    renderBar({ hook: "active", binding: "X1/X2", error: null });

    expect(screen.getByTestId("ptt-status")).toHaveTextContent(
      "Клавиша: Боковая кнопка мыши (X1/X2)",
    );
  });

  it("shows the installation error when Raw Input is unavailable", () => {
    renderBar({
      hook: "unavailable",
      binding: "X1/X2",
      error: "RegisterRawInputDevices failed",
    });

    const status = screen.getByTestId("ptt-status");
    expect(status).toHaveTextContent("PTT недоступен");
    expect(status).toHaveAttribute("title", "RegisterRawInputDevices failed");
  });

  it("says so when the platform has no global input", () => {
    renderBar({ hook: "unsupported", binding: "X1/X2", error: null });

    expect(screen.getByTestId("ptt-status")).toHaveTextContent(
      "PTT недоступен",
    );
  });
});
