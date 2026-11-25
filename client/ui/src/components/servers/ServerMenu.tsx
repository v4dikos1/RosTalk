import { LogOut, ServerCog, UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { coreApi } from "@/core";
import { adminTabIds } from "@/lib/permissions";
import { useAppStore } from "@/store/appStore";
import { runCoreAction, useCoreStore } from "@/store/coreStore";

const MENU_WIDTH = 244;

/**
 * Actions of the current server: invite, server settings and leaving it.
 *
 * The menu is opened from the server name in the title bar and in the sidebar
 * header. "Настройки сервера" is hidden without administration rights; the
 * server checks the same permission again, the client only avoids a dead item.
 *
 * A Radix Popover anchored to the click point keeps the menu inside the window
 * (stage P8); the old version clamped a fixed box by hand.
 */
export function ServerMenu() {
  const { t } = useTranslation();
  const anchor = useAppStore((store) => store.serverMenu);
  const close = useAppStore((store) => store.closeServerMenu);
  const openInvite = useAppStore((store) => store.openInvite);
  const openServerSettings = useAppStore((store) => store.openServerSettings);
  const state = useCoreStore((store) => store.state);

  if (!anchor) {
    return null;
  }

  const connected = state?.connection === "connected";
  const server = state?.server ?? null;
  const bookmark = state?.servers.find(
    (item) => item.id === state.activeServerId,
  );
  const name = server?.name ?? bookmark?.name ?? t("app.name");
  const subtitle = connected
    ? t("main.onlineCount", {
        count: server?.onlineUsers ?? state?.users.length ?? 0,
      })
    : bookmark?.host ?? t("connection.disconnected");
  const canAdmin = adminTabIds(state?.permissions?.server).length > 0;

  function invite() {
    close();
    openInvite();
  }

  function leave() {
    close();
    void runCoreAction(() => coreApi.disconnect());
  }

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <PopoverAnchor asChild>
        <span
          aria-hidden
          style={{
            position: "fixed",
            left: anchor.x,
            top: anchor.y,
            width: 1,
            height: 1,
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        role="menu"
        aria-label={t("serverMenu.title", { name })}
        data-testid="server-actions-menu"
        style={{ width: MENU_WIDTH }}
        className="p-1.5"
      >
        <div className="mb-1 border-b border-border px-1.5 pb-2 pt-1">
          <p className="truncate text-[13px] font-semibold text-foreground">
            {name}
          </p>
          <p className="truncate text-[11px] text-muted">{subtitle}</p>
        </div>
        <button
          type="button"
          role="menuitem"
          onClick={invite}
          disabled={!connected}
          data-testid="server-menu-invite"
          className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[12px] text-muted hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
        >
          <UserPlus className="size-3.5" aria-hidden />
          {t("serverMenu.invite")}
        </button>
        {canAdmin ? (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              openServerSettings();
            }}
            data-testid="server-menu-settings"
            className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[12px] text-muted hover:bg-hover hover:text-foreground"
          >
            <ServerCog className="size-3.5" aria-hidden />
            {t("serverMenu.settings")}
          </button>
        ) : null}
        {connected ? (
          <>
            <div className="my-1 border-t border-border" />
            <button
              type="button"
              role="menuitem"
              onClick={leave}
              data-testid="server-menu-leave"
              className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[12px] text-danger hover:bg-danger/15"
            >
              <LogOut className="size-3.5" aria-hidden />
              {t("serverMenu.leave")}
            </button>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
