import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
test.beforeAll(async () => {
  server = await createServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 1429, strictPort: true } });
  await server.listen();
});
test.afterAll(async () => { await server.close(); });

test("scene stages, backgrounds, overlap, narrow layout and unknown item", async ({ page }, testInfo) => {
  await page.goto("http://127.0.0.1:1429/");
  await page.evaluate(() => { document.body.innerHTML = '<div id="art-test"></div>'; });
  await page.addScriptTag({ type: "module", url: "/src/features/new-year/art/Scene.fixture.tsx" });
  await page.waitForFunction(() => "renderArt" in window);
  for (const background of ["dusk", "aurora"]) {
    for (const days of [0, 8, 31]) {
      await page.evaluate(([d, b]) => (window as unknown as { renderArt: (days: number, background: string) => void }).renderArt(Number(d), String(b)), [days, background]);
      await expect(page.locator(".ny-scene")).toHaveAttribute("data-background", background);
      await expect(page.getByRole("img", { name: "Unknown ornament" })).toBeVisible();
      await page.locator(".ny-scene img").evaluateAll((imgs) => Promise.all(imgs.map((img) => (img as HTMLImageElement).decode())));
      if (days === 31) {
        const glyph = await page.locator(".ny-placement").nth(1).evaluate((el) => (el as HTMLElement).offsetWidth * 0.896 / (el.closest(".ny-scene") as HTMLElement).offsetWidth);
        expect(glyph).toBeGreaterThan(0.08);
        expect(glyph).toBeLessThan(0.09);
      }
      await page.locator(".ny-scene").screenshot({ path: testInfo.outputPath(`${background}-${days}.png`), animations: "disabled" });
    }
  }
  await page.setViewportSize({ width: 320, height: 700 });
  await page.locator(".ny-scene").screenshot({ path: testInfo.outputPath("narrow.png"), animations: "disabled" });
  expect(await page.locator(".ny-scene").evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(320);
});

