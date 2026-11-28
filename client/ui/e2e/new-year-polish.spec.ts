import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
type FixtureWindow = Window & { nyFixture: { mount: (options: object) => Promise<void> } };
test.beforeAll(async () => { server = await createServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 1433, strictPort: true } }); await server.listen(); });
test.afterAll(async () => { await server.close(); });
async function game(page: Page, target?: object) {
  await page.goto("http://127.0.0.1:1433/");
  await page.evaluate(() => { document.body.innerHTML = ""; });
  await page.addScriptTag({ type: "module", url: "/src/features/new-year/GameRoot.fixture.tsx" });
  await page.waitForFunction(() => "nyFixture" in window);
  await page.evaluate((peer) => (window as unknown as FixtureWindow).nyFixture.mount(peer ? { target: peer } : { state: { flakes: 12, growthDays: 8, inventory: [{ itemId: "ball-red", qty: 2 }, { itemId: "bell-gold", qty: 1 }] } }), target);
  await expect(page.getByTestId("new-year-game")).toBeVisible();
}
for (const width of [1280, 640]) {
  test(`screens at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    await game(page);
    const dialog = page.getByTestId("new-year-game");
    await expect(page.locator(".ny-day")).toHaveCount(31);
    await dialog.screenshot({ path: info.outputPath(`calendar-${width}.png`), animations: "disabled" });
    await page.getByRole("tab", { name: "Reel" }).click();
    await page.getByRole("button", { name: "Open for 6 flakes" }).click();
    await expect(page.getByText(/You received:/)).toBeVisible();
    await dialog.screenshot({ path: info.outputPath(`reel-${width}.png`), animations: "disabled" });
    await page.getByRole("tab", { name: "Tree" }).click();
    await dialog.screenshot({ path: info.outputPath(`editor-${width}.png`), animations: "disabled" });
    await game(page, { kind: "peer", userId: 11, nickname: "Anya" });
    await expect(page.locator(".ny-placement")).toHaveCount(1);
    await dialog.screenshot({ path: info.outputPath(`peer-${width}.png`), animations: "disabled" });
  });
  test(`promo at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route("**/shell-polish?promo=1", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script></head><body></body></html>` }));
    await page.goto("http://127.0.0.1:1433/shell-polish?promo=1");
    await page.waitForFunction(() => "__vite_plugin_react_preamble_installed__" in window);
    await page.addScriptTag({ type: "module", url: "/e2e/new-year-shell.fixture.tsx" });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.screenshot({ path: info.outputPath(`promo-${width}.png`), animations: "disabled" });
  });
}
