import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { coreApi } from "@/core";
import type { ClientSettings } from "@/core/api";
import { i18n } from "@/i18n";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useVoiceStore } from "@/store/voiceStore";

import { SettingsDialog } from "./SettingsDialog";

function prepare(
  section:
    | "profile"
    | "general"
    | "appearance"
    | "voice"
    | "hotkeys"
    | "identity"
    | "diagnostics"
    | "about",
) {
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
    devices: {
      inputs: [
        {
          id: "mic-a",
          name: "Microphone A",
          isDefault: true,
          channels: 1,
          sampleRate: 48_000,
          sampleFormat: "F32",
        },
      ],
      outputs: [
        {
          id: "out-a",
          name: "Headphones A",
          isDefault: true,
          channels: 2,
          sampleRate: 48_000,
          sampleFormat: "F32",
        },
      ],
      defaultInput: "mic-a",
      defaultOutput: "out-a",
    },
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
  useAppStore.setState({
    settingsOpen: true,
    settingsSection: section,
  });
}

describe("SettingsDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(coreApi, "updateSettings").mockImplementation(
      async (settings: ClientSettings) => settings,
    );
  });

  it("changes the preset, accent and density through the core", async () => {
    prepare("appearance");
    const update = vi.spyOn(coreApi, "updateSettings");
    render(<SettingsDialog />);

    await userEvent.click(screen.getByTestId("appearance-preset-paper"));
    await waitFor(() =>
      expect(useSettingsStore.getState().settings?.appearance.preset).toBe(
        "paper",
      ),
    );
    expect(useSettingsStore.getState().settings?.theme).toBe("light");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: "light",
        appearance: expect.objectContaining({ preset: "paper" }),
      }),
    );

    await userEvent.click(screen.getByTestId("appearance-accent-violet"));
    await waitFor(() =>
      expect(useSettingsStore.getState().settings?.appearance.accent).toBe(
        "violet",
      ),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Компактная" }),
    );
    await waitFor(() => {
      const settings = useSettingsStore.getState().settings;
      expect(settings?.appearance.density).toBe("compact");
      expect(settings?.compact).toBe(true);
    });

    // The language stays in the general section.
    await userEvent.click(screen.getByTestId("settings-tab-general"));
    await userEvent.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() =>
      expect(useSettingsStore.getState().settings?.locale).toBe("en"),
    );
  });

  it("keeps the server out of the client settings and offers a profile tab", () => {
    prepare("general");
    render(<SettingsDialog />);
    expect(screen.getByTestId("settings-tab-profile")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-tab-server")).toBeNull();
  });

  it("stores the close-to-tray behaviour and the default channel", async () => {
    prepare("general");
    render(<SettingsDialog />);

    const traySwitch = screen.getByRole("switch", {
      name: "Закрывать в трей",
    });
    await userEvent.click(traySwitch);
    await waitFor(() =>
      expect(useSettingsStore.getState().settings?.closeToTray).toBe(false),
    );

    fireEvent.change(screen.getByTestId("settings-default-channel"), {
      target: { value: "4" },
    });
    await waitFor(() =>
      expect(useSettingsStore.getState().settings?.defaultChannelId).toBe(4),
    );
  });

  it("selects devices, runs the microphone loopback and edits the threshold", async () => {
    prepare("voice");
    const update = vi.spyOn(coreApi, "updateSettings");
    const micTest = vi.spyOn(coreApi, "setVoiceMicTest").mockResolvedValue();
    render(<SettingsDialog />);

    fireEvent.change(screen.getByTestId("settings-input-device"), {
      target: { value: "mic-a" },
    });
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          voice: expect.objectContaining({ inputDevice: "mic-a" }),
        }),
      ),
    );

    await userEvent.click(screen.getByTestId("settings-mic-test"));
    expect(micTest).toHaveBeenCalledWith(true);

    fireEvent.change(screen.getByTestId("settings-threshold"), {
      target: { value: "-30" },
    });
    await waitFor(() => {
      const gate = useSettingsStore.getState().settings?.voice.gate;
      expect(gate?.mode === "voiceActivation" ? gate.threshold_db : null).toBe(
        -30,
      );
    });
  });

  it("previews every cue and stores the sound group switches", async () => {
    prepare("voice");
    const preview = vi.spyOn(coreApi, "previewVoiceSound").mockResolvedValue();
    render(<SettingsDialog />);

    await userEvent.click(screen.getByTestId("settings-sound-preview-micOn"));
    expect(preview).toHaveBeenCalledWith("micOn");

    fireEvent.change(screen.getByTestId("settings-sound-set"), {
      target: { value: "bright" },
    });
    await waitFor(() =>
      expect(useSettingsStore.getState().settings?.voice.sounds.set).toBe(
        "bright",
      ),
    );

    await userEvent.click(screen.getByRole("switch", { name: "Микрофон" }));
    await waitFor(() =>
      expect(useSettingsStore.getState().settings?.voice.sounds.microphone).toBe(
        false,
      ),
    );
  });

  it("captures a new push-to-talk key and resets the defaults", async () => {
    prepare("hotkeys");
    render(<SettingsDialog />);

    await userEvent.click(screen.getByTestId("hotkey-pushToTalk"));
    fireEvent.keyDown(window, { key: "F8" });

    await waitFor(() => {
      const binding = useSettingsStore
        .getState()
        .settings?.voice.hotkeys.find((item) => item.action === "pushToTalk");
      expect(binding?.accelerator).toBe("F8");
    });

    await userEvent.click(screen.getByText("Вернуть по умолчанию"));
    await waitFor(() => {
      const binding = useSettingsStore
        .getState()
        .settings?.voice.hotkeys.find((item) => item.action === "pushToTalk");
      expect(binding?.accelerator).toBe("X1/X2");
    });
  });

  it("records Ctrl+K from a Russian-layout key press", async () => {
    prepare("hotkeys");
    render(<SettingsDialog />);

    await userEvent.click(screen.getByTestId("hotkey-toggleMute"));
    fireEvent.keyDown(window, { key: "л", code: "KeyK", ctrlKey: true });

    await waitFor(() => {
      const binding = useSettingsStore
        .getState()
        .settings?.voice.hotkeys.find((item) => item.action === "toggleMute");
      expect(binding?.accelerator).toBe("Ctrl+K");
    });
    // The Latin spelling is shown even though the layout produced a Cyrillic
    // character.
    expect(screen.getByTestId("hotkey-toggleMute")).toHaveTextContent("Ctrl+K");
  });

  it("exports the identity through a native file picker", async () => {
    prepare("identity");
    vi.spyOn(coreApi, "pickIdentityPath").mockResolvedValue("/tmp/me.rostalkkey");
    const exportIdentity = vi
      .spyOn(coreApi, "exportIdentity")
      .mockResolvedValue();
    render(<SettingsDialog />);

    await userEvent.click(screen.getByRole("button", { name: /Выбрать файл/ }));
    await waitFor(() =>
      expect(screen.getByText("/tmp/me.rostalkkey")).toBeInTheDocument(),
    );
    await userEvent.type(screen.getByTestId("identity-password"), "secret");
    await userEvent.click(screen.getByTestId("identity-submit"));

    await waitFor(() =>
      expect(exportIdentity).toHaveBeenCalledWith("/tmp/me.rostalkkey", "secret"),
    );
    expect(
      await screen.findByText("Личность сохранена в файл."),
    ).toBeInTheDocument();
  });

  it("turns the local log off, exports on demand and deletes it after confirmation", async () => {
    prepare("diagnostics");
    const exportDiagnostics = vi
      .spyOn(coreApi, "exportDiagnostics")
      .mockResolvedValue("C:/Users/me/rostalk-diagnostics-20261122-120000.log");
    const clearDiagnostics = vi
      .spyOn(coreApi, "clearDiagnostics")
      .mockResolvedValue();
    render(<SettingsDialog />);

    const toggle = screen.getByRole("switch", { name: "Вести журнал" });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(useSettingsStore.getState().settings?.diagnostics.consent).toBe(
        "denied",
      ),
    );

    // Export works even with the log off: it is an explicit user action.
    await userEvent.click(screen.getByTestId("diagnostics-export"));
    await waitFor(() =>
      expect(exportDiagnostics).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByTestId("diagnostics-exported")).toHaveTextContent(
      "rostalk-diagnostics-20261122-120000.log",
    );

    await userEvent.click(screen.getByTestId("diagnostics-clear"));
    expect(screen.getByText("Удалить журнал? Файлы сотрутся с диска.")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("diagnostics-clear-confirm"));
    await waitFor(() => expect(clearDiagnostics).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Журнал удалён.")).toBeInTheDocument();
  });

  it("shows the client version from ping, not a literal", async () => {
    prepare("about");
    vi.spyOn(coreApi, "ping").mockResolvedValue({
      message: "pong",
      protocolVersion: 1,
      clientVersion: "9.9.9",
    });
    render(<SettingsDialog />);

    await waitFor(() =>
      expect(screen.getByTestId("about-version")).toHaveTextContent("v9.9.9"),
    );
  });
});
