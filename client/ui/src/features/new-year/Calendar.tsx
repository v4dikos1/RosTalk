import { Droplets, Gift, Snowflake, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import promoImage from "@/assets/newyear/promo-tree.webp";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CATALOG, SEASON_DAYS, itemName, rarityOf, type GameState } from "./api";
import { Ornament } from "./art/Ornament";
import type { ArtLocale } from "./locales/art";
import { GAME_NS } from "./locales/game";
import type { Operation } from "./store";

export type DayStatus = "claimed" | "missed" | "today" | "future";
export interface CalendarDay {
  day: number;
  iso: string;
  status: DayStatus;
  isToday: boolean;
  itemId: string | null;
  watered: boolean;
}

function seasonParts(season: string): [number, number] {
  const match = /^(\d{4})-(\d{2})$/.exec(season);
  return match ? [Number(match[1]), Number(match[2])] : [2026, 12];
}

/** The 31 dated cells of the season. Only the server `day` and `phase` decide the status. */
export function buildDays(state: GameState): CalendarDay[] {
  const claims = new Map(state.claims.map((claim) => [claim.day, claim.itemId]));
  const watered = new Set(state.wateredDays);
  const today = state.phase === "active" ? state.day : null;
  return Array.from({ length: SEASON_DAYS }, (_, index) => {
    const day = index + 1;
    const iso = `${state.season}-${String(day).padStart(2, "0")}`;
    const itemId = claims.get(iso) ?? null;
    const past = state.phase === "gallery" || state.phase === "closed" || (today !== null && iso < today);
    const isToday = iso === today;
    const status: DayStatus = itemId ? "claimed" : isToday ? "today" : past ? "missed" : "future";
    return { day, iso, status, isToday, itemId, watered: watered.has(iso) };
  });
}

/** Number of empty cells before the 1st with Monday as the first column. */
export function firstOffset(season: string): number {
  const [year, month] = seasonParts(season);
  return (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
}

function formatter(locale: ArtLocale, options: Intl.DateTimeFormatOptions, zone = "UTC") {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone });
  } catch {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
  }
}

export function formatDay(iso: string, locale: ArtLocale): string {
  const [year = 2026, month = 12, day = 1] = iso.split("-").map(Number);
  return formatter(locale, { day: "numeric", month: "long" }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function formatMoment(iso: string, locale: ArtLocale, zone: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : formatter(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }, zone).format(date);
}

const HISTORY_KINDS = ["chat", "voice", "spin", "duplicate"];
const RARITY_LABELS = { en: { common: "Common", rare: "Rare", epic: "Epic", legendary: "Legendary" }, ru: { common: "Обычная", rare: "Редкая", epic: "Эпическая", legendary: "Легендарная" } } as const;

export function Calendar({ state, busy, locale, lastClaim, onClaim, onWater }: {
  state: GameState;
  busy: Operation | null;
  locale: ArtLocale;
  lastClaim: string | null;
  onClaim: () => void;
  onWater: () => void;
}) {
  const { t } = useTranslation(GAME_NS);
  const days = buildDays(state);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = days.find((cell) => cell.iso === picked) ?? days.find((cell) => cell.isToday) ?? days[0]!;
  const weekdays = Array.from({ length: 7 }, (_, index) => formatter(locale, { weekday: "short" }).format(new Date(Date.UTC(2024, 0, 1 + index))));
  const active = state.phase === "active";
  const todayCell = days.find((cell) => cell.isToday);
  const wateredToday = todayCell ? todayCell.watered : false;
  const canClaim = active && state.enrolled && selected.status === "today" && busy === null;
  const waterBlocker = !active ? "readOnly" : !state.enrolled ? "notEnrolled" : wateredToday ? "wateredToday" : state.water < 1 ? "noWater" : null;
  const status = (cell: CalendarDay) => t(`status.${cell.status}`);

  return <div className="ny-calendar">
    {state.claims.length === 0 && <section className="ny-welcome" aria-labelledby="ny-welcome-title">
      <img src={promoImage} alt="" width={96} height={96} />
      <div>
        <h3 id="ny-welcome-title">{t("welcome.title")}</h3>
        <p>{state.phase === "upcoming" ? t("welcome.upcoming", { date: formatDay(`${state.season}-01`, locale) }) : t("welcome.body")}</p>
      </div>
    </section>}
    <div className="ny-calendar-layout">
      <section aria-labelledby="ny-days-title">
        <h3 id="ny-days-title" className="ny-heading">{t("calendar.title")}</h3>
        <p className="ny-calendar-note">{t("calendar.illustration")}</p>
        <div className="ny-grid" role="group" aria-label={t("calendar.title")}>
          {weekdays.map((name) => <span key={name} className="ny-weekday" aria-hidden="true">{name}</span>)}
          {Array.from({ length: firstOffset(state.season) }, (_, index) => <span key={`gap-${index}`} aria-hidden="true" />)}
          {days.map((cell) => { const preview = cell.itemId ?? CATALOG[(cell.day - 1) % CATALOG.length]!.id; return <Button variant="ghost" key={cell.iso} className="ny-day" data-status={cell.status} data-today={cell.isToday || undefined}
            aria-pressed={cell.iso === selected.iso} aria-current={cell.isToday ? "date" : undefined}
            aria-label={t("calendar.dayLabel", { date: formatDay(cell.iso, locale), status: status(cell), watered: cell.watered ? t("calendar.wateredSuffix") : "" })}
            onClick={() => setPicked(cell.iso)}>
            <span className="ny-day-number" aria-hidden="true">{cell.day}</span>
            <span className="ny-day-item" aria-hidden="true"><Ornament itemId={preview} locale={locale} /></span><span className={`ny-rarity-dot ny-rarity-${rarityOf(preview) ?? "common"}`} aria-hidden="true" />
            {cell.watered && <Droplets className="ny-day-water" size={11} aria-hidden="true" />}
          </Button>; })}
        </div>
      </section>
      <section aria-labelledby="ny-tree-title">
        <div className="ny-detail" data-testid="ny-day-detail">
          <h4>{formatDay(selected.iso, locale)}</h4>
          <p>{status(selected)}{selected.watered ? ` · ${t("calendar.watered")}` : ""}</p>
          {selected.itemId
            ? <p className="ny-reward"><span className="ny-reward-art"><Ornament itemId={selected.itemId} locale={locale} /></span><span>{t("detail.reward", { item: itemName(selected.itemId, locale) })}<br /><Badge variant="outline" className={`ny-rarity-${rarityOf(selected.itemId) ?? "common"}`}>{rarityOf(selected.itemId) ? RARITY_LABELS[locale][rarityOf(selected.itemId)!] : (locale === "ru" ? "Неизвестно" : "Unknown")}</Badge></span></p>
            : <div className="ny-detail-preview"><span className="ny-reward-art" aria-hidden="true"><Ornament itemId="snowflake" locale={locale} /></span><div><p className="ny-detail-placeholder"><Gift size={16} aria-hidden="true" />{t(`detail.${selected.status}`)}</p><Badge variant="outline" className="ny-rarity-common">{locale === "ru" ? "Случайная" : "Random"}</Badge></div></div>}
          {selected.status === "today" && active && <>
            <Button onClick={onClaim} disabled={!canClaim}>{busy === "claim" ? t("calendar.claiming") : t("calendar.claim")}</Button>
            {!state.enrolled && <p className="ny-hint">{t("blockers.notEnrolled")}</p>}
          </>}
        </div>
        <div role="status" aria-live="polite" className="ny-live">{lastClaim ? t("calendar.claimed", { item: itemName(lastClaim, locale) }) : ""}</div>
        <h3 id="ny-tree-title" className="ny-heading">{t("tree.title")}</h3>
        <p className="ny-growth" data-testid="ny-growth">{t("tree.growth", { days: state.growthDays, total: SEASON_DAYS })}</p>
        <div className="ny-progress" role="progressbar" aria-label={t("tree.growthLabel")} aria-valuemin={0} aria-valuemax={SEASON_DAYS} aria-valuenow={state.growthDays}>
          <span style={{ width: `${Math.min(100, (state.growthDays / SEASON_DAYS) * 100)}%` }} />
        </div>
        <dl className="ny-stats">
          <div><dt><Droplets size={14} aria-hidden="true" /> {t("tree.water")}</dt><dd data-testid="ny-water">{state.water}</dd></div>
          <div><dt><Snowflake size={14} aria-hidden="true" /> {t("tree.flakes")}</dt><dd data-testid="ny-flakes">{state.flakes}</dd></div>
        </dl>
        <Button variant="secondary" onClick={onWater} disabled={waterBlocker !== null || busy !== null}>{busy === "water" ? t("tree.watering") : t("tree.waterAction")}</Button>
        {waterBlocker && <p className="ny-hint">{t(`blockers.${waterBlocker}`)}</p>}
        <h4 className="ny-heading"><Sparkles size={14} aria-hidden="true" /> {t("history.title")}</h4>
        {state.history.length === 0
          ? <p className="ny-hint">{t("history.empty")}</p>
          : <ul className="ny-history" data-testid="ny-history">
            {state.history.map((entry, index) => <li key={`${entry.at}-${index}`}>
              <span>{t(`history.kind.${HISTORY_KINDS.includes(entry.kind) ? entry.kind : "other"}`)}</span>
              <time dateTime={entry.at}>{formatMoment(entry.at, locale, state.zone)}</time>
              <strong>{entry.delta > 0 ? `+${entry.delta}` : entry.delta}</strong>
            </li>)}
          </ul>}
      </section>
    </div>
  </div>;
}
