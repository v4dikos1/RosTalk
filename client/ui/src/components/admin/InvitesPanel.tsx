/* eslint-disable react-hooks/set-state-in-effect -- data screens synchronise with the core through async requests */
import { Plus, Ticket } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  inviteCreate,
  inviteList,
  inviteRevoke,
  resultInvite,
  resultInvites,
  type AdminInvite,
  type AdminRole,
} from "@/lib/admin";
import { canGrantRole } from "@/lib/permissions";
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
  { value: 3600, key: "hour" },
  { value: 86400, key: "day" },
  { value: 604800, key: "week" },
  { value: 2592000, key: "month" },
];

export function InvitesPanel({
  roles,
  actor,
}: {
  roles: AdminRole[];
  actor: { highest: number; permissions: string[]; manageServer: boolean };
}) {
  const { t } = useTranslation();
  const settings = useSettingsStore((store) => store.settings);
  const action = useAdminAction();
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [roleId, setRoleId] = useState(0);
  const [expiry, setExpiry] = useState(86400);
  const [maxUses, setMaxUses] = useState(1);
  const [now] = useState(() => Date.now());

  const locale = settings?.locale ?? "ru";
  const grantable = useMemo(
    () =>
      roles.filter((role) =>
        canGrantRole(
          { position: role.position, permissions: role.permissions },
          actor,
        ),
      ),
    [roles, actor],
  );

  async function refresh() {
    const result = await action.run(inviteList(true));
    if (result) {
      setInvites(resultInvites(result));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    const result = await action.run(
      inviteCreate({
        roleId,
        expiresInSeconds: expiry,
        maxUses,
      }),
    );
    if (result) {
      const created = resultInvite(result);
      if (created) {
        setUrls((current) => ({ ...current, [created.id]: created.url }));
      }
      await refresh();
    }
  }

  async function revoke(invite: AdminInvite) {
    const result = await action.run(inviteRevoke(invite.id));
    if (result) {
      await refresh();
    }
  }

  function status(invite: AdminInvite): {
    label: string;
    variant: "success" | "secondary" | "danger";
    active: boolean;
  } {
    if (invite.revokedAtUnixMs > 0) {
      return { label: t("admin.invites.revoked"), variant: "danger", active: false };
    }
    if (invite.expiresAtUnixMs > 0 && invite.expiresAtUnixMs <= now) {
      return { label: t("admin.invites.expired"), variant: "secondary", active: false };
    }
    if (invite.usedCount >= invite.maxUses) {
      return { label: t("admin.invites.usedUp"), variant: "secondary", active: false };
    }
    return { label: t("admin.invites.active"), variant: "success", active: true };
  }

  return (
    <div className="space-y-3" data-testid="invites-panel">
      <AdminCard title={t("admin.invites.createTitle")} hint={t("admin.invites.createHint")}>
        <div className="grid grid-cols-3 gap-2">
          <label className="space-y-1">
            <span className="text-[11px] text-muted">{t("admin.invites.role")}</span>
            <Select value={roleId} onChange={(event) => setRoleId(Number(event.target.value))}>
              <option value={0}>{t("admin.invites.defaultRole")}</option>
              {grantable.map((role) => (
                <option key={role.id} value={role.id}>
                  {roleName(role, t)}
                </option>
              ))}
            </Select>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted">{t("admin.invites.expiry")}</span>
            <Select value={expiry} onChange={(event) => setExpiry(Number(event.target.value))}>
              {EXPIRY.map((item) => (
                <option key={item.value} value={item.value}>
                  {t(`admin.invites.expiryOption.${item.key}`)}
                </option>
              ))}
            </Select>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted">{t("admin.invites.maxUses")}</span>
            <Input
              type="number"
              min={1}
              max={1000}
              value={maxUses}
              onChange={(event) => setMaxUses(Math.max(1, Number(event.target.value) || 1))}
            />
          </label>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" disabled={action.pending} onClick={() => void create()} data-testid="invite-create">
            <Plus className="size-3.5" aria-hidden />
            {t("admin.invites.create")}
          </Button>
          <AdminPending pending={action.pending} />
          <AdminErrorNotice error={action.error} />
        </div>
        {Object.entries(urls).length > 0 ? (
          <div className="mt-2 space-y-1 rounded-sm border border-success/40 bg-success/10 p-2">
            <p className="text-[11px] font-medium text-success">{t("admin.invites.shownOnce")}</p>
            {Object.entries(urls).map(([id, url]) => (
              <div key={id} className="flex items-center gap-1">
                <code className="min-w-0 flex-1 truncate text-[10px] text-foreground">{url}</code>
                <CopyButton text={url} />
              </div>
            ))}
          </div>
        ) : null}
      </AdminCard>

      <AdminCard
        title={t("admin.invites.title")}
        hint={t("admin.invites.hint")}
        actions={<AdminPending pending={action.pending} />}
      >
        <div className="space-y-1">
          {invites.map((invite) => {
            const state = status(invite);
            const role = roles.find((item) => item.id === invite.roleId);
            return (
              <div
                key={invite.id}
                className="flex items-center gap-2 rounded-sm border border-border/70 px-2 py-1"
                data-testid={`invite-row-${invite.id}`}
              >
                <Ticket className="size-3.5 shrink-0 text-faint" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                  {role ? roleName(role, t) : t("admin.invites.defaultRole")}
                </span>
                <span className="shrink-0 text-[10px] text-faint">
                  {invite.usedCount}/{invite.maxUses}
                </span>
                <span className="shrink-0 text-[10px] text-faint">
                  {invite.expiresAtUnixMs > 0
                    ? formatDateTime(invite.expiresAtUnixMs, locale)
                    : t("admin.invites.never")}
                </span>
                <Badge variant={state.variant}>{state.label}</Badge>
                {urls[invite.id] ? <CopyButton text={urls[invite.id]!} /> : null}
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-danger hover:text-danger"
                  disabled={!state.active}
                  onClick={() => void revoke(invite)}
                  data-testid={`invite-revoke-${invite.id}`}
                >
                  {t("admin.invites.revoke")}
                </Button>
              </div>
            );
          })}
          {invites.length === 0 ? <AdminEmpty>{t("admin.invites.empty")}</AdminEmpty> : null}
        </div>
        <AdminErrorNotice error={action.error} />
      </AdminCard>
    </div>
  );
}
