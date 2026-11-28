import { Hash, Volume2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { UserStateIcons } from "@/components/channels/UserStateIcons";
import { PresenceDot } from "@/components/common/PresenceDot";
import { UserAvatar } from "@/components/common/UserAvatar";
import { AvatarViewerDialog } from "@/components/profile/AvatarViewerDialog";
import { useAppStore } from "@/store/appStore";
import { useSettingsStore } from "@/store/settingsStore";
import { StreamViewerCount } from "@/components/streams/StreamViewers";
import type { ChannelView, RoleView, UserView } from "@/core/api";
import { roleName, roleNameStyle } from "@/lib/roles";
import { streamViewers } from "@/lib/streamViewers";
import { cn } from "@/lib/utils";

export interface MembersPaneProps {
  /** The open channel; its voice members come first. */
  channel: ChannelView;
  users: UserView[];
  channels: ChannelView[];
  roles: RoleView[];
  selfUserId: number;
  speakingUserIds: ReadonlySet<number>;
  /** Server identity for the avatar palette. */
  serverId: string | null;
  /** Presence is only meaningful while the control plane is connected. */
  connected: boolean;
  /** Always visible on a narrow window: the pane is an overlay there. */
  overlay?: boolean;
  onClose: () => void;
  /** Opens the user context menu at a position (right click, Shift+F10 or Menu). */
  onUserMenu: (user: UserView, position: { x: number; y: number }) => void;
  /** Opens the profile section when your own row is activated (stage P27). */
  onOpenProfile: () => void;
}

/**
 * Right-hand member pane (stage P8).
 *
 * Above: the people in the open voice channel with speaking, microphone,
 * sound, stream and role state. Below: everyone else online on the server,
 * grouped by channel.
 *
 * Stage P27: the primary click (or Enter) on another participant opens a
 * read-only avatar viewer, while the context action and Shift+F10/ContextMenu
 * keep the user menu. Your own row opens the profile instead, which is where
 * the avatar editor lives now.
 */
export function MembersPane({
  channel,
  users,
  channels,
  roles,
  selfUserId,
  speakingUserIds,
  serverId,
  connected,
  overlay = false,
  onClose,
  onUserMenu,
  onOpenProfile,
}: MembersPaneProps) {
  const gameEnabled = useSettingsStore((s) => s.persistedNewYear === "enabled" && s.settings?.plugins.newYear === "enabled");
  const gameTarget = useAppStore((s) => s.newYearTarget);
  const { t } = useTranslation();
  // The open viewer remembers its server and the participant's join: the
  // target is resolved from the current users every render, so a new hash
  // arrives in place. A server switch or a departed participant makes the
  // viewer close; clearing the request during render means a later return of
  // the same id or server needs a new click. The row that opened it lives in
  // a ref and receives focus only while it is still in the document.
  const [avatarView, setAvatarView] = useState<{
    userId: number;
    serverId: string | null;
    connectedAt: number;
    attempt: number;
    open: boolean;
  } | null>(null);
  // Strictly increasing across openings, so a failure from an earlier open
  // can never match a later one even after the request state was cleared.
  const avatarAttempt = useRef(0);
  // Focus target for a close that was not requested by the page (a departed
  // participant or a server switch). It is written only in event handlers.
  const avatarRestore = useRef<HTMLElement | null>(null);
  const treeRestore = useRef<HTMLElement | null>(null);

  const byName = useMemo(
    () => (a: UserView, b: UserView) =>
      a.id === selfUserId
        ? -1
        : b.id === selfUserId
          ? 1
          : a.nickname.localeCompare(b.nickname) || a.id - b.id,
    [selfUserId],
  );

  const inChannel = useMemo(
    () =>
      users
        .filter((user) => user.channelId === channel.id)
        .slice()
        .sort(byName),
    [users, channel.id, byName],
  );

  // "Online on the server" lists the other channels only: the open channel is
  // already above, and repeating it would read as a second, different group.
  const elsewhere = useMemo(() => {
    const order = channels
      .slice()
      .sort(
        (a, b) => a.position - b.position || a.name.localeCompare(b.name),
      );
    const groups: Array<{ id: number; name: string; kind: ChannelView["kind"]; users: UserView[] }> =
      [];
    for (const entry of order) {
      if (entry.id === channel.id) {
        continue;
      }
      const members = users
        .filter((user) => user.channelId === entry.id)
        .slice()
        .sort(byName);
      if (members.length > 0) {
        groups.push({
          id: entry.id,
          name: entry.name,
          kind: entry.kind,
          users: members,
        });
      }
    }
    const idle = users
      .filter((user) => user.channelId === 0)
      .slice()
      .sort(byName);
    if (idle.length > 0) {
      groups.push({
        id: 0,
        name: t("members.noChannel"),
        kind: "text",
        users: idle,
      });
    }
    return groups;
  }, [channels, users, channel.id, byName, t]);

  const onlineCount =
    channel.kind === "voice" ? inChannel.length : users.length;

  function openMenu(
    user: UserView,
    position: { x: number; y: number },
  ) {
    onUserMenu(user, position);
  }

  function openPrimary(user: UserView, row: HTMLElement) {
    if (user.id === selfUserId) {
      onOpenProfile();
      return;
    }
    avatarAttempt.current += 1;
    avatarRestore.current = row;
    setAvatarView({
      userId: user.id,
      serverId,
      connectedAt: user.connectedAtUnixMs,
      attempt: avatarAttempt.current,
      open: true,
    });
  }

  const avatarCandidate =
    avatarView === null
      ? null
      : (users.find((user) => user.id === avatarView.userId) ?? null);
  // A departed participant or a server switch finishes the request for good:
  // clearing it during render (the supported "adjust state on prop change"
  // path) means a later return of the same id or server needs a new click.
  const avatarTargetGone =
    avatarView !== null &&
    (avatarView.serverId !== serverId ||
      avatarCandidate === null ||
      avatarCandidate.connectedAtUnixMs !== avatarView.connectedAt);
  if (avatarTargetGone) {
    setAvatarView(null);
  }
  const avatarUser =
    avatarTargetGone || avatarCandidate === null ? null : avatarCandidate;
  const avatarOpen = avatarView?.open === true && avatarUser !== null;

  // Focus belongs to the close, not to a row that may already be gone.
  useEffect(() => {
    if (avatarView === null && avatarRestore.current?.isConnected) {
      avatarRestore.current.focus();
    }
  }, [avatarView]);

  useEffect(() => {
    if (gameTarget !== null || treeRestore.current === null) return;
    const row = treeRestore.current;
    treeRestore.current = null;
    const frame = requestAnimationFrame(() => { if (row.isConnected) row.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [gameTarget]);

  return (
    <aside
      data-testid="members-pane"
      data-layout={overlay ? "overlay" : "docked"}
      aria-label={t("members.title")}
      className={cn(
        "sheet sheet-members flex w-60 shrink-0 flex-col bg-surface",
        overlay &&
          "absolute inset-y-0 right-0 z-30 rounded-none border-l border-border shadow-panel",
      )}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 px-3">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {t("members.title")}
        </h2>
        <span className="shrink-0 text-[11px] tabular-nums text-faint">
          {onlineCount}
        </span>
        <button
          type="button"
          aria-label={t("members.hide")}
          title={t("members.hide")}
          onClick={onClose}
          data-testid="members-pane-close"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-faint transition-colors duration-150 hover:bg-hover hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {channel.kind === "voice" ? (
          <section aria-label={t("members.count", { count: inChannel.length })}>
            <p className="px-2 pb-1 text-[12px] font-medium text-faint">
              {channel.name}
            </p>
            {inChannel.length === 0 ? (
              <p
                className="px-3 py-1 text-[11px] text-faint"
                data-testid="members-empty"
              >
                {t("members.empty")}
              </p>
            ) : (
              <ul className="space-y-px">
                {inChannel.map((user) => (
                  <li key={user.id}>
                    <MemberRow
                      user={user}
                      isSelf={user.id === selfUserId}
                      roles={roles}
                      serverId={serverId}
                      speaking={speakingUserIds.has(user.id)}
                      online={connected}
                      viewers={
                        user.streaming ? streamViewers(users, user.id) : []
                      }
                      onPrimary={(row) => openPrimary(user, row)}
                      onMenu={(position) => openMenu(user, position)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {channel.kind === "text" || elsewhere.length > 0 ? (
          <section
            className={cn(
              channel.kind === "voice" && "mt-5",
            )}
          >
            <p className="px-2 pb-1 text-[12px] font-medium text-faint">
              {t("members.onlineTitle")}
            </p>
            {elsewhere.length === 0 ? (
              <p className="px-3 py-1 text-[11px] text-faint">
                {t("members.onlineEmpty")}
              </p>
            ) : null}
            {elsewhere.map((group) => {
              const Icon = group.kind === "voice" ? Volume2 : Hash;
              return (
                <div key={group.id} className="mb-1">
                  <p className="mt-1.5 flex items-center gap-1.5 px-2 py-0.5 text-[11px] text-faint">
                    <Icon className="size-3 shrink-0" aria-hidden />
                    <span className="min-w-0 truncate">{group.name}</span>
                  </p>
                  <ul className="space-y-px">
                    {group.users.map((user) => (
                      <li key={user.id}>
                        <MemberRow
                          user={user}
                          isSelf={user.id === selfUserId}
                          roles={roles}
                          serverId={serverId}
                          speaking={speakingUserIds.has(user.id)}
                          online={connected}
                          compact
                          viewers={
                            user.streaming ? streamViewers(users, user.id) : []
                          }
                          onPrimary={(row) => openPrimary(user, row)}
                          onMenu={(position) => openMenu(user, position)}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>
        ) : null}
      </div>
      <AvatarViewerDialog
        user={avatarUser}
        open={avatarOpen}
        attempt={avatarView?.attempt ?? 0}
        onOpenChange={(next) => {
          if (!next) {
            setAvatarView(null);
          }
        }}
        serverId={serverId}
        onOpenTree={avatarUser && connected && gameEnabled ? () => { treeRestore.current = avatarRestore.current; useAppStore.getState().openNewYear({ kind: "peer", userId: avatarUser.id, nickname: avatarUser.nickname }); setAvatarView(null); } : undefined}
      />
    </aside>
  );
}

function MemberRow({
  user,
  isSelf,
  roles,
  serverId,
  speaking,
  online,
  viewers = [],
  compact = false,
  onPrimary,
  onMenu,
}: {
  user: UserView;
  isSelf: boolean;
  roles: RoleView[];
  serverId: string | null;
  speaking: boolean;
  online: boolean;
  viewers?: UserView[];
  compact?: boolean;
  onPrimary: (row: HTMLButtonElement) => void;
  onMenu: (position: { x: number; y: number }) => void;
}) {
  const { t } = useTranslation();
  const highestRole = roles
    .filter((role) => user.roleIds.includes(role.id))
    .sort((a, b) => b.position - a.position)[0];
  const showRole = highestRole !== undefined && highestRole.position > 1;
  const roleLabel = roleName(highestRole, t);
  const displayName = isSelf ? t("users.you") : user.nickname;

  function showMenu(row: HTMLButtonElement) {
    const rect = row.getBoundingClientRect();
    onMenu({ x: rect.left, y: rect.bottom });
  }

  return (
    <button
      type="button"
      onClick={(event) => onPrimary(event.currentTarget)}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        // A keyboard context menu is Shift+F10 or the dedicated Menu key.
        if (
          (event.key === "F10" && event.shiftKey) ||
          event.key === "ContextMenu"
        ) {
          event.preventDefault();
          showMenu(event.currentTarget);
        }
      }}
      title={
        isSelf
          ? t("members.openProfile")
          : t("members.openAvatar", { name: user.nickname })
      }
      data-testid={`member-pane-${user.id}`}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent",
        compact ? "row-dense" : "h-10",
      )}
    >
      <span className="relative inline-flex shrink-0">
        <UserAvatar
          name={displayName}
          color={user.color}
          role={showRole ? roleLabel : undefined}
          serverId={serverId}
          userId={user.id}
          avatarHash={user.avatarHash}
          speaking={speaking}
          size={compact ? "sm" : "md"}
        />
        <PresenceDot online={online && !user.voice.away} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-[13px]",
            speaking ? "font-medium text-foreground" : "text-muted",
          )}
          style={roleNameStyle(user.color)}
        >
          {displayName}
        </span>
        {!compact && showRole ? (
          <span className="block truncate text-[11px] leading-tight text-faint">
            {roleLabel}
          </span>
        ) : null}
      </span>
      <UserStateIcons
        voice={user.voice}
        streaming={user.streaming}
        speaking={speaking}
      />
      {user.streaming ? (
        <StreamViewerCount
          viewers={viewers}
          testId={`member-viewers-${user.id}`}
        />
      ) : null}
    </button>
  );
}
