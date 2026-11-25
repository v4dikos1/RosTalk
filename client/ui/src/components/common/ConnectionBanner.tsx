import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useCoreStore } from "@/store/coreStore";

function ReconnectCountdown({
  attempt,
  delayMs,
}: {
  attempt: number;
  delayMs: number;
}) {
  const { t } = useTranslation();
  const [remaining, setRemaining] = useState(() =>
    Math.max(1, Math.ceil(delayMs / 1000)),
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRemaining((current) => (current > 0 ? current - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span className="text-muted">
      {remaining > 0
        ? t("connection.reconnectingCountdown", {
            attempt,
            seconds: remaining,
          })
        : t("connection.reconnectingNow")}
    </span>
  );
}

/**
 * A retry in progress. Fatal failures clear the session and are rendered by
 * the state screen of the main view, with human text and a recovery action.
 */
export function ConnectionBanner() {
  const { t } = useTranslation();
  const state = useCoreStore((core) => core.state);

  if (state?.connection !== "reconnecting") {
    return null;
  }
  const attempt = state.reconnect?.attempt ?? 1;
  const delayMs = state.reconnect?.delayMs ?? 1000;

  return (
    <div className="animate-fade-in flex min-h-9 items-center gap-2 border-b border-warning/35 bg-warning/10 px-3 text-xs text-foreground">
      <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
      <span role="status" className="font-semibold">
        {t("connection.reconnectingTitle")}
      </span>
      <span aria-hidden>
        <ReconnectCountdown
          key={`${attempt}-${delayMs}`}
          attempt={attempt}
          delayMs={delayMs}
        />
      </span>
    </div>
  );
}
