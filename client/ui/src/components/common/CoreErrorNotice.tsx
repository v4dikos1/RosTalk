import { AlertTriangle, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { coreErrorText, isRetryable } from "@/lib/coreError";
import { useCoreStore } from "@/store/coreStore";

/**
 * Non-fatal command failure (a rejected join, a closed channel, a timed out
 * request). The connection itself stays up, so this is a dismissible strip
 * rather than the full `ConnectionBanner`.
 *
 * The reason is localised, names the channel or action when the caller knows
 * it, and keeps the technical detail in an expandable block — a tooltip alone
 * is not reachable from the keyboard.
 */
export function CoreErrorNotice() {
  const { t } = useTranslation();
  const error = useCoreStore((core) => core.actionError);
  const context = useCoreStore((core) => core.actionContext);
  const clear = useCoreStore((core) => core.setActionError);
  const [details, setDetails] = useState(false);

  if (!error) {
    return null;
  }
  const text = coreErrorText(error);
  const retryable = isRetryable(error);
  return (
    <div
      role="alert"
      className="animate-fade-in relative flex min-h-8 items-center gap-2 border-t border-danger/30 bg-danger/10 px-3 text-[12px] text-foreground"
      data-testid="core-error"
    >
      <AlertTriangle className="size-3.5 shrink-0 text-danger" aria-hidden />
      <span className="min-w-0">
        {context ? (
          <span className="mr-1.5 font-semibold text-foreground">
            {context}:
          </span>
        ) : null}
        <span className="font-medium">{t(text.key)}</span>
        {retryable ? (
          <span className="ml-1.5 text-[11px] text-muted">
            {t("errors.help.retryHint")}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={() => setDetails((value) => !value)}
        aria-expanded={details}
        data-testid="core-error-details"
        className="ml-auto shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] text-muted hover:bg-hover hover:text-foreground"
      >
        {t("errors.help.details")}
      </button>
      <button
        type="button"
        aria-label={t("common.dismiss")}
        onClick={() => {
          setDetails(false);
          clear(null);
        }}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-foreground"
      >
        <X className="size-3.5" aria-hidden />
      </button>
      {details ? (
        <pre
          className="absolute bottom-9 right-2 z-20 max-w-[min(560px,90vw)] whitespace-pre-wrap rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[10px] text-muted shadow-panel"
          data-testid="core-error-technical"
        >
          {text.detail}
        </pre>
      ) : null}
    </div>
  );
}
