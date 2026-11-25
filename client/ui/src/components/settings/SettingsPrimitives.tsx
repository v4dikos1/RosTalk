import type { ReactNode } from "react";

/** A labelled setting row shared by every settings section. */
export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-2">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-foreground">{label}</p>
        {hint ? <p className="text-[11px] text-muted">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Small sentence-case heading of a settings group. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-1 mt-3 text-[11px] font-medium text-faint first:mt-0">
      {children}
    </h3>
  );
}
