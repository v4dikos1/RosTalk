/* eslint-disable react-hooks/set-state-in-effect -- data screens synchronise with the core through async requests */
import { Filter } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ChannelView } from "@/core/api";
import { auditList, resultAudit, type AdminAuditEntry, type AdminRole, type AdminUser } from "@/lib/admin";
import { formatDateTime } from "@/lib/time";
import { useSettingsStore } from "@/store/settingsStore";

import { AdminCard, AdminEmpty, AdminErrorNotice, AdminPending, useAdminAction } from "./AdminCommon";

const ACTION_KEYS: Record<string, string> = {
  "role.create": "roleCreate",
  "role.update": "roleUpdate",
  "role.delete": "roleDelete",
  "role.reorder": "roleReorder",
  "role.assign": "roleAssign",
  "role.unassign": "roleUnassign",
  "channel.create": "channelCreate",
  "channel.update": "channelUpdate",
  "channel.delete": "channelDelete",
  "channel.move": "channelMove",
  "channel.override.set": "overrideSet",
  "channel.override.clear": "overrideClear",
  "invite.create": "inviteCreate",
  "invite.revoke": "inviteRevoke",
  "settings.update": "settingsUpdate",
  "member.kick": "kick",
  "member.ban": "ban",
  "member.unban": "unban",
  "member.move": "move",
  "member.mute": "mute",
  "member.deafen": "deafen",
  "member.stop_stream": "stopStream",
  "api_token.create": "tokenCreate",
  "api_token.revoke": "tokenRevoke",
};

export function AuditPanel({
  roles,
  channels,
  users,
}: {
  roles: AdminRole[];
  channels: ChannelView[];
  users: AdminUser[];
}) {
  const { t } = useTranslation();
  const settings = useSettingsStore((store) => store.settings);
  const action = useAdminAction();
  const [entries, setEntries] = useState<AdminAuditEntry[]>([]);
  const [actionPrefix, setActionPrefix] = useState("");
  const [actorId, setActorId] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState(0);

  const locale = settings?.locale ?? "ru";

  async function load(beforeId = 0) {
    const result = await action.run(
      auditList({ limit: 50, beforeId, actionPrefix, actorId }),
    );
    if (!result) {
      return;
    }
    const page = resultAudit(result);
    setEntries((current) => (beforeId === 0 ? page.entries : [...current, ...page.entries]));
    setHasMore(page.hasMore);
    setNextBefore(page.nextBeforeId);
  }

  useEffect(() => {
    setEntries([]);
    setHasMore(false);
    setNextBefore(0);
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionPrefix, actorId]);

  function label(entry: AdminAuditEntry): string {
    const key = ACTION_KEYS[entry.action];
    return key ? t(`admin.audit.actions.${key}`) : entry.action;
  }

  function userName(id: number): string {
    return users.find((user) => user.id === id)?.nickname ?? `#${id}`;
  }

  function channelName(id: number): string {
    return channels.find((channel) => channel.id === id)?.name ?? `#${id}`;
  }

  function roleName(id: number): string {
    return roles.find((role) => role.id === id)?.name ?? `#${id}`;
  }

  return (
    <div data-testid="audit-panel">
    <AdminCard
      title={t("admin.audit.title")}
      hint={t("admin.audit.hint")}
      actions={<AdminPending pending={action.pending} />}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-40 flex-1 space-y-1">
          <span className="text-[11px] text-muted">{t("admin.audit.actionFilter")}</span>
          <Input
            value={actionPrefix}
            onChange={(event) => setActionPrefix(event.target.value)}
            placeholder="member."
            data-testid="audit-filter-action"
          />
        </label>
        <label className="w-44 space-y-1">
          <span className="text-[11px] text-muted">{t("admin.audit.actorFilter")}</span>
          <Select
            value={actorId}
            onChange={(event) => setActorId(Number(event.target.value))}
            data-testid="audit-filter-actor"
          >
            <option value={0}>{t("admin.audit.allActors")}</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.nickname}
              </option>
            ))}
          </Select>
        </label>
        <Button size="sm" variant="secondary" onClick={() => void load(0)}>
          <Filter className="size-3.5" aria-hidden />
          {t("admin.audit.apply")}
        </Button>
      </div>

      <div className="mt-2 max-h-[360px] space-y-1 overflow-y-auto pr-1">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="rounded-sm border border-border/70 px-2 py-1.5 text-[11px]"
            data-testid={`audit-row-${entry.id}`}
          >
            <div className="flex items-center gap-2">
              <Badge variant="outline">{label(entry)}</Badge>
              <span className="min-w-0 flex-1 truncate text-foreground">
                {entry.actorName || t("admin.audit.localActor")}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-faint">
                {formatDateTime(entry.createdAtUnixMs, locale)}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-faint">
              {entry.targetUserId > 0 ? <span>{userName(entry.targetUserId)}</span> : null}
              {entry.targetChannelId > 0 ? <span>{channelName(entry.targetChannelId)}</span> : null}
              {entry.targetRoleId > 0 ? <span>{roleName(entry.targetRoleId)}</span> : null}
              {entry.details ? <span className="text-muted">{entry.details}</span> : null}
            </div>
          </div>
        ))}
        {entries.length === 0 ? <AdminEmpty>{t("admin.audit.empty")}</AdminEmpty> : null}
      </div>
      {hasMore ? (
        <div className="mt-2 flex justify-center">
          <Button size="sm" variant="secondary" onClick={() => void load(nextBefore)} disabled={action.pending}>
            {t("admin.audit.loadMore")}
          </Button>
        </div>
      ) : null}
      <AdminErrorNotice error={action.error} />
    </AdminCard>
    </div>
  );
}
