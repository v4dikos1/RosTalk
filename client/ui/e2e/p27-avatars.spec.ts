import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

// Stage P27: the right member pane opens a read-only avatar viewer on the
// primary action, while the context action still opens the user menu. The
// fixture adapter seeds another user's picture through `?demoAvatarUser=`;
// `?demoAvatarUnavailable=1` keeps only the hash, which is the same state a
// failed proxy read produces.
const outDir = path.resolve(process.cwd(), "../../docs/assets/p27");
mkdirSync(outDir, { recursive: true });
const base = "/?fixtures=1&theme=dark&lang=ru&channel=3&view=members";

async function openClient(page: Page, query = "") {
  await page.goto(`${base}${query}`);
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

test.describe("stage P27 avatar viewer", () => {
  test("shows another member's stored picture and returns focus on Escape", async ({
    page,
  }) => {
    await openClient(page, "&demoAvatarUser=2");
    const row = page.getByTestId("member-pane-2");
    await row.click();

    const viewer = page.getByTestId("avatar-viewer");
    await expect(viewer).toBeVisible();
    await expect(page.getByTestId("avatar-viewer-image")).toBeVisible();
    await expect(page.getByTestId("avatar-viewer-state")).toContainText(
      "Сохранённый размер: 256 × 256",
    );
    await page.waitForTimeout(100);
    await shot(page, "viewer-loaded");

    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(row).toBeFocused();
  });

  test("shows initials and a plain state when the picture is missing or unavailable", async ({
    page,
  }) => {
    await openClient(page);
    await page.getByTestId("member-pane-2").click();
    await expect(page.getByTestId("avatar-viewer-fallback")).toBeVisible();
    await expect(page.getByTestId("avatar-viewer-state")).toContainText(
      "У участника нет аватара",
    );
    await shot(page, "viewer-missing");
    await page.keyboard.press("Escape");

    await openClient(page, "&demoAvatarUser=2&demoAvatarUnavailable=1");
    await page.getByTestId("member-pane-2").click();
    await expect(page.getByTestId("avatar-viewer-fallback")).toBeVisible();
    await expect(page.getByTestId("avatar-viewer-state")).toContainText(
      "Аватар недоступен",
    );
    await shot(page, "viewer-unavailable");
  });

  test("keeps the user menu on the context action and on Shift+F10", async ({
    page,
  }) => {
    await openClient(page, "&demoAvatarUser=2");

    await page.getByTestId("member-pane-2").click({ button: "right" });
    await expect(page.getByTestId("user-menu")).toBeVisible();
    // Stage P27 removed the cross-user reset even for the administrator.
    await expect(page.getByTestId("user-menu-reset-avatar")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("user-menu")).toBeHidden();

    const row = page.getByTestId("member-pane-2");
    await row.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByTestId("user-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("avatar-viewer")).toBeHidden();
  });

  test("your own row opens the profile with the avatar editor", async ({
    page,
  }) => {
    await openClient(page);
    await page.getByTestId("member-pane-1").click();
    await expect(page.getByTestId("settings-avatar-change")).toBeVisible();
    await expect(page.getByTestId("avatar-dialog")).toHaveCount(0);
    await page.getByTestId("settings-avatar-change").click();
    await expect(page.getByTestId("avatar-dialog")).toBeVisible();
    await shot(page, "profile-editor");
  });
});
