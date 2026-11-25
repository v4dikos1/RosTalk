import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-transform duration-150 active:scale-[0.98] disabled:cursor-not-allowed [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-transparent bg-accent text-accent-foreground hover:bg-accent-strong disabled:border-border disabled:bg-active disabled:text-faint disabled:opacity-100",
        secondary:
          "border border-border bg-raised text-foreground hover:bg-hover disabled:opacity-60",
        ghost:
          "text-muted hover:bg-hover hover:text-foreground disabled:opacity-45",
        outline:
          "border border-border-strong bg-transparent text-foreground hover:bg-hover disabled:opacity-60",
        danger:
          "border border-transparent bg-danger text-danger-foreground hover:opacity-90 disabled:border-border disabled:bg-active disabled:text-faint disabled:opacity-100",
        link: "text-accent underline-offset-4 hover:underline disabled:opacity-45",
      },
      size: {
        default: "h-8 px-3 text-[13px]",
        sm: "h-7 px-2.5 text-xs",
        xs: "h-6 px-2 text-[11px]",
        lg: "h-9 px-4 text-sm",
        icon: "size-8",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonProps = ComponentPropsWithoutRef<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : (type ?? "button")}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
