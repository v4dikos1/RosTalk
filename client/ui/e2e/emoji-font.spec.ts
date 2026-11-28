import { expect, test, type Page } from "@playwright/test";

/**
 * P33 bundled emoji font, browser check.
 *
 * Windows 10 WebView2 ships Segoe UI Emoji from the Emoji 12 generation, so a
 * post-Emoji-12 glyph such as 🫠 (U+1FAE0, Emoji 14) has no system font there.
 * The client bundles Noto Color Emoji as "RosTalk Emoji" and puts it right
 * after Golos Text. This spec proves the bundled subsets are actually
 * requested and paint a non-blank glyph in the picker, and that the local
 * single-glyph face covers U+1F46A (👪), which the Google ranges skip. The real
 * Windows 10 look is the owner's manual gate; this host can only check the
 * browser mechanics.
 */

const FONT_FILE = /\/assets\/noto-emoji-\d+-[\w-]+\.woff2$/;

async function openChat(page: Page) {
  await page.goto("/?fixtures=1&theme=dark&lang=ru&channel=1&view=chat");
  await expect(page.getByTestId("main-screen")).toBeVisible();
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** True once the bundled family covers `glyph` and its subset is loaded. */
async function fontLoaded(page: Page, glyph: string): Promise<boolean> {
  return page.evaluate(async (char) => {
    await document.fonts.load('16px "RosTalk Emoji"', char);
    await document.fonts.ready;
    return document.fonts.check('16px "RosTalk Emoji"', char);
  }, glyph);
}

/**
 * Draws `glyph` with the bundled family on a canvas and counts painted pixels
 * and quantised colours: a blank or monochrome-fallback cell stays near zero.
 */
async function paintReport(
  page: Page,
  glyph: string,
): Promise<{ pixels: number; colours: number }> {
  return page.evaluate((char) => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return { pixels: 0, colours: 0 };
    }
    context.font = '16px "RosTalk Emoji"';
    context.textBaseline = "top";
    context.fillText(char, 0, 0);
    const data = context.getImageData(0, 0, 32, 32).data;
    const colours = new Set<number>();
    let pixels = 0;
    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3] ?? 0;
      if (alpha === 0) {
        continue;
      }
      pixels += 1;
      const key =
        ((data[index] ?? 0) >> 3) * 1024 +
        ((data[index + 1] ?? 0) >> 3) * 32 +
        ((data[index + 2] ?? 0) >> 3);
      colours.add(key);
    }
    return { pixels, colours: colours.size };
  }, glyph);
}

test.describe("P33 bundled emoji font", () => {
  test("renders a post-Emoji-12 glyph from the local woff2 subset", async ({
    page,
  }, testInfo) => {
    const fontResponses: { url: string; status: number }[] = [];
    page.on("response", (response) => {
      if (FONT_FILE.test(new URL(response.url()).pathname)) {
        fontResponses.push({ url: response.url(), status: response.status() });
      }
    });

    await openChat(page);

    // The font is not in the initial page: the picker's first emoji paints it.
    const fontRequest = page.waitForResponse(
      (response) => FONT_FILE.test(new URL(response.url()).pathname),
      { timeout: 15_000 },
    );

    await page.getByTestId("chat-emoji").click();
    await expect(page.getByTestId("emoji-picker")).toBeVisible();
    await expect(page.getByTestId("emoji-loading")).toHaveCount(0);

    const search = page.getByTestId("emoji-search");
    await search.fill("melting");
    const cell = page.getByTestId("emoji-🫠");
    await expect(cell).toBeVisible();

    const response = await fontRequest;
    expect(response.status()).toBe(200);
    expect(response.url()).toMatch(/noto-emoji-\d+-[\w-]+\.woff2$/);
    await expect
      .poll(() => fontResponses.length, { timeout: 15_000 })
      .toBeGreaterThan(0);

    // The family is applied through --font-sans and comes right after Golos.
    const families = await cell.evaluate((node) =>
      getComputedStyle(node).fontFamily,
    );
    expect(families).toContain('"RosTalk Emoji"');
    expect(families.indexOf('"Golos Text"')).toBeLessThan(
      families.indexOf('"RosTalk Emoji"'),
    );

    expect(await fontLoaded(page, "🫠")).toBe(true);

    // "Non-blank" is measured, not guessed.
    const painted = await paintReport(page, "🫠");
    expect(painted.pixels).toBeGreaterThan(20);
    // Noto Color Emoji is a colour font; a blank or tofu cell stays one colour.
    expect(painted.colours).toBeGreaterThan(2);

    const cellShot = await cell.screenshot();
    await testInfo.attach("emoji-cell-1fae0.png", {
      body: cellShot,
      contentType: "image/png",
    });
    await testInfo.attach("emoji-picker-1fae0.png", {
      body: await page.getByTestId("emoji-picker").screenshot(),
      contentType: "image/png",
    });
    expect(cellShot.byteLength).toBeGreaterThan(100);
  });

  test("paints U+1F46A from the bundled face, not Segoe UI Emoji", async ({
    page,
  }, testInfo) => {
    await openChat(page);

    // The fallback face is a separate request; it is not read before the
    // glyph first renders.
    const fallbackRequest = page.waitForResponse(
      (response) => /noto-emoji-1f46a[^/]*\.woff2$/.test(response.url()),
      { timeout: 15_000 },
    );

    await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.id = "emoji-family-probe";
      probe.textContent = "👪";
      probe.style.cssText =
        "position:fixed;top:8px;left:8px;z-index:99999;" +
        "font-family:var(--font-sans);font-size:16px;line-height:1";
      document.body.append(probe);
    });

    const response = await fallbackRequest;
    expect(response.status()).toBe(200);
    expect(response.url()).toMatch(/noto-emoji-1f46a[^/]*\.woff2$/);

    const probe = page.locator("#emoji-family-probe");
    await expect(probe).toBeVisible();

    // The stack is inherited from --font-sans: Golos first, emoji fallback next.
    const families = await probe.evaluate(
      (node) => getComputedStyle(node).fontFamily,
    );
    expect(families).toContain('"RosTalk Emoji"');
    expect(families.indexOf('"Golos Text"')).toBeLessThan(
      families.indexOf('"RosTalk Emoji"'),
    );

    expect(await fontLoaded(page, "👪")).toBe(true);

    const painted = await paintReport(page, "👪");
    expect(painted.pixels).toBeGreaterThan(20);
    expect(painted.colours).toBeGreaterThan(2);

    // Which face did Chromium actually use for the codepoint? The canvas
    // above only knows that something colourful painted; the platform font
    // list names the face. Segoe UI Emoji would mean a Windows 10 fallback.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = (await cdp.send("DOM.getDocument")) as {
      root: { nodeId: number };
    };
    const { nodeId } = (await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "#emoji-family-probe",
    })) as { nodeId: number };
    expect(nodeId).toBeGreaterThan(0);
    const { fonts } = (await cdp.send("CSS.getPlatformFontsForNode", {
      nodeId,
    })) as { fonts: { familyName: string; glyphCount: number }[] };
    const usedFamilies = fonts.map((font) => font.familyName).join(", ");
    expect(fonts.reduce((sum, font) => sum + font.glyphCount, 0)).toBeGreaterThan(0);
    expect(usedFamilies).toContain("Noto Color Emoji");
    expect(usedFamilies).not.toContain("Segoe UI Emoji");

    const probeShot = await probe.screenshot();
    await testInfo.attach("emoji-glyph-1f46a.png", {
      body: probeShot,
      contentType: "image/png",
    });
    expect(probeShot.byteLength).toBeGreaterThan(100);
  });
});
