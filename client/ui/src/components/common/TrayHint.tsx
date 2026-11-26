import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { BrandMark } from "@/components/common/BrandMark";
import { useSettingsStore } from "@/store/settingsStore";

const SEEN_KEY = "rostalk.trayHintSeen";
const PENDING_KEY = "rostalk.trayHintPending";

/**
 * One-time hint after the window was hidden to the tray. The WebView does not
 * see the native close event, but it does see its document become hidden and
 * visible again; the hint is shown when the user returns, and never twice.
 */
export function TrayHint() {
  const { t } = useTranslation();
  const closeToTray = useSettingsStore(
    (store) => store.settings?.closeToTray ?? false,
  );
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!closeToTray) {
      return;
    }
    function onVisibility() {
      try {
        if (document.hidden) {
          if (window.localStorage.getItem(SEEN_KEY) !== "1") {
            window.sessionStorage.setItem(PENDING_KEY, "1");
          }
          return;
        }
        if (window.sessionStorage.getItem(PENDING_KEY) === "1") {
          window.sessionStorage.removeItem(PENDING_KEY);
          window.localStorage.setItem(SEEN_KEY, "1");
          setVisible(true);
        }
      } catch {
        // Storage may be unavailable; the hint is optional.
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [closeToTray]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    const timer = window.setTimeout(() => setVisible(false), 7000);
    return () => window.clearTimeout(timer);
  }, [visible]);

  if (!visible) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid="tray-hint"
      className="animate-fade-in fixed bottom-16 left-1/2 z-30 flex max-w-[420px] -translate-x-1/2 items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-foreground shadow-panel"
    >
      <BrandMark className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{t("app.trayHint")}</span>
      <button
        type="button"
        aria-label={t("common.dismiss")}
        onClick={() => setVisible(false)}
        className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-hover"
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}
