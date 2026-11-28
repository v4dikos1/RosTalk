import { CalendarDays, CircleDot, RefreshCw, Snowflake, TreePine } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ChatProxyView } from "@/core/api";
import { createGameApi, errorKey, type GameTarget } from "./api";
import { Calendar } from "./Calendar";
import { Roulette } from "./Roulette";
import { TreeEditor } from "./TreeEditor";
import { TreeViewer } from "./TreeViewer";
import { GAME_NS } from "./locales/game";
import type { ArtLocale } from "./locales/art";
import { createGameStore, scopeKey, type GameStore } from "./store";
import "./game.css";

export interface GameRootProps {
  proxy: ChatProxyView;
  serverId: string;
  selfId: number;
  target: GameTarget;
  onClose: () => void;
}

type TabId = "calendar" | "roulette" | "tree";
const TABS: TabId[] = ["calendar", "roulette", "tree"];

function Skeleton() {
  return <div className="ny-skeleton" aria-hidden="true"><span /><span /><span /></div>;
}

function Game({ store, target, locale }: { store: GameStore; target: GameTarget; locale: ArtLocale }) {
  const { t } = useTranslation(GAME_NS);
  const s = useStore(store);
  const [tab, setTab] = useState<TabId>("calendar");
  const self = target.kind === "self";

  useEffect(() => {
    if (!self) return;
    const refresh = () => void store.getState().load();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [store, self]);

  const choose = (next: TabId) => {
    setTab(next);
    if (self) void s.load();
  };
  const reload = () => void (self ? s.load() : s.loadPeer());
  const errorText = s.error ? t(`errors.${errorKey(s.error)}`) : "";
  const banner = s.error && s.error.op !== "spin" && s.error.op !== "layout" ? errorText : "";
  const fatal = self && s.state === null && s.error !== null;
  const title = self ? t("title") : t("titlePeer", { name: target.kind === "peer" ? target.nickname : "" });
  const description = self ? (s.state ? t(`phase.${s.state.phase}`) : t("description")) : t("descriptionPeer");

  return <>
    <div className="ny-head">
      <span className="ny-event-mark" aria-hidden="true"><Snowflake size={20} /></span>
      <div className="ny-titles">
        <DialogTitle>{title} {!self && <Badge variant="outline" className="ny-readonly">{locale === "ru" ? "Просмотр" : "View only"}</Badge>}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </div>
      <Button variant="ghost" size="icon" className="ny-refresh" aria-label={t("refresh")} title={t("refresh")} disabled={s.loading || s.busy !== null} onClick={reload}>
        <RefreshCw className={s.loading ? "animate-spin" : undefined} size={16} aria-hidden="true" />
      </Button>
    </div>
    {self && <div className="ny-tabs" role="tablist" aria-label={t("tabsLabel")}>
      {TABS.map((id) => { const Icon = id === "calendar" ? CalendarDays : id === "roulette" ? CircleDot : TreePine; return <Button variant="ghost" key={id} id={`ny-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`ny-panel-${id}`} onClick={() => choose(id)}><Icon size={15} aria-hidden="true" />{id === "roulette" ? (locale === "ru" ? "Рулетка" : "Reel") : id === "tree" ? (locale === "ru" ? "Ёлка" : "Tree") : t(`tabs.${id}`)}</Button>; })}
    </div>}
    <div className="ny-body" id={`ny-panel-${tab}`} role={self ? "tabpanel" : undefined} aria-labelledby={self ? `ny-tab-${tab}` : undefined} aria-busy={s.loading || undefined}>
      {banner && <div className="ny-banner" role="alert" data-testid="ny-error">
        <span>{banner}</span>
        {!fatal && <Button variant="ghost" size="xs" onClick={reload}>{t("retry")}</Button>}
        <Button variant="ghost" size="xs" onClick={() => s.clearError()}>{t("dismiss")}</Button>
      </div>}
      {fatal
        ? <div className="ny-fatal" data-testid="ny-fatal">
          <p>{s.error?.code === "event_closed" ? t("state.ended") : errorText}</p>
          <Button onClick={reload} disabled={s.loading}>{t("retry")}</Button>
        </div>
        : self && s.state
          ? tab === "calendar" ? <Calendar state={s.state} busy={s.busy} locale={locale} lastClaim={s.lastClaim} onClaim={() => void s.claim()} onWater={() => void s.water()} /> : tab === "roulette" ? <Roulette balance={s.state.flakes} busy={s.busy !== null || (s.state.phase !== "active" && !s.retryId)} retry={!!s.retryId} receipt={s.receipt} error={s.error?.op === "spin" ? errorText : ""} onOpen={() => void s.spin()} /> : <TreeEditor state={s.state} draft={s.draft} busy={s.busy !== null} conflict={s.conflict} error={s.error?.op === "layout" ? errorText : ""} locale={locale} onDraft={s.setDraft} onSave={() => void s.saveLayout()} onReload={s.reloadLayout} onReapply={s.reapplyDraft} />
          : self ? <Skeleton /> : s.peer.tree ? <TreeViewer tree={s.peer.tree} locale={locale} /> : <p className="ny-peer" role="status">{s.peer.status === "loading" ? t("peer.loading") : s.peer.status === "empty" ? (locale === "ru" ? "Участник ещё не украсил ёлку." : "This member has no tree yet.") : errorText}</p>}
    </div>
  </>;
}

export default function GameRoot({ proxy, serverId, selfId, target, onClose }: GameRootProps) {
  const { t, i18n } = useTranslation(GAME_NS);
  const peerId = target.kind === "peer" ? target.userId : 0;
  const locale: ArtLocale = i18n.language.startsWith("ru") ? "ru" : "en";
  const { baseUrl, token } = proxy;
  const store = useMemo(
    () => createGameStore(createGameApi({ baseUrl, token }), scopeKey(serverId, selfId), peerId ? { kind: "peer", userId: peerId, nickname: "" } : { kind: "self" }),
    [baseUrl, token, serverId, selfId, peerId],
  );

  useEffect(() => {
    store.getState().activate();
    void (peerId ? store.getState().loadPeer() : store.getState().load());
    return () => store.getState().dispose();
  }, [store, peerId]);

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="new-year-game ny-dialog max-h-none w-[min(900px,94vw)] p-0" closeLabel={t("close")} data-testid="new-year-game">
      <Game store={store} target={target} locale={locale} />
    </DialogContent>
  </Dialog>;
}
