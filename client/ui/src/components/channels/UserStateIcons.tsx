import { HeadphoneOff, MicOff, MoonStar } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { LiveBadge } from "@/components/streams/LiveBadge";
import type { VoiceStateView } from "@/core/api";

function StatusIcon({
  label,
  className,
  children,
}: {
  label: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex items-center"
    >
      <span className={className} aria-hidden>
        {children}
      </span>
    </span>
  );
}

/** Speaking indicator, ready for the local audio engine of stage 2.3. */
export function SpeakingIndicator() {
  const { t } = useTranslation();
  const label = t("users.speaking");
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="flex h-3.5 w-4 items-end justify-center gap-[2px] pb-[2px]"
    >
      <span className="speaking-bar block h-1.5 w-[2px] rounded-full bg-accent" />
      <span className="speaking-bar block h-3.5 w-[2px] rounded-full bg-accent" />
      <span className="speaking-bar block h-2.5 w-[2px] rounded-full bg-accent" />
    </span>
  );
}

export interface UserStateIconsProps {
  voice: VoiceStateView;
  streaming: boolean;
  speaking?: boolean;
}

/** Microphone, deafen, away and stream badges from the control plane. */
export function UserStateIcons({
  voice,
  streaming,
  speaking = false,
}: UserStateIconsProps) {
  const { t } = useTranslation();
  const micMuted = voice.selfMuted || voice.serverMuted;
  const soundMuted = voice.selfDeafened || voice.serverDeafened;

  return (
    <span className="flex items-center gap-1.5">
      {speaking ? <SpeakingIndicator /> : null}
      {streaming ? <LiveBadge variant="icon" /> : null}
      {micMuted ? (
        <StatusIcon label={t("users.micMuted")} className="text-danger">
          <MicOff className="size-3.5" />
        </StatusIcon>
      ) : null}
      {soundMuted ? (
        <StatusIcon label={t("users.soundMuted")} className="text-danger">
          <HeadphoneOff className="size-3.5" />
        </StatusIcon>
      ) : null}
      {voice.away ? (
        <StatusIcon label={t("users.away")} className="text-warning">
          <MoonStar className="size-3.5" />
        </StatusIcon>
      ) : null}
    </span>
  );
}
