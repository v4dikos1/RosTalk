import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

type Mount = { locale?: "ru" | "en"; theme?: "dark" | "light"; state?: Record<string, unknown>; target?: unknown };
type Fixture = {
  server: { calls: { method: string; path: string }[]; state: Record<string, unknown>; offline: boolean };
  mount(options?: Mount): Promise<void>;
  closed: number;
};

let server: ViteDevServer;
test.beforeAll(async () => {
  server = await createServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 1430, strictPort: true } });
  await server.listen();
});
test.afterAll(async () => { await server.close(); });

async function open(page: Page, options: Mount = {}) {
  await page.goto("http://127.0.0.1:1430/");
  await page.evaluate(() => { document.body.innerHTML = ""; });
  await page.addScriptTag({ type: "module", url: "/src/features/new-year/GameRoot.fixture.tsx" });
  await page.waitForFunction(() => "nyFixture" in window);
  await page.evaluate((o) => (window as unknown as { nyFixture: Fixture }).nyFixture.mount(o), options);
  await expect(page.getByTestId("new-year-game")).toBeVisible();
}
const calls = (page: Page, method: string, path: string) =>
  page.evaluate(([m, p]) => (window as unknown as { nyFixture: Fixture }).nyFixture.server.calls.filter((c) => c.method === m && c.path === p).length, [method, path] as const);

test("one-page calendar in both themes and languages, 640px stack", async ({ page }, testInfo) => {
  for (const [locale, theme] of [["en", "dark"], ["ru", "light"]] as const) {
    await open(page, { locale, theme });
    await expect(page.getByTestId("ny-day-detail")).toBeVisible();
    const dialog = await page.getByTestId("new-year-game").boundingBox();
    expect(dialog!.width).toBeLessThanOrEqual(900);
    expect(dialog!.height).toBeLessThanOrEqual(620);
    const body = await page.locator(".ny-body").boundingBox();
    for (const box of await page.locator(".ny-day").evaluateAll((cells) => cells.map((c) => c.getBoundingClientRect().toJSON()))) {
      expect(box.height).toBeGreaterThanOrEqual(36);
      expect(box.width).toBeGreaterThanOrEqual(36);
      expect(box.bottom).toBeLessThanOrEqual(body!.y + body!.height);
    }
    await expect(page.locator(".ny-day")).toHaveCount(31);
    await expect(page.locator(".ny-welcome img")).toHaveJSProperty("complete", true);
    await page.getByTestId("new-year-game").screenshot({ path: testInfo.outputPath(`calendar-${locale}-${theme}.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 640, height: 700 });
  const layout = await page.locator(".ny-calendar-layout").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  expect(layout).toBe(1);
  await expect(page.getByRole("button", { name: /^(Claim reward|Забрать награду)$/ })).toBeVisible();
  await page.getByTestId("new-year-game").screenshot({ path: testInfo.outputPath("calendar-640.png"), animations: "disabled" });
});

test("keyboard selects a day, claim posts once and Escape closes", async ({ page }, testInfo) => {
  await open(page);
  const day = page.getByRole("button", { name: /^December 7,/ });
  await day.focus();
  await page.keyboard.press("Enter");
  await expect(day).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("ny-day-detail")).toContainText("not yet open");
  await page.getByRole("button", { name: /^December 3,/ }).click();
  const claim = page.getByRole("button", { name: "Claim reward" });
  await claim.dblclick();
  await expect(page.getByText("You received: Red bauble")).toBeVisible();
  expect(await calls(page, "POST", "/me/claim")).toBe(1);
  await expect(page.getByTestId("ny-water")).toHaveText("1");
  await page.getByTestId("new-year-game").screenshot({ path: testInfo.outputPath("claimed.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("new-year-game")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { nyFixture: Fixture }).nyFixture.closed)).toBe(1);
});

test("a rejected water keeps the balance and offline shows a retry", async ({ page }) => {
  await open(page, { state: { water: 1, wateredDays: ["2026-12-03"] } });
  await expect(page.getByRole("button", { name: "Water the tree" })).toBeDisabled();
  await expect(page.getByText("The tree is already watered today.")).toBeVisible();
  expect(await calls(page, "POST", "/me/water")).toBe(0);
  await expect(page.getByTestId("ny-water")).toHaveText("1");
  await page.evaluate(() => { (window as unknown as { nyFixture: Fixture }).nyFixture.server.offline = true; });
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByTestId("ny-error")).toContainText("unreachable");
  await expect(page.getByTestId("ny-water")).toHaveText("1");
  await page.evaluate(() => { (window as unknown as { nyFixture: Fixture }).nyFixture.server.offline = false; });
  await page.getByTestId("ny-error").getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("ny-error")).toHaveCount(0);
});

test("the gallery is read only and an unauthorized session is an error panel", async ({ page }) => {
  await open(page, { state: { phase: "gallery", day: "2027-01-02", claims: [{ day: "2026-12-01", itemId: "ball-red" }] } });
  await expect(page.getByRole("button", { name: "Claim reward" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Water the tree" })).toBeDisabled();
  expect(await calls(page, "PUT", "/me/enrollment")).toBe(0);
  await open(page, { state: { phase: "closed" } });
  await expect(page.getByTestId("ny-fatal")).toContainText("The event is over.");
});
