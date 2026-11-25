/**
 * Window controls for the custom title bar.
 *
 * The desktop shell owns the real window; a browser preview has none. The
 * browser implementation records the requested actions in
 * `window.__ROSTALK_WINDOW__` so Playwright can prove that a click reached the
 * window API, and keeps a maximized flag so the restore icon changes. It never
 * pretends to move a real window.
 */

export interface WindowChromeApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  /** The same path as the system close button and ADR 0010 (tray or quit). */
  close(): Promise<void>;
  /** Ends the client, exactly like the tray `Quit` item. */
  quit(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /**
   * Subscribes to maximize/restore changes. Resolves to the unsubscribe
   * function; a reloaded page never leaks a listener.
   */
  onMaximizedChange(
    listener: (maximized: boolean) => void,
  ): Promise<() => void>;
}

/** Test probe of the browser fallback; absent in the desktop shell. */
export interface BrowserWindowState {
  actions: string[];
  maximized: boolean;
}

declare global {
  interface Window {
    __ROSTALK_WINDOW__?: BrowserWindowState;
  }
}

type BrowserState = BrowserWindowState & {
  listeners: Set<(maximized: boolean) => void>;
};

function browserState(): BrowserState {
  if (typeof window === "undefined") {
    return { actions: [], maximized: false, listeners: new Set() };
  }
  const existing = window.__ROSTALK_WINDOW__ as BrowserState | undefined;
  if (existing && existing.listeners instanceof Set) {
    return existing;
  }
  const created: BrowserState = {
    actions: existing?.actions ?? [],
    maximized: existing?.maximized ?? false,
    listeners: new Set(),
  };
  window.__ROSTALK_WINDOW__ = created;
  return created;
}

function record(action: string) {
  const state = browserState();
  state.actions.push(action);
}

function setMaximized(maximized: boolean) {
  const state = browserState();
  if (state.maximized === maximized) {
    return;
  }
  state.maximized = maximized;
  for (const listener of state.listeners) {
    listener(maximized);
  }
}

/** Browser preview: no real window, only the recorded intent. */
export const browserWindowChrome: WindowChromeApi = {
  async minimize() {
    record("minimize");
  },
  async toggleMaximize() {
    const state = browserState();
    record("toggleMaximize");
    setMaximized(!state.maximized);
  },
  async close() {
    record("close");
  },
  async quit() {
    record("quit");
  },
  async isMaximized() {
    return browserState().maximized;
  },
  async onMaximizedChange(listener) {
    const state = browserState();
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  },
};
