import { useTranslation } from "react-i18next";
import { useState } from "react";
import { Gift, Snowflake } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CATALOG, itemName, rarityOf, SPIN_COST, type SpinReceipt } from "./api";
import { Ornament } from "./art/Ornament";
import type { ArtLocale } from "./locales/art";
import "./reel.css";

const labels = {
  en: { title: "Prize reel", open: "Open for 6 flakes", retry: "Retry opening", balance: "Flakes", result: "You received", duplicate: "Duplicate: +2 flakes returned", skip: "Skip", common: "Common", rare: "Rare", epic: "Epic", legendary: "Legendary" },
  ru: { title: "Лента призов", open: "Открыть за 6 снежинок", retry: "Повторить открытие", balance: "Снежинки", result: "Ваша награда", duplicate: "Повтор: возвращено 2 снежинки", skip: "Пропустить", common: "Обычная", rare: "Редкая", epic: "Эпическая", legendary: "Легендарная" },
} as const;

export function Roulette({ balance, busy, retry, receipt, error, onOpen }: { balance: number; busy: boolean; retry: boolean; receipt: SpinReceipt | null; error: string; onOpen: () => void }) {
  const { i18n } = useTranslation();
  const [skippedId, setSkippedId] = useState<string | null>(null);
  const locale: ArtLocale = i18n.language.startsWith("ru") ? "ru" : "en";
  const t = labels[locale];
  const rarity = receipt ? rarityOf(receipt.itemId) : null;
  const cards = Array.from({ length: 15 }, (_, index) => index === 7 && receipt ? receipt.itemId : CATALOG[index % CATALOG.length]!.id);
  return <section className="ny-reel-panel" aria-label={t.title}>
    <div className="ny-reel-heading"><div><span className="ny-eyebrow"><Gift size={14} aria-hidden="true" /> {t.title}</span><h2>{t.title}</h2></div><span className="ny-balance"><Snowflake size={16} aria-hidden="true" /> {t.balance}: <strong>{balance}</strong></span></div>
    <div className="ny-reel" aria-hidden="true"><div key={receipt?.requestId ?? "empty"} className={`ny-reel-track${receipt && skippedId !== receipt.requestId ? " ny-reel-reveal" : ""}`}>{cards.map((id, i) => <div className={`ny-reel-card ny-border-${rarityOf(id) ?? "common"}`} key={i}><Ornament itemId={id} locale={locale} /></div>)}</div></div>
    <div aria-live="polite" className="ny-reel-result">{receipt && <><span className="ny-result-art"><Ornament itemId={receipt.itemId} locale={locale} /></span><p>{t.result}: {itemName(receipt.itemId, locale)}{rarity && <> · <Badge variant="outline" className={`ny-rarity-${rarity}`}>{t[rarity]}</Badge></>}{receipt.duplicate && <> · {t.duplicate}</>}</p></>}</div>
    {error && <p role="alert">{error}</p>}
    <div className="ny-reel-actions"><Button disabled={busy || (!retry && balance < SPIN_COST)} onClick={onOpen}>{retry ? t.retry : t.open}</Button>{receipt && <Button variant="ghost" onClick={() => setSkippedId(receipt.requestId)}>{t.skip}</Button>}</div>
  </section>;
}
