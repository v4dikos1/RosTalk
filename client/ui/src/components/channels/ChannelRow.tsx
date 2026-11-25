import { ChevronRight, Hash, Lock, LogIn, MoonStar, Volume2 } from "lucide-react";
import type { DragEvent } from "react";
import { useTranslation } from "react-i18next";

import type { ChannelView } from "@/core/api";
import { cn } from "@/lib/utils";

export interface ChannelRowProps {
  channel: ChannelView;
  depth: number;
  selected: boolean;
  connected: boolean;
  hasChildren: boolean;
  expanded: boolean;
  userCount: number;
  /** Unread messages above the read marker (stage 4.1). */
  unread?: number;
  /** Unread messages that mention the caller. */
  mentions?: number;
  tabIndex?: number;
  ariaLevel?: number;
  dataTreeKey?: string;
  onClick: () => void;
  onJoin?: (() => void) | undefined;
  onToggle?: (() => void) | undefined;
  onFocus?: (() => void) | undefined;
  /** First top-level row of another group: a little air above it. */
  groupStart?: boolean;
  /** A person is dragged over this row (stage 3.2 move moderation). */
  dropActive?: boolean;
  onDragOverRow?: ((event: DragEvent<HTMLElement>) => void) | undefined;
  onDropRow?: ((event: DragEvent<HTMLElement>) => void) | undefined;
}

/**
 * One channel row. It is the `treeitem`: the expand chevron is a span inside
 * the button, not a nested button, so the markup is valid and the tree handles
 * ArrowLeft/ArrowRight itself.
 */
export function ChannelRow({
  channel,
  depth,
  selected,
  connected,
  hasChildren,
  expanded,
  userCount,
  unread = 0,
  mentions = 0,
  tabIndex = -1,
  ariaLevel = 1,
  dataTreeKey,
  onClick,
  onJoin,
  onToggle,
  onFocus,
  groupStart = false,
  dropActive = false,
  onDragOverRow,
  onDropRow,
}: ChannelRowProps) {
  const { t } = useTranslation();
  const Icon = channel.kind === "text" ? Hash : Volume2;
  const canJoin = channel.kind === "voice" && onJoin !== undefined;

  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={selected}
      aria-level={ariaLevel}
      aria-expanded={hasChildren ? expanded : undefined}
      tabIndex={tabIndex}
      data-testid={`channel-${channel.id}`}
      data-channel-id={channel.id}
      data-kind={channel.kind}
      data-tree-key={dataTreeKey}
      data-group-start={groupStart ? "true" : undefined}
      title={
        channel.kind === "voice"
          ? [channel.topic, t("channel.doubleClickJoin")]
              .filter(Boolean)
              .join(" · ")
          : channel.topic || undefined
      }
      onFocus={onFocus}
      onDragOver={onDragOverRow}
      onDrop={onDropRow}
      onClick={onClick}
      onDoubleClick={() => {
        if (canJoin) {
          onJoin?.();
        }
      }}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
      className={cn(
        "row-dense group flex w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] transition-colors duration-150",
        groupStart && "mt-1.5",
        "hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
        selected
          ? "bg-active text-foreground"
          : "text-muted",
        dropActive && "ring-1 ring-accent",
      )}
    >
      <span
        aria-hidden
        data-testid={`channel-toggle-${channel.id}`}
        onClick={(event) => {
          if (hasChildren && onToggle) {
            event.stopPropagation();
            onToggle();
          }
        }}
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-sm",
          hasChildren ? "hover:bg-hover" : "opacity-0",
        )}
      >
        <ChevronRight
          className={cn(
            "size-3.5 transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
      </span>
      <Icon
        className={cn(
          "size-4 shrink-0",
          selected ? "text-accent" : "text-faint",
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{channel.name}</span>
      {canJoin && !connected ? (
        <span
          aria-hidden
          data-testid={`channel-join-${channel.id}`}
          title={t("channel.doubleClickJoin")}
          onClick={(event) => {
            event.stopPropagation();
            onJoin?.();
          }}
          className="flex size-4 shrink-0 items-center justify-center rounded-sm text-faint opacity-0 hover:bg-hover hover:text-accent group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <LogIn className="size-3.5" />
        </span>
      ) : null}
      {mentions > 0 ? (
        <span
          className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1.5 text-[10px] font-semibold leading-none tabular-nums text-danger-foreground"
          aria-label={t("tree.mentions", { count: mentions })}
          data-testid={`channel-mentions-${channel.id}`}
        >
          {mentions > 99 ? "99+" : mentions}
        </span>
      ) : unread > 0 ? (
        <span
          className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-none tabular-nums text-accent-foreground"
          aria-label={t("tree.unread", { count: unread })}
          data-testid={`channel-unread-${channel.id}`}
        >
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
      {channel.afk ? (
        <MoonStar
          className="size-3 shrink-0 text-faint"
          aria-label={t("tree.idle")}
        />
      ) : null}
      {connected ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-accent"
          aria-label={t("tree.connectedHere")}
          title={t("tree.connectedHere")}
        />
      ) : null}
      {userCount > 0 ? (
        <span className="shrink-0 text-[11px] tabular-nums text-faint">
          {userCount}
        </span>
      ) : null}
      {channel.passwordProtected ? (
        <Lock
          className="size-3 shrink-0 text-faint"
          aria-label={t("tree.locked")}
        />
      ) : null}
      {channel.temporary ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-warning"
          aria-label={t("tree.temporary")}
          title={t("tree.temporary")}
        />
      ) : null}
    </button>
  );
}
