import { Copy, Loader2, UserPlus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { copyText } from "@/components/admin/AdminCommon";
import type { CoreError } from "@/core/api";
import { inviteCreate, resultInvite, sendAdmin } from "@/lib/admin";
import { asCoreError, coreErrorText } from "@/lib/coreError";
import { hasPermission } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { useCoreStore } from "@/store/coreStore";

/**
 * The invite form shared by the sidebar popover and the server-menu dialog.
 * Creation goes through the same admin action as the settings screen, so the
 * server writes its audit entry.
 */
export function InviteForm({ showHint = true }: { showHint?: boolean } = {}) {
  const { t } = useTranslation();
  const permissions = useCoreStore(
    (store) => store.state?.permissions?.server ?? [],
  );
  const connected = useCoreStore(
    (store) => store.state?.connection === "connected",
  );
  const allowed = hasPermission(permissions, "manageInvites");
  const [maxUses, setMaxUses] = useState(5);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<CoreError | null>(null);

  async function create() {
    if (busy || !allowed) {
      return;
    }
    setBusy(true);
    setError(null);
    setUrl(null);
    try {
      const result = await sendAdmin(
        inviteCreate({
          roleId: 0,
          expiresInSeconds: 86_400,
          maxUses,
        }),
      );
      const invite = resultInvite(result);
      if (invite) {
        setUrl(invite.url);
      }
    } catch (reason) {
      setError(asCoreError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) {
      return;
    }
    const ok = await copyText(url);
    setCopied(ok);
    if (ok) {
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  if (!allowed) {
    return (
      <p
        data-testid="invite-no-right"
        className="mt-1 rounded-sm border border-border bg-raised px-2 py-1.5 text-[11px] text-muted"
      >
        {t("invite.noRight")}
      </p>
    );
  }

  return (
    <>
      {showHint ? (
        <p className="mt-0.5 text-[11px] leading-snug text-muted">
          {t("invite.hint")}
        </p>
      ) : null}
      <label className="mt-2 block space-y-1">
        <span className="text-[11px] text-muted">{t("invite.uses")}</span>
        <Select
          value={maxUses}
          onChange={(event) => setMaxUses(Number(event.target.value))}
          data-testid="invite-uses"
        >
          {[1, 3, 5].map((value) => (
            <option key={value} value={value}>
              {value === 1
                ? t("invite.usesOne")
                : t("invite.usesMany", { count: value })}
            </option>
          ))}
        </Select>
      </label>
      <Button
        className="mt-2"
        size="sm"
        disabled={busy || !connected}
        onClick={() => void create()}
        data-testid="invite-create"
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <UserPlus className="size-3.5" aria-hidden />
        )}
        {t("invite.create")}
      </Button>
      {error ? (
        <p
          role="alert"
          className="mt-2 text-[11px] text-danger"
          title={coreErrorText(error).detail}
        >
          {t(coreErrorText(error).key)}
        </p>
      ) : null}
      {url ? (
        <div className="mt-2 space-y-1 rounded-sm border border-success/40 bg-success/10 p-2">
          <p className="text-[11px] font-medium text-success">
            {t("invite.shownOnce")}
          </p>
          <div className="flex items-center gap-1">
            <Input
              readOnly
              value={url}
              className="min-w-0 flex-1 font-mono text-[10px]"
              data-testid="invite-link"
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("invite.copy")}
              onClick={() => void copy()}
              data-testid="invite-copy"
            >
              <Copy className="size-3.5" aria-hidden />
            </Button>
          </div>
          <p
            className={cn("text-[10px] text-faint", copied && "text-success")}
            role="status"
          >
            {copied ? t("invite.copied") : t("invite.linkHint")}
          </p>
        </div>
      ) : null}
    </>
  );
}
