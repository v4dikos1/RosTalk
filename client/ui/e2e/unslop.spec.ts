import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

// "After" set of the unslop pass (docs/ux/2026-11-22-unslop-plan.md).
//
// Same screens, viewport and fixtures as docs/assets/unslop/0*-*.png so the
// two folders can be compared one-to-one. Besides the images, the spec asserts
// the rules of the plan that are structural rather than visual: one LIVE
// marker, a 56 px header, one 16:9 stream window, ember mentions and
// separators, sentence-case settings headings, no uppercase labels, no text
// below 10 px and a single "not connected" label.
const outDir = path.resolve(process.cwd(), "../../docs/assets/unslop");
mkdirSync(outDir, { recursive: true });

const link = `rostalk://join?host=192.168.0.13:7443&fp=${"ab".repeat(32)}&invite=demo`;

async function openMock(page: Page, query: string) {
  await page.goto(`/?fixtures=1&${query}`);
  await expect(page.getByTestId("main-screen")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function shot(page: Page, name: string) {
  await page.screenshot({
    path: path.join(outDir, `after-${name}.png`),
    animations: "disabled",
    caret: "hide",
  });
}

test.describe("unslop screenshots at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

  test("01/02 main dark, voice and chat", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&channel=4&view=members");
    // One rhythm: the channel header and the sidebar header are both 56 px.
    const header = page.locator("main header").first();
    const box = await header.boundingBox();
    expect(Math.round(box?.height ?? 0)).toBe(56);
    // One LIVE marker: the header. The tree only keeps the accent icon.
    await expect(page.getByText("В эфире")).toHaveCount(1);
    await expect(page.getByTestId("channel-live")).toBeVisible();
    await shot(page, "01-main-dark-voice");

    await page.goto("/?fixtures=1&theme=dark&lang=ru&channel=1&view=chat");
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(page.getByTestId("message").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);

    // A mention is an ember rule on the row, not a filled block.
    const mention = page.locator('[data-testid="message"]').filter({
      hasText: "посмотри, как теперь выглядит лента",
    });
    const shadow = await mention.evaluate(
      (node) => getComputedStyle(node).boxShadow,
    );
    expect(shadow).toContain("inset");
    expect(shadow).not.toBe("none");
    await shot(page, "02-main-dark-chat");
  });

  test("03/04 main light, voice and chat", async ({ page }) => {
    await openMock(page, "theme=light&lang=ru&channel=4&view=members");
    await shot(page, "03-main-light-voice");

    await page.goto("/?fixtures=1&theme=light&lang=ru&channel=1&view=chat");
    await expect(page.getByTestId("message").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    await shot(page, "04-main-light-chat");
  });

  test("07/08 first run, dark and light", async ({ page }) => {
    await page.goto(
      `/?fixtures=1&onboarding=1&theme=dark&lang=ru&nickname=&link=${encodeURIComponent(link)}`,
    );
    await expect(page.getByTestId("onboarding")).toBeVisible();
    await expect(page.getByTestId("link-preview")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    await shot(page, "07-onboarding-dark");

    await page.goto(
      `/?fixtures=1&onboarding=1&theme=light&lang=ru&nickname=&link=${encodeURIComponent(link)}`,
    );
    await expect(page.getByTestId("onboarding")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    await shot(page, "08-onboarding-light");
  });

  test("09/10/18 settings appearance, dark and light", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&settings=appearance");
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    // The group headings are sentence case, and the note uses a lucide icon.
    const heading = page.getByText("Пресет", { exact: true }).first();
    expect(
      await heading.evaluate((node) => getComputedStyle(node).textTransform),
    ).toBe("none");
    await expect(
      page.getByTestId("settings-content").locator(".lucide-info"),
    ).toHaveCount(1);
    await shot(page, "09-settings-appearance-dark");

    await page.goto("/?fixtures=1&theme=light&lang=ru&settings=appearance");
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.waitForTimeout(200);
    await shot(page, "10-settings-appearance-light");
    await shot(page, "18-settings-appearance-light");
  });

  test("11/12 admin general and roles", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&settings=server&adminTab=general");
    await expect(page.getByTestId("server-general")).toBeVisible();
    await shot(page, "11-admin-general-dark");

    await page.goto(
      "/?fixtures=1&theme=dark&lang=ru&settings=server&adminTab=roles",
    );
    await expect(page.getByTestId("role-editor")).toBeVisible();
    await page.getByTestId("role-select-2").click();
    await expect(page.getByTestId("permission-kick")).toBeVisible();
    await page.waitForTimeout(150);
    await shot(page, "12-admin-roles-dark");
  });

  test("13/16 one stream, one 16:9 window", async ({ page }) => {
    for (const [theme, name] of [
      ["dark", "13-streams-live-dark"],
      ["light", "16-streams-live-light"],
    ] as const) {
      await openMock(page, `theme=${theme}&lang=ru&channel=4&view=members`);
      await page.getByTestId("main-tab-streams").click();
      await expect(page.getByTestId("streams-panel")).toBeVisible();
      const tile = page.getByTestId("stream-6");
      await expect(tile).toBeVisible();

      const grid = page.getByTestId("streams-grid");
      expect(
        await grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns),
      ).not.toContain(" ");
      // 16:9, within a pixel of rounding.
      const box = await tile.boundingBox();
      const ratio = (box?.width ?? 0) / (box?.height ?? 1);
      expect(Math.abs(ratio - 16 / 9)).toBeLessThan(0.02);
      await shot(page, name);
    }
  });

  test("14 command palette with keycaps", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&palette=1");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    const footer = page.locator("[data-testid='command-palette'] footer");
    await expect(footer.locator("kbd")).toHaveCount(3);
    await expect(footer.locator("kbd").first()).toHaveText("↑↓");
    await shot(page, "14-palette-dark");
  });

  test("15 disconnected light: one connection label", async ({ page }) => {
    await openMock(page, "theme=light&lang=ru&state=disconnected");
    await expect(page.getByTestId("state-welcome")).toBeVisible();
    await expect(page.getByText("Нет связи")).toHaveCount(1);
    await expect(page.getByText("Не подключено")).toHaveCount(0);
    await shot(page, "15-disconnected-light");
  });

  test("19 user menu: switches instead of checkboxes", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&userMenu=2");
    await expect(page.getByTestId("user-menu")).toBeVisible();
    await shot(page, "19-user-menu-dark");

    await page.getByTestId("user-menu-ban").click();
    await expect(page.getByTestId("user-menu-by-key")).toHaveAttribute(
      "role",
      "switch",
    );
    await expect(page.getByTestId("user-menu-by-ip")).toHaveAttribute(
      "role",
      "switch",
    );
    await expect(page.locator("input[type=checkbox]")).toHaveCount(0);
    await page.waitForTimeout(150);
    await shot(page, "19b-user-menu-ban-dark");
  });

  test("20 server switcher, light", async ({ page }) => {
    await openMock(page, "theme=light&lang=ru&channel=3&view=members");
    await page.getByTestId("server-switcher").click();
    await expect(page.getByTestId("server-menu")).toBeVisible();
    await shot(page, "20-server-switcher-light");
  });

  test("21 settings voice, light", async ({ page }) => {
    await openMock(page, "theme=light&lang=ru&settings=voice");
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.waitForTimeout(200);
    await shot(page, "21-settings-voice-light");
  });

  test("22 direct message, dark", async ({ page }) => {
    await page.goto("/?fixtures=1&theme=dark&lang=ru&dm=2");
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(page.getByTestId("message").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    // The unread boundary is the same pill as a date, in accent.
    const line = page.getByTestId("new-messages-line");
    await expect(line).toBeVisible();
    const pill = line.getByText("Новые сообщения");
    expect(
      await pill.evaluate((node) => getComputedStyle(node).textTransform),
    ).toBe("none");
    await shot(page, "22-dm-dark");
  });

  test("no visible text below 10 px outside avatar initials", async ({
    page,
  }) => {
    await openMock(page, "theme=dark&lang=ru&channel=1&view=chat");
    const tiny = await page.evaluate(() => {
      const found: string[] = [];
      for (const element of document.querySelectorAll<HTMLElement>("body *")) {
        const own = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent?.trim() ?? "")
          .join("");
        if (own.length <= 2) {
          continue; // Avatar initials are allowed to stay at 8 px.
        }
        const size = Number.parseFloat(getComputedStyle(element).fontSize);
        if (size < 10) {
          found.push(`${element.tagName}:${size}:${own.slice(0, 24)}`);
        }
      }
      return found;
    });
    expect(tiny).toEqual([]);
  });
});

test.describe("unslop 125 % (1152×720 at DPR 1.25)", () => {
  test.use({
    viewport: { width: 1152, height: 720 },
    deviceScaleFactor: 1.25,
  });

  test("05 main dark at 125 %", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&channel=4&view=members&scale=125");
    await shot(page, "05-main-dark-125");
  });

  test("06 main light at 125 %", async ({ page }) => {
    await openMock(page, "theme=light&lang=ru&channel=4&view=members&scale=125");
    await shot(page, "06-main-light-125");
  });

  test("17 chat dark at 125 %", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&channel=1&view=chat&scale=125");
    await expect(page.getByTestId("message").first()).toBeVisible();
    await shot(page, "17-chat-125-dark");
  });
});
