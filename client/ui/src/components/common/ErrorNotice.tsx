import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { CoreError } from "@/core/api";
import { coreErrorText } from "@/lib/coreError";
import { cn } from "@/lib/utils";

/**
 * Human-readable rendering of a `CoreError` or server `Error` frame.
 *
 * The UI never shows a machine code or the English technical message as the
 * primary text (stage 2.4 requirement 10); the detail stays in the tooltip and
 * is available for a bug report.
 */
export function ErrorNotice({
  error,
  className,
  onRetry,
  retryLabel,
}: {
  error: CoreError;
  className?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  const { t } = useTranslation();
  const text = coreErrorText(error);
  const outdated =
    error.code === "protocolVersionUnsupported" ||
    error.serverCode === "protocolVersionUnsupported";
  const banned =
    error.serverCode === "banned" || error.code === "serverError"
      ? error.serverCode === "banned"
      : false;

  return (
    <div
      role="alert"
      data-testid="error-notice"
      className={cn(
        "rounded-sm border border-danger/35 bg-danger/10 px-3 py-2 text-[12px] text-foreground",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium" title={text.detail}>
            {t(text.key)}
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            {banned
              ? t("errors.help.banned")
              : outdated
                ? t("errors.help.outdated")
                : t("errors.help.generic")}
          </p>
          {outdated && error.actionUrl ? (
            <a
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
              href={error.actionUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="size-3" aria-hidden />
              {t("errors.help.download")}
            </a>
          ) : null}
          {error.retryable && onRetry ? (
            <Button
              className="mt-2"
              size="xs"
              variant="secondary"
              onClick={onRetry}
            >
              <RefreshCw className="size-3" aria-hidden />
              {retryLabel ?? t("connection.retry")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
