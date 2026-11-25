import { Check, Clipboard, ServerCog } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { LINUX_INSTALL_COMMAND, RELEASES_URL } from "@/lib/release";
import { useAppStore } from "@/store/appStore";

/**
 * "I want my own server" (P13, ADR 0026). The client no longer installs
 * servers: it explains the two ways and shows the release page and the Linux
 * command with Copy buttons. Nothing is opened in a browser: that would need a
 * shell call that is outside the anti-cheat white list (ADR 0023).
 */
export function OwnServerDialog() {
  const open = useAppStore((state) => state.hostingOpen);
  const close = useAppStore((state) => state.closeHosting);
  const { t } = useTranslation();
  if (!open) {
    return null;
  }
  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent
        className="w-[min(560px,94vw)]"
        closeLabel={t("common.close")}
        data-testid="own-server-dialog"
      >
        <header className="border-b border-border px-5 py-3 pr-12">
          <div className="flex items-center gap-2">
            <ServerCog className="size-4 text-accent" aria-hidden />
            <DialogTitle className="text-[14px] font-semibold">
              {t("ownServer.title")}
            </DialogTitle>
          </div>
          <DialogDescription className="mt-1 text-[12px] text-muted">
            {t("ownServer.body")}
          </DialogDescription>
        </header>
        <div className="space-y-4 px-5 py-4">
          <section className="space-y-1.5">
            <h3 className="text-[12px] font-semibold text-foreground">
              {t("ownServer.windowsTitle")}
            </h3>
            <p className="text-[12px] text-muted">{t("ownServer.windowsHint")}</p>
            <CopyField
              label={t("ownServer.releases")}
              value={RELEASES_URL}
              testId="own-server-releases"
            />
            <p className="text-[11px] text-faint">{t("ownServer.browserHint")}</p>
          </section>
          <section className="space-y-1.5">
            <h3 className="text-[12px] font-semibold text-foreground">
              {t("ownServer.linuxTitle")}
            </h3>
            <p className="text-[12px] text-muted">{t("ownServer.linuxHint")}</p>
            <CopyField
              label={t("ownServer.linuxTitle")}
              value={LINUX_INSTALL_COMMAND}
              testId="own-server-linux"
            />
          </section>
          <p className="text-[12px] text-muted">{t("ownServer.done")}</p>
        </div>
        <footer className="flex justify-end border-t border-border px-5 py-3">
          <Button type="button" size="sm" variant="secondary" onClick={close}>
            {t("common.close")}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function CopyField({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      window.setTimeout(() => setState("idle"), 1200);
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-1.5">
        <input
          readOnly
          value={value}
          aria-label={label}
          onFocus={(event) => event.currentTarget.select()}
          className="h-8 min-w-0 flex-1 select-all rounded-sm border border-border bg-raised px-2 font-mono text-[11px] text-foreground"
          data-testid={testId}
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void copy()}
          data-testid={`${testId}-copy`}
        >
          {state === "copied" ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Clipboard className="size-3.5" aria-hidden />
          )}
          {state === "copied" ? t("ownServer.copied") : t("ownServer.copy")}
        </Button>
      </div>
      {state === "failed" ? (
        <p role="alert" className="text-[11px] text-danger">
          {t("ownServer.copyFailed")}
        </p>
      ) : null}
    </div>
  );
}
