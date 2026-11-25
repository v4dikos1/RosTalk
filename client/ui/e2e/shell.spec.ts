import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Stage P7: the window shell (ADR 0024).
 *
 * The desktop window has no system caption; the title bar, the profile menu and
 * the separate server settings must work without a real Tauri window. The
 * browser window API records every call in `window.__ROSTALK_WINDOW__`, so the
 * buttons are proven to reach the window boundary instead of being decorative.
 */
const outDir = path.resolve(process.cwd(), "../../docs/assets/p7");
mkdirSync(outDir, { recursive: true });

async function open(page: Page, query: string) {
  await page.goto(`/?fixtures=1&${query}`);
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

test.describe("window shell", () => {
  test("the profile menu opens the profile settings", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&channel=3");
    await page.getByTestId("profile-panel").click();
    await expect(page.getByTestId("profile-menu")).toBeVisible();
    await expect(page.getByTestId("profile-menu-status")).toBeVisible();
    await page.getByTestId("profile-menu-profile").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await expect(page.getByTestId("settings-tab-profile")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByTestId("settings-nickname")).toBeVisible();
  });

  test("the profile menu opens the general settings", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&channel=3");
    await page.getByTestId("profile-panel").click();
    await page.getByTestId("profile-menu-settings").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await expect(page.getByTestId("settings-tab-general")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("server settings are offered to an admin only", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&channel=3");
    await page.getByTestId("title-bar-server").click();
    await expect(page.getByTestId("server-actions-menu")).toBeVisible();
    await expect(page.getByTestId("server-menu-invite")).toBeVisible();
    await expect(page.getByTestId("server-menu-settings")).toBeVisible();
    await expect(page.getByTestId("server-menu-leave")).toBeVisible();
    await page.getByTestId("server-menu-settings").click();
    await expect(page.getByTestId("server-settings-dialog")).toBeVisible();
    await expect(page.getByTestId("server-admin")).toBeVisible();
    // The client settings no longer contain the server section.
    await expect(page.getByTestId("settings-dialog")).toHaveCount(0);

    await open(page, "theme=dark&lang=ru&channel=3&admin=0");
    await page.getByTestId("title-bar-server").click();
    await expect(page.getByTestId("server-actions-menu")).toBeVisible();
    await expect(page.getByTestId("server-menu-settings")).toHaveCount(0);
    await expect(page.getByTestId("server-menu-leave")).toBeVisible();
  });

  test("the sidebar server name opens the same server menu", async ({
    page,
  }) => {
    await open(page, "theme=dark&lang=ru&channel=3");
    await page.getByTestId("server-name").click();
    await expect(page.getByTestId("server-actions-menu")).toBeVisible();
    await expect(page.getByTestId("server-menu-settings")).toBeVisible();
  });

  test("the server menu opens the invite dialog", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&channel=3");
    await page.getByTestId("title-bar-server").click();
    await page.getByTestId("server-menu-invite").click();
    await expect(page.getByTestId("invite-dialog")).toBeVisible();
    await expect(page.getByTestId("invite-create")).toBeVisible();
  });

  test("title bar buttons reach the window API", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&channel=3");

    await page.getByTestId("title-bar-minimize").click();
    await page.getByTestId("title-bar-maximize").click();
    await expect(page.getByTestId("title-bar-maximize")).toHaveAttribute(
      "aria-label",
      "Восстановить",
    );
    await page.getByTestId("title-bar-maximize").click();
    await expect(page.getByTestId("title-bar-maximize")).toHaveAttribute(
      "aria-label",
      "Развернуть",
    );
    await page.getByTestId("title-bar-close").click();

    const actions = await page.evaluate(
      () => window.__ROSTALK_WINDOW__?.actions ?? [],
    );
    expect(actions).toEqual([
      "minimize",
      "toggleMaximize",
      "toggleMaximize",
      "close",
    ]);
  });

  test("the title bar search opens the command palette", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&channel=3");
    await page.getByTestId("title-bar-search").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await expect(page.getByTestId("palette-input")).toBeFocused();
  });

  test("the profile menu reaches the saved servers", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&channel=3");
    await page.getByTestId("profile-panel").click();
    await page.getByTestId("profile-menu-switch-server").click();
    await expect(page.getByTestId("server-menu")).toBeVisible();
    await expect(page.getByTestId("server-add")).toBeVisible();
  });

  test("shell screenshots", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&channel=3");
    await shot(page, "title-bar-dark-ru");

    await page.getByTestId("profile-panel").click();
    await expect(page.getByTestId("profile-menu")).toBeVisible();
    await shot(page, "profile-menu-dark-ru");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("profile-menu")).toHaveCount(0);

    await page.getByTestId("title-bar-server").click();
    await expect(page.getByTestId("server-actions-menu")).toBeVisible();
    await shot(page, "server-menu-dark-ru");
    await page.getByTestId("server-menu-settings").click();
    await expect(page.getByTestId("server-settings-dialog")).toBeVisible();
    await page.waitForTimeout(200);
    await shot(page, "server-settings-dark-ru");

    await open(page, "theme=light&lang=en&channel=3");
    await shot(page, "title-bar-light-en");
    await page.getByTestId("profile-panel").click();
    await expect(page.getByTestId("profile-menu")).toBeVisible();
    await shot(page, "profile-menu-light-en");
  });
});
