import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

export interface PresenceDotProps {
  /** The person is online on this server right now. */
  online: boolean;
  className?: string;
}

/**
 * Small presence dot drawn on an avatar.
 *
 * Presence is green/grey from the theme tokens, so it cannot be mistaken for
 * the accent-coloured unread badge (playtest-1, complaint 16). Unread stays a
 * number in a badge; this dot never carries a count.
 */
export function PresenceDot({ online, className }: PresenceDotProps) {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={online ? t("users.online") : t("users.offline")}
      title={online ? t("users.online") : t("users.offline")}
      data-presence={online ? "online" : "offline"}
      className={cn(
        "pointer-events-none absolute -bottom-px -right-px size-2 rounded-full ring-2 ring-surface",
        online ? "bg-success" : "bg-border-strong",
        className,
      )}
    />
  );
}
