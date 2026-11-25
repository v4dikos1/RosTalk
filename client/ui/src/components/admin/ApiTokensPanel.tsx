/* eslint-disable react-hooks/set-state-in-effect -- data screens synchronise with the core through async requests */
import { KeyRound, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  resultToken,
  resultTokens,
  tokenCreate,
  tokenList,
  tokenRevoke,
  type AdminRole,
  type AdminToken,
} from "@/lib/admin";
import { canManageRole } from "@/lib/permissions";
import { roleName } from "@/lib/roles";
import { formatDateTime } from "@/lib/time";
import { useSettingsStore } from "@/store/settingsStore";

import {
  AdminCard,
  AdminEmpty,
  AdminErrorNotice,
  AdminPending,
  CopyButton,
  useAdminAction,
} from "./AdminCommon";

const EXPIRY = [
  { value: 0, key: "never" },
  { value: 86400, key: "day" },
  { value: 2592000, key: "month" },
  { value: 7776000, key: "quarter" },
  { value: 31536000, key: "year" },
];

export function ApiTokensPanel({
  roles,
  actorHighest,
  manageServer,
}: {
  roles: AdminRole[];
  actorHighest: number;
  manageServer: boolean;
}) {
  const { t } = useTranslation();
  const settings = useSettingsStore((store) => store.settings);
  const action = useAdminAction();
  const [tokens, setTokens] = useState<AdminToken[]>([]);
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState(0);
  const [expiry, setExpiry] = useState(2592000);
  const [freshToken, setFreshToken] = useState<AdminToken | null>(null);
  // One clock read for the render pass; statuses refresh when the list reloads.
  const [now] = useState(() => Date.now());

  const locale = settings?.locale ?? "ru";
  const availableRoles = useMemo(
    () => roles.filter((role) => canManageRole(role, actorHighest, manageServer)),
    [roles, actorHighest, manageServer],
  );

  useEffect(() => {
    if (roleId === 0 && availableRoles.length > 0) {
      setRoleId(availableRoles[0]!.id);
    }
  }, [availableRoles, roleId]);

  async function refresh() {
    const result = await action.run(tokenList());
    if (result) {
      setTokens(resultTokens(result));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    if (name.trim() === "" || roleId === 0) {
      return;
    }
    const result = await action.run(
      tokenCreate({ name: name.trim(), roleId, expiresInSeconds: expiry }),
    );
    if (result) {
      const created = resultToken(result);
      if (created) {
        setFreshToken(created);
      }
      setName("");
      await refresh();
    }
  }

  async function revoke(token: AdminToken) {
    const result = await action.run(tokenRevoke(token.id));
    if (result) {
      setTokens((current) => current.map((item) =>
        item.id === token.id ? { ...item, revokedAtUnixMs: Date.now() } : item,
      ));
    }
  }

  return (
    <div className="space-y-3" data-testid="api-tokens-panel">
      <AdminCard title={t("admin.tokens.createTitle")} hint={t("admin.tokens.createHint")}>
        <div className="grid grid-cols-[1fr_170px_150px] gap-2">
          <label className="space-y-1">
            <span className="text-[11px] text-muted">{t("admin.tokens.name")}</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={64}
              placeholder={t("admin.tokens.namePlaceholder")}
              data-testid="token-name"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted">{t("admin.tokens.role")}</span>
            <Select value={roleId} onChange={(event) => setRoleId(Number(event.target.value))} data-testid="token-role">
              {availableRoles.map((role) => (
                <option key={role.id} value={role.id}>
                  {roleName(role, t)}
                </option>
              ))}
            </Select>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted">{t("admin.tokens.expiry")}</span>
            <Select value={expiry} onChange={(event) => setExpiry(Number(event.target.value))}>
              {EXPIRY.map((item) => (
                <option key={item.value} value={item.value}>
                  {t(`admin.tokens.expiryOption.${item.key}`)}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            disabled={action.pending || name.trim() === "" || roleId === 0}
            onClick={() => void create()}
            data-testid="token-create"
          >
            <Plus className="size-3.5" aria-hidden />
            {t("admin.tokens.create")}
          </Button>
          <AdminPending pending={action.pending} />
          <AdminErrorNotice error={action.error} />
        </div>
        {freshToken ? (
          <div className="mt-2 rounded-sm border border-warning/50 bg-warning/10 p-2" data-testid="token-fresh">
            <p className="text-[11px] font-medium text-warning">{t("admin.tokens.shownOnce")}</p>
            <div className="mt-1 flex items-center gap-1">
              <code className="min-w-0 flex-1 break-all rounded-sm bg-background/60 px-1.5 py-1 font-mono text-[11px] text-foreground">
                {freshToken.token}
              </code>
              <CopyButton text={freshToken.token} />
            </div>
          </div>
        ) : null}
      </AdminCard>

      <AdminCard
        title={t("admin.tokens.title")}
        hint={t("admin.tokens.hint")}
        actions={<AdminPending pending={action.pending} />}
      >
        <div className="space-y-1">
          {tokens.map((token) => {
            const revoked = token.revokedAtUnixMs > 0;
            const expired = token.expiresAtUnixMs > 0 && token.expiresAtUnixMs <= now;
            const role = roles.find((item) => item.id === token.roleId);
            return (
              <div
                key={token.id}
                className="flex items-center gap-2 rounded-sm border border-border/70 px-2 py-1"
                data-testid={`token-row-${token.id}`}
              >
                <KeyRound className="size-3.5 shrink-0 text-faint" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{token.name}</span>
                <Badge variant="outline">
                  {role ? roleName(role, t) : t("admin.tokens.noRole")}
                </Badge>
                <span className="shrink-0 text-[10px] text-faint">
                  {token.expiresAtUnixMs > 0
                    ? formatDateTime(token.expiresAtUnixMs, locale)
                    : t("admin.tokens.never")}
                </span>
                <Badge variant={revoked || expired ? "danger" : "success"}>
                  {revoked
                    ? t("admin.tokens.revoked")
                    : expired
                      ? t("admin.tokens.expired")
                      : t("admin.tokens.active")}
                </Badge>
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-danger hover:text-danger"
                  disabled={revoked}
                  onClick={() => void revoke(token)}
                  data-testid={`token-revoke-${token.id}`}
                >
                  {t("admin.tokens.revoke")}
                </Button>
              </div>
            );
          })}
          {tokens.length === 0 ? <AdminEmpty>{t("admin.tokens.empty")}</AdminEmpty> : null}
        </div>
        <AdminErrorNotice error={action.error} />
      </AdminCard>
    </div>
  );
}
