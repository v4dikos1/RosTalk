import {
  AudioLines,
  Ear,
  HeadphoneOff,
  Headphones,
  Keyboard,
  LogOut,
  Mic,
  MicOff,
  Radio,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { coreApi } from "@/core";
import type { GateMode } from "@/core/api";
import { leaveVoiceChannel } from "@/lib/channels";
import { formatAccelerator } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { runCoreAction, useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useVoiceStore } from "@/store/voiceStore";

interface ControlButtonProps {
  icon: LucideIcon;
  label: string;
  /** Extra tooltip line, for example a push-to-talk hook error. */
  hint?: string | undefined;
  active?: boolean;
  disabled?: boolean;
  tone?: "neutral" | "danger" | "accent";
  onClick: () => void;
  testId?: string;
}

function ControlButton({
  icon: Icon,
  label,
  hint,
  active = false,
  disabled = false,
  tone = "neutral",
  onClick,
  testId,
}: ControlButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          data-testid={testId}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "flex size-8 items-center justify-center rounded-md border transition-transform duration-150 active:scale-[0.97]",
            disabled && "cursor-not-allowed opacity-45",
            active
              ? tone === "danger"
                ? "border-danger/50 bg-danger/15 text-danger"
                : tone === "accent"
                  ? "border-accent/60 bg-accent/15 text-accent"
                  : "border-border-strong bg-active text-foreground"
              : "border-transparent text-muted hover:bg-hover hover:text-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {hint ? `${label}: ${hint}` : label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The single voice group of stage P26 (ADR 0038).
 *
 * Microphone, transmission mode, self-monitoring, sound and leaving the
 * channel live together in the sidebar footer. Leaving asks the core, which
 * knows the voice channel the user is actually connected to — not the channel
 * currently open in the centre pane (playtest-2, complaints 14–15).
 */
export function VoiceControls({ className }: { className?: string }) {
  const { t } = useTranslation();
  const state = useCoreStore((core) => core.state);
  const voiceState = useVoiceStore((voice) => voice.state);
  const activationThreshold = useSettingsStore(
    (store) => store.settings?.voice.activationThresholdDb ?? -45,
  );
  const [gateOpen, setGateOpen] = useState(false);

  const connected = state?.connection === "connected";
  const self = state?.users.find((user) => user.id === state.selfUserId);
  const micMuted =
    self?.voice.selfMuted === true || self?.voice.serverMuted === true;
  const soundMuted =
    self?.voice.selfDeafened === true || self?.voice.serverDeafened === true;
  const presenceChannel = state?.channels.find(
    (item) => item.id === self?.channelId,
  );
  const idleChannel = presenceChannel?.afk === true;
  const engineChannelId = voiceState?.channelId ?? 0;
  const activeChannelId =
    engineChannelId > 0 ? engineChannelId : (self?.channelId ?? 0);
  const voiceChannel = state?.channels.find(
    (item) => item.id === activeChannelId,
  );
  const inVoice = activeChannelId > 0;

  const gate: GateMode = voiceState?.gate ?? {
    mode: "voiceActivation",
    threshold_db: -45,
    hold_ms: 300,
  };
  const ptt = voiceState?.pushToTalk ?? null;
  const pttMode = gate.mode === "pushToTalk";
  // "unknown" is the first few milliseconds before the shell reports the hook.
  const pttBroken =
    pttMode && (ptt?.hook === "unavailable" || ptt?.hook === "unsupported");
  const gateIcon =
    gate.mode === "pushToTalk"
      ? Keyboard
      : gate.mode === "continuous"
        ? Radio
        : AudioLines;
  const bindingLabel = formatAccelerator(
    ptt?.binding ?? "",
    t("controls.mouseSideButton"),
  );
  const gateLabel = pttMode
    ? pttBroken
      ? t("controls.pttUnavailable")
      : t("controls.pttBinding", { binding: bindingLabel })
    : t(`controls.gate.${gate.mode}`);
  const threshold = gate.mode === "voiceActivation" ? gate.threshold_db : null;
  const leaveLabel = t("channel.leave");

  function chooseGate(mode: GateMode["mode"]) {
    setGateOpen(false);
    const next: GateMode =
      mode === "voiceActivation"
        ? {
            mode: "voiceActivation",
            threshold_db: threshold ?? activationThreshold,
            hold_ms: 300,
          }
        : { mode };
    void runCoreAction(() => coreApi.setVoiceGate(next));
  }

  return (
    <div
      role="group"
      aria-label={t("controls.voiceGroup")}
      data-testid="voice-controls"
      className={cn(
        "rounded-md border border-border bg-surface p-1.5",
        className,
      )}
    >
      <div className="flex items-center gap-1">
        <ControlButton
          icon={micMuted ? MicOff : Mic}
          label={
            idleChannel
              ? t("controls.micIdle")
              : micMuted
                ? t("controls.micOff")
                : t("controls.micOn")
          }
          active={micMuted}
          disabled={!connected || self?.voice.serverMuted === true || idleChannel}
          tone="danger"
          onClick={() =>
            void runCoreAction(() =>
              coreApi.toggleVoiceState("mute"),
            )
          }
          testId="control-mic"
        />

        <DropdownMenu open={gateOpen} onOpenChange={setGateOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={gateLabel}
                  data-testid="control-gate"
                  className={cn(
                    "flex size-8 items-center justify-center rounded-md border transition-transform duration-150 active:scale-[0.97]",
                    gate.mode !== "voiceActivation"
                      ? "border-border-strong bg-active text-foreground"
                      : "border-transparent text-muted hover:bg-hover hover:text-foreground",
                    gateOpen && "bg-active text-foreground",
                  )}
                >
                  <GateIcon icon={gateIcon} />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>
              {t("controls.gateTooltip", {
                mode: t(`controls.gate.${gate.mode}`),
                threshold:
                  threshold === null
                    ? t("controls.gateNoThreshold")
                    : `${threshold} dB`,
              })}
              {pttBroken && ptt?.error ? (
                <span className="mt-1 block text-[11px] text-danger">
                  {ptt.error}
                </span>
              ) : null}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            role="menu"
            aria-label={t("voice.mode")}
            data-testid="gate-menu"
            side="top"
            align="start"
            className="w-60"
          >
            <DropdownMenuLabel>{t("voice.mode")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={gate.mode}
              onValueChange={(value) => chooseGate(value as GateMode["mode"])}
            >
              {(["voiceActivation", "pushToTalk", "continuous"] as const).map(
                (mode) => (
                  <DropdownMenuRadioItem
                    key={mode}
                    value={mode}
                    data-testid={`gate-option-${mode}`}
                    className="py-1.5"
                  >
                    <span className="min-w-0 flex-1">
                      {t(`controls.gate.${mode}`)}
                    </span>
                    {mode === "voiceActivation" ? (
                      <span className="shrink-0 text-[10px] tabular-nums text-faint">
                        {threshold ?? activationThreshold} dB
                      </span>
                    ) : null}
                  </DropdownMenuRadioItem>
                ),
              )}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <ControlButton
          icon={Ear}
          label={
            voiceState?.micTest
              ? t("controls.micTestOff")
              : t("controls.micTestOn")
          }
          hint={t("voice.testHint")}
          active={voiceState?.micTest === true}
          tone="accent"
          onClick={() =>
            void runCoreAction(() =>
              coreApi.setVoiceMicTest(!(voiceState?.micTest ?? false)),
            )
          }
          testId="control-mic-test"
        />
        <ControlButton
          icon={soundMuted ? HeadphoneOff : Headphones}
          label={soundMuted ? t("controls.soundOff") : t("controls.soundOn")}
          hint={t("controls.soundHint")}
          active={soundMuted}
          disabled={!connected || self?.voice.serverDeafened === true}
          tone="danger"
          onClick={() =>
            void runCoreAction(() =>
              coreApi.toggleVoiceState("deafen"),
            )
          }
          testId="control-sound"
        />
      </div>

      {inVoice ? (
        <button
          type="button"
          onClick={() => void leaveVoiceChannel()}
          data-testid="control-leave"
          aria-label={
            voiceChannel
              ? t("controls.leaveHint", { channel: voiceChannel.name })
              : leaveLabel
          }
          title={
            voiceChannel
              ? t("controls.leaveHint", { channel: voiceChannel.name })
              : leaveLabel
          }
          className="mt-1 flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border border-border px-2 text-[11px] text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground"
        >
          <LogOut className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{leaveLabel}</span>
          {voiceChannel ? (
            <span className="ml-auto min-w-0 truncate text-[10px] text-faint">
              {voiceChannel.name}
            </span>
          ) : null}
        </button>
      ) : (
        <p
          data-testid="voice-idle"
          className="mt-1 truncate px-1 text-[11px] text-faint"
        >
          {t("controls.notConnected")}
        </p>
      )}
    </div>
  );
}

function GateIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-4" aria-hidden />;
}
