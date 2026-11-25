import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import type { ChannelView, RoleView, UnreadView, UserView } from "@/core/api";
import { participantKey, participantPreference } from "@/lib/settings";
import { streamViewers } from "@/lib/streamViewers";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/store/settingsStore";

import { ChannelRow } from "./ChannelRow";
import { UserRow } from "./UserRow";

export interface ChannelTreeProps {
  channels: ChannelView[];
  users: UserView[];
  roles: RoleView[];
  selfUserId: number;
  selectedChannelId: number | null;
  /** Unread counters of visible channels. */
  unread?: UnreadView[];
  onSelectChannel: (channelId: number | null) => void;
  onJoinChannel?: (channel: ChannelView) => void;
  /** A click on a live user opens their screen instead of the member list. */
  onWatchStream?: (userId: number) => void;
  /** Users currently talking, measured by the audio engine. */
  speakingUserIds?: ReadonlySet<number>;
  onUserContextMenu?: (
    user: UserView,
    position: { x: number; y: number },
  ) => void;
  /** Server identity used for per-user preferences. */
  serverId?: string | null;
  /** Dragging a person into another channel is server moderation (3.2). */
  canMoveMembers?: boolean;
  onMoveUser?: (userId: number, channelId: number) => void;
  className?: string;
}

interface ChannelRowModel {
  key: string;
  interactive: true;
  kind: "channel";
  channel: ChannelView;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  userCount: number;
}

interface UserRowModel {
  key: string;
  interactive: true;
  kind: "user";
  user: UserView;
  depth: number;
}

interface EmptyRowModel {
  key: string;
  interactive: false;
  kind: "empty";
  depth: number;
}

type RowModel = ChannelRowModel | UserRowModel | EmptyRowModel;

function ordered(channels: ChannelView[]): ChannelView[] {
  return channels
    .slice()
    .sort(
      (a, b) =>
        a.position - b.position ||
        a.name.localeCompare(b.name) ||
        a.id - b.id,
    );
}

/**
 * Channel tree from design 5.4.
 *
 * Markup is a flat ARIA tree: every channel and every person is a `treeitem`
 * button under one `role=tree` container, with `aria-level`. Nested
 * interactive groups would be invalid, and a flat tree keeps roving focus
 * simple (stage 2.4 requirement 9).
 */
export function ChannelTree({
  channels,
  users,
  roles,
  selfUserId,
  selectedChannelId,
  unread = [],
  onSelectChannel,
  onJoinChannel,
  onWatchStream,
  speakingUserIds,
  onUserContextMenu,
  serverId = null,
  canMoveMembers = false,
  onMoveUser,
  className,
}: ChannelTreeProps) {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const treeRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [draggingUser, setDraggingUser] = useState<number | null>(null);
  const [dropChannel, setDropChannel] = useState<number | null>(null);

  const unreadByChannel = useMemo(() => {
    const map = new Map<number, { unread: number; mentions: number }>();
    for (const counter of unread) {
      if (counter.channelId !== 0) {
        map.set(counter.channelId, {
          unread: counter.unread,
          mentions: counter.mentions,
        });
      }
    }
    return map;
  }, [unread]);

  const rows = useMemo<RowModel[]>(() => {
    const byParent = new Map<number, ChannelView[]>();
    const ids = new Set(channels.map((channel) => channel.id));
    for (const channel of ordered(channels)) {
      const parent =
        channel.parentId !== 0 && ids.has(channel.parentId)
          ? channel.parentId
          : 0;
      const list = byParent.get(parent) ?? [];
      list.push(channel);
      byParent.set(parent, list);
    }

    const result: RowModel[] = [];
    const seen = new Set<number>();
    function walk(parentId: number, depth: number) {
      for (const channel of byParent.get(parentId) ?? []) {
        if (seen.has(channel.id)) {
          continue; // A malformed parent loop must not hang the UI.
        }
        seen.add(channel.id);
        const children = byParent.get(channel.id) ?? [];
        const members = users
          .filter((user) => user.channelId === channel.id)
          .sort((a, b) => {
            if (a.id === selfUserId) return -1;
            if (b.id === selfUserId) return 1;
            return a.nickname.localeCompare(b.nickname) || a.id - b.id;
          });
        const expanded = !collapsed.has(channel.id) || children.length === 0;
        result.push({
          key: `channel:${channel.id}`,
          interactive: true,
          kind: "channel",
          channel,
          depth,
          hasChildren: children.length > 0,
          expanded,
          userCount: members.length,
        });
        if (expanded) {
          for (const user of members) {
            result.push({
              key: `user:${user.id}`,
              interactive: true,
              kind: "user",
              user,
              depth: depth + 1,
            });
          }
          if (members.length === 0 && channel.kind === "voice" && children.length === 0) {
            result.push({
              key: `empty:${channel.id}`,
              interactive: false,
              kind: "empty",
              depth: depth + 1,
            });
          }
          walk(channel.id, depth + 1);
        }
      }
    }
    walk(0, 1);
    return result;
  }, [channels, users, collapsed, selfUserId]);

  const items = useMemo(
    () => rows.filter((row): row is ChannelRowModel | UserRowModel => row.interactive),
    [rows],
  );
  const selectedKey =
    selectedChannelId !== null ? `channel:${selectedChannelId}` : null;
  const effectiveFocus = useMemo(() => {
    if (focusKey && items.some((row) => row.key === focusKey)) {
      return focusKey;
    }
    if (selectedKey && items.some((row) => row.key === selectedKey)) {
      return selectedKey;
    }
    return items[0]?.key ?? null;
  }, [focusKey, items, selectedKey]);

  function focusRow(key: string) {
    setFocusKey(key);
    const node = treeRef.current?.querySelector<HTMLElement>(
      `[data-tree-key="${key}"]`,
    );
    node?.focus();
  }

  function activate(row: ChannelRowModel | UserRowModel) {
    if (row.kind === "channel") {
      onSelectChannel(row.channel.id);
      if (row.channel.kind === "voice" && onJoinChannel) {
        onJoinChannel(row.channel);
      }
    } else if (row.user.streaming && onWatchStream) {
      onWatchStream(row.user.id);
    } else {
      onSelectChannel(row.user.channelId);
    }
  }

  function toggle(channelId: number) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(channelId)) {
        next.delete(channelId);
      } else {
        next.add(channelId);
      }
      return next;
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const active = document.activeElement;
    const index = items.findIndex((row) => {
      const node = treeRef.current?.querySelector<HTMLElement>(
        `[data-tree-key="${row.key}"]`,
      );
      return node === active;
    });
    if (index === -1) {
      return;
    }
    const row = items[index];
    if (!row) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(items[Math.min(items.length - 1, index + 1)]?.key ?? row.key);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(items[Math.max(0, index - 1)]?.key ?? row.key);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusRow(items[0]?.key ?? row.key);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusRow(items[items.length - 1]?.key ?? row.key);
      return;
    }
    if (row.kind === "channel" && event.key === "ArrowRight") {
      event.preventDefault();
      if (row.hasChildren && !row.expanded) {
        toggle(row.channel.id);
      } else if (row.hasChildren) {
        const next = items[index + 1];
        if (next) {
          focusRow(next.key);
        }
      }
      return;
    }
    if (row.kind === "channel" && event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.hasChildren && row.expanded) {
        toggle(row.channel.id);
      } else {
        // Focus the nearest parent channel row above.
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
          const candidate = items[cursor];
          if (candidate?.kind === "channel" && candidate.depth < row.depth) {
            focusRow(candidate.key);
            break;
          }
        }
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(row);
    }
    if (
      row.kind === "user" &&
      (event.key === "ContextMenu" ||
        (event.shiftKey && event.key === "F10")) &&
      onUserContextMenu
    ) {
      event.preventDefault();
      const node = treeRef.current?.querySelector<HTMLElement>(
        `[data-tree-key="${row.key}"]`,
      );
      const rect = node?.getBoundingClientRect();
      onUserContextMenu(row.user, {
        x: rect?.left ?? 0,
        y: rect?.bottom ?? 0,
      });
    }
  }

  if (rows.length === 0) {
    return (
      <nav aria-label={t("tree.label")} className={cn("min-h-0", className)}>
        <div role="tree" aria-label={t("tree.label")}>
          <p className="px-2 py-3 text-[12px] text-faint">
            {t("tree.noChannels")}
          </p>
        </div>
      </nav>
    );
  }

  return (
    <nav aria-label={t("tree.label")} className={cn("min-h-0", className)}>
      <div
        ref={treeRef}
        role="tree"
        aria-label={t("tree.label")}
        onKeyDown={onKeyDown}
        data-testid="channel-tree"
        className="space-y-px"
      >
        {rows.map((row, rowIndex) => {
          if (row.kind === "empty") {
            return (
              <div
                key={row.key}
                role="none"
                className="row-dense flex items-center text-[12px] italic text-faint"
                style={{ paddingLeft: `${26 + row.depth * 12}px` }}
              >
                {t("tree.empty")}
              </div>
            );
          }
          if (row.kind === "channel") {
            return (
              <ChannelRow
                key={row.key}
                channel={row.channel}
                depth={row.depth - 1}
                selected={row.channel.id === selectedChannelId}
                connected={
                  users.find((user) => user.id === selfUserId)?.channelId ===
                  row.channel.id
                }
                hasChildren={row.hasChildren}
                expanded={row.expanded}
                userCount={row.userCount}
                unread={unreadByChannel.get(row.channel.id)?.unread ?? 0}
                mentions={unreadByChannel.get(row.channel.id)?.mentions ?? 0}
                groupStart={rowIndex > 0 && row.depth === 1}
                tabIndex={effectiveFocus === row.key ? 0 : -1}
                ariaLevel={row.depth}
                dataTreeKey={row.key}
                onFocus={() => setFocusKey(row.key)}
                onClick={() => {
                  setFocusKey(row.key);
                  onSelectChannel(row.channel.id);
                }}
                onJoin={
                  onJoinChannel
                    ? () => {
                        setFocusKey(row.key);
                        onJoinChannel(row.channel);
                      }
                    : undefined
                }
                onToggle={
                  row.hasChildren ? () => toggle(row.channel.id) : undefined
                }
                dropActive={
                  draggingUser !== null &&
                  dropChannel === row.channel.id &&
                  row.channel.kind === "voice"
                }
                onDragOverRow={
                  canMoveMembers && draggingUser !== null && row.channel.kind === "voice"
                    ? (event) => {
                        event.preventDefault();
                        setDropChannel(row.channel.id);
                      }
                    : undefined
                }
                onDropRow={
                  canMoveMembers && row.channel.kind === "voice"
                    ? (event) => {
                        event.preventDefault();
                        const raw = event.dataTransfer.getData("text/plain");
                        const userId = Number(raw.replace(/^rostalk-user:/, ""));
                        if (Number.isFinite(userId) && userId > 0 && onMoveUser) {
                          onMoveUser(userId, row.channel.id);
                        }
                        setDraggingUser(null);
                        setDropChannel(null);
                      }
                    : undefined
                }
              />
            );
          }
          const preference = participantPreference(
            settings,
            participantKey(serverId, row.user.id),
          );
          return (
            <UserRow
              key={row.key}
              user={row.user}
              isSelf={row.user.id === selfUserId}
              roles={roles}
              serverId={serverId}
              speaking={speakingUserIds?.has(row.user.id) ?? false}
              localMuted={preference.muted}
              localVolume={preference.volume}
              viewers={
                row.user.streaming ? streamViewers(users, row.user.id) : []
              }
              tabIndex={effectiveFocus === row.key ? 0 : -1}
              ariaLevel={row.depth}
              dataTreeKey={row.key}
              onFocus={() => setFocusKey(row.key)}
              onClick={() => {
                setFocusKey(row.key);
                onSelectChannel(row.user.channelId);
              }}
              draggable={canMoveMembers && row.user.id !== selfUserId}
              onDragStartUser={
                canMoveMembers && row.user.id !== selfUserId
                  ? (event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(
                        "text/plain",
                        `rostalk-user:${row.user.id}`,
                      );
                      setDraggingUser(row.user.id);
                    }
                  : undefined
              }
              onDragEndUser={() => {
                setDraggingUser(null);
                setDropChannel(null);
              }}
              onContextMenu={
                onUserContextMenu
                  ? (event) => {
                      event.preventDefault();
                      setFocusKey(row.key);
                      const rect = event.currentTarget.getBoundingClientRect();
                      onUserContextMenu(row.user, {
                        x: event.clientX || rect.left,
                        y: event.clientY || rect.bottom,
                      });
                    }
                  : undefined
              }
            />
          );
        })}
      </div>
    </nav>
  );
}
