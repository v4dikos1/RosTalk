import { expect, test, type Page } from "@playwright/test";

/**
 * P31 live-testing fixes. The fixture adapter is enough: the composer, the
 * tree and the virtualized chat are the same components the desktop client
 * runs. Screenshots land in the Playwright output folder, not in the
 * repository; the assertions are the acceptance signal.
 */

async function openChat(page: Page, query: string) {
  await page.goto(`/?fixtures=1&${query}`);
  await expect(page.getByTestId("main-screen")).toBeVisible();
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

test.describe("P31 composer", () => {
  test("grows without a scrollbar, inserts emoji and keeps tooltips inside", async ({
    page,
  }, testInfo) => {
    await openChat(page, "theme=dark&lang=ru&channel=1&view=chat");
    const input = page.getByTestId("chat-input");
    const composer = page.getByTestId("message-composer");

    // Empty and single-line fields must not show the native scrollbar.
    const empty = await input.evaluate((node) => ({
      overflow: getComputedStyle(node).overflowY,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }));
    expect(empty.overflow).toBe("hidden");
    expect(empty.scrollHeight).toBeLessThanOrEqual(empty.clientHeight + 1);
    await composer.screenshot({ path: testInfo.outputPath("composer-empty.png") });

    await input.fill("одна строка");
    const single = await input.evaluate((node) => ({
      overflow: getComputedStyle(node).overflowY,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }));
    expect(single.overflow).toBe("hidden");
    expect(single.scrollHeight).toBeLessThanOrEqual(single.clientHeight + 1);

    // The picker opens above the composer, searches in Russian and inserts at
    // the caret without losing the draft.
    await input.fill("привет мир");
    await input.evaluate((node: HTMLTextAreaElement) => {
      node.focus();
      node.setSelectionRange(6, 6);
    });
    await page.getByTestId("chat-emoji").click();
    await expect(page.getByTestId("emoji-picker")).toBeVisible();
    await page.getByTestId("emoji-search").fill("кот");
    await expect(page.getByTestId("emoji-🐱")).toBeVisible();
    await page.getByTestId("emoji-🐱").click();
    await expect(page.getByTestId("emoji-picker")).toHaveCount(0);
    await expect(input).toHaveValue("привет🐱 мир");
    await expect(input).toBeFocused();

    await page.getByTestId("chat-emoji").click();
    await expect(page.getByTestId("emoji-picker")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("emoji-picker.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("emoji-picker")).toHaveCount(0);

    // Multi-line content grows to the 132 px cap, and only then scrolls.
    await input.fill(Array.from({ length: 12 }, (_, i) => `строка ${i + 1}`).join("\n"));
    const multiline = await input.evaluate((node) => ({
      overflow: getComputedStyle(node).overflowY,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      height: node.getBoundingClientRect().height,
    }));
    expect(multiline.overflow).toBe("auto");
    expect(multiline.scrollHeight).toBeGreaterThan(multiline.clientHeight);
    expect(multiline.height).toBeLessThanOrEqual(132);
    await composer.screenshot({
      path: testInfo.outputPath("composer-multiline.png"),
    });

    // Tooltips sit above their controls, stay in the viewport and do not cover
    // the textarea.
    const inputBox = await input.boundingBox();
    await page.getByTestId("chat-send").hover();
    const sendTip = page.getByRole("tooltip");
    await expect(sendTip).toBeVisible();
    const sendBox = await sendTip.boundingBox();
    const viewport = page.viewportSize();
    expect(sendBox).not.toBeNull();
    expect(inputBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (sendBox && inputBox && viewport) {
      expect(sendBox.y).toBeGreaterThanOrEqual(0);
      expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(viewport.height);
      expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(inputBox.y + 2);
    }
    await page.screenshot({
      path: testInfo.outputPath("tooltip-bottom.png"),
      animations: "disabled",
    });
  });
});

test.describe("P31 tree and selection", () => {
  test("keeps empty voice channels free of a placeholder row", async ({
    page,
  }, testInfo) => {
    await page.goto("/?fixtures=1&theme=dark&lang=ru&channel=5&view=chat");
    await expect(page.getByTestId("main-screen")).toBeVisible();
    await expect(page.getByTestId("channel-5")).toBeVisible();
    await expect(page.getByText("Здесь никого")).toHaveCount(0);
    await page.getByTestId("channel-tree").screenshot({
      path: testInfo.outputPath("tree-empty-voice.png"),
    });
  });

  test("selects chat text but not the interface chrome", async ({ page }) => {
    await openChat(page, "theme=dark&lang=ru&channel=1&view=chat");
    await expect(page.getByTestId("message").first()).toBeVisible();

    const chrome = await page.evaluate(
      () => getComputedStyle(document.body).userSelect,
    );
    expect(chrome).toBe("none");
    const message = await page
      .getByTestId("message")
      .first()
      .evaluate((node) => getComputedStyle(node).userSelect);
    expect(message).toBe("text");
    const composer = await page
      .getByTestId("chat-input")
      .evaluate((node) => getComputedStyle(node).userSelect);
    expect(composer).toBe("text");
    const sidebar = await page
      .getByTestId("channel-tree")
      .evaluate((node) => getComputedStyle(node).userSelect);
    expect(sidebar).toBe("none");
  });
});

test.describe("P31 chat across tabs", () => {
  test("keeps the message scroll and the draft on Стрим → Чат", async ({
    page,
  }, testInfo) => {
    await openChat(
      page,
      "theme=dark&lang=ru&channel=4&view=chat&longChat=1",
    );
    const list = page.getByTestId("message-list");
    const input = page.getByTestId("chat-input");
    await expect(page.getByTestId("message").first()).toBeVisible();

    // A real overflow, not just node identity: move the virtualized feed up
    // and read the offset back from the browser.
    await expect
      .poll(() =>
        list.evaluate((node) => node.scrollHeight - node.clientHeight),
      )
      .toBeGreaterThan(200);
    const before = await list.evaluate((node) => {
      node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2);
      return node.scrollTop;
    });
    expect(before).toBeGreaterThan(0);
    await expect(page.getByTestId("message").first()).toBeVisible();

    await input.fill("черновик для стрима");
    await page
      .getByTestId("chat-panel")
      .evaluate((node) => node.setAttribute("data-p31-kept", "1"));
    await page.screenshot({
      path: testInfo.outputPath("chat-before-tabs.png"),
      animations: "disabled",
    });

    await page.getByTestId("main-tab-streams").click();
    await expect(page.getByTestId("streams-panel")).toBeVisible();
    await expect(page.getByTestId("chat-view")).toBeHidden();
    // The hidden chat is the same mounted node, not a remount.
    await expect(page.getByTestId("chat-panel")).toHaveAttribute(
      "data-p31-kept",
      "1",
    );

    await page.getByTestId("main-tab-chat").click();
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(page.getByTestId("chat-panel")).toHaveAttribute(
      "data-p31-kept",
      "1",
    );

    // The scroll offset survives the tab switch within one pixel.
    await expect
      .poll(async () => {
        const current = await list.evaluate((node) => node.scrollTop);
        return Math.abs(current - before) <= 1;
      })
      .toBe(true);
    const after = await list.evaluate((node) => node.scrollTop);
    expect(after).toBeGreaterThan(0);
    await expect(page.getByTestId("message").first()).toBeVisible();
    await expect(input).toHaveValue("черновик для стрима");
    await page.screenshot({
      path: testInfo.outputPath("chat-after-tabs.png"),
      animations: "disabled",
    });
  });
});
