import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

// Stage P26 acceptance: the room layout at the minimum and maximised window,
// at 100 % and 125 % DPI, in both languages, with six participants, two live
// streams, and the member pane open and closed (playtest-2, complaints 3, 5,
// 6, 8, 14, 15).
const outDir = path.resolve(process.cwd(), "../../docs/assets/p26");
mkdirSync(outDir, { recursive: true });

async function open(page: Page, query: string) {
  await page.goto(`/?fixtures=1&${query}`);
  await expect(page.getByTestId("main-screen")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
}

async function shot(page: Page, name: string) {
  await page.screenshot({
    path: path.join(outDir, `${name}.png`),
    animations: "disabled",
    caret: "hide",
  });
}

async function expectNoOverlap(page: Page) {
  const ids = [
    "channel-you-are-here",
    "channel-live",
    "channel-members",
    "toggle-stream",
    "toggle-members",
  ];
  const boxes: Array<{ id: string; x: number; y: number; w: number; h: number }> =
    [];
  for (const id of ids) {
    const locator = page.getByTestId(id);
    if ((await locator.count()) === 0) {
      continue;
    }
    const box = await locator.boundingBox();
    expect(box, `${id} box`).not.toBeNull();
    if (box) {
      boxes.push({ id, x: box.x, y: box.y, w: box.width, h: box.height });
    }
  }
  for (let index = 0; index < boxes.length; index += 1) {
    for (let other = index + 1; other < boxes.length; other += 1) {
      const a = boxes[index]!;
      const b = boxes[other]!;
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      expect(
        overlapX > 0.5 && overlapY > 0.5,
        `${a.id} overlaps ${b.id}`,
      ).toBe(false);
    }
  }
}

async function expectServerOnce(page: Page, name: string) {
  await expect(page.getByTestId("title-bar")).not.toContainText(name);
  await expect(page.getByTestId("server-name")).toContainText(name);
  await expect(page.getByTestId("server-name")).toContainText(
    /\d+ (в сети|online)/,
  );
}

async function expectVoiceGroupOnce(page: Page) {
  const voice = page.getByTestId("voice-controls");
  await expect(voice).toBeVisible();
  await expect(voice.getByTestId("control-mic")).toBeVisible();
  await expect(voice.getByTestId("control-gate")).toBeVisible();
  await expect(voice.getByTestId("control-mic-test")).toBeVisible();
  await expect(voice.getByTestId("control-sound")).toBeVisible();
  await expect(voice.getByTestId("control-leave")).toBeVisible();
  await expect(page.getByTestId("control-bar").getByTestId("control-mic")).toHaveCount(
    0,
  );
  await expect(page.getByTestId("control-bar").getByTestId("control-leave")).toHaveCount(
    0,
  );
}

async function expectSheetGap(page: Page) {
  const sidebar = await page.getByTestId("sidebar").boundingBox();
  const main = await page
    .getByTestId("main-screen")
    .locator("main")
    .boundingBox();
  expect(sidebar).not.toBeNull();
  expect(main).not.toBeNull();
  if (!sidebar || !main) {
    return;
  }
  expect(Math.round(sidebar.x)).toBe(8);
  expect(Math.round(main.x - (sidebar.x + sidebar.width))).toBe(8);
}

test.describe("P26 minimum window 960x600", () => {
  test.use({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 });

  test("RU, 100 %, two streams, member pane open", async ({ page }) => {
    await open(page, "room=six&theme=dark&lang=ru&channel=4&view=chat");
    await page.getByTestId("main-tab-streams").click();
    await expect(page.getByTestId("streams-panel")).toBeVisible();
    await expect(page.getByTestId("stream-5")).toBeVisible();
    await expect(page.getByTestId("stream-6")).toBeVisible();

    await page.getByTestId("toggle-members").click();
    await expect(page.getByTestId("members-pane")).toHaveAttribute(
      "data-layout",
      "overlay",
    );
    await expectNoOverlap(page);
    await expectServerOnce(page, "Очаг друзей");
    await expectVoiceGroupOnce(page);
    await expectSheetGap(page);
    await shot(page, "p26-960-100-ru-streams-members");

    // The overlay closes without a layout shift; the header keeps its groups.
    await page.getByTestId("members-pane-close").click();
    await expect(page.getByTestId("members-pane")).toHaveCount(0);
    await shot(page, "p26-960-100-ru-streams");
  });

  test("EN, 100 %, member pane closed, six participants", async ({ page }) => {
    await open(page, "room=six&theme=light&lang=en&channel=4&view=chat");
    await expect(page.getByTestId("members-pane")).toHaveCount(0);
    await expectNoOverlap(page);
    await expectServerOnce(page, "Очаг друзей");
    await expectVoiceGroupOnce(page);
    await expectSheetGap(page);
    await shot(page, "p26-960-100-en-chat");
  });
});

test.describe("P26 minimum window at 125 % DPI", () => {
  test.use({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1.25 });

  test("EN, two streams, member pane closed", async ({ page }) => {
    await open(page, "room=six&theme=light&lang=en&channel=4&view=chat");
    await page.getByTestId("main-tab-streams").click();
    await expect(page.getByTestId("streams-panel")).toBeVisible();
    await expect(page.getByTestId("stream-5")).toBeVisible();
    await expect(page.getByTestId("stream-6")).toBeVisible();
    await expect(page.getByTestId("members-pane")).toHaveCount(0);
    await expectNoOverlap(page);
    await expectServerOnce(page, "Очаг друзей");
    await expectVoiceGroupOnce(page);
    await expectSheetGap(page);
    await shot(page, "p26-960-125-en-streams");
  });

  test("RU, 125 %, member pane open, chat", async ({ page }) => {
    await open(page, "room=six&theme=dark&lang=ru&channel=4&view=chat");
    await page.getByTestId("toggle-members").click();
    await expect(page.getByTestId("members-pane")).toHaveAttribute(
      "data-layout",
      "overlay",
    );
    await expectNoOverlap(page);
    await expectServerOnce(page, "Очаг друзей");
    await expectVoiceGroupOnce(page);
    await expectSheetGap(page);
    await shot(page, "p26-960-125-ru-chat-members");
  });
});

test.describe("P26 maximised 1920x1080", () => {
  test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

  test("RU, 100 %, docked member pane, two streams", async ({ page }) => {
    await open(page, "room=six&theme=dark&lang=ru&channel=4&view=chat");
    await page.getByTestId("main-tab-streams").click();
    await expect(page.getByTestId("members-pane")).toHaveAttribute(
      "data-layout",
      "docked",
    );
    await expect(page.getByTestId("stream-5")).toBeVisible();
    await expect(page.getByTestId("stream-6")).toBeVisible();
    await expectNoOverlap(page);
    await expectServerOnce(page, "Очаг друзей");
    await expectVoiceGroupOnce(page);
    await expectSheetGap(page);
    await shot(page, "p26-1920-100-ru-streams-members");
  });

  test("EN, 100 %, member pane closed, six participants", async ({ page }) => {
    await open(page, "room=six&theme=light&lang=en&channel=4&view=chat");
    await expect(page.getByTestId("members-pane")).toBeVisible();
    await page.getByTestId("toggle-members").click();
    await expect(page.getByTestId("members-pane")).toHaveCount(0);
    await expectNoOverlap(page);
    await expectServerOnce(page, "Очаг друзей");
    await expectVoiceGroupOnce(page);
    await expectSheetGap(page);
    await shot(page, "p26-1920-100-en-chat");
  });
});

test.describe("P26 maximised at 125 % DPI", () => {
  test.use({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });

  test("EN, member pane closed, two streams", async ({ page }) => {
    await open(page, "room=six&theme=dark&lang=en&channel=4&view=chat");
    await page.getByTestId("main-tab-streams").click();
    await expect(page.getByTestId("members-pane")).toBeVisible();
    await page.getByTestId("toggle-members").click();
    await expect(page.getByTestId("members-pane")).toHaveCount(0);
    await expect(page.getByTestId("stream-5")).toBeVisible();
    await expect(page.getByTestId("stream-6")).toBeVisible();
    await expectNoOverlap(page);
    await expectServerOnce(page, "Очаг друзей");
    await expectVoiceGroupOnce(page);
    await expectSheetGap(page);
    await shot(page, "p26-1920-125-en-streams");
  });

  test("RU, 125 %, member pane open, chat", async ({ page }) => {
    await open(page, "room=six&theme=dark&lang=ru&channel=4&view=chat");
    await expect(page.getByTestId("members-pane")).toHaveAttribute(
      "data-layout",
      "docked",
    );
    await expectNoOverlap(page);
    await expectServerOnce(page, "Очаг друзей");
    await expectVoiceGroupOnce(page);
    await expectSheetGap(page);
    await shot(page, "p26-1920-125-ru-chat-members");
  });
});

test.describe("P26 server identity", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

  test("RosTalk, a long name and the disconnected screen keep one header", async ({
    page,
  }) => {
    await open(page, "server=rostalk&theme=dark&lang=ru&channel=3");
    await expectServerOnce(page, "RosTalk");

    await open(page, "server=long&theme=dark&lang=ru&channel=3");
    await expect(page.getByTestId("server-name")).toHaveAttribute(
      "title",
      "Сервер друзей и очень длинное название, которое проверяет шапку · 7 в сети",
    );
    await shot(page, "p26-long-server-name");

    await open(page, "state=disconnected&theme=dark&lang=en&channel=3");
    await expect(page.getByTestId("title-bar")).not.toContainText("offline");
    await expect(page.getByTestId("server-name")).toContainText("192.168.0.13");
    await expect(page.getByTestId("voice-idle")).toContainText("Not in a channel");
    await shot(page, "p26-disconnected-en");
  });
});

test.describe("P26 keyboard and focus", () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  test("every voice action is reachable, focused and named", async ({ page }) => {
    await open(page, "room=six&theme=dark&lang=ru&channel=4&view=chat");

    for (const id of [
      "control-mic",
      "control-gate",
      "control-mic-test",
      "control-sound",
      "control-leave",
    ]) {
      const button = page.getByTestId(id);
      await button.focus();
      await expect(button).toBeFocused();
      await expect(button).toHaveAccessibleName(/.+/);
    }

    await page.getByTestId("control-gate").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("gate-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("gate-menu")).toHaveCount(0);
  });

  test("each watched stream has its own named unwatch action", async ({
    page,
  }) => {
    await open(page, "room=six&theme=dark&lang=ru&channel=4&view=chat");
    await page.getByTestId("main-tab-streams").click();

    await page.getByTestId("watch-5").click();
    await expect(page.getByTestId("unwatch-5")).toBeVisible();
    const unwatch = page.getByTestId("unwatch-5");
    await unwatch.focus();
    await expect(unwatch).toBeFocused();
    await expect(unwatch).toHaveAccessibleName(
      "Перестать смотреть стрим Dima и выключить его звук",
    );

    // Watching the second stream and leaving the first keeps the second tile.
    await page.getByTestId("watch-6").click();
    await expect(page.getByTestId("unwatch-6")).toBeVisible();
    await page.getByTestId("unwatch-5").click();
    await expect(page.getByTestId("watch-5")).toBeVisible();
    await expect(page.getByTestId("unwatch-6")).toBeVisible();
  });
});
