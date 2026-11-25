import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

/** Compact two-to-four-way switch used across the settings window. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex h-8 items-center gap-0.5 rounded-md border border-border bg-background p-0.5"
    >
      {options.map((option) => {
        const Icon = option.icon;
        const selected = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex h-6 items-center gap-1 rounded-sm px-2 text-[12px] font-medium",
              selected
                ? "bg-active text-foreground"
                : "text-muted hover:text-foreground",
            )}
          >
            {Icon ? (
              <Icon
                className={cn(
                  "size-3.5",
                  selected ? "text-accent" : "text-faint",
                )}
                aria-hidden
              />
            ) : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
