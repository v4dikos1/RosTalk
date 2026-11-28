import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type { UserView } from "@/core/api";
import { avatarColors } from "@/lib/avatar";
import { AVATAR_SIZE, avatarUrl } from "@/lib/avatars";
import { initials } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";

export interface AvatarViewerDialogProps {
  user: UserView | null;
  open: boolean;
  /**
   * Identifier of one opening. A picture that failed in a previous opening is
   * retried when the same URL is opened again.
   */
  attempt: number;
  onOpenChange: (open: boolean) => void;
  /** Server identity for the fallback palette. */
  serverId: string | null;
  onOpenTree?: (() => void) | undefined;
}

/**
 * Read-only large avatar viewer (stage P27).
 *
 * The server keeps one 256x256 picture per user (ADR 0032), so this is the
 * largest version that exists; the dialog never upscales it beyond its stored
 * size. The picture comes from the same content-addressed proxy URL the small
 * avatar uses, so a change of the hash while the dialog is open swaps the
 * image without a new route. A user without a picture, or a failed read, sees
 * the initials and a plain explanation instead of an empty box.
 */
export function AvatarViewerDialog({
  user,
  open,
  attempt,
  onOpenChange,
  serverId,
  onOpenTree,
}: AvatarViewerDialogProps) {
  const { t } = useTranslation();
  const proxy = useChatStore((store) => store.proxy);
  // The failure belongs to one URL and one opening. A new hash or proxy is a
  // new URL, and a new opening is a new attempt, so neither a changed picture
  // nor a retry after a temporary error stays hidden by an old failure.
  const [failure, setFailure] = useState<{
    source: string;
    attempt: number;
  } | null>(null);
  const hash = user?.avatarHash ?? "";
  const source = proxy && hash ? avatarUrl(proxy, hash) : "";
  const name = user?.nickname ?? "";
  const failed =
    source !== "" &&
    failure?.source === source &&
    failure.attempt === attempt;

  const palette =
    user === null ? null : avatarColors(serverId, user.id);
  const fill = palette?.background ?? "var(--accent)";
  const ink = palette?.foreground ?? "var(--accent-foreground)";
  const showPicture = source !== "" && !failed;
  const state = !hash
    ? t("avatar.viewer.missing")
    : !showPicture
      ? t("avatar.viewer.unavailable")
      : t("avatar.viewer.savedSize", { size: AVATAR_SIZE });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(380px,92vw)]"
        data-testid="avatar-viewer"
      >
        <div className="border-b border-border px-4 py-3 pr-10">
          <DialogTitle className="truncate text-[13px] font-semibold text-foreground">
            {t("avatar.viewer.title", { name })}
          </DialogTitle>
          <DialogDescription
            data-testid="avatar-viewer-state"
            className="text-[11px] text-faint"
          >
            {state}
          </DialogDescription>
        </div>
        <div className="flex min-h-[280px] items-center justify-center p-4">
          {showPicture ? (
            <img
              src={source}
              alt={t("avatar.viewer.imageAlt", { name })}
              width={AVATAR_SIZE}
              height={AVATAR_SIZE}
              draggable={false}
              data-testid="avatar-viewer-image"
              className="rounded-lg bg-background object-contain"
              onError={() => setFailure({ source, attempt })}
            />
          ) : (
            <Avatar
              className="size-40 rounded-lg"
              data-testid="avatar-viewer-fallback"
            >
              <span
                className="flex size-full items-center justify-center rounded-[inherit] text-4xl font-semibold"
                style={{ backgroundColor: fill, color: ink }}
              >
                {initials(name)}
              </span>
            </Avatar>
          )}
        </div>
        {onOpenTree && <div className="p-4"><Button onClick={onOpenTree}>{t("newYearShell.tree")}</Button></div>}
      </DialogContent>
    </Dialog>
  );
}
