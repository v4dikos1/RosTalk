import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

// P13: the client shows "I want my own server" instead of the SSH wizard, and
// the wizard lives in rostalk-server-setup (server-setup.html). Screenshots go
// to docs/assets/p13 only.
const outDir = path.resolve(process.cwd(), "../../docs/assets/p13");
mkdirSync(outDir, { recursive: true });

const setupUrl = "http://127.0.0.1:4174/server-setup.html?fixtures=1";

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  await page.screenshot({
    path: path.join(outDir, `${name}.png`),
    animations: "disabled",
    caret: "hide",
  });
}

async function fillAccess(page: Page, passwordLabel: string) {
  await page.getByTestId("hosting-address").fill("203.0.113.5");
  await page.getByRole("button", { name: passwordLabel }).click();
  await page.getByTestId("hosting-password").fill("correct horse battery");
  await page.getByTestId("hosting-check-host").click();
  await expect(page.getByTestId("hosting-host-key")).toBeVisible();
}

test.describe("P13 client: own server", () => {
  test("own server dialog, dark, Russian", async ({ page }) => {
    await page.goto("/?fixtures=1&hosting=1&theme=dark&lang=ru&nickname=Алиса");
    await expect(page.getByTestId("own-server-dialog")).toBeVisible();
    await expect(page.getByTestId("own-server-releases")).toHaveValue(
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest$/,
    );
    await expect(page.locator("[data-testid=own-server-dialog] a[href]")).toHaveCount(0);
    await shot(page, "client-own-server-dark-ru");
  });

  test("own server dialog, light, English", async ({ page }) => {
    await page.goto("/?fixtures=1&hosting=1&theme=light&lang=en&nickname=Alice");
    await expect(page.getByTestId("own-server-dialog")).toBeVisible();
    await shot(page, "client-own-server-light-en");
  });

  test("onboarding entry, dark, Russian", async ({ page }) => {
    await page.goto("/?fixtures=1&onboarding=1&theme=dark&lang=ru&nickname=");
    await expect(page.getByTestId("onboarding-own-hosting")).toHaveText(
      "Нет ссылки? Хочу свой сервер",
    );
    await page.getByTestId("onboarding-own-hosting").click();
    await expect(page.getByTestId("own-server-dialog")).toBeVisible();
  });
});

test.describe("P13 rostalk-server-setup", () => {
  test("server step, Russian", async ({ page }) => {
    await page.goto(setupUrl);
    await expect(page.getByTestId("hosting-wizard")).toBeVisible();
    await shot(page, "server-setup-server-ru");
  });

  test("install and done, Russian", async ({ page }) => {
    await page.goto(setupUrl);
    await fillAccess(page, "Пароль");
    await page.getByTestId("hosting-next").click();
    await expect(page.getByTestId("hosting-install")).toBeEnabled();
    await shot(page, "server-setup-check-ru");
    await page.getByTestId("hosting-install").click();
    await expect(page.getByTestId("hosting-step-done")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("hosting-connect")).toHaveCount(0);
    await shot(page, "server-setup-done-ru");
  });

  test("missing server folder, English", async ({ browser }) => {
    const context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 920, height: 720 },
    });
    const page = await context.newPage();
    await page.goto(`${setupUrl}&hostingNoBundle=1`);
    await fillAccess(page, "Password");
    await page.getByTestId("hosting-next").click();
    await expect(page.getByText(/Unpack the whole archive/)).toBeVisible();
    await expect(page.getByTestId("hosting-install")).toBeDisabled();
    await shot(page, "server-setup-no-bundle-en");
    await context.close();
  });
});
