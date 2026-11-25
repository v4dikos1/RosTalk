import { Flame } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { CommandPalette } from "@/components/command/CommandPalette";
import { ChatNotices } from "@/components/chat/ChatNotices";
import { ChannelPasswordDialog } from "@/components/connect/ChannelPasswordDialog";
import { ConnectDialog } from "@/components/connect/ConnectDialog";
import { ContextMenu } from "@/components/common/ContextMenu";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { TrayHint } from "@/components/common/TrayHint";
import { TitleBar } from "@/components/layout/TitleBar";
import { InviteDialog } from "@/components/servers/InviteDialog";
import { ServerMenu } from "@/components/servers/ServerMenu";
import { ServerSettingsDialog } from "@/components/servers/ServerSettingsDialog";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GalleryPage } from "@/features/gallery/GalleryPage";
import { OwnServerDialog } from "./features/own-server/OwnServerDialog";
import { MainScreen } from "@/features/main/MainScreen";
import { OnboardingWizard } from "@/features/onboarding/OnboardingWizard";
import { coreApi, isDesktop } from "@/core";
import { useGlobalHotkeys } from "@/hooks/useGlobalHotkeys";
import { i18n } from "@/i18n";
import { readDebugFlags } from "@/lib/debug";
import { useAppStore } from "@/store/appStore";
import { startCoreMirror } from "@/store/coreStore";
import { startChatMirror } from "@/store/chatMirror";
import { useSettingsStore } from "@/store/settingsStore";
import { startStreamMirror } from "@/store/streamStore";
import { startSoundMirror } from "@/store/soundMirror";
import { startVoiceMirror } from "@/store/voiceStore";

function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function getHashSnapshot() {
  return window.location.hash;
}

function useRoute(): "main" | "gallery" {
  const hash = useSyncExternalStore(subscribeToHash, getHashSnapshot, () => "");
  return hash.startsWith("#/gallery") ? "gallery" : "main";
}

function Splash() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <span className="flex size-12 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <Flame className="size-6" aria-hidden />
        </span>
        <p className="text-[13px] text-muted">{t("app.loading")}</p>
      </div>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const settings = useSettingsStore((state) => state.settings);
  const loaded = useSettingsStore((state) => state.loaded);
  const hydrateSettings = useSettingsStore((state) => state.hydrate);
  const wizardOpen = useAppStore((state) => state.wizardOpen);
  const wizardLink = useAppStore((state) => state.wizardLink);
  const openWizard = useAppStore((state) => state.openWizard);
  const openHosting = useAppStore((state) => state.openHosting);
  const openSettings = useAppStore((state) => state.openSettings);
  const openServerSettings = useAppStore((state) => state.openServerSettings);
  const openServerList = useAppStore((state) => state.openServerList);
  const openPalette = useAppStore((state) => state.openPalette);
  const openUserMenu = useAppStore((state) => state.openUserMenu);
  const selectChannel = useAppStore((state) => state.selectChannel);
  const openDm = useAppStore((state) => state.openDm);
  const setView = useAppStore((state) => state.setView);
  const debugApplied = useRef(false);

  useGlobalHotkeys();

  // One subscription per window; the core owns the truth and the UI mirrors it.
  useEffect(() => startCoreMirror(), []);
  useEffect(() => startChatMirror(), []);
  useEffect(() => startVoiceMirror(), []);
  useEffect(() => startStreamMirror(), []);
  useEffect(() => startSoundMirror(), []);

  useEffect(() => {
    void hydrateSettings();
  }, [hydrateSettings]);

  useEffect(() => {
    if (!settings) {
      return;
    }
    const appearance = settings.appearance;
    const root = document.documentElement.dataset;
    // `theme` stays the derived flag for the tray, the title and old bundles;
    // everything visual hangs off the appearance attributes.
    root.theme = settings.theme;
    root.preset = appearance.preset;
    root.accent = appearance.accent;
    root.density = appearance.density;
    root.radius = appearance.radius;
    root.fontScale = String(appearance.fontScale);
    document.documentElement.lang = settings.locale;
    void i18n.changeLanguage(settings.locale);

    // The desktop shell zooms the webview natively: popovers, hit-testing and
    // fixed overlays stay consistent. The browser preview has no such call and
    // falls back to the CSS zoom in the stylesheet.
    if (isDesktop) {
      root.nativeScale = "true";
      void coreApi
        .setInterfaceScale(appearance.fontScale / 100)
        .catch(() => {
          delete root.nativeScale;
        });
    } else {
      delete root.nativeScale;
    }
  }, [settings]);

  // `rostalk://` links: one received at launch and any that arrive later.
  useEffect(() => {
    const unsubscribe = coreApi.subscribeDeepLinks((link) => openWizard(link));
    void coreApi
      .takePendingLink()
      .then((link) => {
        if (link) {
          openWizard(link);
        }
      })
      .catch(() => {
        // A link is optional; failing to read it must not break startup.
      });
    return unsubscribe;
  }, [openWizard]);

  // Gallery/Playwright overrides: open a pane or a channel once, after the
  // settings are known.
  useEffect(() => {
    if (!loaded || debugApplied.current) {
      return;
    }
    debugApplied.current = true;
    const flags = readDebugFlags();
    if (flags.onboarding) {
      openWizard(flags.link ?? undefined);
    }
    if (flags.hosting) {
      openHosting();
    }
    if (flags.settingsSection) {
      openSettings(flags.settingsSection);
    }
    if (flags.serverSettings) {
      openServerSettings();
    }
    if (flags.serverList) {
      openServerList();
    }
    if (flags.palette) {
      openPalette();
    }
    if (flags.userMenuUserId) {
      openUserMenu(flags.userMenuUserId, 720, 300);
    }
    if (flags.channelId !== null) {
      selectChannel(flags.channelId);
    }
    if (flags.dmPeerId !== null) {
      openDm(flags.dmPeerId);
    }
    if (flags.view !== null) {
      setView(flags.view);
    }
  }, [
    loaded,
    openPalette,
    openSettings,
    openServerSettings,
    openServerList,
    openUserMenu,
    openWizard,
    openHosting,
    selectChannel,
    openDm,
    setView,
  ]);

  if (route === "gallery") {
    return (
      <TooltipProvider delayDuration={250} skipDelayDuration={0}>
        <div className="flex h-full min-h-0 flex-col">
          <TitleBar />
          <div className="min-h-0 flex-1 overflow-auto">
            <GalleryPage />
          </div>
        </div>
      </TooltipProvider>
    );
  }

  if (!loaded || !settings) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <TitleBar />
        <div className="min-h-0 flex-1">
          <Splash />
        </div>
      </div>
    );
  }

  const showWizard = wizardOpen || !settings.onboardingComplete;

  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={0}>
      <div className="flex h-full min-h-0 flex-col">
        <TitleBar />
        <div className="flex min-h-0 flex-1 flex-col">
          {showWizard ? (
            <OnboardingWizard key={wizardLink ?? "new"} />
          ) : (
            <MainScreen />
          )}
        </div>
      </div>
      <ErrorBoundary name="settings">
        <SettingsDialog />
      </ErrorBoundary>
      <ServerSettingsDialog />
      <ServerMenu />
      <InviteDialog />
      <CommandPalette />
      <ConnectDialog />
      <OwnServerDialog />
      <ChannelPasswordDialog />
      <ContextMenu />
      <ChatNotices />
      <TrayHint />
    </TooltipProvider>
  );
}
