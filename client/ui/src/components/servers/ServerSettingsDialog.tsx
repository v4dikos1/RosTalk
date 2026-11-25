import { ServerCog } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ServerAdmin } from "@/components/admin/ServerAdmin";
import { EmptyState } from "@/components/common/EmptyState";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { adminTabIds } from "@/lib/permissions";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";

/**
 * Server administration, separate from the client settings (stage P7).
 *
 * The old settings dialog mixed the client and one server; here the server
 * name, tabs and audit belong to the current connection only. The menu entry is
 * hidden without rights, but `ServerAdmin` still checks the same permission
 * list so a stale IPC state cannot open an empty screen.
 */
export function ServerSettingsDialog() {
  const { t } = useTranslation();
  const open = useAppStore((store) => store.serverSettingsOpen);
  const close = useAppStore((store) => store.closeServerSettings);
  const state = useCoreStore((store) => store.state);
  const canAdmin = adminTabIds(state?.permissions?.server).length > 0;
  const name = state?.server?.name ?? t("serverSettings.title");

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        closeLabel={t("common.close")}
        className="h-[min(720px,calc(88vh/var(--fixed-scale)))] w-[min(960px,95vw)]"
        data-testid="server-settings-dialog"
      >
        <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4 pr-12">
          <span className="flex size-8 items-center justify-center rounded-md border border-border bg-raised text-muted">
            <ServerCog className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <DialogTitle className="truncate text-[14px] font-semibold">
              {t("serverSettings.title")}
            </DialogTitle>
            <DialogDescription className="truncate text-[12px] text-muted">
              {name}
            </DialogDescription>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden p-4">
          {canAdmin ? (
            <ServerAdmin />
          ) : (
            <EmptyState
              className="h-full"
              title={t("serverSettings.noRight")}
              description={t("serverSettings.noRightHint")}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
