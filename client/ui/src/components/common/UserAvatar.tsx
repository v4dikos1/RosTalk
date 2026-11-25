import { useTranslation } from "react-i18next";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { avatarColors } from "@/lib/avatar";
import { avatarUrl } from "@/lib/avatars";
import { cn, initials } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";

export interface UserAvatarProps {
  name: string;
  /**
   * `#rrggbb` from the user's highest coloured role. Since stage P9 the role
   * colour lives in the name; here it only fills an avatar without a user id.
   */
  color?: string | null;
  /** Optional role name for the tooltip. */
  role?: string | undefined;
  /** Speaking is measured locally in stage 2.3; stage 2.2 never fakes it. */
  speaking?: boolean | undefined;
  /** Server identity: user ids are only unique per server. */
  serverId?: string | null | undefined;
  /** Stable seed of the palette. Without it the role colour is the fill. */
  userId?: number | undefined;
  /** SHA-256 of the uploaded picture; empty means initials (stage P11). */
  avatarHash?: string | null | undefined;
  /** `chat` follows the theme token `--chat-avatar` (36 px dark, 40 px light). */
  size?: "sm" | "md" | "lg" | "xl" | "chat";
}

const sizeClass = {
  sm: "size-5 text-[8px]",
  md: "size-7 text-[10px]",
  lg: "size-10 text-sm",
  xl: "size-24 text-2xl",
  chat: "size-[var(--chat-avatar)] text-[12px]",
} as const;

/**
 * Round avatar: the uploaded picture when there is one, otherwise a
 * deterministic fill from `serverId:userId`. The ring belongs to speaking
 * alone (an ember ring with a gap that shows the panel behind it); the role
 * colour is drawn in the name next to the avatar (stage P9). A failed picture
 * request falls back to the initials, so a reset avatar is never empty.
 */
export function UserAvatar({
  name,
  color,
  role,
  speaking = false,
  serverId,
  userId,
  avatarHash,
  size = "md",
}: UserAvatarProps) {
  const { t } = useTranslation();
  const proxy = useChatStore((store) => store.proxy);
  const palette = userId === undefined ? null : avatarColors(serverId, userId);
  const fill = palette?.background ?? (color ? `${color}24` : "var(--accent)");
  const ink = palette?.foreground ?? color ?? "var(--accent-foreground)";
  const source = proxy && avatarHash ? avatarUrl(proxy, avatarHash) : "";

  return (
    <Avatar
      className={cn(
        sizeClass[size],
        "rounded-full",
        speaking && "ring-2 ring-accent ring-offset-2 ring-offset-transparent",
      )}
      data-avatar-hash={avatarHash || undefined}
    >
      {source ? (
        <AvatarImage
          src={source}
          alt=""
          className="rounded-[inherit]"
          data-testid="avatar-image"
        />
      ) : null}
      <AvatarFallback
        className="rounded-[inherit] font-semibold"
        style={{ backgroundColor: fill, color: ink }}
        title={role ? t("users.role", { role }) : undefined}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
