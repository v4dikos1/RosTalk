import { Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { CoreError } from "@/core/api";
import { asCoreError, coreErrorText } from "@/lib/coreError";
import { sendAdmin } from "@/lib/admin";
import type { AdminAction, AdminResult } from "@/proto/rostalk/v1/admin_pb";
import { cn } from "@/lib/utils";

export function AdminCard({
  title,
  hint,
  actions,
  children,
  className,
}: {
  title?: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-md border border-border bg-raised/40 p-3", className)}>
      {title || actions ? (
        <header className="mb-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? (
              <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
            ) : null}
            {hint ? <p className="mt-0.5 text-[11px] leading-snug text-faint">{hint}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function AdminField({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block space-y-1", className)}>
      <span className="block text-[11px] font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="block text-[10px] leading-snug text-faint">{hint}</span> : null}
    </label>
  );
}

export function useAdminAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<CoreError | null>(null);

  async function run(action: AdminAction): Promise<AdminResult | null> {
    if (pending) {
      return null;
    }
    setPending(true);
    setError(null);
    try {
      return await sendAdmin(action);
    } catch (reason) {
      setError(asCoreError(reason));
      return null;
    } finally {
      setPending(false);
    }
  }

  return { run, pending, error, clearError: () => setError(null) };
}

export function AdminErrorNotice({ error }: { error: CoreError | null }) {
  const { t } = useTranslation();
  if (!error) {
    return null;
  }
  const text = coreErrorText(error);
  return (
    <p role="alert" className="text-[11px] text-danger" title={text.detail}>
      {t(text.key)}
    </p>
  );
}

export function AdminPending({ pending }: { pending: boolean }) {
  if (!pending) {
    return null;
  }
  return <Loader2 className="size-3.5 animate-spin text-muted" aria-hidden />;
}

export function AdminEmpty({ children }: { children: ReactNode }) {
  return <p className="py-3 text-center text-[11px] text-faint">{children}</p>;
}

/** Copies text inside the WebView; never sends it over the network. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (ok) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }
        });
      }}
      aria-label={label ?? t("admin.common.copy")}
    >
      {copied ? t("admin.common.copied") : t("admin.common.copy")}
    </Button>
  );
}
