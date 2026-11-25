import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

export function Input({
  className,
  type = "text",
  ...props
}: ComponentPropsWithoutRef<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "h-8 w-full rounded-md border border-border bg-background px-2.5 text-[13px] text-foreground placeholder:text-faint",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
        className,
      )}
      {...props}
    />
  );
}
