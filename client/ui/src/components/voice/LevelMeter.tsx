import { cn } from "@/lib/utils";

/** Maps dBFS to a 0..1 fraction of the visible meter (-60..0 dB). */
function fraction(db: number): number {
  const clamped = Math.max(-60, Math.min(0, db));
  return (clamped + 60) / 60;
}

/**
 * Microphone level meter with the activation threshold. Speaking is measured
 * by the client, never taken from the control plane (design 4.6).
 */
export function LevelMeter({
  levelDb,
  thresholdDb = null,
  active = false,
  label,
  className,
}: {
  levelDb: number;
  thresholdDb?: number | null;
  active?: boolean;
  label: string;
  className?: string;
}) {
  const level = fraction(levelDb);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={-60}
      aria-valuemax={0}
      aria-valuenow={Math.round(Math.max(-60, Math.min(0, levelDb)))}
      className={cn(
        "relative h-2.5 overflow-hidden rounded-full bg-active",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-full origin-left rounded-full transition-transform duration-100",
          active ? "bg-accent" : "bg-accent/55",
        )}
        style={{ transform: `scaleX(${level.toFixed(4)})` }}
      />
      {thresholdDb !== null ? (
        <span
          aria-hidden
          data-testid="threshold-marker"
          className="absolute inset-y-0 w-px bg-foreground/70"
          style={{ left: `${(fraction(thresholdDb) * 100).toFixed(2)}%` }}
        />
      ) : null}
    </div>
  );
}
