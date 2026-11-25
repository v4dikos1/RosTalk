import { Hash, Volume2, X } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { UserStateIcons } from "@/components/channels/UserStateIcons";
import { PresenceDot } from "@/components/common/PresenceDot";
import { UserAvatar } from "@/components/common/UserAvatar";
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
  onUserMenu: (user: UserView, position: { x: number; y: number }) => void;
}

/**
 * Right-hand member pane (stage P8).
 *
 * Above: the people in the open voice channel with speaking, microphone,
 * sound, stream and role state. Below: everyone else online on the server,
 * grouped by channel. A click opens the same user menu as the tree rows.
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
}: MembersPaneProps) {
  const { t } = useTranslation();

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

  function openMenu(user: UserView, event: React.MouseEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    onUserMenu(user, {
      x: event.clientX || rect.left,
      y: event.clientY || rect.bottom,
    });
  }

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
                      onOpen={(event) => openMenu(user, event)}
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
                          onOpen={(event) => openMenu(user, event)}
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
  onOpen,
}: {
  user: UserView;
  isSelf: boolean;
  roles: RoleView[];
  serverId: string | null;
  speaking: boolean;
  online: boolean;
  viewers?: UserView[];
  compact?: boolean;
  onOpen: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useTranslation();
  const highestRole = roles
    .filter((role) => user.roleIds.includes(role.id))
    .sort((a, b) => b.position - a.position)[0];
  const showRole = highestRole !== undefined && highestRole.position > 1;
  const roleLabel = roleName(highestRole, t);
  const displayName = isSelf ? t("users.you") : user.nickname;

  return (
    <button
      type="button"
      onClick={onOpen}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpen(event);
      }}
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
