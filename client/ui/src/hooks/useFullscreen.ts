import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { coreApi, isDesktop } from "@/core";

export interface FullscreenControls {
  /** The player currently covers the screen (DOM fullscreen or the window). */
  active: boolean;
  /** Enters when inactive, leaves when active. */
  toggle: () => Promise<void>;
  /** Leaves DOM and desktop-window fullscreen without entering again. */
  exit: () => Promise<void>;
}

/**
 * Fullscreen for one stream tile.
 *
 * The DOM Fullscreen API is the primary path: the element itself goes
 * fullscreen and Esc works natively. Inside the desktop shell the same click
 * also asks Tauri for a fullscreen window (`setFullscreen` at runtime), because
 * WebView2 may only expand the element to the window's client area. The window
 * is never created fullscreen in `tauri.conf.json` — that path makes `tao`
 * synthesize an Alt keypress at startup (ADR 0012 / anti-cheat hygiene).
 */
export function useFullscreen(
  target: RefObject<HTMLElement | null>,
): FullscreenControls {
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const windowMode = useRef(false);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const leave = useCallback(async () => {
    windowMode.current = false;
    if (
      typeof document !== "undefined" &&
      document.fullscreenElement &&
      typeof document.exitFullscreen === "function"
    ) {
      await document.exitFullscreen().catch(() => {});
    }
    if (isDesktop) {
      await coreApi.setWindowFullscreen(false).catch(() => {});
    }
    setActive(false);
  }, []);

  const enter = useCallback(async () => {
    const element = target.current;
    if (!element) {
      return;
    }
    let dom = false;
    if (typeof element.requestFullscreen === "function") {
      try {
        await element.requestFullscreen({ navigationUI: "hide" });
        dom = true;
      } catch {
        // WebView2 builds without the API fall back to the window below.
      }
    }
    if (isDesktop) {
      try {
        await coreApi.setWindowFullscreen(true);
        windowMode.current = true;
      } catch {
        // The window permission can be missing in a mis-built bundle; the
        // DOM path above is still usable.
      }
    }
    if (dom || windowMode.current) {
      setActive(true);
    }
  }, [target]);

  const toggle = useCallback(async () => {
    const domActive =
      typeof document !== "undefined" && document.fullscreenElement !== null;
    if (activeRef.current || domActive) {
      await leave();
    } else {
      await enter();
    }
  }, [enter, leave]);

  useEffect(() => {
    const onChange = () => {
      const element = target.current;
      const dom =
        typeof document !== "undefined" &&
        element !== null &&
        document.fullscreenElement === element;
      if (dom) {
        setActive(true);
        return;
      }
      setActive(false);
      if (windowMode.current) {
        windowMode.current = false;
        if (isDesktop) {
          void coreApi.setWindowFullscreen(false).catch(() => {});
        }
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [target]);

  // The OS window does not leave fullscreen on Esc by itself.
  useEffect(() => {
    if (!active) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void leave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, leave]);

  return { active, toggle, exit: leave };
}
