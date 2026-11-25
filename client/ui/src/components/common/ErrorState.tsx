import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface ErrorStateProps {
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}

export function ErrorState({
  title,
  description,
  action,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-10 text-center animate-fade-in",
        className,
      )}
    >
      <span className="flex size-11 items-center justify-center rounded-full border border-danger/40 bg-danger/10 text-danger">
        <AlertTriangle className="size-5" aria-hidden />
      </span>
      <h3 className="mt-1 text-sm font-semibold text-foreground">{title}</h3>
      <p className="max-w-sm text-xs leading-relaxed text-muted">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
