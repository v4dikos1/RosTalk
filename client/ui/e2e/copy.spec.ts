import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

// Stage P6 rewrites the interface copy. These shots compare the same screens
// before and after the pass: run with P6_OUT=before or P6_OUT=after.
const phase = process.env.P6_OUT === "before" ? "before" : "after";
const outDir = path.resolve(process.cwd(), `../../docs/assets/p6/${phase}`);
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

test.describe(`stage p6 copy (${phase})`, () => {
  test("chat with messages, dark, Russian", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&channel=1");
    await shot(page, "chat-dark-ru");
  });

  test("empty chat, dark, Russian", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&channel=2");
    await shot(page, "chat-empty-dark-ru");
  });

  test("chat with messages, light, English", async ({ page }) => {
    await open(page, "theme=light&lang=en&channel=1");
    await shot(page, "chat-light-en");
  });

  test("user menu of another member, dark, Russian", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&userMenu=2");
    await expect(page.getByTestId("user-menu")).toBeVisible();
    await shot(page, "user-menu-other-dark-ru");
  });

  test("user menu of your own row, dark, Russian", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&userMenu=1");
    await expect(page.getByTestId("user-menu")).toBeVisible();
    await shot(page, "user-menu-self-dark-ru");
  });

  test("voice settings, dark, Russian", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&settings=voice");
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.waitForTimeout(200);
    await shot(page, "settings-voice-dark-ru");
  });

  test("voice settings, light, English", async ({ page }) => {
    await open(page, "theme=light&lang=en&settings=voice");
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.waitForTimeout(200);
    await shot(page, "settings-voice-light-en");
  });

  test("streams, dark, Russian", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&channel=4");
    await page.getByTestId("main-tab-streams").click();
    await expect(page.getByTestId("streams-panel")).toBeVisible();
    await shot(page, "streams-dark-ru");
  });

  test("command palette, dark, Russian", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&palette=1");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.waitForTimeout(200);
    await shot(page, "command-palette-dark-ru");
  });
});
