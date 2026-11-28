import { expect, test, type Page } from "@playwright/test";

/**
 * P33 chat fixes: the full emoji picker (categories, lazy data, virtualized
 * grid), the composer's vertical centering and the clickable author nickname.
 * The fixture adapter runs the same components as the desktop client.
 */

async function openChat(page: Page) {
  await page.goto("/?fixtures=1&theme=dark&lang=ru&channel=1&view=chat");
  await expect(page.getByTestId("main-screen")).toBeVisible();
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function composerCenterDelta(page: Page): Promise<number[]> {
  const input = await page.getByTestId("chat-input").boundingBox();
  expect(input).not.toBeNull();
  const deltas: number[] = [];
  for (const id of ["chat-attach", "chat-emoji", "chat-send"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box).not.toBeNull();
    if (box && input) {
      deltas.push(
        Math.abs(
          box.y + box.height / 2 - (input.y + input.height / 2),
        ),
      );
    }
  }
  return deltas;
}

test.describe("P33 composer alignment", () => {
  test("centers attach, emoji and send on one line and at the multiline cap", async ({
    page,
  }, testInfo) => {
    await openChat(page);
    const input = page.getByTestId("chat-input");
    const composer = page.getByTestId("message-composer");

    // Empty and one-line: every control shares the field's vertical center.
    expect(Math.max(...(await composerCenterDelta(page)))).toBeLessThanOrEqual(2);
    await composer.screenshot({
      path: testInfo.outputPath("composer-one-line.png"),
    });

    await input.fill("одна строка");
    expect(Math.max(...(await composerCenterDelta(page)))).toBeLessThanOrEqual(2);

    // The field reaches its 132 px cap; the buttons must stay centered instead
    // of sticking to the bottom edge (the P33 regression).
    await input.fill(
      Array.from({ length: 12 }, (_, index) => `строка ${index + 1}`).join(
        "\n",
      ),
    );
    const height = await input.evaluate(
      (node) => node.getBoundingClientRect().height,
    );
    expect(height).toBeGreaterThan(100);
    expect(height).toBeLessThanOrEqual(132);
    expect(Math.max(...(await composerCenterDelta(page)))).toBeLessThanOrEqual(2);
    await composer.screenshot({
      path: testInfo.outputPath("composer-multiline.png"),
    });
  });
});

test.describe("P33 emoji picker", () => {
  test("loads the Unicode set lazily, groups it and inserts at the caret", async ({
    page,
  }, testInfo) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("emojiData")) {
        requests.push(request.url());
      }
    });

    await openChat(page);
    // The big data module is not part of the initial composer chunk.
    expect(requests).toHaveLength(0);

    const input = page.getByTestId("chat-input");
    await input.fill("привет мир");
    await input.evaluate((node: HTMLTextAreaElement) => {
      node.focus();
      node.setSelectionRange(6, 6);
    });

    await page.getByTestId("chat-emoji").click();
    await expect(page.getByTestId("emoji-picker")).toBeVisible();
    await expect(page.getByTestId("emoji-tabs")).toBeVisible();
    await expect(page.getByTestId("emoji-grid")).toBeVisible();
    expect(requests.length).toBeGreaterThan(0);

    // Nine emoji-test categories, localized, Component excluded.
    await expect(page.getByTestId("emoji-tabs").locator('[role="tab"]')).toHaveCount(9);
    await expect(page.getByTestId("emoji-tab-smileys")).toHaveText("Смайлы");
    await expect(page.getByTestId("emoji-tab-smileys")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Not all ~4000 entries are mounted: only the visible rows and overscan.
    const mounted = await page
      .getByTestId("emoji-grid")
      .locator("[data-emoji-button]")
      .count();
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(200);

    // Search in Russian, pick with the keyboard, keep the caret position.
    await page.getByTestId("emoji-search").fill("кот");
    await expect(page.getByTestId("emoji-🐱")).toBeVisible();
    const firstMatch = page.locator('[data-emoji-index="0"]');
    await expect(firstMatch).toBeVisible();
    const firstGlyph = await firstMatch.getAttribute("aria-label");
    await page.keyboard.press("ArrowDown");
    await expect(firstMatch).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("emoji-picker")).toHaveCount(0);
    await expect(input).toHaveValue(`привет${firstGlyph} мир`);
    await expect(input).toBeFocused();

    // A category tab switches the visible set.
    await page.getByTestId("chat-emoji").click();
    await expect(page.getByTestId("emoji-grid")).toBeVisible();
    await page.getByTestId("emoji-tab-nature").click();
    await expect(page.getByTestId("emoji-tab-nature")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("emoji-tab-smileys")).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await page.screenshot({
      path: testInfo.outputPath("emoji-picker-full.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("emoji-picker")).toHaveCount(0);
  });
});

test.describe("P33 mention author", () => {
  test("opens the existing user menu from the nickname", async ({
    page,
  }, testInfo) => {
    await openChat(page);
    const author = page.getByTestId("message-author").first();
    await expect(author).toBeVisible();
    const label = await author.getAttribute("aria-label");
    expect(label).toBeTruthy();

    await author.click();
    const menu = page.getByTestId("user-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("role", "dialog");
    await page.screenshot({
      path: testInfo.outputPath("author-menu.png"),
      animations: "disabled",
    });
  });
});
