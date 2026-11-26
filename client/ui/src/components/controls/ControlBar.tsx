import { LogIn } from "lucide-react";
import { useTranslation } from "react-i18next";

import { QualityIndicator } from "@/components/common/QualityIndicator";
import { ProfileMenu } from "@/components/layout/ProfileMenu";
import { Button } from "@/components/ui/button";
import { qualityFor } from "@/lib/quality";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useVoiceStore } from "@/store/voiceStore";

/**
 * The bottom bar: profile, connection quality and the current voice channel.
 *
 * The voice buttons used to live here too. Stage P26 (ADR 0038) moved them
 * into one group in the sidebar footer, next to the list the user watches;
 * this bar keeps the identity and status and does not repeat the controls.
 */
export function ControlBar() {
  const { t } = useTranslation();
  const state = useCoreStore((core) => core.state);
  const openConnect = useAppStore((app) => app.openConnect);
  const voiceState = useVoiceStore((voice) => voice.state);
  const stats = useVoiceStore((voice) => voice.stats);
  const previousStats = useVoiceStore((voice) => voice.previousStats);

  const connected = state?.connection === "connected";
  const self = state?.users.find((user) => user.id === state.selfUserId);
  const channel = state?.channels.find((item) => item.id === self?.channelId);
  const inVoice = connected && (voiceState?.channelId ?? 0) !== 0;
  const connection = qualityFor({
    connection: state?.connection ?? null,
    voiceChannelId: voiceState?.channelId ?? 0,
    stats,
    previous: previousStats,
  });

  return (
    <footer
      data-testid="control-bar"
      className="flex h-14 shrink-0 items-center gap-3 bg-chrome px-3"
    >
      <div className="flex w-[236px] min-w-0 items-center gap-2.5">
        <ProfileMenu />
      </div>

      <div className="flex flex-1 items-center justify-center gap-1">
        {!connected ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openConnect()}
            data-testid="control-connect"
          >
            <LogIn className="size-3.5" aria-hidden />
            {t("main.connect")}
          </Button>
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
      </div>
    </footer>
  );
}
