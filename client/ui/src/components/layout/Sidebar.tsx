import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ChannelTree } from "@/components/channels/ChannelTree";
import { UserContextMenu } from "@/components/channels/UserContextMenu";
import { BrandMark } from "@/components/common/BrandMark";
import { PresenceDot } from "@/components/common/PresenceDot";
import { UserAvatar } from "@/components/common/UserAvatar";
import { ConnectionQuality } from "@/components/connection/ConnectionQuality";
import { VoiceControls } from "@/components/controls/VoiceControls";
import { ServerSwitcher } from "@/components/servers/ServerSwitcher";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { UnreadView, UserView } from "@/core/api";
import { cn } from "@/lib/utils";
import { memberMove, sendAdmin } from "@/lib/admin";
import { joinVoiceChannel } from "@/lib/channels";
import { asCoreError } from "@/lib/coreError";
import { hasPermission } from "@/lib/permissions";
import { watchStreamInChannel } from "@/lib/streams";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useVoiceStore, voiceLevelForUser } from "@/store/voiceStore";

interface DirectMessageListProps {
  unread: UnreadView[];
  users: UserView[];
  selfUserId: number;
  activePeerId: number | null;
  serverId: string | null;
  onOpen: (peerId: number) => void;
}

/** Direct conversations with unread history, plus a hint on how to start one. */
function DirectMessageList({
  unread,
  users,
  selfUserId,
  activePeerId,
  serverId,
  onOpen,
}: DirectMessageListProps) {
  const { t } = useTranslation();
  const conversations = unread
    .filter((counter) => counter.peerUserId !== 0 && counter.peerUserId !== selfUserId)
    .sort((a, b) => (b.lastMessageId ?? 0) - (a.lastMessageId ?? 0));
  return (
    <div className="mx-2 mb-3 mt-1">
      <p className="px-2 pb-1 text-[12px] font-medium text-faint">
        {t("chat.directMessages")}
      </p>
      {conversations.length === 0 ? (
        <p className="px-2 py-1 text-[12px] leading-snug text-faint">
          {t("chat.directHint")}
        </p>
      ) : (
        <div className="space-y-0.5">
          {conversations.map((counter) => {
            const online = users.find((user) => user.id === counter.peerUserId);
            const name = online?.nickname || counter.peerNickname || `#${counter.peerUserId}`;
            return (
              <button
                key={counter.peerUserId}
                type="button"
                onClick={() => onOpen(counter.peerUserId)}
                data-testid={`dm-${counter.peerUserId}`}
                data-active={activePeerId === counter.peerUserId ? "true" : undefined}
                className={cn(
                  "row-dense flex w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 hover:bg-hover",
                  activePeerId === counter.peerUserId
                    ? "bg-active text-foreground"
                    : "text-muted",
                )}
              >
                <span className="relative inline-flex shrink-0">
                  <UserAvatar
                    name={name}
                    color={online?.color ?? null}
                    serverId={serverId}
                    userId={counter.peerUserId}
                    avatarHash={online?.avatarHash ?? ""}
                    size="sm"
                  />
                  <PresenceDot online={online !== undefined} />
                </span>
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {counter.unread > 0 ? (
                  <span
                    aria-label={t("tree.unread", { count: counter.unread })}
                    className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-none tabular-nums text-accent-foreground"
                  >
                    {counter.unread > 99 ? "99+" : counter.unread}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const state = useCoreStore((core) => core.state);
  const selectedChannelId = useAppStore((app) => app.selectedChannelId);
  const selectChannel = useAppStore((app) => app.selectChannel);
  const openPalette = useAppStore((app) => app.openPalette);
  const openUserMenu = useAppStore((app) => app.openUserMenu);
  const openDm = useAppStore((app) => app.openDm);
  const dmPeerId = useAppStore((app) => app.dmPeerId);
  const setView = useAppStore((app) => app.setView);
  const setActionError = useCoreStore((store) => store.setActionError);
  const levels = useVoiceStore((store) => store.levels);
  const canMoveMembers = hasPermission(state?.permissions?.server, "moveMembers");
  const connected = state?.connection === "connected";
  const self = state?.users.find((user) => user.id === state.selfUserId);
  const micMuted =
    self?.voice.selfMuted === true || self?.voice.serverMuted === true;
  const speaking = new Set<number>(
    connected && !micMuted && (levels?.selfSpeaking ?? false) && self
      ? [self.id]
      : [],
  );
  for (const user of state?.users ?? []) {
    if (user.id === state?.selfUserId) {
      continue;
    }
    if (voiceLevelForUser(levels, user.id)?.speaking) {
      speaking.add(user.id);
    }
  }

  return (
    <aside
      data-testid="sidebar"
      className="sheet sheet-side flex w-[264px] shrink-0 flex-col bg-surface"
    >
      <header className="flex h-14 shrink-0 items-center gap-2.5 px-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent/15">
          <BrandMark className="size-[18px]" />
        </span>
        <ServerSwitcher />
        <ConnectionQuality compact />
      </header>

      <div className="shrink-0 px-2 pb-2">
        <button
          type="button"
          onClick={openPalette}
          data-testid="open-palette"
          className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-background px-2.5 text-left text-[12px] text-faint transition-colors duration-150 hover:bg-hover hover:text-muted"
        >
          <Search className="size-3.5" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t("palette.placeholder")}</span>
          <kbd className="rounded-sm border border-border px-1 text-[10px]">
            Ctrl K
          </kbd>
        </button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <DirectMessageList
          unread={state?.unread ?? []}
          users={state?.users ?? []}
          selfUserId={state?.selfUserId ?? 0}
          activePeerId={dmPeerId}
          serverId={state?.server?.id ?? null}
          onOpen={openDm}
        />
        <div className="px-2 pb-2">
          <ChannelTree
            channels={state?.channels ?? []}
            users={state?.users ?? []}
            roles={state?.roles ?? []}
            selfUserId={state?.selfUserId ?? 0}
            selectedChannelId={selectedChannelId}
            unread={state?.unread ?? []}
            onSelectChannel={selectChannel}
            onJoinChannel={(channel) => void joinVoiceChannel(channel.id)}
            onWatchStream={(userId) => {
              const user = state?.users.find((item) => item.id === userId);
              if (!user) {
                return;
              }
              selectChannel(user.channelId);
              setView("streams");
              void watchStreamInChannel(user.channelId, userId);
            }}
            speakingUserIds={speaking}
            onUserContextMenu={(user, position) => {
              openUserMenu(user.id, position.x, position.y);
            }}
            serverId={state?.server?.id ?? null}
            canMoveMembers={canMoveMembers}
            onMoveUser={(userId, channelId) => {
              void sendAdmin(memberMove(userId, channelId)).catch((error: unknown) =>
                setActionError(asCoreError(error)),
              );
            }}
          />
        </div>
      </ScrollArea>

      <footer className="shrink-0 border-t border-border px-2 py-2">
        <VoiceControls />
      </footer>

      <UserContextMenu />
    </aside>
  );
}
