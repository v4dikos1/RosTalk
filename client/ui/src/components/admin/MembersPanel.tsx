import { Ban, LogOut, Search, VolumeX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { ChannelView } from "@/core/api";
import {
  banList,
  memberBan,
  memberKick,
  memberList,
  memberSetDeafened,
  memberSetMuted,
  memberUnban,
  resultBans,
  resultUsers,
  roleAssign,
  roleUnassign,
  type AdminBan,
  type AdminRole,
  type AdminUser,
} from "@/lib/admin";
import { canGrantRole, highestPosition } from "@/lib/permissions";
import { roleName } from "@/lib/roles";
import { formatDateTime } from "@/lib/time";
import { useSettingsStore } from "@/store/settingsStore";
import { cn } from "@/lib/utils";

import { AdminCard, AdminEmpty, AdminErrorNotice, AdminPending, useAdminAction } from "./AdminCommon";

interface Moderator {
  selfId: number;
  highest: number;
  permissions: string[];
  manageServer: boolean;
}

type RowMode = { id: number; kind: "kick" | "ban" } | null;

export function MembersPanel({
  roles,
  channels,
  actor,
  canManageRoles,
  onChanged,
}: {
  roles: AdminRole[];
  channels: ChannelView[];
  actor: Moderator;
  canManageRoles: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const settings = useSettingsStore((store) => store.settings);
  const listAction = useAdminAction();
  const action = useAdminAction();
  const banAction = useAdminAction();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [bans, setBans] = useState<AdminBan[]>([]);
  const [query, setQuery] = useState("");
  const [includeOffline, setIncludeOffline] = useState(true);
  const [rowMode, setRowMode] = useState<RowMode>(null);
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState(0);
  const [byIp, setByIp] = useState(false);
  const [byKey, setByKey] = useState(true);
  const [roleChoice, setRoleChoice] = useState<Record<number, number>>({});

  const locale = settings?.locale ?? "ru";

  useEffect(() => {
    let cancelled = false;
    void listAction.run(memberList(query, includeOffline)).then((result) => {
      if (!cancelled && result) {
        setUsers(resultUsers(result));
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, includeOffline]);

  useEffect(() => {
    let cancelled = false;
    void banAction.run(banList(false)).then((result) => {
      if (!cancelled && result) {
        setBans(resultBans(result));
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const channelName = useMemo(() => {
    const map = new Map(channels.map((channel) => [channel.id, channel.name]));
    return (id: number) => map.get(id) ?? "";
  }, [channels]);

  function targetHighest(user: AdminUser): number {
    return highestPosition(user.roleIds, roles);
  }

  function canAct(user: AdminUser): boolean {
    if (user.id === actor.selfId) {
      return false;
    }
    return actor.manageServer || targetHighest(user) < actor.highest;
  }

  async function toggleRole(user: AdminUser, roleId: number, held: boolean) {
    const result = await action.run(
      held ? roleUnassign(user.id, roleId) : roleAssign(user.id, roleId),
    );
    if (result) {
      onChanged();
    }
  }

  async function submit(mode: "kick" | "ban", user: AdminUser) {
    if (mode === "kick") {
      const result = await action.run(memberKick(user.id, reason));
      if (result) {
        setRowMode(null);
        setReason("");
        onChanged();
      }
      return;
    }
    const result = await action.run(
      memberBan({
        userId: user.id,
        reason,
        expiresInSeconds: duration,
        byKey,
        byIp,
      }),
    );
    if (result) {
      setRowMode(null);
      setReason("");
      onChanged();
      const refreshed = await banAction.run(banList(false));
      if (refreshed) {
        setBans(resultBans(refreshed));
      }
    }
  }

  async function unban(ban: AdminBan) {
    const result = await banAction.run(
      memberUnban(ban.userId > 0 ? { userId: ban.userId } : { ip: ban.ip }),
    );
    if (result) {
      setBans((current) => current.filter((item) => item.id !== ban.id));
      onChanged();
    }
  }

  return (
    <div className="space-y-3" data-testid="members-panel">
      <AdminCard
        title={t("admin.members.title")}
        hint={t("admin.members.hint")}
        actions={<AdminPending pending={listAction.pending} />}
      >
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("admin.members.search")}
              className="pl-7"
              data-testid="member-search"
            />
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            <Switch checked={includeOffline} onCheckedChange={setIncludeOffline} />
            {t("admin.members.offline")}
          </label>
        </div>

        <div className="mt-2 max-h-[360px] space-y-1 overflow-y-auto pr-1">
          {users.map((user) => {
            const actable = canAct(user);
            const expanded = rowMode?.id === user.id;
            return (
              <div
                key={user.id}
                className="rounded-sm border border-border/70 px-2 py-1.5"
                data-testid={`member-row-${user.id}`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      user.online ? "bg-accent" : "bg-faint/50",
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                    {user.nickname}
                    {user.id === actor.selfId ? (
                      <span className="ml-1 text-[10px] text-faint">({t("users.you")})</span>
                    ) : null}
                  </span>
                  {user.channelId !== 0 ? (
                    <span className="shrink-0 text-[10px] text-faint">{channelName(user.channelId)}</span>
                  ) : null}
                  <span className="shrink-0 text-[10px] text-faint">
                    {user.online ? t("admin.members.online") : user.lastSeenAtUnixMs > 0 ? formatDateTime(user.lastSeenAtUnixMs, locale) : ""}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {user.roleIds.map((roleId) => {
                    const role = roles.find((item) => item.id === roleId);
                    if (!role) {
                      return null;
                    }
                    return (
                      <span
                        key={roleId}
                        className="inline-flex items-center gap-1 rounded-sm border border-border bg-raised px-1.5 py-0.5 text-[10px]"
                        style={{ color: `#${(role.color >>> 0).toString(16).padStart(6, "0").slice(-6)}` }}
                      >
                        {roleName(role, t)}
                        {canManageRoles ? (
                          <button
                            type="button"
                            className="text-faint hover:text-danger"
                            onClick={() => void toggleRole(user, roleId, true)}
                            aria-label={t("admin.members.removeRole", { role: roleName(role, t) })}
                          >
                            ×
                          </button>
                        ) : null}
                      </span>
                    );
                  })}
                  {canManageRoles ? (
                    <Select
                      value={roleChoice[user.id] ?? 0}
                      onChange={(event) => {
                        const roleId = Number(event.target.value);
                        setRoleChoice((current) => ({ ...current, [user.id]: roleId }));
                        if (roleId !== 0) {
                          void toggleRole(user, roleId, user.roleIds.includes(roleId));
                        }
                      }}
                      aria-label={t("admin.members.addRole")}
                      className="h-6 text-[10px]"
                    >
                      <option value={0}>{t("admin.members.addRole")}</option>
                      {roles
                        .filter((role) => !user.roleIds.includes(role.id))
                        .filter((role) =>
                          canGrantRole(
                            { position: role.position, permissions: role.permissions },
                            { highest: actor.highest, permissions: actor.permissions, manageServer: actor.manageServer },
                          ),
                        )
                        .map((role) => (
                          <option key={role.id} value={role.id}>
                            {roleName(role, t)}
                          </option>
                        ))}
                    </Select>
                  ) : null}
                  {actable ? (
                    <div className="ml-auto flex items-center gap-1">
                      {actor.permissions.includes("muteMembers") || actor.manageServer ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => void action.run(memberSetMuted(user.id, true)).then((result) => result && onChanged())}
                          title={t("admin.members.mute")}
                        >
                          <VolumeX className="size-3" aria-hidden />
                        </Button>
                      ) : null}
                      {actor.permissions.includes("deafenMembers") || actor.manageServer ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => void action.run(memberSetDeafened(user.id, true)).then((result) => result && onChanged())}
                          title={t("admin.members.deafen")}
                        >
                          <VolumeX className="size-3" aria-hidden />
                        </Button>
                      ) : null}
                      {actor.permissions.includes("kick") || actor.manageServer ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            setRowMode(expanded && rowMode.kind === "kick" ? null : { id: user.id, kind: "kick" });
                            setReason("");
                          }}
                          data-testid={`member-kick-${user.id}`}
                        >
                          <LogOut className="size-3" aria-hidden />
                          {t("admin.members.kick")}
                        </Button>
                      ) : null}
                      {actor.permissions.includes("ban") || actor.manageServer ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          className="text-danger hover:text-danger"
                          onClick={() => {
                            setRowMode(expanded && rowMode.kind === "ban" ? null : { id: user.id, kind: "ban" });
                            setReason("");
                          }}
                          data-testid={`member-ban-${user.id}`}
                        >
                          <Ban className="size-3" aria-hidden />
                          {t("admin.members.ban")}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {expanded ? (
                  <div className="mt-1.5 space-y-1.5 border-t border-border pt-1.5">
                    <Input
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder={t("admin.members.reason")}
                      maxLength={256}
                      data-testid="member-reason"
                    />
                    {rowMode.kind === "ban" ? (
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                        <label className="flex items-center gap-1.5">
                          <Switch checked={byKey} onCheckedChange={setByKey} />
                          {t("admin.members.byKey")}
                        </label>
                        <label className="flex items-center gap-1.5">
                          <Switch checked={byIp} onCheckedChange={setByIp} />
                          {t("admin.members.byIp")}
                        </label>
                        <Select
                          value={duration}
                          onChange={(event) => setDuration(Number(event.target.value))}
                          aria-label={t("admin.members.duration")}
                        >
                          <option value={0}>{t("admin.members.permanent")}</option>
                          <option value={3600}>{t("admin.members.hour")}</option>
                          <option value={86400}>{t("admin.members.day")}</option>
                          <option value={604800}>{t("admin.members.week")}</option>
                        </Select>
                      </div>
                    ) : null}
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="xs"
                        variant={rowMode.kind === "ban" ? "danger" : "default"}
                        disabled={action.pending || (rowMode.kind === "ban" && !byKey && !byIp)}
                        onClick={() => void submit(rowMode.kind, user)}
                        data-testid="member-confirm"
                      >
                        {rowMode.kind === "ban" ? t("admin.members.confirmBan") : t("admin.members.confirmKick")}
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setRowMode(null)}>
                        {t("common.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
          {users.length === 0 ? <AdminEmpty>{t("admin.members.empty")}</AdminEmpty> : null}
        </div>
        <AdminErrorNotice error={listAction.error ?? action.error} />
      </AdminCard>

      <AdminCard
        title={t("admin.bans.title")}
        hint={t("admin.bans.hint")}
        actions={<AdminPending pending={banAction.pending} />}
      >
        <div className="space-y-1">
          {bans.map((ban) => (
            <div
              key={ban.id}
              className="flex items-center gap-2 rounded-sm border border-border/70 px-2 py-1"
              data-testid={`ban-row-${ban.id}`}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                {ban.ip || ban.publicKey.slice(0, 16)}
                {ban.publicKey ? "…" : ""}
              </span>
              <span className="shrink-0 text-[10px] text-faint">{ban.reason}</span>
              {ban.expiresAtUnixMs > 0 ? (
                <Badge variant={ban.expired ? "secondary" : "outline"}>
                  {formatDateTime(ban.expiresAtUnixMs, locale)}
                </Badge>
              ) : (
                <Badge variant="danger">{t("admin.bans.permanent")}</Badge>
              )}
              <Button size="xs" variant="ghost" onClick={() => void unban(ban)}>
                {t("admin.bans.unban")}
              </Button>
            </div>
          ))}
          {bans.length === 0 ? <AdminEmpty>{t("admin.bans.empty")}</AdminEmpty> : null}
        </div>
        <AdminErrorNotice error={banAction.error} />
      </AdminCard>
    </div>
  );
}
