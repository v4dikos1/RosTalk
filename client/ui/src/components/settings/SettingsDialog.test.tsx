import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { coreApi } from "@/core";
import type {
  ClientSettings,
  GlobalInputStatus,
  HotkeyBinding,
  PttStatus,
} from "@/core/api";
import { i18n } from "@/i18n";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useVoiceStore } from "@/store/voiceStore";

import { SettingsDialog } from "./SettingsDialog";

/** All three scoped actions bound to chords, as in the shipped toggle defaults. */
const CHORD_HOTKEYS: HotkeyBinding[] = [
  { action: "pushToTalk", accelerator: "Ctrl+Shift+P" },
  { action: "toggleMute", accelerator: "Ctrl+Shift+M" },
  { action: "toggleDeafen", accelerator: "Ctrl+Shift+D" },
  { action: "commandPalette", accelerator: "Ctrl+K" },
  { action: "openSettings", accelerator: "Ctrl+Comma" },
  { action: "leaveChannel", accelerator: "Ctrl+Shift+L" },
];

interface PrepareOptions {
  backgroundHotkeys?: boolean;
  hotkeys?: HotkeyBinding[];
  globalInput?: Partial<GlobalInputStatus>;
  pushToTalk?: PttStatus;
  /** Simulate the first render before the core's voice snapshot arrives. */
  withoutVoiceState?: boolean;
}

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
  options: PrepareOptions = {},
) {
  const settings = structuredClone(fixtureSettings);
  if (options.backgroundHotkeys !== undefined) {
    settings.voice.backgroundHotkeys = options.backgroundHotkeys;
  }
  if (options.hotkeys) {
    settings.voice.hotkeys = options.hotkeys;
  }
  useCoreStore.setState({
    state: structuredClone(fixtureState),
    hydrated: true,
    pending: [],
    actionError: null,
  });
  useSettingsStore.setState({
    settings,
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
    state: options.withoutVoiceState
      ? null
      : {
          media: "connected",
          publishing: true,
          publishAllowed: true,
          channelId: 3,
          selfMuted: false,
          deafened: false,
          micTest: false,
          gate: { mode: "voiceActivation", threshold_db: -45, hold_ms: 300 },
          pushToTalk: options.pushToTalk ?? {
            hook: "active",
            binding: "X1/X2",
            error: null,
          },
          globalInput: {
            registered: true,
            keyboardCaptured: false,
            pushToTalk: true,
            toggleMute: false,
            toggleDeafen: false,
            ...options.globalInput,
          },
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

  it("gives the dialog one fixed outer height with an inner scroller", () => {
    prepare("profile");
    render(<SettingsDialog />);

    const dialog = screen.getByTestId("settings-dialog");
    expect(dialog.className).toContain(
      "h-[min(720px,calc((100vh-96px)/var(--fixed-scale)))]",
    );
    expect(dialog.className).toContain("max-h-none");
    // The removed 420 px floor used to push the body past the frame.
    const body = screen.getByTestId("settings-content");
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).not.toContain("min-h-[420px]");
  });

  it("opens the avatar editor from the profile section", async () => {
    prepare("profile");
    render(<SettingsDialog />);

    expect(screen.queryByTestId("avatar-dialog")).toBeNull();
    await userEvent.click(screen.getByTestId("settings-avatar-change"));
    expect(screen.getByTestId("avatar-dialog")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("avatar-dialog")).toBeNull();
  });

  it("turns background combinations on through the core", async () => {
    prepare("hotkeys");
    render(<SettingsDialog />);

    await userEvent.click(screen.getByTestId("settings-background-hotkeys"));

    await waitFor(() =>
      expect(
        useSettingsStore.getState().settings?.voice.backgroundHotkeys,
      ).toBe(true),
    );
    expect(coreApi.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: expect.objectContaining({ backgroundHotkeys: true }),
      }),
    );
  });

  it("shows a PTT chord as unavailable, toggles as window-only, and enables the opt-in in one click", async () => {
    prepare("hotkeys", {
      backgroundHotkeys: false,
      hotkeys: CHORD_HOTKEYS,
      // Before the first install report the core has not registered anything.
      globalInput: {
        registered: false,
        pushToTalk: false,
        toggleMute: false,
        toggleDeafen: false,
      },
      pushToTalk: {
        hook: "unknown",
        binding: "Ctrl+Shift+P",
        error: null,
      },
    });
    const updateVoice = vi.spyOn(
      useSettingsStore.getState(),
      "updateVoice",
    );
    render(<SettingsDialog />);

    // Push-to-talk has no window fallback: the chord is unavailable until the
    // core confirms the background install, never "window only".
    const ptt = screen.getByTestId("hotkey-scope-pushToTalk");
    expect(ptt).toHaveAttribute("data-scope", "unavailable");
    expect(ptt).toHaveTextContent("Недоступно");
    expect(ptt).toHaveAttribute(
      "title",
      "Фоновый ввод для этого действия не установлен.",
    );

    // Mute and deafen do have a window handler, so a chord is window-only.
    for (const action of ["toggleMute", "toggleDeafen"]) {
      const badge = screen.getByTestId(`hotkey-scope-${action}`);
      expect(badge).toHaveAttribute("data-scope", "window");
      expect(badge).toHaveTextContent("Только в окне");
    }

    const enable = screen.getByTestId("hotkeys-enable-background");
    expect(enable).toHaveTextContent("Включить сочетания в фоне");
    await userEvent.click(enable);

    expect(updateVoice).toHaveBeenCalledTimes(1);
    expect(updateVoice).toHaveBeenCalledWith({ backgroundHotkeys: true });
    await waitFor(() =>
      expect(
        useSettingsStore.getState().settings?.voice.backgroundHotkeys,
      ).toBe(true),
    );
    // The call to action is gone as soon as the opt-in is on.
    expect(screen.queryByTestId("hotkeys-enable-background")).toBeNull();
  });

  it("shows X1/X2 push-to-talk as background while chord toggles wait for the opt-in", () => {
    // The shipped defaults with a successful install on this machine.
    prepare("hotkeys", { backgroundHotkeys: false });
    render(<SettingsDialog />);

    const ptt = screen.getByTestId("hotkey-scope-pushToTalk");
    expect(ptt).toHaveAttribute("data-scope", "global");
    expect(ptt).toHaveTextContent("В фоне");

    for (const action of ["toggleMute", "toggleDeafen"]) {
      const badge = screen.getByTestId(`hotkey-scope-${action}`);
      expect(badge).toHaveAttribute("data-scope", "window");
      expect(badge).toHaveTextContent("Только в окне");
    }
    expect(
      screen.getByTestId("hotkeys-enable-background"),
    ).toBeInTheDocument();
  });

  it("keeps a PTT chord unavailable while the voice snapshot is missing", () => {
    prepare("hotkeys", {
      backgroundHotkeys: false,
      hotkeys: CHORD_HOTKEYS,
      withoutVoiceState: true,
    });
    render(<SettingsDialog />);

    const ptt = screen.getByTestId("hotkey-scope-pushToTalk");
    expect(ptt).toHaveAttribute("data-scope", "unavailable");
    expect(ptt).toHaveTextContent("Недоступно");
    expect(ptt).toHaveAttribute(
      "title",
      "Фоновый ввод для этого действия не установлен.",
    );
    // Toggles keep the window handler even before the first snapshot.
    expect(screen.getByTestId("hotkey-scope-toggleMute")).toHaveAttribute(
      "data-scope",
      "window",
    );
  });

  it("marks every installed action as background with the opt-in on", () => {
    prepare("hotkeys", {
      backgroundHotkeys: true,
      globalInput: {
        registered: true,
        pushToTalk: true,
        toggleMute: true,
        toggleDeafen: true,
      },
    });
    render(<SettingsDialog />);

    for (const action of ["pushToTalk", "toggleMute", "toggleDeafen"]) {
      const badge = screen.getByTestId(`hotkey-scope-${action}`);
      expect(badge).toHaveAttribute("data-scope", "global");
      expect(badge).toHaveTextContent("В фоне");
    }
    expect(screen.queryByTestId("hotkeys-enable-background")).toBeNull();
    expect(screen.queryByTestId("hotkeys-window-only-warning")).toBeNull();
  });

  it("shows not-set and unavailable scopes for missing or broken bindings", () => {
    prepare("hotkeys", {
      backgroundHotkeys: false,
      hotkeys: [
        { action: "pushToTalk", accelerator: null },
        { action: "toggleMute", accelerator: "Ctrl+Shift" },
        { action: "toggleDeafen", accelerator: "Ctrl+Shift+D" },
        { action: "commandPalette", accelerator: "Ctrl+K" },
        { action: "openSettings", accelerator: "Ctrl+Comma" },
        { action: "leaveChannel", accelerator: "Ctrl+Shift+L" },
      ],
      globalInput: {
        registered: false,
        pushToTalk: false,
        toggleMute: false,
        toggleDeafen: false,
      },
      pushToTalk: { hook: "unknown", binding: "", error: null },
    });
    render(<SettingsDialog />);

    const unset = screen.getByTestId("hotkey-scope-pushToTalk");
    expect(unset).toHaveAttribute("data-scope", "unset");
    expect(unset).toHaveTextContent("Не назначено");

    const invalid = screen.getByTestId("hotkey-scope-toggleMute");
    expect(invalid).toHaveAttribute("data-scope", "unavailable");
    expect(invalid).toHaveTextContent("Недоступно");
    expect(invalid).toHaveAttribute(
      "title",
      "Нужна клавиша после модификаторов.",
    );

    expect(screen.getByTestId("hotkey-scope-toggleDeafen")).toHaveAttribute(
      "data-scope",
      "window",
    );
  });

  it("shows a PTT chord as unavailable with the core reason when the install failed", () => {
    prepare("hotkeys", {
      backgroundHotkeys: false,
      hotkeys: CHORD_HOTKEYS,
      globalInput: {
        registered: true,
        pushToTalk: false,
        toggleMute: true,
        toggleDeafen: true,
      },
      pushToTalk: {
        hook: "unavailable",
        binding: "Ctrl+Shift+P",
        error: "combination needs the background opt-in",
      },
    });
    render(<SettingsDialog />);

    // Push-to-talk has no window fallback: the badge must not claim it still
    // works while the window is focused.
    const badge = screen.getByTestId("hotkey-scope-pushToTalk");
    expect(badge).toHaveAttribute("data-scope", "unavailable");
    expect(badge).toHaveTextContent("Недоступно");
    expect(badge).toHaveAttribute(
      "title",
      "combination needs the background opt-in",
    );
    expect(screen.getByTestId("hotkeys-registration-error")).toHaveTextContent(
      "Push-to-talk недоступен: combination needs the background opt-in",
    );
  });

  it("explains window-only scope, the PTT fallback and the anti-cheat trade-off in one note", () => {
    prepare("hotkeys", {
      backgroundHotkeys: false,
      hotkeys: CHORD_HOTKEYS,
      globalInput: {
        registered: false,
        pushToTalk: false,
        toggleMute: false,
        toggleDeafen: false,
      },
      pushToTalk: { hook: "unknown", binding: "Ctrl+Shift+P", error: null },
    });
    render(<SettingsDialog />);

    // One note for all three actions, not the old separate PTT-only alert.
    const warnings = screen.getAllByTestId("hotkeys-window-only-warning");
    expect(warnings).toHaveLength(1);
    const warning = warnings[0]!;
    expect(warning).toHaveTextContent(/пока окно RosTalk в фокусе/);
    expect(warning).toHaveTextContent(/Push-to-talk оконного режима нет/);
    expect(warning).toHaveTextContent(/захватывает клавиатуру/);
    expect(warning).toHaveTextContent(/ADR 0012/);
    // Inline next to the editor, not a second modal.
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does not turn the background opt-in on from Restore defaults", async () => {
    prepare("hotkeys", { backgroundHotkeys: false });
    const updateVoice = vi.spyOn(
      useSettingsStore.getState(),
      "updateVoice",
    );
    render(<SettingsDialog />);

    await userEvent.click(
      screen.getByRole("button", { name: "Вернуть по умолчанию" }),
    );

    await waitFor(() => expect(updateVoice).toHaveBeenCalledTimes(1));
    expect(updateVoice).toHaveBeenCalledWith({
      hotkeys: expect.any(Array),
    });
    expect(
      "backgroundHotkeys" in (updateVoice.mock.calls[0]?.[0] ?? {}),
    ).toBe(false);
    expect(
      useSettingsStore.getState().settings?.voice.backgroundHotkeys,
    ).toBe(false);
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
    expect(screen.getByTestId("diagnostics-exported")).toHaveClass("select-text");

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
