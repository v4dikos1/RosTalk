import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Snowflake, TreePine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { coreApi } from "@/core";
import { useAppStore } from "@/store/appStore";
import { useChatStore } from "@/store/chatStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { read, support, write, type Support } from "./support";

const GameRoot = lazy(() => import("@/features/new-year/GameRoot"));

export function PluginHost() {
  const { t } = useTranslation();
  const state = useCoreStore((s) => s.state);
  const proxy = useChatStore((s) => s.proxy);
  const settings = useSettingsStore((s) => s.settings);
  const persisted = useSettingsStore((s) => s.persistedNewYear);
  const update = useSettingsStore((s) => s.update);
  const app = useAppStore();
  const [result, setResult] = useState<{ scope: string; support: Support | null } | null>(null);
  const [promoScope, setPromoScope] = useState<string | null>(null);
  const previousScope = useRef("");
  const self = state?.users.find((user) => user.id === state.selfUserId);
  const serverId = state?.server?.id;
  const scope = state?.connection === "connected" && serverId && self && proxy ? `${serverId}:${self.id}:${self.connectedAtUnixMs}:${proxy.baseUrl}` : "";
  const setting = settings?.plugins.newYear ?? "absent";
  const enabled = setting === "enabled" && persisted === "enabled";
  const seenKey = `rostalk.newYear.seen:${serverId}:2026-12`;
  const modalBusy = app.settingsOpen || app.wizardOpen || app.connectOpen || app.hostingOpen || app.serverSettingsOpen || app.serverListOpen || app.inviteOpen || app.paletteOpen || app.channelPasswordId !== null;

  useEffect(() => {
    if (!scope || !proxy || !settings?.onboardingComplete || app.wizardOpen || setting === "disabled" || (setting === "absent" && (read(seenKey) === "1" || read(`rostalk.newYear.uninstalled:${scope}`) === "1"))) return;
    let live = true;
    void coreApi.chatProxy().then((actual) => {
      if (!live || !actual || actual.baseUrl !== proxy.baseUrl || actual.token !== proxy.token) return null;
      return support(proxy, scope);
    }).then((value) => { if (live) setResult({ scope, support: value }); }).catch(() => { if (live) setResult({ scope, support: null }); });
    return () => { live = false; };
  }, [scope, proxy, settings?.onboardingComplete, app.wizardOpen, setting, seenKey]);

  const available = result?.scope === scope && result.support?.apiVersion === 1 && result.support.phase !== "closed";
  useEffect(() => {
    if (!scope || !available || modalBusy || app.newYearTarget || !result?.support) return;
    if (setting === "absent" && read(seenKey) !== "1" && read(`rostalk.newYear.uninstalled:${scope}`) !== "1" && (result.support.phase === "active" || result.support.phase === "upcoming")) {
      write(seenKey, "1"); queueMicrotask(() => setPromoScope(scope));
    } else if (enabled && (result.support.phase === "active" || result.support.phase === "upcoming") && read(`rostalk.newYear.open:${scope}`) !== "1") {
      write(`rostalk.newYear.open:${scope}`, "1"); app.openNewYear({ kind: "self" });
    }
  }, [scope, available, modalBusy, app.newYearTarget, app.openNewYear, result, setting, enabled, seenKey]);

  useEffect(() => {
    const changed = previousScope.current !== "" && previousScope.current !== scope;
    previousScope.current = scope;
    if (changed || !enabled || !scope || (app.newYearTarget?.kind === "peer" && !state?.users.some((user) => user.id === (app.newYearTarget?.kind === "peer" ? app.newYearTarget.userId : 0)))) app.closeNewYear();
  }, [enabled, scope, state?.users, app.newYearTarget, app.closeNewYear]);

  const showPromo = promoScope === scope && setting === "absent" && !modalBusy;
  const target = app.newYearTarget;
  return <>
    <Dialog open={showPromo} onOpenChange={(open) => { if (!open) setPromoScope(null); }}><DialogContent className="w-[min(480px,92vw)] border-[#d7a454]/40 bg-[#102235] p-0 text-[#e7f3f4]"><div className="flex items-center gap-4 border-b border-[#d7a454]/25 p-5 pr-12"><span className="flex size-16 shrink-0 items-center justify-center rounded-xl border border-[#d7a454]/40 bg-[#172d3c] text-[#d7a454]"><TreePine size={32} aria-hidden="true" /></span><div><DialogTitle className="text-base font-semibold">{t("newYearShell.title")}</DialogTitle><DialogDescription className="mt-1 text-sm text-[#bbced3]">{t("newYearShell.description")}</DialogDescription></div></div><div className="p-5"><p className="mb-4 flex gap-2 text-xs text-[#b9cdd2]"><Snowflake size={16} aria-hidden="true" />{t("newYearShell.activity")}</p><div className="flex gap-2"><Button className="bg-[#d7a454] text-[#102235] hover:bg-[#e7bc72]" onClick={() => { setPromoScope(null); void update({ plugins: { newYear: "enabled" } }); }}>{t("newYearShell.install")}</Button><Button variant="ghost" className="text-[#e7f3f4]" onClick={() => setPromoScope(null)}>{t("newYearShell.later")}</Button></div></div></DialogContent></Dialog>
    {enabled && target && result?.scope === scope && !available && <Dialog open onOpenChange={(open) => { if (!open) app.closeNewYear(); }}><DialogContent><DialogTitle>{t("newYearShell.title")}</DialogTitle><DialogDescription>{t("newYearShell.unavailable")}</DialogDescription><Button onClick={app.closeNewYear}>{t("newYearShell.later")}</Button></DialogContent></Dialog>}
    {enabled && available && scope && proxy && serverId && self && target && <Suspense fallback={null}><GameRoot key={scope} proxy={proxy} serverId={serverId} selfId={self.id} target={target} onClose={app.closeNewYear} /></Suspense>}
  </>;
}
