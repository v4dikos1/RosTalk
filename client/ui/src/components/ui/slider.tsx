import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/** Range input with the ember accent. */
export const Slider = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    type="range"
    className={cn(
      "h-4 w-full cursor-pointer accent-accent",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
      className,
    )}
    {...props}
  />
));
Slider.displayName = "Slider";
