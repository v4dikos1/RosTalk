import { getCurrentWindow } from "@tauri-apps/api/window";

import type { WindowChromeApi } from "@/lib/windowChrome";

import { commands } from "./bindings";

/**
 * Desktop window controls. `close` goes through Tauri's close request, which is
 * the same `WindowEvent::CloseRequested` path as the system cross: ADR 0010
 * decides between hiding to the tray and quitting.
 *
 * The `minimize`, `toggleMaximize`, `isMaximized` and `startDragging` commands
 * are the only window permissions granted to the WebView (capabilities/
 * default.json). No focus, always-on-top or fullscreen calls exist here.
 */
export const tauriWindowChrome: WindowChromeApi = {
  async minimize() {
    await getCurrentWindow().minimize();
  },
  async toggleMaximize() {
    await getCurrentWindow().toggleMaximize();
  },
  async close() {
    await getCurrentWindow().close();
  },
  async quit() {
    await commands.quitApp();
  },
  async isMaximized() {
    return getCurrentWindow().isMaximized();
  },
  async onMaximizedChange(listener) {
    return getCurrentWindow().onResized(async () => {
      try {
        listener(await getCurrentWindow().isMaximized());
      } catch {
        // A destroyed window (economy mode) has no maximized state to report.
      }
    });
  },
};
