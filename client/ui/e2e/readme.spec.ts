import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

// Screenshots for the README on fixture data only (no real
// servers, names or addresses). Regenerate with
//   cd client/ui && npx playwright test e2e/readme.spec.ts
const outDir = path.resolve(process.cwd(), "../../docs/images");
mkdirSync(outDir, { recursive: true });

async function openMock(page: Page, query: string) {
  await page.goto(`/?fixtures=1&lang=ru&${query}`);
  await expect(page.getByTestId("main-screen")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function shot(page: Page, name: string) {
  await page.screenshot({
    path: path.join(outDir, `${name}.png`),
    animations: "disabled",
    caret: "hide",
  });
}

test.describe("README screenshots at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

  test("voice channel", async ({ page }) => {
    await openMock(page, "theme=dark&channel=3&view=chat");
    await shot(page, "voice");
  });

  test("text chat", async ({ page }) => {
    await openMock(page, "theme=dark&channel=1&view=chat");
    await expect(page.getByTestId("message").first()).toBeVisible();
    await shot(page, "chat");
  });

  test("screen sharing", async ({ page }) => {
    await openMock(page, "theme=dark&channel=4&view=members");
    await page.getByTestId("main-tab-streams").click();
    await expect(page.getByTestId("stream-6")).toBeVisible();
    await shot(page, "streams");
  });

  test("voice settings, light theme", async ({ page }) => {
    await openMock(page, "theme=light&settings=voice");
    await shot(page, "settings-voice");
  });

  test("roles and permissions", async ({ page }) => {
    await openMock(page, "theme=dark&settings=server&adminTab=roles");
    await page.getByText("Moderator", { exact: true }).first().click();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    await shot(page, "admin-roles");
  });
});
