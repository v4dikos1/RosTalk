import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

// Stage UI polish: every preset renders with its real tokens, plus the
// appearance section itself. Kept apart from the stage 2.4 set.
const outDir = path.resolve(process.cwd(), "../../docs/assets/stage-ui");
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

const presets = ["rostalk", "paper", "amoled", "contrast"] as const;

test.describe("stage ui presets", () => {
  for (const preset of presets) {
    test(`main screen, ${preset}`, async ({ page }) => {
      await openMock(page, `preset=${preset}&lang=ru&channel=3`);
      await shot(page, `main-${preset}-ru`);
    });
  }

  test("ember accent on rostalk", async ({ page }) => {
    await openMock(page, "preset=rostalk&accent=ember&lang=ru&channel=3");
    await shot(page, "main-rostalk-ember-ru");
  });

  test("ice accent on rostalk", async ({ page }) => {
    await openMock(page, "preset=rostalk&accent=ice&lang=ru&channel=3");
    await shot(page, "main-rostalk-ice-ru");
  });

  test("violet accent on paper", async ({ page }) => {
    await openMock(page, "preset=paper&accent=violet&lang=en&channel=3");
    await shot(page, "main-paper-violet-en");
  });

  test("appearance settings, rostalk", async ({ page }) => {
    await openMock(page, "preset=rostalk&accent=auto&lang=ru&settings=appearance");
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.waitForTimeout(200);
    await shot(page, "settings-appearance-rostalk-ru");
  });

  test("appearance settings, paper, compact, 125%", async ({ page }) => {
    await openMock(
      page,
      "preset=paper&accent=moss&compact=1&scale=125&radius=round&lang=en&settings=appearance",
    );
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.waitForTimeout(250);
    await shot(page, "settings-appearance-paper-125-en");
  });

  test("chat with a date separator", async ({ page }) => {
    await openMock(
      page,
      "preset=rostalk&accent=auto&lang=ru&channel=1&view=chat",
    );
    await shot(page, "chat-date-separator-ru");
  });
});
