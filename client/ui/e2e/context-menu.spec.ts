import { expect, test } from "@playwright/test";

// The WebView2 context menu is disabled in the desktop shell (stage 2.3.1).
// This spec proves the page-level replacement: no browser menu, a small
// Cut/Copy/Paste menu in a field, and working keyboard copy/paste.

test.describe("context menu", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?fixtures=1&theme=dark&lang=ru&channel=3&view=chat");
    await expect(page.getByTestId("main-screen")).toBeVisible();
    await page.getByTestId("profile-panel").click();
    await page.getByTestId("profile-menu-profile").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await expect(page.getByTestId("settings-nickname")).toBeVisible();
  });

  test("right-click in a field shows the small edit menu", async ({ page }) => {
    const field = page.getByTestId("settings-nickname");
    await field.click();
    await field.fill("alice");
    await field.press("End");
    await field.click({ button: "right" });

    await expect(page.getByTestId("context-menu")).toBeVisible();
    await expect(page.getByTestId("context-menu-paste")).toBeVisible();
    await expect(page.getByTestId("context-menu-selectAll")).toBeVisible();
  });

  test("right-click outside a field shows no menu", async ({ page }) => {
    await page.getByRole("heading", { name: "Настройки" }).click({
      button: "right",
    });
    await expect(page.getByTestId("context-menu")).toBeHidden();
  });

  test("keyboard copy and paste still work in a field", async ({ page }) => {
    const field = page.getByTestId("settings-nickname");
    await field.click();
    await field.fill("alice");
    await field.press("Control+a");
    await field.press("Control+c");
    await field.press("End");
    await field.press("Control+v");
    await expect(field).toHaveValue("alicealice");
  });
});
