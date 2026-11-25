import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { coreApi } from "@/core";
import type { CoreError } from "@/core/api";
import { i18n } from "@/i18n";
import {
  fixtureDevices,
  fixtureSettings,
  fixtureState,
} from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useVoiceStore } from "@/store/voiceStore";

import { OnboardingWizard } from "./OnboardingWizard";

const link = `rostalk://join?host=192.168.0.13:7443&fp=${"ab".repeat(32)}&invite=demo`;

function prepare() {
  useCoreStore.setState({
    state: structuredClone(fixtureState),
    hydrated: true,
    pending: [],
    actionError: null,
  });
  useSettingsStore.setState({
    settings: {
      ...structuredClone(fixtureSettings),
      onboardingComplete: false,
      nickname: "",
    },
    loaded: true,
    error: null,
  });
  useAppStore.setState({
    wizardOpen: true,
    wizardLink: null,
    selectedChannelId: null,
  });
  useVoiceStore.setState({
    devices: structuredClone(fixtureDevices),
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
      inputDevice: null,
      outputDevice: null,
      error: null,
    },
    levels: { selfLevelDb: -22, selfSpeaking: true, participants: [] },
    stats: null,
    previousStats: null,
  });
}

describe("OnboardingWizard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    prepare();
  });

  it("walks the wizard including diagnostics and joins the default channel", async () => {
    const user = userEvent.setup();
    const connect = vi
      .spyOn(coreApi, "connect")
      .mockResolvedValue(structuredClone(fixtureState));
    const join = vi.spyOn(coreApi, "joinChannel").mockResolvedValue();
    const complete = vi
      .spyOn(coreApi, "completeOnboarding")
      .mockResolvedValue({ ...fixtureSettings, onboardingComplete: true });
    const update = vi
      .spyOn(coreApi, "updateSettings")
      .mockImplementation(async (settings) => settings);

    render(<OnboardingWizard />);

    await user.type(screen.getByTestId("onboarding-link"), link);
    await user.click(screen.getByTestId("onboarding-next"));
    const nickname = screen.getByTestId("onboarding-nickname");
    await user.type(nickname, "Alice");
    await user.click(screen.getByTestId("onboarding-next"));

    expect(screen.getByTestId("onboarding-input")).toBeInTheDocument();
    await user.click(screen.getByTestId("onboarding-mic-next"));

    // The last step asks about the local log and never blocks joining.
    expect(
      screen.getByTestId("onboarding-diagnostics-allow"),
    ).toBeInTheDocument();
    await user.click(screen.getByTestId("onboarding-diagnostics-deny"));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ diagnostics: { consent: "denied" } }),
      ),
    );
    await user.click(screen.getByTestId("onboarding-finish"));

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(connect.mock.calls[0]?.[0]).toMatchObject({
      target: { mode: "link", link },
      nickname: "Alice",
    });
    expect(join).toHaveBeenCalledWith(3, null);
    expect(complete).toHaveBeenCalledWith("Alice");
    expect(useAppStore.getState().wizardOpen).toBe(false);
  });

  it("saves the diagnostics consent on the last step and can go back", async () => {
    const user = userEvent.setup();
    const update = vi
      .spyOn(coreApi, "updateSettings")
      .mockImplementation(async (settings) => settings);
    // A fresh profile has not answered yet.
    useSettingsStore.setState({
      settings: {
        ...structuredClone(fixtureSettings),
        onboardingComplete: false,
        nickname: "",
        diagnostics: { consent: "undecided" },
      },
    });

    render(<OnboardingWizard />);
    await user.type(screen.getByTestId("onboarding-link"), link);
    await user.click(screen.getByTestId("onboarding-next"));
    await user.type(screen.getByTestId("onboarding-nickname"), "Alice");
    await user.click(screen.getByTestId("onboarding-next"));
    await user.click(screen.getByTestId("onboarding-mic-next"));

    const allow = screen.getByTestId("onboarding-diagnostics-allow");
    expect(allow).toHaveAttribute("aria-pressed", "false");
    await user.click(allow);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ diagnostics: { consent: "granted" } }),
      ),
    );

    // The step is skippable and the wizard can step back to the microphone.
    await user.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByTestId("onboarding-input")).toBeInTheDocument();
  });

  it("focuses the link field and advances on Enter", async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    expect(screen.getByTestId("onboarding-link")).toHaveFocus();
    await user.type(screen.getByTestId("onboarding-link"), link);
    await user.keyboard("{Enter}");

    expect(screen.getByTestId("onboarding-nickname")).toBeInTheDocument();
  });

  it("probes a direct address on Enter and asks for its fingerprint", async () => {
    const user = userEvent.setup();
    const probe = vi.spyOn(coreApi, "probeServer").mockResolvedValue({
      host: "192.168.0.13:7443",
      hostname: "192.168.0.13",
      port: 7443,
      mode: "pinned",
      fingerprint: "ab".repeat(32),
      knownName: null,
      knownFingerprint: null,
      certificateChanged: false,
    });
    render(<OnboardingWizard />);

    await user.click(screen.getByTestId("onboarding-mode-direct"));
    await user.type(screen.getByTestId("onboarding-host"), "192.168.0.13:7443");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(screen.getByTestId("connect-fingerprint")).toBeInTheDocument(),
    );
    expect(probe).toHaveBeenCalledWith("192.168.0.13:7443");
    expect(screen.getByTestId("onboarding-next")).toBeDisabled();
    expect(screen.getByTestId("onboarding-reason")).toHaveTextContent(
      "Подтвердите отпечаток сертификата.",
    );
  });

  it("rejects a link that is not a rostalk:// invitation", async () => {
    const user = userEvent.setup();
    const connect = vi.spyOn(coreApi, "connect");

    render(<OnboardingWizard />);
    await user.type(screen.getByTestId("onboarding-link"), "https://example.com");
    await user.click(screen.getByTestId("onboarding-next"));

    expect(
      screen.getByText("Это не ссылка-приглашение RosTalk."),
    ).toBeInTheDocument();
    expect(connect).not.toHaveBeenCalled();
  });

  it("shows a ban as human text, not a code", async () => {
    const user = userEvent.setup();
    const banned: CoreError = {
      code: "serverError",
      message: "server rejected the handshake: banned",
      retryable: false,
      actionUrl: null,
      serverCode: "banned",
    };
    vi.spyOn(coreApi, "connect").mockRejectedValue(banned);

    render(<OnboardingWizard />);
    await user.type(screen.getByTestId("onboarding-link"), link);
    await user.click(screen.getByTestId("onboarding-next"));
    await user.type(screen.getByTestId("onboarding-nickname"), "Alice");
    await user.click(screen.getByTestId("onboarding-next"));
    await user.click(screen.getByTestId("onboarding-mic-next"));
    await user.click(screen.getByTestId("onboarding-finish"));

    expect(
      await screen.findByText("Доступ запрещён (блокировка)"),
    ).toBeInTheDocument();
    expect(screen.queryByText(banned.message)).not.toBeInTheDocument();
    expect(screen.getByTestId("onboarding")).toBeInTheDocument();
  });

  it("never rewrites a localhost address from the link", async () => {
    const user = userEvent.setup();
    const localLink = `rostalk://join?host=localhost:7443&fp=${"cd".repeat(32)}`;
    render(<OnboardingWizard />);
    await user.type(screen.getByTestId("onboarding-link"), localLink);

    expect(screen.getByTestId("link-preview")).toHaveTextContent(
      "localhost:7443",
    );
    expect(
      screen.getByText(/Адрес не подменяем/),
    ).toBeInTheDocument();
  });
});
