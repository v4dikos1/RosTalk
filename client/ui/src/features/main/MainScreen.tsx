import {
  AlertTriangle,
  ArrowRight,
  ClipboardPaste,
  LogIn,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Radio,
  ServerCog,
  Settings2,
  WifiOff,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChatPanel } from "@/components/chat/ChatPanel";
import { BrandMark } from "@/components/common/BrandMark";
import { ConnectionBanner } from "@/components/common/ConnectionBanner";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { UserAvatar } from "@/components/common/UserAvatar";
import { CoreErrorNotice } from "@/components/common/CoreErrorNotice";
import { EmptyState } from "@/components/common/EmptyState";
import { ControlBar } from "@/components/controls/ControlBar";
import { ChannelHeader } from "@/components/layout/ChannelHeader";
import { Sidebar } from "@/components/layout/Sidebar";
import { StreamStartDialog } from "@/components/streams/StreamStartDialog";
import { StreamsPanel } from "@/components/streams/StreamsPanel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { coreApi } from "@/core";
import type { ChatTarget, CoreState } from "@/core/api";
import {
  COMPACT_LAYOUT_MAX_WIDTH,
  useWindowWidth,
} from "@/hooks/useWindowWidth";
import {
  defaultVoiceChannel,
  joinVoiceChannel,
} from "@/lib/channels";
import { conversationKey } from "@/lib/chat";
import { coreErrorText } from "@/lib/coreError";
import { watchStreamInChannel } from "@/lib/streams";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";
import { runCoreAction, useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useStreamStore } from "@/store/streamStore";
import { useVoiceStore, voiceLevelForUser } from "@/store/voiceStore";

import { MembersPane } from "./MembersPane";

function pickChannel(state: CoreState, selectedChannelId: number | null) {
  if (selectedChannelId !== null) {
    const selected = state.channels.find(
      (channel) => channel.id === selectedChannelId,
    );
    if (selected) {
      return selected;
    }
  }
  const own = state.users.find((user) => user.id === state.selfUserId);
  const ownChannel = state.channels.find(
    (channel) => channel.id === own?.channelId,
  );
  if (ownChannel) {
    return ownChannel;
  }
  return (
    state.channels.find((channel) => channel.kind === "voice") ??
    state.channels[0]
  );
}

function LoadingPanel() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="flex flex-col items-center gap-2">
        <span className="size-8 animate-spin rounded-full border-2 border-border border-t-accent" />
        <p className="text-[12px] text-muted">{t("states.connecting")}</p>
      </div>
    </div>
  );
}

function ConnectingPanel() {
  const { t } = useTranslation();
  const state = useCoreStore((core) => core.state);
  const bookmark = state?.servers.find(
    (server) => server.id === state.activeServerId,
  );
  return (
    <div
      data-testid="connecting-panel"
      className="flex min-h-0 flex-1 items-center justify-center p-6"
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 text-center">
        <span className="mx-auto flex size-11 items-center justify-center rounded-md bg-accent/15">
          <BrandMark className="size-5" />
        </span>
        <h2 className="mt-3 text-[15px] font-semibold text-foreground">
          {t("states.connectingTitle")}
        </h2>
        <p className="mt-1 text-[12px] text-muted">
          {bookmark ? `${bookmark.name} · ${bookmark.host}` : t("states.connectingHint")}
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />
          <span className="text-[12px] text-faint">{t("states.connectingShort")}</span>
        </div>
        <Button
          className="mt-4"
          size="sm"
          variant="secondary"
          onClick={() => void runCoreAction(() => coreApi.disconnect())}
        >
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

function StateScreen() {
  const { t } = useTranslation();
  const state = useCoreStore((core) => core.state);
  const settings = useSettingsStore((store) => store.settings);
  const openWizard = useAppStore((app) => app.openWizard);
  const openHosting = useAppStore((app) => app.openHosting);
  const openConnect = useAppStore((app) => app.openConnect);
  const openSettings = useAppStore((app) => app.openSettings);

  const [welcomeMenu, setWelcomeMenu] = useState(false);
  const error = state?.error ?? null;
  const bookmark = state?.servers.find(
    (server) => server.id === state.activeServerId,
  );
  const canRetry =
    bookmark !== undefined && (settings?.nickname ?? "").length > 0;

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      const value = text.trim();
      openWizard(value.startsWith("rostalk://") ? value : undefined);
    } catch {
      openWizard();
    }
  }

  if (error) {
    const text = coreErrorText(error);
    const banned = error.serverCode === "banned";
    const outdated =
      error.code === "protocolVersionUnsupported" ||
      error.serverCode === "protocolVersionUnsupported";
    return (
      <div
        data-testid="state-error"
        className="flex min-h-0 flex-1 items-center justify-center p-6"
      >
        <div className="w-full max-w-md rounded-lg border border-border bg-surface p-6">
          <span
            className={cn(
              "flex size-11 items-center justify-center rounded-md",
              banned || outdated
                ? "bg-danger/15 text-danger"
                : "bg-warning/15 text-warning",
            )}
          >
            {banned || outdated ? (
              <WifiOff className="size-5" aria-hidden />
            ) : (
              <AlertTriangle className="size-5" aria-hidden />
            )}
          </span>
          <h2 className="mt-3 text-[15px] font-semibold text-foreground">
            {t(text.key)}
          </h2>
          <p className="mt-1 text-[12px] text-muted">
            {banned
              ? t("states.bannedHint")
              : outdated
                ? t("states.outdatedHint")
                : t("states.errorHint")}
          </p>
          {outdated && error.actionUrl ? (
            <a
              className="mt-2 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
              href={error.actionUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t("errors.help.download")}
            </a>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {canRetry && error.retryable ? (
              <Button
                size="sm"
                onClick={() =>
                  void runCoreAction(() =>
                    coreApi.connect({
                      target: { mode: "link", link: bookmark.link },
                      nickname: settings?.nickname ?? "",
                    }),
                  )
                }
              >
                <LogIn className="size-3.5" aria-hidden />
                {t("connection.retry")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => openWizard()}
              data-testid="state-other-server"
            >
              <Plus className="size-3.5" aria-hidden />
              {t("states.anotherServer")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => openHosting()}
              data-testid="state-own-hosting"
            >
              <ServerCog className="size-3.5" aria-hidden />
              {t("hosting.entry")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openSettings("about")}
            >
              <Settings2 className="size-3.5" aria-hidden />
              {t("settings.tabs.about")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const saved = state?.servers ?? [];
  return (
    <div
      data-testid="state-welcome"
      className="flex min-h-0 flex-1 items-center justify-center p-6"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-6 text-center">
        <span className="mx-auto flex size-11 items-center justify-center rounded-md bg-accent/15">
          <BrandMark className="size-5" />
        </span>
        <h2 className="mt-3 text-[15px] font-semibold text-foreground">
          {t("states.welcomeTitle")}
        </h2>
        <p className="mt-1 text-[12px] text-muted">{t("states.welcomeHint")}</p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button size="sm" onClick={() => openWizard()} data-testid="welcome-connect">
            <LogIn className="size-3.5" aria-hidden />
            {t("main.connect")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void pasteFromClipboard()}
            data-testid="welcome-paste"
          >
            <ClipboardPaste className="size-3.5" aria-hidden />
            {t("states.pasteLink")}
          </Button>
          <DropdownMenu open={welcomeMenu} onOpenChange={setWelcomeMenu}>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("main.more")}
                data-testid="welcome-menu"
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              role="menu"
              align="end"
              className="w-52 text-left"
            >
              <DropdownMenuItem
                onSelect={() => {
                  setWelcomeMenu(false);
                  openHosting();
                }}
                data-testid="welcome-own-hosting"
              >
                <ServerCog className="size-3.5" aria-hidden />
                {t("hosting.entry")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setWelcomeMenu(false);
                  openConnect();
                }}
              >
                <Plus className="size-3.5" aria-hidden />
                {t("servers.add")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {saved.length > 0 ? (
          <div className="mt-5 border-t border-border pt-3 text-left">
            <p className="text-[11px] font-medium text-faint">
              {t("connect.saved")}
            </p>
            <div className="mt-1.5 space-y-1">
              {saved.slice(0, 4).map((server) => (
                <button
                  key={server.id}
                  type="button"
                  onClick={() => {
                    if (settings?.nickname) {
                      void runCoreAction(() =>
                        coreApi.connect({
                          target: { mode: "link", link: server.link },
                          nickname: settings.nickname,
                        }),
                      );
                    } else {
                      openConnect(server.link);
                    }
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-sm border border-border bg-raised px-2.5 py-1.5 text-left hover:bg-hover"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-medium text-foreground">
                      {server.name}
                    </span>
                    <span className="block truncate text-[11px] text-faint">
                      {server.host}
                      {settings && server.lastConnectedUnixMs > 0
                        ? ` · ${formatRelative(
                            server.lastConnectedUnixMs,
                            settings.locale,
                          )}`
                        : ""}
                    </span>
                  </span>
                  <ArrowRight className="size-3.5 shrink-0 text-faint" aria-hidden />
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function MainScreen() {
  const { t } = useTranslation();
  const state = useCoreStore((core) => core.state);
  const selectedChannelId = useAppStore((app) => app.selectedChannelId);
  const selectChannel = useAppStore((app) => app.selectChannel);
  const openUserMenu = useAppStore((app) => app.openUserMenu);
  const openSettings = useAppStore((app) => app.openSettings);
  const dmPeerId = useAppStore((app) => app.dmPeerId);
  const closeDm = useAppStore((app) => app.closeDm);
  const view = useAppStore((app) => app.view);
  const setView = useAppStore((app) => app.setView);
  const settings = useSettingsStore((store) => store.settings);
  const updateSettings = useSettingsStore((store) => store.update);
  const levels = useVoiceStore((store) => store.levels);
  const stopStream = useStreamStore((stream) => stream.stop);
  const setStreamVisible = useStreamStore((stream) => stream.setVisible);
  const setStreamChannel = useStreamStore((stream) => stream.setChannel);
  const shutdownStream = useStreamStore((stream) => stream.shutdown);
  const [streamDialogOpen, setStreamDialogOpen] = useState(false);
  // The overlay choice belongs to the current narrow layout: a resize back to
  // the wide layout reads the persisted setting again.
  const [overlayMembers, setOverlayMembers] = useState({
    compact: false,
    open: false,
  });
  const windowWidth = useWindowWidth();
  const compactLayout = windowWidth < COMPACT_LAYOUT_MAX_WIDTH;
  const autojoin = useRef<string | null>(null);

  const channel = state ? pickChannel(state, selectedChannelId) : undefined;
  const peer = state?.users.find((user) => user.id === dmPeerId);
  const peerCounter = state?.unread.find(
    (counter) => counter.peerUserId === dmPeerId,
  );
  const chatTarget = useMemo<ChatTarget | null>(() => {
    if (dmPeerId !== null) {
      return { kind: "dm", peerId: dmPeerId };
    }
    if (channel) {
      return { kind: "channel", channelId: channel.id };
    }
    return null;
  }, [dmPeerId, channel]);
  const memberCount =
    state && channel
      ? state.users.filter((user) => user.channelId === channel.id).length
      : 0;
  const self = state?.users.find((user) => user.id === state.selfUserId);
  const connected = state?.connection === "connected";
  const streamingUsers =
    state && channel
      ? state.users.filter(
          (user) => user.channelId === channel.id && user.streaming,
        )
      : [];
  const selfStreaming = self?.streaming === true;
  const remoteStreamer = streamingUsers.find((user) => user.id !== self?.id);
  const micMuted =
    self?.voice.selfMuted === true || self?.voice.serverMuted === true;
  const transmitting =
    connected &&
    !micMuted &&
    (levels?.selfSpeaking ?? false);
  const speaking = new Set<number>(
    transmitting && self ? [self.id] : [],
  );
  for (const user of state?.users ?? []) {
    if (user.id === state?.selfUserId) {
      continue;
    }
    const level = voiceLevelForUser(levels, user.id);
    if (level?.speaking) {
      speaking.add(user.id);
    }
  }

  // The displayed channel may be a fallback (own channel or the first voice
  // room); reflect it in the tree so the highlight matches the open panel.
  useEffect(() => {
    if (dmPeerId === null && channel && channel.id !== selectedChannelId) {
      selectChannel(channel.id);
    }
  }, [channel, dmPeerId, selectedChannelId, selectChannel]);

  // Every channel opens on chat; the participants live in the right pane and
  // streams stay an explicit tab (playtest-1, complaint 15).
  const channelId = channel?.id ?? null;
  const channelKind = channel?.kind;
  useEffect(() => {
    if (channelKind && dmPeerId === null) {
      setView("chat");
    }
  }, [channelId, channelKind, dmPeerId, setView]);

  // On a narrow window the pane starts hidden and opens over the content; it
  // is not a persisted choice there. The wide layout remembers it in settings.
  const overlayMembersOpen =
    compactLayout && overlayMembers.compact === true
      ? overlayMembers.open
      : false;
  const membersOpen = compactLayout
    ? overlayMembersOpen
    : (settings?.membersPaneOpen ?? true);
  const toggleMembers = () => {
    if (compactLayout) {
      setOverlayMembers({ compact: true, open: !overlayMembersOpen });
      return;
    }
    void updateSettings({ membersPaneOpen: !membersOpen });
  };

  // Enter the remembered channel once per session after a fresh connect.
  useEffect(() => {
    if (!state || state.connection !== "connected" || !settings) {
      return;
    }
    const serverKey = state.server?.id ?? state.activeServerId ?? "unknown";
    if (autojoin.current === serverKey) {
      return;
    }
    if (self && self.channelId !== 0) {
      autojoin.current = serverKey;
      return;
    }
    const target = defaultVoiceChannel(state, settings.defaultChannelId);
    if (!target) {
      autojoin.current = serverKey;
      return;
    }
    autojoin.current = serverKey;
    void joinVoiceChannel(target.id);
  }, [state, settings, self]);

  // The stream engine belongs to the user's voice channel. Leaving the
  // channel ends both publishing and watching.
  useEffect(() => {
    setStreamChannel(self?.channelId ?? 0);
  }, [self?.channelId, setStreamChannel]);

  useEffect(() => {
    if (!connected) {
      void shutdownStream();
    }
  }, [connected, shutdownStream]);

  // A hidden player unsubscribes; the `*:stream` participant disappears when
  // there is neither a local share nor an active view.
  useEffect(() => {
    const streamsView =
      view === "streams" && dmPeerId === null && channel?.kind === "voice";
    void setStreamVisible(streamsView);
  }, [view, dmPeerId, channel?.kind, setStreamVisible]);

  return (
    <div
      data-testid="main-screen"
      className="flex h-full min-h-0 flex-col bg-chrome"
    >
      <ConnectionBanner />

      <div className="sheet-row relative flex min-h-0 flex-1">
        <Sidebar />
        <main className="sheet sheet-main flex min-w-0 flex-1 flex-col bg-background">
          {!state ? (
            <LoadingPanel />
          ) : state.connection === "connecting" ? (
            <ConnectingPanel />
          ) : state.connection === "disconnected" ? (
            <StateScreen />
          ) : dmPeerId !== null && chatTarget ? (
            <>
              <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
                <UserAvatar
                  name={peer?.nickname ?? peerCounter?.peerNickname ?? ""}
                  color={peer?.color ?? null}
                  avatarHash={peer?.avatarHash ?? ""}
                  serverId={state?.server?.id ?? null}
                  userId={dmPeerId ?? undefined}
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-[14px] font-semibold text-foreground">
                    {peer?.nickname ||
                      peerCounter?.peerNickname ||
                      t("chat.directMessages")}
                  </h2>
                  <p className="flex items-center gap-1.5 truncate text-[12px] text-muted">
                    <MessageCircle className="size-3" aria-hidden />
                    {t("chat.directMessage")}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("common.close")}
                  onClick={closeDm}
                  data-testid="close-dm"
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </header>
              <ErrorBoundary name="chat" className="flex-1">
                <ChatPanel
                  key={conversationKey(chatTarget)}
                  target={chatTarget}
                  peer={peer}
                />
              </ErrorBoundary>
            </>
          ) : channel ? (
            <>
              <ChannelHeader
                channel={channel}
                memberCount={memberCount}
                connected={self?.channelId === channel.id}
                onJoin={() => void joinVoiceChannel(channel.id)}
                streamingCount={streamingUsers.length}
                selfStreaming={selfStreaming && self?.channelId === channel.id}
                onWatchStreams={() => {
                  setView("streams");
                  if (remoteStreamer) {
                    void watchStreamInChannel(channel.id, remoteStreamer.id);
                  }
                }}
                onStartStream={() => setStreamDialogOpen(true)}
                onStopStream={() => void stopStream()}
                membersOpen={membersOpen}
                onToggleMembers={toggleMembers}
              />
              <MainTabs
                view={view}
                streamsCount={streamingUsers.length}
                onChange={setView}
              />
              {view === "streams" && channel.kind === "voice" ? (
                <ErrorBoundary name="streams" className="flex-1">
                  <StreamsPanel channel={channel} />
                </ErrorBoundary>
              ) : null}
              {chatTarget ? (
                // The chat stays mounted while the streams tab is open: the
                // virtualizer keeps its scroll offset and the composer keeps
                // its draft (P31). `hidden` removes it from layout without
                // unmounting, so switching back does not jump or flash.
                <div
                  data-testid="chat-view"
                  className={
                    view === "streams" && channel.kind === "voice"
                      ? "hidden"
                      : "flex min-h-0 flex-1 flex-col"
                  }
                >
                  <ErrorBoundary name="chat" className="flex-1">
                    <ChatPanel
                      key={conversationKey(chatTarget)}
                      target={chatTarget}
                      channel={channel}
                      active={!(view === "streams" && channel.kind === "voice")}
                    />
                  </ErrorBoundary>
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState
              className="flex-1"
              title={t("main.noChannelsTitle")}
              description={t("main.noChannelsHint")}
            />
          )}
        </main>

        {state && channel && dmPeerId === null && membersOpen ? (
          <MembersPane
            channel={channel}
            users={state.users}
            channels={state.channels}
            roles={state.roles}
            selfUserId={state.selfUserId}
            speakingUserIds={speaking}
            serverId={state.server?.id ?? null}
            connected={connected}
            overlay={compactLayout}
            onClose={toggleMembers}
            onUserMenu={(user, position) => {
              openUserMenu(user.id, position.x, position.y);
            }}
            onOpenProfile={() => openSettings("profile")}
          />
        ) : null}
      </div>

      <ControlBar />
      <CoreErrorNotice />
      {channel && channel.kind === "voice" ? (
        <StreamStartDialog
          open={streamDialogOpen && connected}
          onOpenChange={setStreamDialogOpen}
          channelId={channel.id}
        />
      ) : null}
    </div>
  );
}

function MainTabs({
  view,
  streamsCount,
  onChange,
}: {
  view: "chat" | "streams";
  streamsCount: number;
  onChange: (view: "chat" | "streams") => void;
}) {
  const { t } = useTranslation();
  const tabs: Array<
    ["chat" | "streams", typeof MessageCircle, string]
  > = [["chat", MessageCircle, t("main.chat")]];
  if (streamsCount > 0) {
    tabs.push(["streams", Radio, t("streams.tab", { count: streamsCount })]);
  }
  return (
    <div
      role="group"
      aria-label={t("chat.viewTabs")}
      className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3"
    >
      {tabs.map(([id, Icon, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={view === id}
          data-testid={`main-tab-${id}`}
          onClick={() => onChange(id)}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors duration-150",
            view === id
              ? "bg-active font-medium text-foreground"
              : "text-muted hover:bg-hover hover:text-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}
