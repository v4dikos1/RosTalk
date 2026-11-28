import { expect, test, type Page } from "@playwright/test";

/**
 * P33 shell fixes from the owner's live P32 acceptance:
 *
 * A. the settings dialog keeps one outer height while sections change;
 * B. "leave channel" is a voice control in the voice row, not a wide strip
 *    below it;
 * C. a mouse-focused button carries no box-shadow (the Windows 10 residual
 *    "shadow" under buttons) while the keyboard ring is an outline, and the
 *    depth of dialogs, menus and tooltips is untouched.
 *
 * Win10 itself is the owner's manual gate: this host is Windows 11 and cannot
 * paint the native WebView2 defect. The computed-style assertions below are
 * the browser-verifiable part.
 */

const FLAT_SHADOW = /^(?:none|rgba\(0, 0, 0, 0\) 0px 0px 0px 0px)$/;

function isFlatShadow(value: string): boolean {
  return FLAT_SHADOW.test(value.replace(/\s+/g, " ").trim());
}

async function openMain(page: Page, query: string) {
  await page.goto(`/?fixtures=1&${query}`);
  await expect(page.getByTestId("main-screen")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function openSettings(page: Page, section: string) {
  await openMain(page, `theme=dark&lang=ru&settings=${section}`);
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  // The open animation scales the frame; measure only after it settles.
  await page.waitForTimeout(250);
}

const SECTIONS = [
  "profile",
  "general",
  "appearance",
  "voice",
  "hotkeys",
  "identity",
  "diagnostics",
  "updates",
  "plugins",
  "about",
] as const;

test.describe("P33 fixed settings height", () => {
  test("every section keeps the same outer height and only the body scrolls", async ({
    page,
  }, testInfo) => {
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (!viewport) {
      return;
    }
    const height = Math.min(720, viewport.height - 96);

    await openSettings(page, "profile");
    const dialog = page.getByTestId("settings-dialog");

    const heights: number[] = [];
    for (const section of SECTIONS) {
      await page.getByTestId(`settings-tab-${section}`).click();
      await expect(page.getByTestId("settings-content")).toBeVisible();
      await page.waitForTimeout(180);
      const box = await dialog.boundingBox();
      expect(box, `${section} box`).not.toBeNull();
      if (!box) {
        continue;
      }
      heights.push(box.height);
      expect(box.y, `${section} top`).toBeGreaterThanOrEqual(0);
      expect(
        box.y + box.height,
        `${section} bottom`,
      ).toBeLessThanOrEqual(viewport.height + 0.5);
      expect(
        Math.abs(box.height - height),
        `${section} height ${box.height} vs ${height}`,
      ).toBeLessThanOrEqual(1);
      await dialog.screenshot({
        path: testInfo.outputPath(`settings-${section}.png`),
        animations: "disabled",
      });
    }
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);

    // Long sections scroll inside the fixed body instead of growing it.
    await page.getByTestId("settings-tab-voice").click();
    const body = page.getByTestId("settings-content");
    await expect
      .poll(() => body.evaluate((node) => node.scrollHeight - node.clientHeight))
      .toBeGreaterThan(100);
    const outer = await page.evaluate(() => {
      const dialogNode = document.querySelector<HTMLElement>(
        '[data-testid="settings-dialog"]',
      );
      const bodyNode = document.querySelector<HTMLElement>(
        '[data-testid="settings-content"]',
      );
      return {
        dialogOverflow: dialogNode
          ? getComputedStyle(dialogNode).overflowY
          : null,
        bodyOverflow: bodyNode ? getComputedStyle(bodyNode).overflowY : null,
      };
    });
    expect(outer.dialogOverflow).toBe("hidden");
    expect(outer.bodyOverflow).toBe("auto");
  });

  test.describe("800x600", () => {
    test.use({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });

    test("stays inside the small window and keeps the same height", async ({
      page,
    }) => {
      await openSettings(page, "general");
      const dialog = page.getByTestId("settings-dialog");
      const heights: number[] = [];
      for (const section of ["general", "voice", "about", "plugins"] as const) {
        await page.getByTestId(`settings-tab-${section}`).click();
        await page.waitForTimeout(180);
        const box = await dialog.boundingBox();
        expect(box).not.toBeNull();
        if (!box) {
          continue;
        }
        heights.push(box.height);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(600.5);
      }
      expect(heights).toHaveLength(4);
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
      expect(Math.abs(heights[0]! - 504)).toBeLessThanOrEqual(1);
    });
  });
});

test.describe("P33 leave in the voice row", () => {
  test("sits in the row with the same geometry and a destructive accent", async ({
    page,
  }, testInfo) => {
    await openMain(page, "theme=dark&lang=ru&channel=3&view=chat");

    const row = page.getByTestId("voice-control-row");
    const leave = row.getByTestId("control-leave");
    await expect(leave).toBeVisible();
    await expect(leave).toHaveAccessibleName(/Покинуть голосовой канал/);

    const mic = await page.getByTestId("control-mic").boundingBox();
    const leaveBox = await leave.boundingBox();
    expect(mic).not.toBeNull();
    expect(leaveBox).not.toBeNull();
    if (mic && leaveBox) {
      expect(Math.abs(leaveBox.width - mic.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(leaveBox.height - mic.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(leaveBox.y - mic.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(leaveBox.height - 32)).toBeLessThanOrEqual(1);
    }

    const colors = await page.evaluate(() => {
      const leaveNode = document.querySelector<HTMLElement>(
        '[data-testid="control-leave"]',
      );
      const micNode = document.querySelector<HTMLElement>(
        '[data-testid="control-mic"]',
      );
      const probe = document.createElement("span");
      probe.style.color = "var(--danger)";
      document.body.append(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      return {
        leave: leaveNode ? getComputedStyle(leaveNode).color : null,
        mic: micNode ? getComputedStyle(micNode).color : null,
        danger,
      };
    });
    expect(colors.leave).toBe(colors.danger);
    expect(colors.leave).not.toBe(colors.mic);

    await page.getByTestId("voice-controls").screenshot({
      path: testInfo.outputPath("voice-row.png"),
      animations: "disabled",
    });

    // Narrow window: the row must still fit its own box.
    await page.setViewportSize({ width: 800, height: 600 });
    await page.waitForTimeout(150);
    const fit = await page.evaluate(() => {
      const rowNode = document.querySelector<HTMLElement>(
        '[data-testid="voice-control-row"]',
      );
      const group = document.querySelector<HTMLElement>(
        '[data-testid="voice-controls"]',
      );
      const leaveNode = document.querySelector<HTMLElement>(
        '[data-testid="control-leave"]',
      );
      if (!rowNode || !group || !leaveNode) {
        return null;
      }
      const groupBox = group.getBoundingClientRect();
      const leaveRect = leaveNode.getBoundingClientRect();
      return {
        scrollWidth: rowNode.scrollWidth,
        clientWidth: rowNode.clientWidth,
        leaveRight: leaveRect.right,
        groupRight: groupBox.right,
      };
    });
    expect(fit).not.toBeNull();
    if (fit) {
      expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth + 1);
      expect(fit.leaveRight).toBeLessThanOrEqual(fit.groupRight + 0.5);
    }
  });
});

test.describe("P33 button shadows", () => {
  test("pointer focus is flat, keyboard focus keeps an outline, depth stays", async ({
    page,
  }) => {
    await openSettings(page, "appearance");
    const dialog = page.getByTestId("settings-dialog");
    const tab = page.getByTestId("settings-tab-appearance");

    // Mouse focus: no shadow, no ring, no drop-shadow filter.
    await tab.click();
    const pointer = await tab.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        shadow: style.boxShadow,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        filter: style.filter,
      };
    });
    expect(isFlatShadow(pointer.shadow)).toBe(true);
    expect(pointer.filter).toBe("none");
    expect(
      pointer.outlineStyle === "none" ||
        Number.parseFloat(pointer.outlineWidth) === 0,
    ).toBe(true);

    // No button in the dialog keeps an always-on ring (the selected preset
    // used to carry `ring-1`, which reads as a shadow under the button).
    const ringed = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="settings-dialog"] button',
        ),
      );
      return nodes
        .map((node) => ({
          id: node.dataset.testid ?? node.getAttribute("aria-label") ?? "",
          shadow: getComputedStyle(node).boxShadow.replace(/\s+/g, " ").trim(),
        }))
        .filter(
          (item) =>
            item.shadow !== "none" &&
            item.shadow !== "rgba(0, 0, 0, 0) 0px 0px 0px 0px",
        );
    });
    expect(ringed).toEqual([]);

    // Keyboard focus: the avatar preview used to swap the outline for a
    // `ring-2` box-shadow; now every tab stop shows an outline instead.
    await page.goto("/?fixtures=1&theme=dark&lang=ru&settings=profile");
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(250);
    let sawAvatar = false;
    for (let step = 0; step < 14; step += 1) {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const node = document.activeElement as HTMLElement | null;
        if (!node) {
          return null;
        }
        const style = getComputedStyle(node);
        return {
          testId: node.dataset.testid ?? "",
          shadow: style.boxShadow,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
        };
      });
      expect(focused).not.toBeNull();
      if (!focused) {
        continue;
      }
      expect(isFlatShadow(focused.shadow)).toBe(true);
      expect(focused.outlineStyle).toBe("solid");
      expect(Number.parseFloat(focused.outlineWidth)).toBeGreaterThanOrEqual(2);
      if (focused.testId === "settings-avatar-preview") {
        sawAvatar = true;
        break;
      }
    }
    expect(sawAvatar).toBe(true);

    // Depth of the frame and of a tooltip is not a control surface.
    const dialogShadow = await dialog.evaluate(
      (node) => getComputedStyle(node).boxShadow.replace(/\s+/g, " ").trim(),
    );
    expect(isFlatShadow(dialogShadow)).toBe(false);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByTestId("control-mic").hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    const tooltipShadow = await tooltip.evaluate(
      (node) => getComputedStyle(node).boxShadow.replace(/\s+/g, " ").trim(),
    );
    expect(isFlatShadow(tooltipShadow)).toBe(false);
  });
});
