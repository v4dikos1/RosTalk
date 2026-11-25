import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

// Screenshots are committed and attached to the stage 2.4 PR so the interface
// can be reviewed without building the desktop client. They cover both themes
// and both languages.
const outDir = path.resolve(process.cwd(), "../../docs/assets/stage-2.4");
mkdirSync(outDir, { recursive: true });
const adminOutDir = path.resolve(process.cwd(), "../../docs/assets/stage-3.2");
mkdirSync(adminOutDir, { recursive: true });

const link = `rostalk://join?host=192.168.0.13:7443&fp=${"ab".repeat(32)}&invite=demo`;

async function openMock(page: Page, query: string) {
  await page.goto(`/?fixtures=1&${query}`);
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

async function adminShot(page: Page, name: string) {
  await page.screenshot({
    path: path.join(adminOutDir, `${name}.png`),
    animations: "disabled",
    caret: "hide",
  });
}

test.describe("stage 2.4 screenshots", () => {
  test("main screen, dark, Russian", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&channel=3");
    await shot(page, "main-dark-ru");
  });

  test("main screen, light, Russian", async ({ page }) => {
    await openMock(page, "theme=light&lang=ru&channel=3");
    await shot(page, "main-light-ru");
  });

  test("main screen, dark, English", async ({ page }) => {
    await openMock(page, "theme=dark&lang=en&channel=3");
    await shot(page, "main-dark-en");
  });

  test("main screen, light, English", async ({ page }) => {
    await openMock(page, "theme=light&lang=en&channel=3");
    await shot(page, "main-light-en");
  });

  test("first run, dark, Russian: link", async ({ page }) => {
    await page.goto(
      `/?fixtures=1&onboarding=1&theme=dark&lang=ru&nickname=&link=${encodeURIComponent(link)}`,
    );
    await expect(page.getByTestId("onboarding")).toBeVisible();
    await expect(page.getByTestId("link-preview")).toBeVisible();
    await shot(page, "onboarding-link-dark-ru");
  });

  test("first run, dark, Russian: nickname and microphone", async ({ page }) => {
    await page.goto(
      `/?fixtures=1&onboarding=1&theme=dark&lang=ru&nickname=&link=${encodeURIComponent(link)}`,
    );
    await expect(page.getByTestId("onboarding")).toBeVisible();
    await page.getByTestId("onboarding-next").click();
    await expect(page.getByTestId("onboarding-nickname")).toBeVisible();
    await page.getByTestId("onboarding-nickname").fill("Алиса");
    await shot(page, "onboarding-nickname-dark-ru");
    await page.getByTestId("onboarding-next").click();
    await expect(page.getByTestId("onboarding-input")).toBeVisible();
    await page.waitForTimeout(350);
    await shot(page, "onboarding-microphone-dark-ru");
  });

  test("first run, light, English: microphone", async ({ page }) => {
    await page.goto(
      `/?fixtures=1&onboarding=1&theme=light&lang=en&nickname=&link=${encodeURIComponent(link)}`,
    );
    await expect(page.getByTestId("onboarding")).toBeVisible();
    await page.getByTestId("onboarding-next").click();
    await page.getByTestId("onboarding-nickname").fill("Alice");
    await page.getByTestId("onboarding-next").click();
    await expect(page.getByTestId("onboarding-input")).toBeVisible();
    await page.waitForTimeout(350);
    await shot(page, "onboarding-microphone-light-en");
  });

  test("settings, voice, dark, Russian", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&settings=voice");
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.waitForTimeout(200);
    await shot(page, "settings-voice-dark-ru");
    await page.getByTestId("settings-content").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForTimeout(150);
    await shot(page, "settings-voice-sounds-dark-ru");
  });

  test("settings, hotkeys, light, English", async ({ page }) => {
    await openMock(page, "theme=light&lang=en&settings=hotkeys");
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.waitForTimeout(200);
    await shot(page, "settings-hotkeys-light-en");
  });

  test("settings, general, dark, English", async ({ page }) => {
    await openMock(page, "theme=dark&lang=en&settings=general");
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.waitForTimeout(200);
    await shot(page, "settings-general-dark-en");
  });

  test("command palette, dark, Russian", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&palette=1");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.waitForTimeout(200);
    await shot(page, "command-palette-dark-ru");
  });

  test("command palette, light, English", async ({ page }) => {
    await openMock(page, "theme=light&lang=en&palette=1");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.waitForTimeout(200);
    await shot(page, "command-palette-light-en");
  });

  test("user context menu, dark, Russian", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&userMenu=2");
    await expect(page.getByTestId("user-menu")).toBeVisible();
    await shot(page, "user-menu-dark-ru");
  });

  test("connection details, dark, Russian", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru");
    await page.getByTestId("quality-indicator").first().click();
    await expect(page.getByTestId("quality-details")).toBeVisible();
    await shot(page, "connection-details-dark-ru");
  });

  test("server switcher, dark, Russian", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru");
    await page.getByTestId("server-switcher").click();
    await expect(page.getByTestId("server-menu")).toBeVisible();
    await shot(page, "server-switcher-dark-ru");
  });

  test("banned state, dark, Russian", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&state=banned");
    await expect(page.getByTestId("state-error")).toBeVisible();
    await shot(page, "state-banned-dark-ru");
  });

  test("reconnecting, light, English", async ({ page }) => {
    await openMock(page, "theme=light&lang=en&state=reconnecting");
    await expect(page.getByRole("status")).toBeVisible();
    await shot(page, "state-reconnecting-light-en");
  });

  test("disconnected welcome, dark, Russian", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&state=disconnected");
    await expect(page.getByTestId("state-welcome")).toBeVisible();
    await shot(page, "state-welcome-dark-ru");
  });

  test("admin general, dark, Russian", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&settings=server&adminTab=general");
    await expect(page.getByTestId("server-admin")).toBeVisible();
    await expect(page.getByTestId("server-general")).toBeVisible();
    await adminShot(page, "admin-general-dark-ru");
  });

  test("admin roles and permission matrix, dark, Russian", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&settings=server&adminTab=roles");
    await expect(page.getByTestId("role-editor")).toBeVisible();
    await page.getByTestId("role-select-2").click();
    await expect(page.getByTestId("permission-kick")).toBeVisible();
    await adminShot(page, "admin-roles-dark-ru");
  });

  test("admin channels and overrides, light, English", async ({ page }) => {
    await openMock(page, "theme=light&lang=en&settings=server&adminTab=channels");
    await expect(page.getByTestId("channel-editor")).toBeVisible();
    await page.getByTestId("channel-select-3").click();
    await expect(page.getByTestId("override-role")).toBeVisible();
    await adminShot(page, "admin-channels-light-en");
  });

  test("admin invites, dark, Russian", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&settings=server&adminTab=invites");
    await expect(page.getByTestId("invites-panel")).toBeVisible();
    await expect(page.getByTestId("invite-row-1")).toBeVisible();
    await adminShot(page, "admin-invites-dark-ru");
  });

  test("admin members and bans, dark, Russian", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&settings=server&adminTab=members");
    await expect(page.getByTestId("members-panel")).toBeVisible();
    await expect(page.getByTestId("member-row-2")).toBeVisible();
    await adminShot(page, "admin-members-dark-ru");
  });

  test("admin audit, light, English", async ({ page }) => {
    await openMock(page, "theme=light&lang=en&settings=server&adminTab=audit");
    await expect(page.getByTestId("audit-panel")).toBeVisible();
    await expect(page.getByTestId("audit-row-5")).toBeVisible();
    await adminShot(page, "admin-audit-light-en");
  });

  test("admin API tokens, dark, Russian", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&settings=server&adminTab=tokens");
    await expect(page.getByTestId("api-tokens-panel")).toBeVisible();
    await expect(page.getByTestId("token-row-1")).toBeVisible();
    await adminShot(page, "admin-tokens-dark-ru");
  });

  test("user context menu moderation, dark, Russian", async ({ page }) => {
    await openMock(page, "theme=dark&lang=ru&userMenu=2");
    await expect(page.getByTestId("user-menu-kick")).toBeVisible();
    await page.getByTestId("user-menu-ban").click();
    await expect(page.getByTestId("user-menu-reason")).toBeVisible();
    await adminShot(page, "user-menu-moderation-dark-ru");
  });

  test("component gallery, light", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 2600 });
    await page.goto("/?fixtures=1&theme=light&lang=ru#/gallery");
    await expect(
      page.getByRole("heading", { name: "Галерея компонентов" }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    await page.screenshot({
      path: path.join(outDir, "gallery-light.png"),
      animations: "disabled",
      caret: "hide",
      fullPage: true,
    });
  });
});
