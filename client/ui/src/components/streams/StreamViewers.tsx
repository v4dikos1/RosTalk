import { Eye } from "lucide-react";
import { useTranslation } from "react-i18next";

import { UserAvatar } from "@/components/common/UserAvatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { UserView } from "@/core/api";
import { cn } from "@/lib/utils";

/** How many avatars a tile shows before the "+N" chip takes over. */
const STACK_SIZE = 3;

export interface StreamViewersProps {
  /** Everyone watching the stream, already filtered and sorted. */
  viewers: UserView[];
  /** Server identity for the avatar palette. */
  serverId: string | null;
  /** `light` sits on the dark player chrome of a tile. */
  tone?: "light" | "default";
  className?: string;
  testId?: string;
}

/**
 * Audience of one stream (stage P12): a stack of avatars, "Watching: N" and the
 * full list on hover.
 *
 * Rendering nothing at zero keeps the tiles clean: an empty stream has no
 * audience badge, not a "0".
 */
export function StreamViewers({
  viewers,
  serverId,
  tone = "light",
  className,
  testId = "stream-viewers",
}: StreamViewersProps) {
  const { t } = useTranslation();
  if (viewers.length === 0) {
    return null;
  }
  const shown = viewers.slice(0, STACK_SIZE);
  const hidden = viewers.length - shown.length;
  const names = viewers.map((user) => user.nickname).join(", ");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid={testId}
          data-count={viewers.length}
          aria-label={t("streams.viewers", { count: viewers.length })}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[10px] leading-none",
            tone === "light" ? "bg-black/55 text-white/85" : "bg-hover text-muted",
            className,
          )}
        >
          <span className="flex items-center -space-x-1" aria-hidden>
            {shown.map((user) => (
              <span key={user.id} className="rounded-lg ring-2 ring-black/45">
                <UserAvatar
                  name={user.nickname}
                  color={user.color}
                  serverId={serverId}
                  userId={user.id}
                  avatarHash={user.avatarHash}
                  size="sm"
                />
              </span>
            ))}
            {hidden > 0 ? (
              <span
                data-testid={`${testId}-more`}
                className="flex size-5 items-center justify-center rounded-lg bg-white/20 text-[10px] font-semibold text-white"
              >
                +{hidden}
              </span>
            ) : null}
          </span>
          <span className="hidden tabular-nums sm:inline">
            {t("streams.viewing", { count: viewers.length })}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent data-testid={`${testId}-list`}>
        <p className="mb-1 font-medium">
          {t("streams.viewerNames", { names })}
        </p>
        <ul className="space-y-0.5">
          {viewers.map((user) => (
            <li key={user.id} className="truncate">
              {user.nickname}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Compact "eye + N" chip for the channel tree and the member pane, where a
 * stack of avatars would not fit. The names are in the native tooltip.
 */
export function StreamViewerCount({
  viewers,
  className,
  testId = "stream-viewer-count",
}: {
  viewers: UserView[];
  className?: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  if (viewers.length === 0) {
    return null;
  }
  const names = viewers.map((user) => user.nickname).join(", ");
  return (
    <span
      data-testid={testId}
      data-count={viewers.length}
      role="img"
      aria-label={t("streams.viewers", { count: viewers.length })}
      title={t("streams.viewerNames", { names })}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-faint",
        className,
      )}
    >
      <Eye className="size-3" aria-hidden />
      {viewers.length}
    </span>
  );
}
