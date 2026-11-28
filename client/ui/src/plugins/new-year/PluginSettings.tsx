import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { Snowflake, TreePine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { coreApi } from "@/core";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useChatStore } from "@/store/chatStore";
import { clearPreferences, support, write, type Support } from "./support";

export function PluginSettings() {
  const { t, i18n } = useTranslation();
  const status = useSettingsStore((s) => s.settings?.plugins.newYear ?? "absent");
  const pending = useSettingsStore((s) => s.newYearUpdatePending);
  const error = useSettingsStore((s) => s.error);
  const update = useSettingsStore((s) => s.update);
  const state = useCoreStore((s) => s.state);
  const proxy = useChatStore((s) => s.proxy);
  const connected = state?.connection === "connected";
  const self = state?.users.find((user) => user.id === state.selfUserId);
  const scope = connected && state?.server?.id && self && proxy ? `${state.server.id}:${self.id}:${self.connectedAtUnixMs}:${proxy.baseUrl}` : "";
  const [result, setResult] = useState<{ scope: string; value: Support | null } | null>(null);
  const persisted = useSettingsStore((s) => s.persistedNewYear);
  const [art, setArt] = useState<string | null>(null);
  useEffect(() => {
    if (persisted !== "enabled" || status !== "enabled") return;
    let live = true;
    void import("@/assets/newyear/promo-tree.webp").then((image) => { if (live) setArt(image.default); });
    return () => { live = false; };
  }, [persisted, status]);
  useEffect(() => {
    if (!scope || !proxy) return;
    let live = true;
    void coreApi.chatProxy().then((actual) => live && actual && actual.baseUrl === proxy.baseUrl && actual.token === proxy.token ? support(proxy, scope) : null)
      .then((value) => { if (live) setResult({ scope, value }); }).catch(() => { if (live) setResult({ scope, value: null }); });
    return () => { live = false; };
  }, [scope, proxy]);
  const checked = result?.scope === scope && scope !== "";
  const compatible = checked && result.value?.apiVersion === 1;
  const phaseLabels = i18n.language.startsWith("ru") ? { upcoming: "скоро", active: "идёт", gallery: "галерея", closed: "завершено" } : { upcoming: "upcoming", active: "active", gallery: "gallery", closed: "closed" };
  const connectionText = !connected ? t("newYearShell.offline") : !checked ? t("newYearShell.checking") : compatible ? t("newYearShell.supported", { season: result.value!.season, phase: phaseLabels[result.value!.phase] }) : t("newYearShell.unavailable");
  const remove = async () => {
    await update({ plugins: { newYear: "absent" } });
    if (useSettingsStore.getState().persistedNewYear !== "absent") return;
    clearPreferences();
    const state = useCoreStore.getState().state;
    const self = state?.users.find((user) => user.id === state.selfUserId);
    const proxy = useChatStore.getState().proxy;
    if (state?.connection === "connected" && state.server?.id && self && proxy) write(`rostalk.newYear.uninstalled:${state.server.id}:${self.id}:${self.connectedAtUnixMs}:${proxy.baseUrl}`, "1");
  };
  return <section className="rounded-xl border border-border bg-background p-4 shadow-sm"><div className="flex items-start gap-4"><span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#d7a454]/40 bg-[#102235] text-[#d7a454]">{art && persisted === "enabled" && status === "enabled" ? <img src={art} alt="" className="size-full object-cover" /> : <TreePine size={30} aria-hidden="true" />}</span><div className="min-w-0 space-y-2"><div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">{t("newYearShell.title")}</h2>{(!connected || !checked || compatible) && <Badge variant="outline">{t(`newYearShell.${status}`)}</Badge>}</div><p className="text-sm text-muted">{t("newYearShell.description")}</p></div></div><p className="mt-4 flex items-center gap-2 text-xs text-muted" role="status"><Snowflake size={14} aria-hidden="true" />{connectionText}</p><p className="mt-2 text-xs text-muted">{t("newYearShell.activity")}</p>{error && <p role="alert" className="mt-2 text-danger">{t("newYearShell.saveError")}</p>}<div className="mt-4 flex gap-2">{status === "absent" ? <Button disabled={pending} onClick={() => void update({ plugins: { newYear: "enabled" } })}>{t("newYearShell.install")}</Button> : <><Button disabled={pending} onClick={() => void update({ plugins: { newYear: status === "enabled" ? "disabled" : "enabled" } })}>{t(status === "enabled" ? "newYearShell.disable" : "newYearShell.enable")}</Button><Button variant="ghost" disabled={pending} onClick={() => void remove()}>{t("newYearShell.remove")}</Button></>}</div></section>;
}
