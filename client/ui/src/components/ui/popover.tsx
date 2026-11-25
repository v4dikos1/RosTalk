import * as PopoverPrimitive from "@radix-ui/react-popover";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
} from "react";

import { cn } from "@/lib/utils";

/**
 * Floating panel anchored to a control (shadcn/ui on Radix Popover).
 *
 * The content is portalled to the body and positioned by Radix, so it is never
 * clipped by a scrolled or `overflow: hidden` parent (playtest-1, complaint 23).
 * Collision handling with the viewport edges is on by default; the available
 * height keeps a tall panel scrollable inside a 600 px window.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export const PopoverContent = forwardRef<
  ComponentRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(
  (
    {
      className,
      align = "start",
      side = "bottom",
      sideOffset = 6,
      collisionPadding = 8,
      ...props
    },
    ref,
  ) => (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "z-50 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-lg border border-border bg-raised text-foreground shadow-panel outline-none",
          "animate-fade-in",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  ),
);
PopoverContent.displayName = "PopoverContent";
