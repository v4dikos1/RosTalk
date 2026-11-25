import {
  Download,
  Fingerprint,
  Info,
  Keyboard,
  Loader2,
  Mic,
  Palette,
  Play,
  RefreshCw,
  ScrollText,
  Settings2,
  ShieldCheck,
  Upload,
  UserRound,
  Volume2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { UserAvatar } from "@/components/common/UserAvatar";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import { DiagnosticsSection } from "@/components/settings/DiagnosticsSection";
import { SettingRow, SectionTitle } from "@/components/settings/SettingsPrimitives";
import { LevelMeter } from "@/components/voice/LevelMeter";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { coreApi } from "@/core";
import type {
  CoreError,
  HotkeyAction,
  LocalePreference,
  PingReply,
  SoundEvent,
  SoundSet,
  UpdateCheck,
  UpdateProgress,
} from "@/core/api";
import { asCoreError, coreErrorText } from "@/lib/coreError";
import { readDebugFlags } from "@/lib/debug";
import { defaultUpdateSource, RELEASES_URL } from "@/lib/release";
import {
  HOTKEY_ACTIONS,
  acceleratorFromEvent,
  acceleratorFromMouse,
  formatAccelerator,
  markOnboardingReset,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import {
  useAppStore,
  type SettingsSection,
} from "@/store/appStore";
import { runCoreAction, useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useVoiceStore } from "@/store/voiceStore";

const sections: {
  id: SettingsSection;
  icon: typeof Settings2;
}[] = [
  { id: "profile", icon: UserRound },
  { id: "general", icon: Settings2 },
  { id: "appearance", icon: Palette },
  { id: "voice", icon: Mic },
  { id: "hotkeys", icon: Keyboard },
  { id: "identity", icon: Fingerprint },
  { id: "diagnostics", icon: ScrollText },
  { id: "updates", icon: Download },
  { id: "about", icon: Info },
];

/**
 * Profile: the nickname and the avatar preview. The default channel stays in
 * the general section; the server is the authority for the nickname, so saving
 * while connected also sends it to the server.
 */
function ProfileSection() {
  const { t } = useTranslation();
  const settings = useSettingsStore((store) => store.settings);
  const update = useSettingsStore((store) => store.update);
  const state = useCoreStore((store) => store.state);
  const [nickname, setNickname] = useState(settings?.nickname ?? "");

  if (!settings) {
    return null;
  }
  const self = state?.users.find((user) => user.id === state.selfUserId);

  async function saveNickname() {
    const value = nickname.trim();
    if (value.length < 2) {
      return;
    }
    await update({ nickname: value });
    if (state?.connection === "connected" && state.nickname !== value) {
      await runCoreAction(() => coreApi.setNickname(value));
    }
  }

  return (
    <div className="divide-y divide-border">
      <div>
        <SectionTitle>{t("settings.general.profile")}</SectionTitle>
        <div className="flex items-center gap-3 py-2">
          <UserAvatar
            name={self?.nickname || nickname || "?"}
            color={self?.color ?? null}
            serverId={state?.server?.id ?? null}
            userId={self?.id}
            avatarHash={self?.avatarHash ?? ""}
            size="xl"
          />
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-foreground">
              {t("settings.general.avatarPreview")}
            </p>
            <p className="max-w-sm text-[11px] leading-snug text-faint">
              {t("settings.general.avatarPreviewHint")}
            </p>
          </div>
        </div>
        <SettingRow label={t("settings.general.nickname")}>
          <div className="flex items-center gap-1.5">
            <Input
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              maxLength={32}
              className="w-44"
              data-testid="settings-nickname"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={nickname.trim().length < 2}
              onClick={() => void saveNickname()}
            >
              {t("common.save")}
            </Button>
          </div>
        </SettingRow>
        <p className="pb-2 text-[11px] text-faint">
          {state?.connection === "connected"
            ? t("settings.profile.connectedHint")
            : t("settings.profile.offlineHint")}
        </p>
      </div>
    </div>
  );
}

function GeneralSection() {
  const { t } = useTranslation();
  const settings = useSettingsStore((store) => store.settings);
  const update = useSettingsStore((store) => store.update);
  const closeSettings = useAppStore((store) => store.closeSettings);
  const state = useCoreStore((store) => store.state);

  if (!settings) {
    return null;
  }
  const voiceChannels = (state?.channels ?? [])
    .filter((channel) => channel.kind === "voice")
    .slice()
    .sort(
      (a, b) =>
        a.position - b.position || a.name.localeCompare(b.name),
    );

  return (
    <div className="divide-y divide-border">
      <div>
        <SectionTitle>{t("settings.general.interface")}</SectionTitle>
        <SettingRow label={t("settings.general.language")}>
          <Segmented<LocalePreference>
            value={settings.locale}
            onChange={(locale) => void update({ locale })}
            label={t("settings.general.language")}
            options={[
              { value: "ru", label: "Русский" },
              { value: "en", label: "English" },
            ]}
          />
        </SettingRow>
      </div>

      <div>
        <SectionTitle>{t("settings.general.window")}</SectionTitle>
        <SettingRow
          label={t("settings.general.closeToTray")}
          hint={t("settings.general.closeToTrayHint")}
        >
          <Switch
            checked={settings.closeToTray}
            onCheckedChange={(closeToTray) => void update({ closeToTray })}
            aria-label={t("settings.general.closeToTray")}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.general.economyMode")}
          hint={t("settings.general.economyModeHint")}
        >
          <Switch
            checked={settings.economyMode}
            onCheckedChange={(economyMode) => void update({ economyMode })}
            aria-label={t("settings.general.economyMode")}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.general.economyMinutes")}
          hint={t("settings.general.economyMinutesHint")}
        >
          <Input
            type="number"
            min={1}
            max={240}
            value={settings.economyModeIdleMinutes}
            disabled={!settings.economyMode}
            onChange={(event) => {
              const minutes = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(minutes)) {
                void update({
                  economyModeIdleMinutes: Math.min(240, Math.max(1, minutes)),
                });
              }
            }}
            className="w-24"
            aria-label={t("settings.general.economyMinutes")}
            data-testid="settings-economy-minutes"
          />
        </SettingRow>
      </div>

      <div>
        <SectionTitle>{t("settings.general.channels")}</SectionTitle>
        <SettingRow
          label={t("settings.general.defaultChannel")}
          hint={t("settings.general.defaultChannelHint")}
        >
          <Select
            value={settings.defaultChannelId ?? "none"}
            onChange={(event) =>
              void update({
                defaultChannelId:
                  event.target.value === "none"
                    ? null
                    : Number(event.target.value),
              })
            }
            data-testid="settings-default-channel"
          >
            <option value="none">{t("settings.general.noDefaultChannel")}</option>
            {voiceChannels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name}
              </option>
            ))}
          </Select>
        </SettingRow>
      </div>

      <div>
        <SectionTitle>{t("settings.general.onboarding")}</SectionTitle>
        <div className="flex flex-wrap items-center gap-2 py-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              // Defer the reset to the next launch so the wizard never opens
              // behind this still-mounted dialog.
              markOnboardingReset();
              closeSettings();
            }}
            data-testid="restart-onboarding"
          >
            <UserRound className="size-3.5" aria-hidden />
            {t("settings.general.restartOnboarding")}
          </Button>
          <p className="text-[11px] text-faint">
            {t("settings.general.restartOnboardingHint")}
          </p>
        </div>
      </div>

      <div className="pt-2 text-[11px] text-faint">
        {t("settings.general.persistedHint")}
      </div>
    </div>
  );
}

function VoiceSection() {
  const { t } = useTranslation();
  const settings = useSettingsStore((store) => store.settings);
  const updateVoice = useSettingsStore((store) => store.updateVoice);
  const devices = useVoiceStore((store) => store.devices);
  const voiceState = useVoiceStore((store) => store.state);
  const levelDb = useVoiceStore((store) => store.levels?.selfLevelDb ?? -100);

  useEffect(() => {
    void useVoiceStore.getState().refresh();
  }, []);

  if (!settings) {
    return null;
  }
  const voice = settings.voice;
  const testing = voiceState?.micTest === true;
  const available = (devices?.inputs.length ?? 0) > 0;
  const threshold =
    voice.gate.mode === "voiceActivation" ? voice.gate.threshold_db ?? -45 : -45;
  const speaking =
    voice.gate.mode === "voiceActivation" &&
    ((voiceState?.publishing ?? false) || levelDb > threshold);

  return (
    <div className="divide-y divide-border">
      <div>
        <div className="mb-1 flex items-center justify-between">
          <SectionTitle>{t("voice.devices")}</SectionTitle>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void useVoiceStore.getState().refresh()}
          >
            <RefreshCw className="size-3" aria-hidden />
            {t("voice.refresh")}
          </Button>
        </div>
        <SettingRow label={t("voice.inputDevice")}>
          <Select
            value={voice.inputDevice ?? "default"}
            onChange={(event) =>
              void updateVoice({
                inputDevice:
                  event.target.value === "default" ? null : event.target.value,
              })
            }
            data-testid="settings-input-device"
          >
            <option value="default">{t("voice.systemDefault")}</option>
            {devices?.inputs.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow label={t("voice.outputDevice")}>
          <Select
            value={voice.outputDevice ?? "default"}
            onChange={(event) =>
              void updateVoice({
                outputDevice:
                  event.target.value === "default" ? null : event.target.value,
              })
            }
            data-testid="settings-output-device"
          >
            <option value="default">{t("voice.systemDefault")}</option>
            {devices?.outputs.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </Select>
        </SettingRow>

        <div className="rounded-md border border-border bg-raised p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-[12px] font-medium text-foreground">
              <Volume2 className="size-4 text-accent" aria-hidden />
              {t("voice.level")}
            </span>
            <span className="tabular-nums text-[11px] text-muted">
              {Math.round(levelDb)} dB
            </span>
          </div>
          <LevelMeter
            className="mt-2"
            levelDb={levelDb}
            thresholdDb={
              voice.gate.mode === "voiceActivation"
                ? voice.gate.threshold_db
                : null
            }
            active={speaking}
            label={t("voice.level")}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-[11px] text-faint">
              {available
                ? testing
                  ? t("voice.testRunning")
                  : t("voice.testHint")
                : t("voice.noDevices")}
            </p>
            <Button
              size="xs"
              variant={testing ? "secondary" : "outline"}
              disabled={!available}
              onClick={() => {
                void coreApi.setVoiceMicTest(!testing).catch(() => {});
              }}
              data-testid="settings-mic-test"
            >
              {testing ? t("voice.testStop") : t("voice.testStart")}
            </Button>
          </div>
          {voiceState?.error ? (
            <p className="mt-2 text-[11px] text-danger">
              {t("voice.deviceError")}
            </p>
          ) : null}
        </div>
      </div>

      <div>
        <SectionTitle>{t("voice.transmission")}</SectionTitle>
        <SettingRow label={t("voice.mode")}>
          <Segmented
            value={voice.gate.mode}
            onChange={(mode) =>
              void updateVoice({
                gate:
                  mode === "voiceActivation"
                    ? {
                        mode: "voiceActivation",
                        threshold_db: threshold,
                        hold_ms: 300,
                      }
                    : { mode },
              })
            }
            label={t("voice.mode")}
            options={[
              { value: "pushToTalk", label: t("voice.gate.pushToTalk") },
              {
                value: "voiceActivation",
                label: t("voice.gate.voiceActivation"),
              },
              { value: "continuous", label: t("voice.gate.continuous") },
            ]}
          />
        </SettingRow>
        {voice.gate.mode === "voiceActivation" ? (
          <div className="py-2">
            <div className="flex items-center justify-between text-[11px] text-muted">
              <span>{t("voice.threshold")}</span>
              <span className="tabular-nums text-foreground">
                {threshold} dB
              </span>
            </div>
            <Slider
              min={-80}
              max={0}
              step={1}
              value={threshold}
              aria-label={t("voice.threshold")}
              onChange={(event) =>
                void updateVoice({
                  gate: {
                    mode: "voiceActivation",
                    threshold_db: Number(event.target.value),
                    hold_ms:
                      voice.gate.mode === "voiceActivation"
                        ? voice.gate.hold_ms
                        : 300,
                  },
                })
              }
              data-testid="settings-threshold"
            />
            <p className="text-[11px] text-faint">{t("voice.thresholdHint")}</p>
          </div>
        ) : null}
        {voice.gate.mode === "pushToTalk" ? (
          <p className="py-1 text-[11px] text-muted">
            {t("voice.pttHint")}
          </p>
        ) : null}
      </div>

      <div>
        <SectionTitle>{t("voice.processing")}</SectionTitle>
        <SettingRow label={t("voice.noiseModel")}>
          <Select
            value={voice.processing.noiseModel}
            onChange={(event) =>
              void updateVoice({
                processing: {
                  ...voice.processing,
                  noiseModel: event.target.value as
                    | "off"
                    | "webRtc"
                    | "rnNoise"
                    | "deepFilter",
                },
              })
            }
            data-testid="settings-noise-model"
          >
            <option value="rnNoise">{t("voice.noise.rnNoise")}</option>
            <option value="webRtc">{t("voice.noise.webRtc")}</option>
            <option value="off">{t("voice.noise.off")}</option>
          </Select>
        </SettingRow>
        {(
          [
            "echoCancellation",
            "noiseSuppression",
            "gainControl",
            "highPassFilter",
          ] as const
        ).map((stage) => (
          <SettingRow key={stage} label={t(`voice.stages.${stage}`)}>
            <Switch
              checked={voice.processing[stage]}
              onCheckedChange={(checked) =>
                void updateVoice({
                  processing: { ...voice.processing, [stage]: checked },
                })
              }
              aria-label={t(`voice.stages.${stage}`)}
            />
          </SettingRow>
        ))}
      </div>

      <div>
        <SectionTitle>{t("voice.soundSection")}</SectionTitle>
        <SettingRow label={t("voice.outputVolume")}>
          <div className="flex items-center gap-2">
            <Slider
              className="w-40"
              min={0}
              max={200}
              step={5}
              value={voice.outputVolume}
              aria-label={t("voice.outputVolume")}
              onChange={(event) =>
                void updateVoice({
                  outputVolume: Number(event.target.value),
                })
              }
            />
            <span className="w-10 text-right text-[11px] tabular-nums text-muted">
              {voice.outputVolume}%
            </span>
          </div>
        </SettingRow>
        <SettingRow
          label={t("voice.levelVoices")}
          hint={t("voice.levelVoicesHint")}
        >
          <Switch
            checked={voice.levelVoices}
            onCheckedChange={(levelVoices) =>
              void updateVoice({ levelVoices })
            }
            aria-label={t("voice.levelVoices")}
            data-testid="settings-level-voices"
          />
        </SettingRow>
        <SettingRow
          label={t("voice.soundsEnabled")}
          hint={t("voice.soundsHint")}
        >
          <Switch
            checked={voice.sounds.enabled}
            onCheckedChange={(enabled) =>
              void updateVoice({
                sounds: { ...voice.sounds, enabled },
              })
            }
            aria-label={t("voice.soundsEnabled")}
          />
        </SettingRow>
        <SettingRow label={t("voice.soundsVolume")}>
          <div className="flex items-center gap-2">
            <Slider
              className="w-40"
              min={0}
              max={100}
              step={5}
              value={voice.sounds.volume}
              disabled={!voice.sounds.enabled}
              aria-label={t("voice.soundsVolume")}
              onChange={(event) =>
                void updateVoice({
                  sounds: {
                    ...voice.sounds,
                    volume: Number(event.target.value),
                  },
                })
              }
            />
            <span className="w-10 text-right text-[11px] tabular-nums text-muted">
              {voice.sounds.volume}%
            </span>
          </div>
        </SettingRow>
        <SettingRow label={t("voice.soundSet.label")}>
          <Select
            className="w-40"
            value={voice.sounds.set}
            disabled={!voice.sounds.enabled}
            onChange={(event) =>
              void updateVoice({
                sounds: {
                  ...voice.sounds,
                  set: event.target.value as SoundSet,
                },
              })
            }
            aria-label={t("voice.soundSet.label")}
            data-testid="settings-sound-set"
          >
            <option value="soft">{t("voice.soundSet.soft")}</option>
            <option value="bright">{t("voice.soundSet.bright")}</option>
          </Select>
        </SettingRow>
        <div className="rounded-md border border-border">
          {SOUND_GROUPS.map(([group, events]) => (
            <div key={group} className="border-b border-border last:border-b-0">
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <span className="block text-[12px] font-medium text-foreground">
                    {t(`voice.soundGroups.${group}`)}
                  </span>
                  <span className="block text-[11px] text-faint">
                    {t(`voice.soundGroups.${group}Hint`)}
                  </span>
                </div>
                <Switch
                  checked={voice.sounds[group]}
                  disabled={!voice.sounds.enabled}
                  onCheckedChange={(checked) =>
                    void updateVoice({
                      sounds: { ...voice.sounds, [group]: checked },
                    })
                  }
                  aria-label={t(`voice.soundGroups.${group}`)}
                />
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-3 pb-2">
                {events.map((event) => (
                  <div
                    key={event}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="truncate text-[11px] text-muted">
                      {t(`voice.soundEvents.${event}`)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("voice.soundPreview", {
                        name: t(`voice.soundEvents.${event}`),
                      })}
                      title={t("voice.soundPreview", {
                        name: t(`voice.soundEvents.${event}`),
                      })}
                      data-testid={`settings-sound-preview-${event}`}
                      onClick={() => void coreApi.previewVoiceSound(event)}
                    >
                      <Play aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type SoundGroupKey =
  | "channel"
  | "microphone"
  | "sound"
  | "streams"
  | "messages"
  | "connection"
  | "pushToTalk";

const SOUND_GROUPS: [SoundGroupKey, SoundEvent[]][] = [
  ["channel", ["selfJoin", "selfLeave", "userJoin", "userLeave"]],
  ["microphone", ["micOff", "micOn"]],
  ["sound", ["soundOff", "soundOn"]],
  [
    "streams",
    ["streamStarted", "selfStreamStarted", "selfStreamEnded", "streamViewerJoined"],
  ],
  ["messages", ["directMessage"]],
  ["connection", ["connectionLost", "connectionRestored"]],
  ["pushToTalk", ["pttDown", "pttUp"]],
];

const hotkeyLabelKey: Record<HotkeyAction, string> = {
  pushToTalk: "voice.hotkeys.pushToTalk",
  toggleMute: "voice.hotkeys.toggleMute",
  toggleDeafen: "voice.hotkeys.toggleDeafen",
  commandPalette: "voice.hotkeys.commandPalette",
  openSettings: "voice.hotkeys.openSettings",
  leaveChannel: "voice.hotkeys.leaveChannel",
};

function HotkeysSection() {
  const { t } = useTranslation();
  const settings = useSettingsStore((store) => store.settings);
  const updateVoice = useSettingsStore((store) => store.updateVoice);
  const [capturing, setCapturing] = useState<HotkeyAction | null>(null);
  const captureRef = useRef<HotkeyAction | null>(null);

  useEffect(() => {
    captureRef.current = capturing;
  }, [capturing]);

  useEffect(() => {
    if (!capturing) {
      return;
    }
    function assign(action: HotkeyAction, accelerator: string | null) {
      if (!settings) {
        return;
      }
      const bindings = settings.voice.hotkeys.map((binding) => {
        if (binding.action === action) {
          return { action, accelerator };
        }
        if (
          accelerator !== null &&
          binding.accelerator?.toLowerCase() === accelerator.toLowerCase()
        ) {
          return { action: binding.action, accelerator: null };
        }
        return binding;
      });
      void updateVoice({ hotkeys: bindings });
      setCapturing(null);
    }
    function onKey(event: KeyboardEvent) {
      const action = captureRef.current;
      if (!action) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        assign(action, null);
        return;
      }
      const accelerator = acceleratorFromEvent(event);
      if (accelerator) {
        assign(action, accelerator);
      }
    }
    function onMouse(event: MouseEvent) {
      const action = captureRef.current;
      if (!action) {
        return;
      }
      const accelerator = acceleratorFromMouse(event.button);
      if (accelerator) {
        event.preventDefault();
        assign(action, accelerator);
      }
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouse, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouse, true);
    };
  }, [capturing, settings, updateVoice]);

  if (!settings) {
    return null;
  }

  return (
    <div>
      <SectionTitle>{t("voice.hotkeys.title")}</SectionTitle>
      <p className="mb-2 text-[11px] text-muted">{t("voice.hotkeys.hint")}</p>
      <div className="divide-y divide-border rounded-md border border-border">
        {HOTKEY_ACTIONS.map((action) => {
          const binding = settings.voice.hotkeys.find(
            (item) => item.action === action,
          );
          return (
            <div
              key={action}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <span className="text-[12px] text-foreground">
                {t(hotkeyLabelKey[action])}
              </span>
              <button
                type="button"
                onClick={() => setCapturing(action)}
                data-testid={`hotkey-${action}`}
                className={cn(
                  "min-w-[132px] rounded-sm border px-2 py-1 text-[11px] tabular-nums",
                  capturing === action
                    ? "border-accent/60 bg-accent/15 text-accent"
                    : binding?.accelerator
                      ? "border-border bg-raised text-foreground hover:bg-hover"
                      : "border-dashed border-border text-faint hover:bg-hover",
                )}
              >
                {capturing === action
                  ? t("voice.hotkeys.capturing")
                  : binding?.accelerator
                    ? formatAccelerator(
                        binding.accelerator,
                        t("controls.mouseSideButton"),
                      )
                    : t("voice.hotkeys.unbound")}
              </button>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void updateVoice({
              hotkeys: [
                { action: "pushToTalk", accelerator: "X1/X2" },
                { action: "toggleMute", accelerator: "Ctrl+Shift+M" },
                { action: "toggleDeafen", accelerator: "Ctrl+Shift+D" },
                { action: "commandPalette", accelerator: "Ctrl+K" },
                { action: "openSettings", accelerator: "Ctrl+Comma" },
                { action: "leaveChannel", accelerator: "Ctrl+Shift+L" },
              ],
            })
          }
        >
          {t("voice.hotkeys.reset")}
        </Button>
        <p className="text-[11px] text-faint">
          {t("voice.hotkeys.clearHint")}
        </p>
      </div>
    </div>
  );
}

function IdentitySection() {
  const { t } = useTranslation();
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [mode, setMode] = useState<"export" | "import">("export");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CoreError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    void coreApi
      .identityInfo()
      .then((info) => setFingerprint(info.fingerprint))
      .catch(() => setFingerprint(null));
  }, []);

  async function chooseFile() {
    try {
      const picked = await coreApi.pickIdentityPath(
        mode === "export" ? "save" : "open",
      );
      if (picked) {
        setPath(picked);
      }
    } catch (reason) {
      setError(asCoreError(reason));
    }
  }

  async function submit() {
    if (!path || password.length === 0 || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      if (mode === "export") {
        await coreApi.exportIdentity(path, password);
        setDone(t("settings.identity.exported"));
      } else {
        const info = await coreApi.importIdentity(path, password);
        setFingerprint(info.fingerprint);
        setDone(t("settings.identity.imported"));
      }
      setPassword("");
    } catch (reason) {
      setError(asCoreError(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-raised p-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-accent" aria-hidden />
          <h3 className="text-[13px] font-semibold text-foreground">
            {t("settings.identity.title")}
          </h3>
        </div>
        <p className="mt-1 text-[11px] text-muted">
          {t("settings.identity.hint")}
        </p>
        <p
          className="mt-2 break-all font-mono text-[11px] text-muted"
          data-testid="identity-fingerprint"
        >
          {fingerprint ?? t("settings.identity.loading")}
        </p>
      </div>

      <div className="rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[13px] font-semibold text-foreground">
            {t("settings.identity.transfer")}
          </h3>
          <Segmented
            value={mode}
            onChange={(value) => {
              setMode(value);
              setPath(null);
              setDone(null);
              setError(null);
            }}
            options={[
              { value: "export", label: t("settings.identity.export") },
              { value: "import", label: t("settings.identity.import") },
            ]}
          />
        </div>
        <p className="mt-1 text-[11px] text-muted">
          {t("settings.identity.transferHint")}
        </p>
        <div className="mt-2 flex items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => void chooseFile()}>
            {mode === "export" ? (
              <Download className="size-3.5" aria-hidden />
            ) : (
              <Upload className="size-3.5" aria-hidden />
            )}
            {t("settings.identity.chooseFile")}
          </Button>
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint"
            title={path ?? undefined}
          >
            {path ?? t("settings.identity.noFile")}
          </span>
        </div>
        <label className="mt-2 block space-y-1">
          <span className="text-[11px] text-muted">
            {t("settings.identity.password")}
          </span>
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            data-testid="identity-password"
          />
        </label>
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            disabled={!path || password.length === 0 || busy}
            onClick={() => void submit()}
            data-testid="identity-submit"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : mode === "export" ? (
              <Download className="size-3.5" aria-hidden />
            ) : (
              <Upload className="size-3.5" aria-hidden />
            )}
            {mode === "export"
              ? t("settings.identity.export")
              : t("settings.identity.import")}
          </Button>
          {done ? (
            <span role="status" className="text-[11px] text-success">
              {done}
            </span>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-[11px] text-danger" title={coreErrorText(error).detail}>
            {t(coreErrorText(error).key)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function UpdatesSection() {
  const { t } = useTranslation();
  const settings = useSettingsStore((store) => store.settings);
  const update = useSettingsStore((store) => store.update);
  const [source, setSource] = useState(settings?.updateSource ?? "");
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<"check" | "install" | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  useEffect(
    () => coreApi.subscribeUpdateProgress((event) => setProgress(event)),
    [],
  );

  useEffect(() => {
    void coreApi
      .ping()
      .then((reply) => setCurrentVersion(reply.clientVersion))
      .catch(() => {});
  }, []);

  if (!settings) {
    return null;
  }

  async function saveSource() {
    setCheck(null);
    setFailed(false);
    await update({ updateSource: source.trim() || null });
  }

  async function checkNow() {
    if (busy) {
      return;
    }
    setBusy("check");
    setFailed(false);
    setCheck(null);
    try {
      setCheck(await coreApi.checkForUpdate());
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  async function installNow() {
    if (busy) {
      return;
    }
    setBusy("install");
    setFailed(false);
    setProgress(null);
    try {
      // On Windows the core starts the installer and exits; the installer
      // restarts the client. If it returns, show the error.
      await coreApi.installUpdate();
    } catch {
      setFailed(true);
      setBusy(null);
    }
  }

  const percent =
    progress?.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <div className="divide-y divide-border">
      <div>
        <SectionTitle>{t("settings.updates.startup")}</SectionTitle>
        <SettingRow
          label={t("settings.updates.autostart")}
          hint={t("settings.updates.autostartHint")}
        >
          <Switch
            checked={settings.autostart}
            onCheckedChange={(autostart) => void update({ autostart })}
            aria-label={t("settings.updates.autostart")}
            data-testid="settings-autostart"
          />
        </SettingRow>
      </div>

      <div>
        <SectionTitle>{t("settings.updates.source")}</SectionTitle>
        <p className="mb-2 text-[11px] text-muted">
          {t("settings.updates.sourceHint")}
        </p>
        <div className="flex items-center gap-1.5">
          <Input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder={defaultUpdateSource()}
            className="min-w-0 flex-1"
            spellCheck={false}
            data-testid="settings-update-source"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={source.trim() === (settings.updateSource ?? "")}
            onClick={() => void saveSource()}
          >
            {t("common.save")}
          </Button>
        </div>
        <p className="mt-1 text-[11px] text-faint">
          {t("settings.updates.sourceEnv")}
        </p>
      </div>

      <div>
        <SectionTitle>{t("settings.updates.check")}</SectionTitle>
        <div className="flex flex-wrap items-center gap-2 py-1">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void checkNow()}
            data-testid="settings-check-updates"
          >
            {busy === "check" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden />
            )}
            {t("settings.updates.checkNow")}
          </Button>
          <span className="text-[11px] text-faint">
            {t("settings.updates.current", {
              version: check?.currentVersion ?? currentVersion ?? "…",
            })}
          </span>
        </div>

        {failed ? (
          <p role="alert" className="mt-2 text-[11px] text-danger">
            {t("settings.updates.failed")}
          </p>
        ) : null}

        {check && !check.configured ? (
          <p className="mt-2 text-[11px] text-muted">
            {t("settings.updates.notConfigured")}
          </p>
        ) : null}

        {check?.configured && !check.available ? (
          <p role="status" className="mt-2 text-[11px] text-success">
            {t("settings.updates.upToDate", { version: check.currentVersion })}
          </p>
        ) : null}

        {check?.available ? (
          <div className="mt-2 rounded-md border border-accent/40 bg-accent/10 p-3">
            <p className="text-[13px] font-semibold text-foreground">
              {t("settings.updates.available", {
                version: check.available.version,
              })}
            </p>
            {check.available.date ? (
              <p className="mt-0.5 text-[11px] text-faint">
                {new Date(check.available.date).toLocaleDateString()}
              </p>
            ) : null}
            {check.available.notes ? (
              <p className="mt-1 whitespace-pre-line text-[11px] text-muted">
                {check.available.notes}
              </p>
            ) : null}
            <p className="mt-2 text-[11px] text-faint">
              {t("settings.updates.restartHint")}
            </p>
            {busy === "install" ? (
              <p className="mt-2 text-[11px] text-muted" role="status">
                {percent === null
                  ? t("settings.updates.downloading")
                  : t("settings.updates.downloadingPercent", { percent })}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => void installNow()}
                data-testid="settings-install-update"
              >
                <Download className="size-3.5" aria-hidden />
                {t("settings.updates.installAndRestart")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() =>
                  setCheck(check ? { ...check, available: null } : check)
                }
              >
                {t("settings.updates.later")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <p className="pt-2 text-[11px] leading-snug text-faint">
        {t("settings.updates.manualHint", { url: RELEASES_URL })}
      </p>
    </div>
  );
}

function AboutSection() {
  const { t } = useTranslation();
  const closeSettings = useAppStore((store) => store.closeSettings);
  const state = useCoreStore((store) => store.state);
  const [ping, setPing] = useState<PingReply | null>(null);
  const [failure, setFailure] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void coreApi
      .ping()
      .then((reply) => {
        if (!cancelled) {
          setPing(reply);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailure(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const showGallery = readDebugFlags().gallery;

  function openGallery() {
    closeSettings();
    window.location.hash = "#/gallery";
  }

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 rounded-md border border-border bg-raised p-3 text-[12px]">
        <dt className="text-muted">{t("settings.about.version")}</dt>
        <dd className="text-foreground" data-testid="about-version">
          {ping ? `v${ping.clientVersion}` : failure ? t("common.unknown") : "…"}
        </dd>
        <dt className="text-muted">{t("settings.about.protocol")}</dt>
        <dd className="text-foreground">
          v{ping?.protocolVersion ?? state?.protocolVersion ?? "—"}
        </dd>
        <dt className="text-muted">{t("settings.about.server")}</dt>
        <dd className="text-foreground">
          {state?.server
            ? `${state.server.name} · v${state.server.version}`
            : t("main.notConnected")}
        </dd>
        <dt className="text-muted">{t("settings.about.build")}</dt>
        <dd className="text-foreground">{t("settings.about.buildValue")}</dd>
      </dl>

      {showGallery ? (
        <section className="rounded-md border border-border p-3">
          <h3 className="text-[13px] font-semibold text-foreground">
            {t("settings.about.gallery")}
          </h3>
          <p className="mt-0.5 text-[12px] text-muted">
            {t("settings.about.galleryHint")}
          </p>
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            onClick={openGallery}
          >
            {t("settings.about.gallery")}
          </Button>
        </section>
      ) : null}

      <p className="text-[11px] leading-snug text-faint">
        {t("settings.about.legal")}
      </p>
    </div>
  );
}

export function SettingsDialog() {
  const { t } = useTranslation();
  const open = useAppStore((state) => state.settingsOpen);
  const section = useAppStore((state) => state.settingsSection);
  const closeSettings = useAppStore((state) => state.closeSettings);
  const setSection = useAppStore((state) => state.setSettingsSection);
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeSettings();
        }
      }}
    >
      <DialogContent
        closeLabel={t("settings.close")}
        className="max-h-[calc(90vh/var(--fixed-scale))] w-[min(920px,94vw)]"
        data-testid="settings-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
      >
        <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4 pr-12">
          <span className="flex size-8 items-center justify-center rounded-md border border-border bg-raised text-muted">
            <Settings2 className="size-4" aria-hidden />
          </span>
          <div>
            <DialogTitle className="text-[14px] font-semibold">
              {t("settings.title")}
            </DialogTitle>
            <DialogDescription className="text-[12px] text-muted">
              {t("settings.subtitle")}
            </DialogDescription>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav
            aria-label={t("settings.title")}
            className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-border p-2"
          >
            {sections.map((item) => {
              const Icon = item.icon;
              const selected = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  data-testid={`settings-tab-${item.id}`}
                  onClick={() => setSection(item.id)}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-sm px-2 text-left text-[13px] whitespace-nowrap",
                    selected
                      ? "bg-active text-foreground"
                      : "text-muted hover:bg-hover hover:text-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "size-4",
                      selected ? "text-accent" : "text-faint",
                    )}
                    aria-hidden
                  />
                  {t(
                    item.id === "identity"
                      ? "settings.tabs.identity"
                      : `settings.tabs.${item.id}`,
                  )}
                </button>
              );
            })}
            <p className="mt-auto px-2 py-2 text-[10px] leading-snug text-faint">
              {t("settings.about.buildValue")}
            </p>
          </nav>

          <div
            ref={contentRef}
            tabIndex={-1}
            data-testid="settings-content"
            className="min-h-[420px] min-w-0 flex-1 overflow-y-auto p-4 focus:outline-none"
          >
            {section === "profile" ? <ProfileSection /> : null}
            {section === "general" ? <GeneralSection /> : null}
            {section === "appearance" ? <AppearanceSection /> : null}
            {section === "voice" ? <VoiceSection /> : null}
            {section === "hotkeys" ? <HotkeysSection /> : null}
            {section === "identity" ? <IdentitySection /> : null}
            {section === "diagnostics" ? <DiagnosticsSection /> : null}
            {section === "updates" ? <UpdatesSection /> : null}
            {section === "about" ? <AboutSection /> : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
