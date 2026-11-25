// Stage P12: who watches a stream. Fixtures only: the live run is a separate
// check against a real server and two clients (see docs/assets/p12).
import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

const outDir = path.resolve(process.cwd(), "../../docs/assets/p12");
mkdirSync(outDir, { recursive: true });

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  await page.screenshot({
    path: path.join(outDir, `${name}.png`),
    fullPage: false,
  });
}

test("the stream tile shows its audience and lists it on hover", async ({
  page,
}) => {
  await page.goto("/?fixtures=1&theme=dark&lang=ru&channel=4&view=members");
  await expect(page.getByTestId("main-screen")).toBeVisible();
  await page.getByTestId("main-tab-streams").click();

  const badge = page.getByTestId("stream-viewers-6");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("data-count", "2");
  await expect(badge).toContainText("Смотрят: 2");
  await shot(page, "stream-viewers-tile-dark-ru");

  await badge.hover();
  await expect(page.getByText("Кто смотрит: Dima, Lena")).toBeVisible();
  await shot(page, "stream-viewers-hover-dark-ru");
});

test("the tree and the member pane count the viewers of a streamer", async ({
  page,
}) => {
  await page.goto("/?fixtures=1&theme=dark&lang=ru&channel=4&view=members");
  await expect(page.getByTestId("main-screen")).toBeVisible();

  await expect(page.getByTestId("user-viewers-6")).toHaveAttribute(
    "data-count",
    "2",
  );
  await expect(page.getByTestId("member-viewers-6")).toHaveAttribute(
    "data-count",
    "2",
  );
  await shot(page, "stream-viewers-rows-dark-ru");
});
