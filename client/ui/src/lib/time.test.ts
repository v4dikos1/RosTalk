import { describe, expect, it } from "vitest";

import {
  dayKey,
  dayLabelFor,
  formatClock,
  formatDuration,
  formatRelative,
} from "./time";

describe("time formatting", () => {
  it("uses the selected language for the clock", () => {
    const timestamp = new Date(2026, 10, 20, 14, 5).getTime();
    expect(formatClock(timestamp, "ru")).toBe("14:05");
    expect(formatClock(timestamp, "en")).toBe("14:05");
  });

  it("labels feed separators relative to the local day", () => {
    const now = new Date(2026, 10, 20, 18, 0).getTime();
    expect(dayLabelFor(now, "ru", now)).toEqual({ kind: "today" });
    const yesterday = new Date(2026, 10, 19, 23, 30).getTime();
    expect(dayLabelFor(yesterday, "ru", now)).toEqual({ kind: "yesterday" });
    const older = new Date(2026, 10, 12, 9, 0).getTime();
    const label = dayLabelFor(older, "ru", now);
    expect(label.kind).toBe("date");
    if (label.kind === "date") {
      expect(label.text).toContain("12");
      expect(label.text).toMatch(/ноя/);
    }
    expect(dayKey(older)).toBe("2026-11-12");
  });

  it("formats relative time in the selected language", () => {
    const now = Date.UTC(2026, 10, 20, 12, 0);
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    expect(formatRelative(fiveMinutesAgo, "ru", now)).toContain("5");
    expect(formatRelative(fiveMinutesAgo, "en", now)).toContain("5");
    expect(formatRelative(fiveMinutesAgo, "ru", now)).not.toBe(
      formatRelative(fiveMinutesAgo, "en", now),
    );
  });

  it("includes the year for a date from another year", () => {
    const now = new Date(2026, 10, 20, 18, 0).getTime();
    const lastYear = new Date(2025, 11, 31, 12, 0).getTime();
    const label = dayLabelFor(lastYear, "en", now);
    expect(label.kind).toBe("date");
    if (label.kind === "date") {
      expect(label.text).toContain("2025");
    }
  });

  it("formats durations as minutes and seconds", () => {
    expect(formatDuration(0, "ru")).toBe("0:00");
    expect(formatDuration(59.9, "en")).toBe("0:59");
    expect(formatDuration(65, "ru")).toBe("1:05");
    expect(formatDuration(3599, "en")).toBe("59:59");
    expect(formatDuration(3600, "ru")).toBe("60:00");
    // A negative value (clock skew) must not produce a negative duration.
    expect(formatDuration(-5, "en")).toBe("0:00");
  });
});
