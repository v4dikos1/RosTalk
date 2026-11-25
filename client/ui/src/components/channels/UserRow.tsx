import { Volume1, VolumeX } from "lucide-react";
import type { DragEvent, MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { UserAvatar } from "@/components/common/UserAvatar";
import { StreamViewerCount } from "@/components/streams/StreamViewers";
import type { RoleView, UserView } from "@/core/api";
import { roleName, roleNameStyle } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { useVoiceStore, voiceLevelForUser } from "@/store/voiceStore";

import { UserStateIcons } from "./UserStateIcons";

export interface UserRowProps {
  user: UserView;
  isSelf: boolean;
  roles: RoleView[];
  /** Server identity: user ids are only unique per server. */
  serverId?: string | null;
  speaking?: boolean;
  localMuted?: boolean;
  localVolume?: number;
  /** Everyone watching this user's stream (stage P12). */
  viewers?: UserView[];
  /** Roving tabindex value; the tree owns keyboard focus. */
  tabIndex?: number;
  ariaLevel?: number;
  dataTreeKey?: string;
  onFocus?: (() => void) | undefined;
  onClick?: (() => void) | undefined;
  onContextMenu?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  /** Moderators can drag a person into another voice channel (stage 3.2). */
  draggable?: boolean;
  onDragStartUser?: ((event: DragEvent<HTMLElement>) => void) | undefined;
  onDragEndUser?: (() => void) | undefined;
}

/**
 * One person inside a channel. It is a `treeitem` itself, so the tree markup
 * stays valid: `role=tree > role=treeitem` without nested interactive groups
 * (stage 2.4 requirement 9).
 */
export function UserRow({
  user,
  isSelf,
  roles,
  serverId = null,
  speaking = false,
  localMuted = false,
  localVolume = 100,
  viewers = [],
  tabIndex = -1,
  ariaLevel = 2,
  dataTreeKey,
  onFocus,
  onClick,
  onContextMenu,
  draggable = false,
  onDragStartUser,
  onDragEndUser,
}: UserRowProps) {
  const { t } = useTranslation();
  const levels = useVoiceStore((voice) => voice.levels);
  const displayName = isSelf ? t("users.you") : user.nickname;
  const highestRole = roles
    .filter((role) => user.roleIds.includes(role.id))
    .sort((a, b) => b.position - a.position)[0];
  const showRole = highestRole !== undefined && highestRole.position > 1;
  const highestRoleLabel = roleName(highestRole, t);
  const measured = voiceLevelForUser(levels, user.id);
  const isSpeaking = speaking || (measured?.speaking ?? false);

  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={false}
      aria-level={ariaLevel}
      tabIndex={tabIndex}
      data-testid={`user-${user.id}`}
      data-tree-key={dataTreeKey}
      data-speaking={isSpeaking ? "true" : undefined}
      draggable={draggable}
      onDragStart={onDragStartUser}
      onDragEnd={onDragEndUser}
      onFocus={onFocus}
      onClick={onClick}
      onDoubleClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        "row-dense group flex w-full items-center gap-2 rounded-md pl-8 pr-2 text-left text-[13px] transition-colors duration-150",
        "hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
        user.voice.away ? "text-faint" : "text-muted",
        isSelf && "text-foreground",
        isSpeaking && "text-foreground",
      )}
    >
      <UserAvatar
        name={displayName}
        color={user.color}
        role={highestRoleLabel || undefined}
        serverId={serverId}
        userId={user.id}
        avatarHash={user.avatarHash}
        speaking={isSpeaking}
        size="sm"
      />
      <span
        className="min-w-0 truncate"
        style={showRole ? roleNameStyle(highestRole.color) : undefined}
      >
        {displayName}
      </span>
      {localMuted ? (
        <span
          role="img"
          aria-label={t("users.localMuted")}
          title={t("users.localMuted")}
          className="inline-flex shrink-0 text-danger"
        >
          <VolumeX className="size-3.5" aria-hidden />
        </span>
      ) : localVolume !== 100 ? (
        <span
          role="img"
          aria-label={t("users.localVolume", { volume: localVolume })}
          title={t("users.localVolume", { volume: localVolume })}
          className="inline-flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-faint"
        >
          <Volume1 className="size-3.5" aria-hidden />
          {localVolume}
        </span>
      ) : null}
      <span className="ml-auto pl-1">
        <UserStateIcons
          voice={user.voice}
          streaming={user.streaming}
          speaking={speaking}
        />
      </span>
      {user.streaming ? (
        <StreamViewerCount
          viewers={viewers}
          testId={`user-viewers-${user.id}`}
        />
      ) : null}
    </button>
  );
}
