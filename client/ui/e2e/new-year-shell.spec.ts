import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 1432, strictPort: true } }); await server.listen(); });
test.afterAll(async () => { await server.close(); });
test("closing a peer tree restores the member row focus", async ({ page }) => {
  await page.route("**/shell-fixture", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script></head><body></body></html>` }));
  await page.goto("http://127.0.0.1:1432/shell-fixture");
  await page.waitForFunction(() => "__vite_plugin_react_preamble_installed__" in window);
  await page.addScriptTag({ type: "module", url: "/e2e/new-year-shell.fixture.tsx" });
  const row = page.getByTestId("member-pane-2");
  await row.click();
  await page.getByRole("button", { name: "Open tree" }).click();
  await expect(page.getByTestId("new-year-game")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("new-year-game")).toHaveCount(0);
  await expect(row).toBeFocused();
});
