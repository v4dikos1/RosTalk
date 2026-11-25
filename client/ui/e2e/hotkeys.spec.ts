import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

// playtest-1, P4: shortcuts must work by physical key, not by the character
// the active layout produces. The headless browser always uses a US layout,
// so the Russian case is dispatched as Windows/WebView2 reports it: `code`
// carries the physical key, `key` carries the Cyrillic character.
const outDir = path.resolve(process.cwd(), "../../docs/assets/p4");
mkdirSync(outDir, { recursive: true });

async function openMock(page: Page, query: string) {
  await page.goto(`/?fixtures=1&${query}`);
  await expect(page.getByTestId("main-screen")).toBeVisible();
}

async function press(
  page: Page,
  init: { code: string; key: string; ctrlKey?: boolean },
) {
  await page.evaluate((event) => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { ...event, bubbles: true, cancelable: true }),
    );
  }, init);
}

test.describe("hotkeys in any layout", () => {
  test("Ctrl+K opens the palette while the Russian layout is active", async ({
    page,
  }) => {
    await openMock(page, "theme=dark&lang=ru&channel=3");

    await press(page, { code: "KeyK", key: "л", ctrlKey: true });

    await expect(page.getByTestId("palette-input")).toBeVisible();
    await page.screenshot({
      path: path.join(outDir, "palette-ru.png"),
      animations: "disabled",
      caret: "hide",
    });
  });

  test("records Ctrl+K from a Russian-layout key press", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&settings=hotkeys");

    const button = page.getByTestId("hotkey-toggleMute");
    await button.click();
    await press(page, { code: "KeyK", key: "л", ctrlKey: true });

    await expect(button).toHaveText("Ctrl+K");
    await page.screenshot({
      path: path.join(outDir, "hotkeys-record-ru.png"),
      animations: "disabled",
      caret: "hide",
    });
  });

  test("Ctrl+Comma opens the settings window in the Russian layout", async ({
    page,
  }) => {
    await openMock(page, "theme=dark&lang=ru&channel=3");

    await press(page, { code: "Comma", key: "б", ctrlKey: true });

    await expect(page.getByTestId("settings-dialog")).toBeVisible();
  });
});
