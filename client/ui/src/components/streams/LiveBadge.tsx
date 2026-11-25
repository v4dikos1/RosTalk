import { Cast } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

export interface LiveBadgeProps {
  /**
   * `full` is the stream tile and the channel header: icon and «В эфире».
   * `icon` is the channel tree and the member pane: the same outline, icon only.
   */
  variant?: "full" | "icon";
  /** On top of video: a dark plate and a fixed ember so it reads in both themes. */
  onMedia?: boolean;
  /** Number of streams, shown after the label (channel header). */
  count?: number;
  className?: string;
}

/**
 * The one stream badge of the client (stage P9, direction A+C): a warm ember
 * outline with the cast icon. It is deliberately not a red filled «LIVE» pill;
 * red stays for errors and mute.
 */
export function LiveBadge({
  variant = "full",
  onMedia = false,
  count,
  className,
}: LiveBadgeProps) {
  const { t } = useTranslation();
  const iconOnly = variant === "icon";
  const label = iconOnly ? t("users.streaming") : t("streams.live");
  return (
    <span
      data-testid={iconOnly ? "live-badge-icon" : "live-badge"}
      role={iconOnly ? "img" : undefined}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm border font-medium leading-none",
        iconOnly
          ? "h-[18px] w-[22px] justify-center"
          : "h-5 gap-1 px-1.5 text-[11px]",
        onMedia
          ? "border-[var(--media-ember-border)] bg-[var(--media-plate)] text-[var(--media-ember-ink)]"
          : "border-accent text-accent",
        className,
      )}
    >
      <Cast className={iconOnly ? "size-3" : "size-3.5"} aria-hidden />
      {iconOnly ? null : (
        <>
          <span>{label}</span>
          {count !== undefined ? (
            <span className="tabular-nums opacity-80">{count}</span>
          ) : null}
        </>
      )}
    </span>
  );
}
