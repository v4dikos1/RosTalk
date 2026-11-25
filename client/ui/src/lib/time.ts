import type { LocalePreference } from "@/core/api";

/**
 * Date and time formatting follows the selected interface language, not the
 * OS locale (stage 2.4 requirement 9).
 */

function intlLocale(locale: LocalePreference): string {
  return locale === "ru" ? "ru-RU" : "en-GB";
}

/** `14:05` in the selected language. */
export function formatClock(
  unixMs: number,
  locale: LocalePreference,
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(unixMs));
}

/** `20 ноя, 14:05` in the selected language. */
export function formatDateTime(
  unixMs: number,
  locale: LocalePreference,
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(unixMs));
}

/** `5 минут назад`, `2 дня назад` — relative to now. */
export function formatRelative(
  unixMs: number,
  locale: LocalePreference,
  now = Date.now(),
): string {
  const deltaSeconds = Math.round((unixMs - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat(intlLocale(locale), {
    numeric: "auto",
  });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [unit, seconds] of units) {
    if (Math.abs(deltaSeconds) >= seconds || unit === "second") {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return formatter.format(0, "second");
}

/** Local calendar day of a timestamp, as a stable `YYYY-MM-DD` key. */
export function dayKey(unixMs: number): string {
  const date = new Date(unixMs);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export type DayLabel =
  | { kind: "today" | "yesterday" }
  | { kind: "date"; text: string };

/** "Today", "Yesterday" or a localized date for a feed separator. */
export function dayLabelFor(
  unixMs: number,
  locale: LocalePreference,
  now = Date.now(),
): DayLabel {
  const key = dayKey(unixMs);
  if (key === dayKey(now)) {
    return { kind: "today" };
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) {
    return { kind: "yesterday" };
  }
  const date = new Date(unixMs);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return {
    kind: "date",
    text: new Intl.DateTimeFormat(intlLocale(locale), {
      day: "numeric",
      month: "long",
      ...(sameYear ? {} : { year: "numeric" }),
    }).format(date),
  };
}

/** `04:12` from a duration in seconds (uptime, stream length). */
export function formatDuration(
  totalSeconds: number,
  locale: LocalePreference,
): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (locale === "ru") {
    return `${minutes}:${rest.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
