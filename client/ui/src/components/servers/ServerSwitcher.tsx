import {
  Check,
  ChevronsUpDown,
  LogOut,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { coreApi } from "@/core";
import type { ServerBookmark } from "@/core/api";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";
import { runCoreAction, useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * Current server identity and the saved-server list.
 *
 * The name opens the server actions menu (invite, server settings, leave).
 * The chevron opens the bookmark list; the profile menu reaches the same list
 * as "Сменить сервер". Switching reconnects with the remembered nickname.
 */
export function ServerSwitcher() {
  const { t } = useTranslation();
  const state = useCoreStore((store) => store.state);
  const settings = useSettingsStore((store) => store.settings);
  const openConnect = useAppStore((store) => store.openConnect);
  const openServerMenu = useAppStore((store) => store.openServerMenu);
  const open = useAppStore((store) => store.serverListOpen);
  const openList = useAppStore((store) => store.openServerList);
  const closeList = useAppStore((store) => store.closeServerList);
  const pushDelta = useCoreStore((store) => store.delta);
  const [forgetId, setForgetId] = useState<string | null>(null);

  const active = state?.servers.find(
    (server) => server.id === state?.activeServerId,
  );
  const connected = state?.connection === "connected";
  const servers = state?.servers ?? [];

  async function connect(server: ServerBookmark) {
    closeList();
    if (settings?.nickname) {
      await runCoreAction(() =>
        coreApi.connect({
          target: { mode: "link", link: server.link },
          nickname: settings.nickname,
        }),
      );
    } else {
      openConnect(server.link);
    }
  }

  async function forget(server: ServerBookmark) {
    try {
      const remaining = await coreApi.removeServer(server.id);
      pushDelta({ type: "bookmarks", payload: remaining });
    } catch {
      // remove_server failures surface through the core notice strip.
    } finally {
      setForgetId(null);
    }
  }

  function openActions(event: React.MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    openServerMenu(rect.left, rect.bottom + 4);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(value) => (value ? openList() : closeList())}
    >
      <div className="flex min-w-0 flex-1 items-center gap-0.5">
        <button
          type="button"
          onClick={openActions}
          aria-haspopup="menu"
          data-testid="server-name"
          className="flex min-w-0 flex-1 items-center gap-1 rounded-sm px-0.5 py-0.5 text-left hover:bg-hover"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold text-foreground">
              {state?.server?.name ?? active?.name ?? t("app.name")}
            </span>
            <span className="block truncate text-[11px] text-muted">
              {connected
                ? t("main.onlineCount", {
                    count: state?.server?.onlineUsers ?? state?.users.length ?? 0,
                  })
                : state?.connection === "reconnecting"
                  ? t("connection.reconnecting")
                  : active
                    ? active.host
                    : t("connection.disconnected")}
            </span>
          </span>
        </button>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("servers.title")}
            data-testid="server-switcher"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-faint hover:bg-hover hover:text-foreground"
          >
            <ChevronsUpDown className="size-3.5" aria-hidden />
          </button>
        </PopoverTrigger>
      </div>

      <PopoverContent
        role="dialog"
        aria-label={t("servers.title")}
        data-testid="server-menu"
        align="start"
        className="w-72 p-1.5"
      >
        <div className="flex items-center justify-between px-1.5 pb-1">
          <p className="text-[11px] font-medium text-faint">
            {t("servers.title")}
          </p>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={closeList}
            className="inline-flex size-5 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-foreground"
          >
            <X className="size-3" aria-hidden />
          </button>
        </div>

        <div className="max-h-[260px] space-y-0.5 overflow-y-auto">
          {servers.length === 0 ? (
            <p className="px-2 py-3 text-[12px] text-faint">
              {t("servers.empty")}
            </p>
          ) : (
            servers.map((server) => {
              const isActive =
                server.id === state?.activeServerId ||
                server.id === active?.id;
              if (forgetId === server.id) {
                return (
                  <div
                    key={server.id}
                    className="flex items-center gap-1 rounded-sm bg-danger/10 px-2 py-1.5"
                    data-testid={`server-forget-confirm-${server.id}`}
                  >
                    <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                      {t("servers.forgetConfirm", { name: server.name })}
                    </span>
                    <button
                      type="button"
                      onClick={() => void forget(server)}
                      className="rounded-sm bg-danger px-1.5 py-0.5 text-[10px] font-medium text-white"
                    >
                      {t("servers.forget")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setForgetId(null)}
                      className="rounded-sm px-1.5 py-0.5 text-[10px] text-muted hover:bg-hover"
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                );
              }
              return (
                <div
                  key={server.id}
                  className={cn(
                    "flex items-center gap-1 rounded-sm",
                    isActive ? "bg-active" : "hover:bg-hover",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => void connect(server)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                  >
                    <span className="w-3 shrink-0">
                      {isActive ? (
                        <Check className="size-3 text-accent" aria-hidden />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-foreground">
                        {server.name}
                      </span>
                      <span className="block truncate text-[10px] text-faint">
                        {server.host}
                        {server.lastConnectedUnixMs > 0 && settings
                          ? ` · ${formatRelative(
                              server.lastConnectedUnixMs,
                              settings.locale,
                            )}`
                          : ""}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={t("servers.forget", { name: server.name })}
                    onClick={() => setForgetId(server.id)}
                    className="mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-faint hover:bg-danger/15 hover:text-danger"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="mt-1 space-y-0.5 border-t border-border pt-1">
          <button
            type="button"
            onClick={() => {
              closeList();
              openConnect();
            }}
            data-testid="server-add"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-foreground"
          >
            <Plus className="size-3.5" aria-hidden />
            {t("servers.add")}
          </button>
          {connected ? (
            <button
              type="button"
              onClick={() => {
                closeList();
                void runCoreAction(() => coreApi.disconnect());
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-foreground"
            >
              <LogOut className="size-3.5" aria-hidden />
              {t("main.disconnect")}
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
