import {
  AudioLines,
  Ear,
  HeadphoneOff,
  Headphones,
  Keyboard,
  LogIn,
  LogOut,
  Mic,
  MicOff,
  Radio,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { QualityIndicator } from "@/components/common/QualityIndicator";
import { ProfileMenu } from "@/components/layout/ProfileMenu";
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
import { qualityFor } from "@/lib/quality";
import { formatAccelerator } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";
import { runCoreAction, useCoreStore } from "@/store/coreStore";
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
            "flex size-9 items-center justify-center rounded-md border transition-transform duration-150 active:scale-[0.97]",
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

export function ControlBar() {
  const { t } = useTranslation();
  const state = useCoreStore((core) => core.state);
  const openConnect = useAppStore((app) => app.openConnect);
  const voiceState = useVoiceStore((voice) => voice.state);
  const stats = useVoiceStore((voice) => voice.stats);
  const previousStats = useVoiceStore((voice) => voice.previousStats);
  const [gateOpen, setGateOpen] = useState(false);

  const connected = state?.connection === "connected";
  const self = state?.users.find((user) => user.id === state.selfUserId);
  const micMuted =
    self?.voice.selfMuted === true || self?.voice.serverMuted === true;
  const soundMuted =
    self?.voice.selfDeafened === true || self?.voice.serverDeafened === true;
  const channel = state?.channels.find((item) => item.id === self?.channelId);
  const idleChannel = channel?.afk === true;
  const inVoice = connected && (voiceState?.channelId ?? 0) !== 0;
  const connection = qualityFor({
    connection: state?.connection ?? null,
    voiceChannelId: voiceState?.channelId ?? 0,
    stats,
    previous: previousStats,
  });
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

  function chooseGate(mode: GateMode["mode"]) {
    setGateOpen(false);
    const next: GateMode =
      mode === "voiceActivation"
        ? {
            mode: "voiceActivation",
            threshold_db: threshold ?? -45,
            hold_ms: 300,
          }
        : { mode };
    void runCoreAction(() => coreApi.setVoiceGate(next));
  }

  return (
    <footer
      data-testid="control-bar"
      className="flex h-14 shrink-0 items-center gap-3 bg-chrome px-3"
    >
      <div className="flex w-[236px] min-w-0 items-center gap-2.5">
        <ProfileMenu />
      </div>

      <div className="flex flex-1 items-center justify-center gap-1">
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
              coreApi.setVoiceState({ selfMuted: !self?.voice.selfMuted }),
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
                    "flex size-9 items-center justify-center rounded-md border transition-transform duration-150 active:scale-[0.97]",
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
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            role="menu"
            aria-label={t("voice.mode")}
            data-testid="gate-menu"
            side="top"
            align="center"
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
                        {threshold ?? -45} dB
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
              coreApi.setVoiceState({
                selfDeafened: !self?.voice.selfDeafened,
              }),
            )
          }
          testId="control-sound"
        />
        {!connected ? (
          <ControlButton
            icon={LogIn}
            label={t("main.connect")}
            onClick={() => openConnect()}
            testId="control-connect"
          />
        ) : null}
      </div>

      <div className="flex w-[260px] items-center justify-end gap-3">
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          <QualityIndicator quality={connection} />
          <span className="tabular-nums">
            {inVoice && stats?.pingMs != null
              ? t("quality.latency", { ms: Math.round(stats.pingMs) })
              : connected
                ? t("quality.online")
                : state?.connection === "reconnecting"
                  ? t("quality.reconnecting")
                  : t("quality.offline")}
          </span>
        </div>
        <span aria-hidden className="h-6 w-px bg-border" />
        <div className="min-w-0 text-right">
          {channel ? (
            <>
              <p className="truncate text-[12px] font-medium text-foreground">
                {channel.name}
              </p>
              <p className="truncate text-[10px] text-faint">
                {t("controls.connected")}
              </p>
            </>
          ) : (
            <p className="truncate text-[12px] font-medium text-foreground">
              {t("controls.notConnected")}
            </p>
          )}
        </div>
        {inVoice ? (
          <button
            type="button"
            onClick={() => void leaveVoiceChannel()}
            data-testid="control-leave"
            className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground"
          >
            <LogOut className="size-3.5" aria-hidden />
            {t("channel.leave")}
          </button>
        ) : null}
      </div>
    </footer>
  );
}

function GateIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-4" aria-hidden />;
}
