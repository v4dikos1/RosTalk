import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

// Screenshots for the UX-fixes stage: the screens the review asked to change.
// They are intentionally separate from the stage 2.4 set so both can be
// compared during review.
const outDir = path.resolve(process.cwd(), "../../docs/assets/stage-ux");
mkdirSync(outDir, { recursive: true });

async function openMock(page: Page, query: string) {
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

test.describe("UX fixes screenshots", () => {
  test("welcome: one primary action, paste and a server menu", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&state=disconnected");
    await expect(page.getByTestId("state-welcome")).toBeVisible();
    await shot(page, "welcome-dark-ru");
  });

  test("connect: direct address probes on blur", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&state=disconnected");
    await page.getByTestId("welcome-menu").click();
    await page.getByRole("menuitem", { name: "Добавить сервер" }).click();
    await expect(page.getByTestId("connect-dialog")).toBeVisible();
    await page.getByTestId("connect-mode-direct").click();
    await page.getByTestId("connect-host").fill("192.168.0.13:7443");
    await page.getByTestId("connect-password").click();
    await expect(page.getByTestId("connect-fingerprint")).toBeVisible();
    await shot(page, "connect-direct-dark-ru");
  });

  test("first run: one selector, quiet own-server link", async ({ page }) => {
    await page.goto(
      "/?fixtures=1&onboarding=1&theme=dark&lang=ru&nickname=",
    );
    await expect(page.getByTestId("onboarding")).toBeVisible();
    await page.getByTestId("onboarding-mode-direct").click();
    await page.getByTestId("onboarding-host").fill("192.168.0.13:7443");
    await page.getByTestId("onboarding-password").click();
    await expect(page.getByTestId("connect-fingerprint")).toBeVisible();
    await shot(page, "onboarding-direct-dark-ru");
  });

  test("invite popover in the header", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&channel=3");
    await page.getByTestId("invite-open").last().click();
    await expect(page.getByTestId("invite-popover")).toBeVisible();
    await shot(page, "invite-popover-dark-ru");
  });

  test("transmission mode menu with three labelled choices", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&channel=3");
    await page.getByTestId("control-gate").click();
    await expect(page.getByTestId("gate-menu")).toBeVisible();
    await shot(page, "gate-menu-dark-ru");
  });

  test("sound settings: output volume and event sounds together", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&settings=voice");
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.getByTestId("settings-content").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForTimeout(150);
    await shot(page, "settings-sound-dark-ru");
  });

  test("member-roles are localized in the tree", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&channel=3");
    await expect(page.getByTestId("channel-tree")).toBeVisible();
    await shot(page, "tree-roles-dark-ru");
  });
});
