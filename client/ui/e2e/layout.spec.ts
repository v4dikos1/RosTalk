import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

// Stage P8 layout: the member pane on the right, full-width chat and streams,
// and every floating panel inside the window. The bounding-box assertions are
// the regression test for playtest-1 complaint 23: a popover used to be an
// absolutely positioned box inside a clipped container.
const outDir = path.resolve(process.cwd(), "../../docs/assets/p8");
mkdirSync(outDir, { recursive: true });

async function open(page: Page, query: string) {
  await page.goto(`/?fixtures=1&${query}`);
  await expect(page.getByTestId("main-screen")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

async function shot(page: Page, name: string) {
  await page.screenshot({
    path: path.join(outDir, `${name}.png`),
    animations: "disabled",
    caret: "hide",
  });
}

/** The panel is rendered and every edge is inside the viewport. */
async function expectInside(page: Page, testId: string, what: string) {
  const locator = page.getByTestId(testId);
  await expect(locator, what).toBeVisible();
  const viewport = page.viewportSize();
  const box = await locator.boundingBox();
  expect(box, `${what}: no bounding box`).not.toBeNull();
  if (!box || !viewport) {
    return;
  }
  expect(box.x, `${what}: left edge`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${what}: top edge`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${what}: right edge`).toBeLessThanOrEqual(
    viewport.width + 0.5,
  );
  expect(box.y + box.height, `${what}: bottom edge`).toBeLessThanOrEqual(
    viewport.height + 0.5,
  );
}

async function closeWithEscape(page: Page, testId: string) {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(testId)).toHaveCount(0);
}

/** Opens every floating panel once and measures it. */
async function checkEveryPanel(page: Page) {
  await page.getByTestId("server-switcher").click();
  await expectInside(page, "server-menu", "saved servers");
  await closeWithEscape(page, "server-menu");

  await page.locator('button[data-testid="quality-indicator"]').click();
  await expectInside(page, "quality-details", "connection details");
  await shot(page, "panel-quality");
  await closeWithEscape(page, "quality-details");

  // The sidebar invite opens upwards from the footer.
  await page.getByTestId("invite-open").first().click();
  await expectInside(page, "invite-popover", "invite above the sidebar");
  await closeWithEscape(page, "invite-popover");

  await page.getByTestId("invite-open").last().click();
  await expectInside(page, "invite-popover", "invite under the channel header");
  await closeWithEscape(page, "invite-popover");

  // Transmission mode menu in the bottom bar.
  await page.getByTestId("control-gate").click();
  await expectInside(page, "gate-menu", "transmission mode menu");
  await shot(page, "panel-gate");
  await closeWithEscape(page, "gate-menu");

  // User menu, opened the same way as from the tree or the member pane.
  await page.getByTestId("user-2").click({ button: "right" });
  await expectInside(page, "user-menu", "user menu");
  await shot(page, "panel-user-menu");
  await closeWithEscape(page, "user-menu");

  // Cut/copy/paste menu at an arbitrary click point.
  await page.getByTestId("chat-input").click({ button: "right" });
  await expectInside(page, "context-menu", "text context menu");
  await closeWithEscape(page, "context-menu");

  // Profile menu above the bottom-left panel.
  await page.getByTestId("profile-panel").click();
  await expectInside(page, "profile-menu", "profile menu");
  await closeWithEscape(page, "profile-menu");

  // Server actions menu opened from the server name, anchored to a point.
  await page.getByTestId("server-name").click();
  await expectInside(page, "server-actions-menu", "server actions");
  await closeWithEscape(page, "server-actions-menu");
}

/** The bottom bar keeps the ping, the channel and "leave" on screen. */
async function checkBottomBar(page: Page) {
  const viewport = page.viewportSize();
  const bar = page.getByTestId("control-bar");
  await expect(bar).toBeVisible();
  const barBox = await bar.boundingBox();
  expect(barBox).not.toBeNull();
  if (!barBox || !viewport) {
    return;
  }
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(viewport.height + 0.5);

  for (const id of ["control-mic", "control-sound", "control-leave"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, `${id} box`).not.toBeNull();
    if (!box) {
      continue;
    }
    expect(box.y, `${id} top`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `${id} bottom`).toBeLessThanOrEqual(
      viewport.height + 0.5,
    );
    expect(box.x, `${id} left`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${id} right`).toBeLessThanOrEqual(
      viewport.width + 0.5,
    );
  }
}

test.describe("960x600: compact layout", () => {
  test.use({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 });

  test("panels stay inside, the member pane opens as an overlay", async ({
    page,
  }) => {
    await open(page, "theme=dark&lang=ru&channel=4&view=chat");

    // Below 1100 px the pane starts hidden even though settings say "open".
    await expect(page.getByTestId("members-pane")).toHaveCount(0);
    await page.getByTestId("toggle-members").click();
    await expectInside(page, "members-pane", "member pane overlay");
    await expect(page.getByTestId("members-pane")).toHaveAttribute(
      "data-layout",
      "overlay",
    );
    await shot(page, "960-overlay-members");
    await page.getByTestId("members-pane-close").click();
    await expect(page.getByTestId("members-pane")).toHaveCount(0);

    await checkBottomBar(page);
    await checkEveryPanel(page);
    await shot(page, "960-chat");
  });
});

test.describe("960x600 at UI scale 125 %", () => {
  test.use({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 });

  test("nothing is clipped at 125 %", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&channel=4&view=chat&scale=125");
    await checkBottomBar(page);
    await checkEveryPanel(page);
    await shot(page, "960-125-chat");
  });
});

test.describe("maximised 1920x1080", () => {
  test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

  test("member pane is docked, chat and a stream use the whole pane", async ({
    page,
  }) => {
    await open(page, "theme=dark&lang=ru&channel=1&view=chat");
    const pane = page.getByTestId("members-pane");
    await expect(pane).toBeVisible();
    await expect(pane).toHaveAttribute("data-layout", "docked");
    const paneBox = await pane.boundingBox();
    expect(Math.round(paneBox?.width ?? 0)).toBe(240);

    // The old 860 px cap left most of a 1920 px window empty.
    const column = await page.getByTestId("message-column").boundingBox();
    expect(column?.width ?? 0).toBeGreaterThan(1200);
    await shot(page, "1920-chat");

    await checkBottomBar(page);
    await checkEveryPanel(page);

    await page.goto("/?fixtures=1&theme=dark&lang=ru&channel=4&view=chat");
    await page.getByTestId("main-tab-streams").click();
    await expect(page.getByTestId("streams-panel")).toBeVisible();
    const tile = page.getByTestId("stream-6");
    await expect(tile).toBeVisible();
    // One stream fills the pane at 16:9; no 1280 px cap and no empty column.
    const tileBox = await tile.boundingBox();
    expect(tileBox?.width ?? 0).toBeGreaterThan(1100);
    const ratio = (tileBox?.width ?? 0) / (tileBox?.height ?? 1);
    expect(Math.abs(ratio - 16 / 9)).toBeLessThan(0.02);
    await shot(page, "1920-one-stream");
  });
});

test.describe("1440x900 reference screens", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

  test("voice, chat and one stream, dark Russian", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&channel=3&view=chat");
    await expect(page.getByTestId("members-pane")).toBeVisible();
    await shot(page, "main-dark-voice");

    await page.goto("/?fixtures=1&theme=dark&lang=ru&channel=1&view=chat");
    await expect(page.getByTestId("message").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    await shot(page, "main-dark-chat");

    await page.goto("/?fixtures=1&theme=dark&lang=ru&channel=4&view=chat");
    await page.getByTestId("main-tab-streams").click();
    await expect(page.getByTestId("stream-6")).toBeVisible();
    await shot(page, "streams-live-dark");
  });
});

test.describe("1440x900 at UI scale 125 %", () => {
  test.use({ viewport: { width: 1152, height: 720 }, deviceScaleFactor: 1 });

  test("reference screen at 125 %", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&channel=4&view=chat&scale=125");
    await shot(page, "main-dark-125");
  });
});

test.describe("DPI 150 %", () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 });

  test("panels and the bottom bar fit at 150 %", async ({ page }) => {
    await open(page, "theme=dark&lang=ru&channel=4&view=chat");
    await checkBottomBar(page);
    await checkEveryPanel(page);
    await shot(page, "dpi150-chat");
  });
});
