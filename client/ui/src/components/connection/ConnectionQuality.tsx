import { Activity, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { QualityIndicator } from "@/components/common/QualityIndicator";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ConnectionQuality } from "@/lib/quality";
import { coreErrorText } from "@/lib/coreError";
import { cn } from "@/lib/utils";
import { coreApi } from "@/core";
import { qualityFor } from "@/lib/quality";
import { useCoreStore } from "@/store/coreStore";
import { useVoiceStore } from "@/store/voiceStore";

function latencyQuality(latencyMs: number | null): ConnectionQuality {
  if (latencyMs === null) {
    return "good";
  }
  if (latencyMs <= 80) {
    return "excellent";
  }
  if (latencyMs <= 180) {
    return "good";
  }
  return "fair";
}

/**
 * Bottom-bar connection indicator. Clicking it opens the details: phase,
 * server, protocol, ping, reconnect counter and the audio monitor state.
 */
export function ConnectionQuality({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const state = useCoreStore((store) => store.state);
  const voice = useVoiceStore((store) => store.state);
  const levelDb = useVoiceStore((store) => store.levels?.selfLevelDb ?? -100);
  const stats = useVoiceStore((store) => store.stats);
  const previousStats = useVoiceStore((store) => store.previousStats);
  const [open, setOpen] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function measure() {
      const started = performance.now();
      try {
        await coreApi.ping();
        if (!cancelled) {
          setLatency(Math.round(performance.now() - started));
        }
      } catch {
        if (!cancelled) {
          setLatency(null);
        }
      }
    }
    void measure();
    const timer = window.setInterval(() => void measure(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const phaseQuality = qualityFor({
    connection: state?.connection ?? null,
    voiceChannelId: voice?.channelId ?? 0,
    stats,
    previous: previousStats,
  });
  const quality =
    phaseQuality === "good" ? latencyQuality(latency) : phaseQuality;
  const connected = state?.connection === "connected";
  const label = connected
    ? t("quality.online")
    : state?.connection === "reconnecting"
      ? t("quality.reconnecting")
      : state?.connection === "connecting"
        ? t("quality.connecting")
        : t("quality.offline");
  const activeServer = state?.servers.find(
    (server) => server.id === state?.activeServerId,
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("quality.details")}
          data-testid="quality-indicator"
          className={cn(
            "flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[11px] text-muted hover:bg-hover hover:text-foreground",
            open && "bg-active text-foreground",
          )}
        >
          <QualityIndicator quality={quality} />
          {compact ? null : <span>{label}</span>}
        </button>
      </PopoverTrigger>

      <PopoverContent
        role="dialog"
        aria-label={t("quality.details")}
        data-testid="quality-details"
        align="start"
        side="bottom"
        className="w-[280px] p-3 text-left"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-accent" aria-hidden />
            <div>
              <p className="text-[12px] font-semibold text-foreground">
                {t("quality.title")}
              </p>
              <p className="text-[11px] text-muted">{label}</p>
            </div>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => setOpen(false)}
            className="inline-flex size-6 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>

        <dl className="mt-2.5 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[11px]">
          <dt className="text-muted">{t("quality.server")}</dt>
          <dd className="truncate text-foreground">
            {state?.server?.name ?? t("main.notConnected")}
          </dd>
          <dt className="text-muted">{t("quality.host")}</dt>
          <dd className="truncate font-mono text-[11px] text-foreground">
            {activeServer?.host ?? "—"}
          </dd>
          <dt className="text-muted">{t("quality.latencyLabel")}</dt>
          <dd className="tabular-nums text-foreground">
            {latency === null ? "—" : t("quality.latency", { ms: latency })}
          </dd>
          <dt className="text-muted">{t("quality.protocol")}</dt>
          <dd className="text-foreground">
            v{state?.protocolVersion ?? 0} · {state?.clientVersion ?? "—"}
          </dd>
          {state?.connection === "reconnecting" && state.reconnect ? (
            <>
              <dt className="text-muted">{t("quality.attempt")}</dt>
              <dd className="text-foreground">
                {t("quality.attemptValue", {
                  attempt: state.reconnect.attempt,
                  seconds: Math.max(
                    1,
                    Math.round(state.reconnect.delayMs / 1000),
                  ),
                })}
              </dd>
            </>
          ) : null}
          <dt className="text-muted">{t("quality.microphone")}</dt>
          <dd className={cn(voice?.error ? "text-danger" : "text-success")}>
            {voice?.error
              ? t("voice.deviceError")
              : voice
                ? t("quality.capturing", { db: Math.round(levelDb) })
                : t("voice.noDevices")}
          </dd>
        </dl>

        {state?.error ? (
          <p
            className="mt-2 rounded-sm border border-danger/30 bg-danger/10 px-2 py-1 text-[11px] text-foreground"
            title={state.error.message}
          >
            {t("quality.lastError")}: {t(coreErrorText(state.error).key)}
          </p>
        ) : null}

        <button
          type="button"
          onClick={() => {
            const started = performance.now();
            void coreApi.ping().then(() =>
              setLatency(Math.round(performance.now() - started)),
            );
            void useVoiceStore.getState().refresh();
          }}
          className="mt-2 flex items-center gap-1 text-[11px] text-accent hover:underline"
        >
          <RefreshCw className="size-3" aria-hidden />
          {t("quality.refresh")}
        </button>
      </PopoverContent>
    </Popover>
  );
}
