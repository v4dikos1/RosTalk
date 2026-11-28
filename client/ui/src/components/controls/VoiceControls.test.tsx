import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { coreApi } from "@/core";
import type { PttStatus, VoiceState } from "@/core/api";
import { i18n } from "@/i18n";
import { fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useCoreStore, useVoiceStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

import { VoiceControls } from "./VoiceControls";

const { leaveVoiceChannel } = vi.hoisted(() => ({
  leaveVoiceChannel: vi.fn(async () => {}),
}));
vi.mock("@/lib/channels", () => ({ leaveVoiceChannel }));

function voiceState(overrides: Partial<VoiceState> = {}): VoiceState {
  return {
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
    inputDevice: "fixture-mic",
    outputDevice: "fixture-headphones",
    error: null,
    ...overrides,
  };
}

function prepare(
  options: {
    channelId?: number;
    voice?: VoiceState;
    serverMuted?: boolean;
    serverDeafened?: boolean;
    connection?: "connected" | "reconnecting" | "disconnected";
  } = {},
) {
  const state = structuredClone(fixtureState);
  state.connection = options.connection ?? "connected";
  if (options.channelId !== undefined || options.serverMuted || options.serverDeafened) {
    state.users = state.users.map((user) =>
      user.id === state.selfUserId
        ? {
            ...user,
            channelId: options.channelId ?? user.channelId,
            voice: {
              ...user.voice,
              serverMuted: options.serverMuted ?? user.voice.serverMuted,
              serverDeafened: options.serverDeafened ?? user.voice.serverDeafened,
            },
          }
        : user,
    );
  }
  useCoreStore.setState({
    state,
    hydrated: true,
    pending: [],
    actionError: null,
  });
  useVoiceStore.setState({
    state: options.voice ?? voiceState(),
    levels: null,
    stats: null,
    previousStats: null,
    devices: null,
  });
}

function renderControls() {
  return render(
    <TooltipProvider delayDuration={0}>
      <VoiceControls />
    </TooltipProvider>,
  );
}

describe("VoiceControls", () => {
  beforeEach(async () => {
    cleanup();
    leaveVoiceChannel.mockClear();
    await i18n.changeLanguage("ru");
    useAppStore.setState({ selectedChannelId: 1 });
    useSettingsStore.setState({ settings: null, loaded: true, error: null });
  });

  afterEach(() => vi.restoreAllMocks());

  it("routes the headphones and microphone through their own serialized toggles", async () => {
    const user = userEvent.setup();
    const toggle = vi.spyOn(coreApi, "toggleVoiceState").mockResolvedValue();
    prepare();
    renderControls();

    await user.click(screen.getByTestId("control-sound"));
    await user.click(screen.getByTestId("control-mic"));

    expect(toggle.mock.calls).toEqual([["deafen"], ["mute"]]);
  });

  it("keeps microphone, mode, monitoring, sound and leave in one labelled row", () => {
    prepare();
    renderControls();

    expect(screen.getByTestId("voice-controls")).toHaveAccessibleName(
      "Голосовые действия",
    );
    expect(screen.getByTestId("control-mic")).toHaveAccessibleName(
      "Выключить микрофон",
    );
    expect(screen.getByTestId("control-gate")).toHaveAccessibleName(
      "По голосу",
    );
    expect(screen.getByTestId("control-mic-test")).toHaveAccessibleName(
      "Прослушать себя",
    );
    expect(screen.getByTestId("control-sound")).toHaveAccessibleName(
      "Выключить звук",
    );

    // P33: leaving is the fifth control of the row, not a strip below it.
    const row = screen.getByTestId("voice-control-row");
    const leave = screen.getByTestId("control-leave");
    expect(row).toContainElement(leave);
    expect(leave).toHaveAccessibleName("Покинуть голосовой канал «Общий»");
    expect(leave).toHaveClass("size-8");
    expect(leave).toHaveClass("text-danger");
    expect(leave).not.toHaveAttribute("aria-pressed");
  });

  it("names leaving the voice channel and uses the actual channel", async () => {
    // The centre pane shows a text channel; the user is still in voice 3.
    prepare({ channelId: 3 });
    renderControls();

    const leave = screen.getByTestId("control-leave");
    expect(leave).toHaveAccessibleName("Покинуть голосовой канал «Общий»");
    expect(leave).not.toHaveTextContent("Покинуть канал");

    await userEvent.click(leave);
    expect(leaveVoiceChannel).toHaveBeenCalledTimes(1);
  });

  it("shows no leave action and a plain state when not in a voice channel", () => {
    prepare({ channelId: 0, voice: voiceState({ channelId: 0 }) });
    renderControls();

    expect(screen.queryByTestId("control-leave")).toBeNull();
    expect(screen.getByTestId("voice-idle")).toHaveTextContent("Не в канале");
  });

  it("keeps microphone and sound configurable without a voice channel", () => {
    prepare({ channelId: 0, voice: voiceState({ channelId: 0 }) });
    renderControls();

    // Previous bottom-bar behaviour: these are client settings, not room
    // actions, so a connected user may change them before joining.
    expect(screen.getByTestId("control-mic")).toBeEnabled();
    expect(screen.getByTestId("control-sound")).toBeEnabled();
  });

  it("disables the microphone in the AFK channel", () => {
    prepare({ channelId: 5, voice: voiceState({ channelId: 5 }) });
    renderControls();

    expect(screen.getByTestId("control-mic")).toBeDisabled();
    expect(screen.getByTestId("control-mic")).toHaveAccessibleName(
      "АФК-канал: микрофон выключает сервер",
    );
  });

  it("cannot unmute a server-muted microphone or a server-deafened sound", () => {
    prepare({ serverMuted: true, serverDeafened: true });
    renderControls();

    expect(screen.getByTestId("control-mic")).toBeDisabled();
    expect(screen.getByTestId("control-mic")).toHaveAccessibleName(
      "Включить микрофон",
    );
    expect(screen.getByTestId("control-sound")).toBeDisabled();
    expect(screen.getByTestId("control-sound")).toHaveAccessibleName(
      "Включить звук",
    );
  });

  it("keeps leaving available during a control-plane reconnect", () => {
    prepare({ connection: "reconnecting" });
    renderControls();

    expect(screen.getByTestId("control-leave")).toBeInTheDocument();
    expect(screen.getByTestId("control-mic")).toBeDisabled();
    expect(screen.getByTestId("control-sound")).toBeDisabled();
  });

  it("offers three labelled transmission modes and shows the PTT binding", async () => {
    prepare({
      voice: voiceState({
        gate: { mode: "pushToTalk" },
        pushToTalk: { hook: "active", binding: "X1/X2", error: null } as PttStatus,
      }),
    });
    renderControls();

    expect(screen.getByTestId("control-gate")).toHaveAccessibleName(
      "Клавиша: Боковая кнопка мыши (X1/X2)",
    );
    await userEvent.click(screen.getByTestId("control-gate"));
    expect(screen.getByTestId("gate-option-voiceActivation")).toHaveTextContent(
      "По голосу",
    );
    expect(screen.getByTestId("gate-option-pushToTalk")).toHaveTextContent(
      "По клавише",
    );
    expect(screen.getByTestId("gate-option-continuous")).toHaveTextContent(
      "Передача всегда",
    );
  });
});
