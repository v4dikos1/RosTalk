import { createRoot } from "react-dom/client";
import { coreApi } from "@/core";
import { MembersPane } from "@/features/main/MembersPane";
import { i18n } from "@/i18n";
import "@/index.css";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { PluginHost } from "@/plugins/new-year/PluginHost";
import { write } from "@/plugins/new-year/support";
import { useAppStore } from "@/store/appStore";
import { useChatStore } from "@/store/chatStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

async function mount() {
  await i18n.changeLanguage("en");
  const proxy = { baseUrl: "http://127.0.0.1:17888", token: "test" };
  const promo = new URLSearchParams(window.location.search).has("promo");
  const state = structuredClone(fixtureState);
  state.server!.id = "shell-focus";
  const self = state.users.find((user) => user.id === state.selfUserId)!;
  write(`rostalk.newYear.open:${state.server!.id}:${self.id}:${self.connectedAtUnixMs}:${proxy.baseUrl}`, "1");
  useCoreStore.setState({ state });
  useChatStore.setState({ proxy });
  useSettingsStore.setState({ settings: { ...fixtureSettings, plugins: { newYear: promo ? "absent" : "enabled" } }, persistedNewYear: promo ? "absent" : "enabled" });
  useAppStore.setState({ newYearTarget: null });
  coreApi.chatProxy = async () => proxy;
  window.fetch = async (url) => new Response(JSON.stringify(String(url).endsWith("/support") ? { apiVersion: 1, season: "2026-12", phase: "active" } : { tree: { growthDays: 1, background: "dusk", placements: [] } }));
  const channel = state.channels.find((entry) => entry.id === 3)!;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  root.render(<><MembersPane channel={channel} users={state.users} channels={state.channels} roles={state.roles} selfUserId={state.selfUserId} speakingUserIds={new Set()} serverId={state.server!.id} connected onClose={() => {}} onUserMenu={() => {}} onOpenProfile={() => {}} /><PluginHost /></>);
}
void mount();
