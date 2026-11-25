import { Copy, Flame, Minus, Search, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { windowChrome } from "@/core";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";

/**
 * The window's own title bar (stage P7, ADR 0024).
 *
 * `decorations: false` in `tauri.conf.json` removes the system caption; this
 * component draws the server identity, the command-palette field and the
 * minimize/maximize/close buttons. Dragging is `data-tauri-drag-region`, which
 * asks tao to post `WM_NCLBUTTONDOWN` with `HTCAPTION` to this window only;
 * Tauri's own handler maximizes it on a double click.
 *
 * Close calls `Window.close()`. That emits `WindowEvent::CloseRequested`, the
 * same event the system cross produces, so ADR 0010 keeps deciding between the
 * tray and quitting.
 */
export function TitleBar() {
  const { t } = useTranslation();
  const state = useCoreStore((store) => store.state);
  const openPalette = useAppStore((store) => store.openPalette);
  const openServerMenu = useAppStore((store) => store.openServerMenu);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void windowChrome
      .isMaximized()
      .then((value) => {
        if (!disposed) {
          setMaximized(value);
        }
      })
      .catch(() => {
        // The browser preview and a destroyed window have no state to read.
      });
    void windowChrome
      .onMaximizedChange((value) => setMaximized(value))
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          unlisten = stop;
        }
      })
      .catch(() => {
        // Listening is optional: the icon still toggles through the button.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const serverName = state?.server?.name ?? t("app.name");
  const connected = state?.connection === "connected";
  const host =
    state?.servers.find((server) => server.id === state.activeServerId)?.host ??
    null;
  const subtitle = connected
    ? t("main.onlineCount", {
        count: state?.server?.onlineUsers ?? state?.users.length ?? 0,
      })
    : state?.connection === "reconnecting"
      ? t("connection.reconnecting")
      : host ?? t("connection.disconnected");

  function openServer(event: React.MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    openServerMenu(rect.left, rect.bottom + 4);
  }

  return (
    <header
      data-tauri-drag-region="deep"
      data-testid="title-bar"
      className="flex h-[34px] shrink-0 select-none items-stretch bg-chrome"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-2.5">
        <span
          className="flex size-6 shrink-0 items-center justify-center text-accent"
          aria-hidden
        >
          <Flame className="size-4" />
        </span>
        <button
          type="button"
          onClick={openServer}
          aria-haspopup="menu"
          data-testid="title-bar-server"
          title={`${serverName} · ${subtitle}`}
          className="flex min-w-0 max-w-[240px] items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors duration-150 hover:bg-hover"
        >
          <span className="min-w-0">
            <span className="block truncate text-[12px] font-medium leading-tight text-foreground">
              {serverName}
            </span>
            <span className="block truncate text-[10px] leading-tight text-faint">
              {subtitle}
            </span>
          </span>
        </button>
      </div>

      <div className="flex flex-1 items-center justify-center px-3">
        <button
          type="button"
          onClick={openPalette}
          aria-label={t("titleBar.search")}
          data-testid="title-bar-search"
          className="flex h-6 w-full max-w-[440px] items-center gap-2 rounded-md border border-border bg-background px-2.5 text-left text-[12px] text-faint transition-colors duration-150 hover:bg-hover hover:text-muted"
        >
          <Search className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {t("titleBar.search")}
          </span>
          <kbd className="shrink-0 rounded-sm border border-border px-1 text-[10px] leading-4">
            Ctrl K
          </kbd>
        </button>
      </div>

      <div className="flex flex-1 items-center justify-end">
        <WindowButton
          label={t("titleBar.minimize")}
          testId="title-bar-minimize"
          onClick={() => void windowChrome.minimize().catch(() => {})}
        >
          <Minus className="size-3.5" aria-hidden />
        </WindowButton>
        <WindowButton
          label={maximized ? t("titleBar.restore") : t("titleBar.maximize")}
          testId="title-bar-maximize"
          onClick={() =>
            void windowChrome.toggleMaximize().catch(() => {})
          }
        >
          {maximized ? (
            <Copy className="size-3" aria-hidden />
          ) : (
            <Square className="size-3" aria-hidden />
          )}
        </WindowButton>
        <WindowButton
          label={t("titleBar.close")}
          testId="title-bar-close"
          danger
          onClick={() => void windowChrome.close().catch(() => {})}
        >
          <X className="size-4" aria-hidden />
        </WindowButton>
      </div>
    </header>
  );
}

function WindowButton({
  label,
  testId,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  testId: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "flex h-full w-[46px] items-center justify-center text-muted transition-colors duration-150",
        danger
          ? "hover:bg-danger hover:text-danger-foreground"
          : "hover:bg-hover hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
