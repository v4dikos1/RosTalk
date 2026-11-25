import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { fixtureHostingApi } from "@/features/hosting/fixtureHostingApi";
import { HostingWizard } from "@/features/hosting/HostingWizard";
import type { HostingApi } from "@/features/hosting/types";
import { i18n } from "@/i18n";
import "@/index.css";
import "@/reduced-motion.css";

import { tauriHostingApi } from "./tauriHostingApi";

/**
 * Second entry point of the UI: the window of `rostalk-server-setup`
 * (P13, ADR 0026). It renders only the installation wizard; the desktop
 * client's stores, core API and settings are not loaded here (no client
 * module that imports `@/core` may be pulled in: it would call client IPC
 * commands this program does not have).
 */
function selectApi(): HostingApi {
  if ("__TAURI_INTERNALS__" in window) {
    return tauriHostingApi;
  }
  const fixtures = new URLSearchParams(window.location.search).has("fixtures");
  return fixtures || import.meta.env.DEV ? fixtureHostingApi : tauriHostingApi;
}

const root = document.documentElement.dataset;
root.theme = "dark";
root.preset = "rostalk";
root.accent = "auto";
root.density = "comfortable";
root.radius = "default";
root.fontScale = "100";
root.chatBackground = "none";

// The installer has no settings file: the system language decides.
const language = navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
void i18n.changeLanguage(language);
document.documentElement.lang = language;

const container = document.getElementById("root");
if (!container) {
  throw new Error("server-setup.html is missing #root");
}

const api = selectApi();

createRoot(container).render(
  <StrictMode>
    <div className="h-full overflow-hidden bg-background text-foreground">
      <HostingWizard api={api} />
    </div>
  </StrictMode>,
);
