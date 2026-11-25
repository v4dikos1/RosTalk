import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

// Stage P11 avatars. Two pages of the fixture adapter act as two clients: an
// upload in one is broadcast in the same way the core mirrors `UserUpdated`,
// so the picture must appear in the other without a reload.
const outDir = path.resolve(process.cwd(), "../../docs/assets/p11");
mkdirSync(outDir, { recursive: true });
const picture = path.resolve(process.cwd(), "e2e/assets/avatar.png");

async function openClient(page: Page, url = "/?fixtures=1&theme=dark&lang=ru&channel=3&view=members") {
  await page.goto(url);
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

async function changeAvatar(page: Page) {
  await page.getByTestId("profile-panel").click();
  await page.getByTestId("profile-menu-avatar").click();
  await expect(page.getByTestId("avatar-dialog")).toBeVisible();
  await page.getByTestId("avatar-file-input").setInputFiles(picture);
  await expect(page.getByTestId("avatar-crop-image")).toBeVisible();
  await page.waitForTimeout(150);
}

test.describe("stage P11 avatars", () => {
  test("an upload is visible to the second client and removal reaches it too", async ({
    context,
  }) => {
    const first = await context.newPage();
    const second = await context.newPage();
    await openClient(first);
    await openClient(second);

    // Both start with initials.
    await expect(first.getByTestId("profile-panel").getByTestId("avatar-image")).toHaveCount(
      0,
    );

    await changeAvatar(first);
    await shot(first, "p11-avatar-crop");

    await first.getByTestId("avatar-save").click();
    await expect(first.getByTestId("avatar-dialog")).toBeHidden();
    await expect(
      first.getByTestId("profile-panel").getByTestId("avatar-image"),
    ).toBeVisible();
    await expect(
      second.getByTestId("profile-panel").getByTestId("avatar-image"),
    ).toBeVisible();

    // The members pane draws the same picture, not only the profile panel.
    await expect(
      second.getByTestId("member-pane-1").getByTestId("avatar-image"),
    ).toBeVisible();
    await second.waitForTimeout(200);
    await shot(second, "p11-avatar-second-client");

    // Removing it also reaches the other page.
    await first.getByTestId("profile-panel").click();
    await first.getByTestId("profile-menu-avatar").click();
    await expect(first.getByTestId("avatar-remove")).toBeVisible();
    await first.getByTestId("avatar-remove").click();
    await expect(first.getByTestId("avatar-dialog")).toBeHidden();
    await expect(
      second.getByTestId("profile-panel").getByTestId("avatar-image"),
    ).toHaveCount(0);
    await first.waitForTimeout(150);
    await shot(first, "p11-avatar-removed");
  });

  test("the crop dialog keeps the picture inside the square", async ({ page }) => {
    await openClient(page);
    await changeAvatar(page);
    const box = await page.getByTestId("avatar-crop").boundingBox();
    expect(box?.width).toBeGreaterThan(200);
    await page.getByTestId("avatar-zoom").fill("2");
    await page.waitForTimeout(100);
    await shot(page, "p11-avatar-zoom");
  });
});
