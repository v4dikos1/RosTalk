import { beforeEach, describe, expect, it } from "vitest";

import { browserWindowChrome } from "./windowChrome";

describe("browser window chrome", () => {
  beforeEach(() => {
    delete window.__ROSTALK_WINDOW__;
  });

  it("records every requested action for the shell tests", async () => {
    await browserWindowChrome.minimize();
    await browserWindowChrome.toggleMaximize();
    await browserWindowChrome.close();
    await browserWindowChrome.quit();
    expect(window.__ROSTALK_WINDOW__?.actions).toEqual([
      "minimize",
      "toggleMaximize",
      "close",
      "quit",
    ]);
  });

  it("keeps the maximized flag and notifies subscribers", async () => {
    const seen: boolean[] = [];
    const stop = await browserWindowChrome.onMaximizedChange((value) =>
      seen.push(value),
    );
    expect(await browserWindowChrome.isMaximized()).toBe(false);
    await browserWindowChrome.toggleMaximize();
    expect(await browserWindowChrome.isMaximized()).toBe(true);
    await browserWindowChrome.toggleMaximize();
    expect(await browserWindowChrome.isMaximized()).toBe(false);
    expect(seen).toEqual([true, false]);

    stop();
    await browserWindowChrome.toggleMaximize();
    expect(seen).toEqual([true, false]);
  });
});
