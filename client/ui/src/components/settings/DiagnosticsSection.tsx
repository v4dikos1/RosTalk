import { Download, Loader2, ScrollText, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { SectionTitle } from "@/components/settings/SettingsPrimitives";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { coreApi } from "@/core";
import type { CoreError } from "@/core/api";
import { asCoreError, coreErrorText } from "@/lib/coreError";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * Diagnostics consent and the two explicit actions: export the report to a
 * file the user picks, or delete the local log. Nothing leaves the machine on
 * its own.
 */
export function DiagnosticsSection() {
  const { t } = useTranslation();
  const settings = useSettingsStore((store) => store.settings);
  const update = useSettingsStore((store) => store.update);
  const [exporting, setExporting] = useState(false);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [error, setError] = useState<CoreError | null>(null);

  if (!settings) {
    return null;
  }
  const enabled = settings.diagnostics.consent === "granted";

  async function exportReport() {
    if (exporting) {
      return;
    }
    setExporting(true);
    setError(null);
    setCancelled(false);
    setExportedPath(null);
    setCleared(false);
    try {
      const path = await coreApi.exportDiagnostics();
      if (path === null) {
        setCancelled(true);
      } else {
        setExportedPath(path);
      }
    } catch (reason) {
      setError(asCoreError(reason));
    } finally {
      setExporting(false);
    }
  }

  async function clearLog() {
    if (clearing) {
      return;
    }
    setClearing(true);
    setError(null);
    setExportedPath(null);
    setCancelled(false);
    try {
      await coreApi.clearDiagnostics();
      setCleared(true);
    } catch (reason) {
      setError(asCoreError(reason));
    } finally {
      setClearing(false);
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-raised p-3">
        <div className="flex items-center gap-2">
          <ScrollText className="size-4 text-accent" aria-hidden />
          <h3 className="text-[13px] font-semibold text-foreground">
            {t("settings.diagnostics.title")}
          </h3>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-muted">
          {t("settings.diagnostics.hint")}
        </p>
        <div className="mt-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">
              {t("settings.diagnostics.enabled")}
            </p>
            <p className="text-[11px] text-muted">
              {t("settings.diagnostics.enabledHint")}
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(checked) =>
              void update({
                diagnostics: { consent: checked ? "granted" : "denied" },
              })
            }
            aria-label={t("settings.diagnostics.enabled")}
            data-testid="diagnostics-switch"
          />
        </div>
        {!enabled ? (
          <p className="mt-2 text-[11px] leading-snug text-faint">
            {t("settings.diagnostics.disabledNotice")}
          </p>
        ) : null}
      </div>

      <div className="rounded-md border border-border p-3">
        <SectionTitle>{t("settings.diagnostics.exportTitle")}</SectionTitle>
        <p className="text-[11px] leading-snug text-muted">
          {t("settings.diagnostics.exportHint")}
        </p>
        <Button
          className="mt-2"
          size="sm"
          variant="secondary"
          disabled={exporting}
          onClick={() => void exportReport()}
          data-testid="diagnostics-export"
        >
          {exporting ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Download className="size-3.5" aria-hidden />
          )}
          {t("settings.diagnostics.export")}
        </Button>
        {exportedPath ? (
          <p
            role="status"
            className="mt-2 break-all text-[11px] text-success select-text"
            data-testid="diagnostics-exported"
          >
            {t("settings.diagnostics.exported", { path: exportedPath })}
          </p>
        ) : null}
        {cancelled ? (
          <p role="status" className="mt-2 text-[11px] text-muted">
            {t("settings.diagnostics.cancelled")}
          </p>
        ) : null}
      </div>

      <div className="rounded-md border border-border p-3">
        <SectionTitle>{t("settings.diagnostics.clearTitle")}</SectionTitle>
        <p className="text-[11px] leading-snug text-muted">
          {t("settings.diagnostics.clearHint")}
        </p>
        {confirming ? (
          <div className="mt-2 space-y-2">
            <p role="alert" className="text-[11px] text-foreground">
              {t("settings.diagnostics.clearConfirm")}
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="danger"
                disabled={clearing}
                onClick={() => void clearLog()}
                data-testid="diagnostics-clear-confirm"
              >
                {clearing ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="size-3.5" aria-hidden />
                )}
                {t("settings.diagnostics.clearAccept")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={clearing}
                onClick={() => setConfirming(false)}
                data-testid="diagnostics-clear-cancel"
              >
                {t("settings.diagnostics.clearCancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            onClick={() => {
              setCleared(false);
              setConfirming(true);
            }}
            disabled={clearing}
            data-testid="diagnostics-clear"
          >
            <Trash2 className="size-3.5" aria-hidden />
            {t("settings.diagnostics.clear")}
          </Button>
        )}
        {cleared ? (
          <p role="status" className="mt-2 text-[11px] text-success">
            {t("settings.diagnostics.cleared")}
          </p>
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          className="text-[11px] text-danger"
          title={coreErrorText(error).detail}
        >
          {t(coreErrorText(error).key)}
        </p>
      ) : null}
    </div>
  );
}
