import { forwardRef, type SelectHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/** Native select styled with the RosTalk tokens; keyboard behaviour comes free. */
export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "h-8 min-w-0 rounded-md border border-border bg-background px-2 text-[12px] text-foreground",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = "Select";
