import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

// Stage 4.1 chat screenshots. They use the fixture adapter: no server is
// needed, but the markup, virtualization, attachments and unread badges are
// the same components the desktop client runs.
const outDir = path.resolve(process.cwd(), "../../docs/assets/stage-4.1");
mkdirSync(outDir, { recursive: true });

async function openChat(page: Page, query: string) {
  await page.goto(`/?fixtures=1&${query}`);
  await expect(page.getByTestId("main-screen")).toBeVisible();
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await expect(page.getByTestId("message").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function shot(page: Page, name: string) {
  await page.screenshot({
    path: path.join(outDir, `${name}.png`),
    animations: "disabled",
    caret: "hide",
  });
}

test.describe("stage 4.1 chat screenshots", () => {
  test("text channel, dark, Russian", async ({ page }) => {
    await openChat(page, "theme=dark&lang=ru&channel=1&view=chat");
    await shot(page, "chat-channel-dark-ru");
  });

  test("text channel, light, English", async ({ page }) => {
    await openChat(page, "theme=light&lang=en&channel=1&view=chat");
    await shot(page, "chat-channel-light-en");
  });

  test("markup and inline image", async ({ page }) => {
    await openChat(page, "theme=dark&lang=ru&channel=1&view=chat");
    const image = page.getByTestId("attachment-image").first();
    await expect(image).toBeVisible();
    await image.click();
    await page.waitForTimeout(200);
    await shot(page, "chat-image-viewer-dark-ru");
    await page.keyboard.press("Escape");
  });

  test("direct message", async ({ page }) => {
    await page.goto("/?fixtures=1&theme=dark&lang=ru&dm=2");
    await expect(page.getByTestId("main-screen")).toBeVisible();
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(page.getByTestId("message").first()).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, "chat-direct-dark-ru");
  });

  test("unread badges in the tree", async ({ page }) => {
    await page.goto("/?fixtures=1&theme=dark&lang=ru&channel=3&view=members");
    await expect(page.getByTestId("channel-mentions-2")).toBeVisible();
    await page.waitForTimeout(250);
    await shot(page, "chat-unread-tree-dark-ru");
  });

  test("opening a direct message from the member tree keeps it open", async ({
    page,
  }) => {
    await page.goto("/?fixtures=1&theme=dark&lang=ru&channel=3&view=members");
    await expect(page.getByTestId("main-screen")).toBeVisible();
    await page.getByTestId("dm-2").click();
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(page.getByTestId("close-dm")).toBeVisible();
    await expect(page.getByTestId("message").first()).toBeVisible();
  });

  test("message hover actions", async ({ page }) => {
    await openChat(page, "theme=dark&lang=en&channel=1&view=chat");
    const ownMessage = page
      .getByTestId("message")
      .filter({ hasText: "Добавил ссылку" })
      .first();
    await ownMessage.hover();
    await page.waitForTimeout(150);
    await shot(page, "chat-message-actions-dark-en");
  });
});
