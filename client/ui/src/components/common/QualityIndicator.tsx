import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { ConnectionQuality } from "@/lib/quality";

const bars: Record<ConnectionQuality, number> = {
  excellent: 3,
  good: 2,
  fair: 1,
  online: 0,
  offline: 0,
};

const qualityTone: Record<ConnectionQuality, string> = {
  excellent: "bg-success",
  good: "bg-success",
  fair: "bg-warning",
  online: "bg-success",
  offline: "bg-border-strong",
};

const heights = ["h-1.5", "h-2.5", "h-3.5"] as const;

/**
 * Connection indicator: three bars inside a voice channel, a dot when the
 * control connection is up but no media path exists, and empty bars offline.
 *
 * The label comes from the quality bucket, which in a call is derived from the
 * real ping/loss/jitter (stage 2.3.1); details on click arrive in stage 2.4.
 */
export function QualityIndicator({
  quality,
  className,
}: {
  quality: ConnectionQuality;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = t(`quality.${quality}`);
  const active = bars[quality];

  if (quality === "online") {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        data-testid="quality-indicator"
        data-quality={quality}
        className={cn("inline-flex items-center", className)}
      >
        <span aria-hidden className="size-1.5 rounded-full bg-success" />
      </span>
    );
  }

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="quality-indicator"
      data-quality={quality}
      className={cn("inline-flex items-end gap-[2px]", className)}
    >
      {heights.map((height, index) => (
        <span
          key={height}
          aria-hidden
          className={cn(
            "w-[3px] rounded-[1px]",
            height,
            index < active ? qualityTone[quality] : "bg-border-strong",
          )}
        />
      ))}
    </span>
  );
}
