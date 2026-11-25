import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

// Stage P9 visual redesign (direction A+C, docs/ux/2026-11-23-p9-directions.md).
// Main screens in both themes. `P9_PHASE=before` writes the pre-redesign set.
const phase = process.env.P9_PHASE === "before" ? "before" : "after";
const outDir = path.resolve(process.cwd(), `../../docs/assets/p9/${phase}`);
mkdirSync(outDir, { recursive: true });

async function open(page: Page, query: string) {
  await page.goto(`/?fixtures=1&lang=ru&${query}`);
  await expect(page.getByTestId("main-screen")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
}

async function shot(page: Page, name: string) {
  await page.screenshot({
    path: path.join(outDir, `${name}.png`),
    animations: "disabled",
    caret: "hide",
  });
}

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

for (const theme of ["dark", "light"] as const) {
  test.describe(`P9 ${theme}`, () => {
    test("voice channel with chat", async ({ page }) => {
      await open(page, `theme=${theme}&channel=3&view=chat`);
      await shot(page, `01-main-${theme}`);
    });

    test("text channel", async ({ page }) => {
      await open(page, `theme=${theme}&channel=1&view=chat`);
      await page.getByTestId("message").last().hover();
      await page.waitForTimeout(200);
      await shot(page, `02-text-${theme}`);
    });

    test("stream", async ({ page }) => {
      await open(page, `theme=${theme}&channel=4&view=chat`);
      await page.getByTestId("main-tab-streams").click();
      await expect(page.getByTestId("streams-panel")).toBeVisible();
      await page.waitForTimeout(200);
      await shot(page, `03-stream-${theme}`);
    });

    test("profile menu", async ({ page }) => {
      await open(page, `theme=${theme}&channel=4&view=chat`);
      await page.getByTestId("profile-panel").click();
      await expect(page.getByTestId("profile-menu")).toBeVisible();
      await page.waitForTimeout(200);
      await shot(page, `04-profile-menu-${theme}`);
    });

    test("appearance settings", async ({ page }) => {
      await open(page, `theme=${theme}&channel=4&view=chat`);
      await page.getByTestId("profile-panel").click();
      await page.getByTestId("profile-menu-settings").click();
      await expect(page.getByTestId("settings-dialog")).toBeVisible();
      const tab = page.getByTestId("settings-tab-appearance");
      if ((await tab.count()) > 0) {
        await tab.click();
      }
      await page.waitForTimeout(200);
      await shot(page, `05-settings-appearance-${theme}`);
    });
  });
}
