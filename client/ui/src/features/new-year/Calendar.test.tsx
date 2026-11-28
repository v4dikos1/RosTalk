import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { buildDays, Calendar, firstOffset, formatMoment } from "./Calendar";
import { makeState } from "./server.fixture";

describe("calendar days", () => {
  it("derives past, today and future from the server day only", () => {
    const state = makeState({ day: "2026-12-03", claims: [{ day: "2026-12-01", itemId: "ball-red" }, { day: "2026-12-03", itemId: "bell-gold" }] });
    const days = buildDays(state);
    expect(days).toHaveLength(31);
    expect(days.slice(0, 5).map((d) => d.status)).toEqual(["claimed", "missed", "claimed", "future", "future"]);
    expect(days[2]?.isToday).toBe(true);
    expect(days.filter((d) => d.isToday)).toHaveLength(1);
    expect(buildDays(makeState({ day: "2026-12-03" }))[2]?.status).toBe("today");
    expect(buildDays(makeState({ day: "2026-12-01" }))[0]?.status).toBe("today");
    expect(buildDays(makeState({ day: "2026-12-31" }))[30]?.status).toBe("today");
  });

  it("treats the gallery as all past and the preview as all future", () => {
    expect(buildDays(makeState({ phase: "gallery", day: "2027-01-02" })).every((d) => d.status === "missed" && !d.isToday)).toBe(true);
    expect(buildDays(makeState({ phase: "upcoming", day: "" })).every((d) => d.status === "future")).toBe(true);
  });

  it("aligns December 2026 to Tuesday and formats times in the server zone", () => {
    expect(firstOffset("2026-12")).toBe(1);
    expect(formatMoment("2026-12-03T23:30:00Z", "en", "Asia/Tokyo")).toContain("8:30");
    expect(formatMoment("nonsense", "en", "UTC")).toBe("");
    expect(formatMoment("2026-12-03T12:00:00Z", "en", "Not/AZone")).toContain("12:00");
  });
});

describe("Calendar", () => {
  beforeAll(async () => { await i18n.changeLanguage("en"); });
  const props = { busy: null, locale: "en" as const, lastClaim: null, onClaim: vi.fn(), onWater: vi.fn() };

  it("enables claim only for an enrolled player on the unclaimed today", async () => {
    const onClaim = vi.fn();
    const view = render(<Calendar {...props} onClaim={onClaim} state={makeState()} />);
    await userEvent.click(screen.getByRole("button", { name: "Claim reward" }));
    expect(onClaim).toHaveBeenCalledTimes(1);
    view.rerender(<Calendar {...props} onClaim={onClaim} busy="claim" state={makeState()} />);
    expect(screen.getByRole("button", { name: "Claiming…" })).toBeDisabled();
    view.rerender(<Calendar {...props} onClaim={onClaim} state={makeState({ enrolled: false })} />);
    expect(screen.getByRole("button", { name: "Claim reward" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /^December 4,/ }));
    expect(screen.queryByRole("button", { name: "Claim reward" })).toBeNull();
    expect(screen.getByTestId("ny-day-detail")).toHaveTextContent("The reward opens on this day.");
  });

  it("falls back to the localized unknown ornament for an unknown reward ID", async () => {
    render(<Calendar {...props} state={makeState({ claims: [{ day: "2026-12-01", itemId: "mystery" }] })} />);
    await userEvent.click(screen.getByRole("button", { name: /^December 1,/ }));
    expect(screen.getAllByRole("img", { name: "Unknown ornament" }).length).toBeGreaterThan(0);
  });
});
