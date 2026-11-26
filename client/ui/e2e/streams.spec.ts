// Stage 5.1 UI screenshots: LIVE labels, the streams tab and the player grid.
// Fixtures only: the actual media path is covered by
// `spikes/stream-webview/tests/streams-engine.spec.ts` against a real server.
import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

const outDir = path.resolve(process.cwd(), "../../docs/assets/stage-5.1");
mkdirSync(outDir, { recursive: true });

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  await page.screenshot({
    path: path.join(outDir, `${name}.png`),
    fullPage: false,
  });
}

test("live marker in the header and the streams tab", async ({ page }) => {
  await page.goto("/?fixtures=1&theme=dark&lang=ru&channel=4&view=members");
  await expect(page.getByTestId("main-screen")).toBeVisible();
  // The tree marks the speaker with an icon, never with a second LIVE badge.
  await expect(
    page.getByTestId("user-6").getByRole("img", { name: "Стримит" }),
  ).toBeVisible();
  await expect(page.getByTestId("channel-live")).toBeVisible();
  await expect(page.getByTestId("main-tab-streams")).toBeVisible();
  await shot(page, "live-tree-dark-ru");
});

test("streams grid with the watch state", async ({ page }) => {
  await page.goto("/?fixtures=1&theme=dark&lang=en&channel=4&view=members");
  await expect(page.getByTestId("main-screen")).toBeVisible();
  await page.getByTestId("main-tab-streams").click();
  await expect(page.getByTestId("streams-panel")).toBeVisible();
  await expect(page.getByTestId("stream-6")).toBeVisible();
  await expect(page.getByTestId("watch-6")).toBeVisible();
  await shot(page, "streams-grid-dark-en");
});

test("150 % volume keeps the app mounted and failures are explicit", async ({
  page,
}) => {
  await page.goto("/?fixtures=1&theme=dark&lang=ru&channel=4&view=members");
  await expect(page.getByTestId("main-screen")).toBeVisible();
  await page.getByTestId("main-tab-streams").click();
  const tile = page.getByTestId("stream-6");
  await expect(tile).toBeVisible();

  // The quality/volume row belongs to a watched stream; start watching first.
  const watch = tile.locator('[data-testid^="watch-"]');
  if (await watch.isVisible()) {
    await watch.click();
  }
  await expect(tile.getByTestId("unwatch-6")).toBeVisible();

  // `audio.volume` only accepts 0..1; 150 % used to throw IndexSizeError inside
  // a React effect and unmount the whole tree.
  const slider = tile.locator('input[type="range"]');
  await slider.evaluate((element) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, "150");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const footer = tile.locator("footer span.tabular-nums");
  await expect(footer).toHaveText("150%");
  await expect(page.getByTestId("main-screen")).toBeVisible();

  // The fixture points at an unreachable media URL: the tile has to say so
  // and offer a retry instead of a generic "source unavailable".
  await expect(tile).toHaveAttribute("data-state", "failed", {
    timeout: 15_000,
  });
  await expect(tile.locator('[data-testid^="retry-"]')).toBeVisible();
  await expect(tile).not.toContainText("Источник экрана недоступен");
});
