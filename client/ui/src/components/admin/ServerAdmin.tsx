/* eslint-disable react-hooks/set-state-in-effect -- data screens synchronise with the core through async requests */
import {
  BadgeCheck,
  KeyRound,
  ListChecks,
  ScrollText,
  Shield,
  Ticket,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import {
  memberList,
  resultUsers,
  sendAdmin,
  type AdminRole,
  type AdminUser,
} from "@/lib/admin";
import {
  adminTabIds,
  hasExplicit,
  highestPosition,
  type AdminTabId,
} from "@/lib/permissions";
import { useCoreStore } from "@/store/coreStore";

import { AdminEmpty } from "./AdminCommon";
import { ApiTokensPanel } from "./ApiTokensPanel";
import { AuditPanel } from "./AuditPanel";
import { ChannelEditor } from "./ChannelEditor";
import { InvitesPanel } from "./InvitesPanel";
import { MembersPanel } from "./MembersPanel";
import { RoleEditor } from "./RoleEditor";
import { ServerGeneral } from "./ServerGeneral";

type AdminTab = AdminTabId;

const TAB_ICONS = {
  general: BadgeCheck,
  roles: Shield,
  channels: ListChecks,
  invites: Ticket,
  members: Users,
  audit: ScrollText,
  tokens: KeyRound,
} as const;

/**
 * The "Server" section of settings (stage 3.2). Every control is behind a
 * permission mirror; the server checks again and its refusal is shown as a
 * localised message, never as raw English.
 */
export function ServerAdmin() {
  const { t } = useTranslation();
  const state = useCoreStore((store) => store.state);
  const [tab, setTab] = useState<AdminTab>(() => {
    // Screenshot/debug override only; production has no query string.
    const requested = new URLSearchParams(window.location.search).get("adminTab");
    const allowed: AdminTab[] = [
      "general",
      "roles",
      "channels",
      "invites",
      "members",
      "audit",
      "tokens",
    ];
    return allowed.includes(requested as AdminTab)
      ? (requested as AdminTab)
      : "general";
  });
  const [members, setMembers] = useState<AdminUser[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);

  const serverPerms = useMemo(
    () => state?.permissions?.server ?? [],
    [state?.permissions?.server],
  );
  const manageServer = hasExplicit(serverPerms, "manageServer");
  const can = useMemo(
    () => (name: string) => manageServer || serverPerms.includes(name),
    [manageServer, serverPerms],
  );

  const roles: AdminRole[] = useMemo(
    () =>
      (state?.roles ?? []).map((role) => ({
        id: role.id,
        name: role.name,
        color: role.color ? Number.parseInt(role.color.replace("#", ""), 16) : 0,
        position: role.position,
        builtin: role.builtin,
        permissions: role.permissions,
      })),
    [state?.roles],
  );

  const self = state?.users.find((user) => user.id === state.selfUserId);
  const actorHighest = self ? highestPosition(self.roleIds, state?.roles ?? []) : -1;

  const tabs = useMemo(
    () => adminTabIds(serverPerms),
    [serverPerms],
  );

  useEffect(() => {
    if (tabs.length > 0 && !tabs.includes(tab)) {
      setTab(tabs[0]!);
    }
  }, [tabs, tab]);

  const reloadMembers = useCallback(async () => {
    setMembersLoading(true);
    try {
      const result = await sendAdmin(memberList("", true));
      setMembers(resultUsers(result));
    } catch {
      setMembers([]);
    } finally {
      setMembersLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadMembers();
  }, [reloadMembers]);

  if (!state || tabs.length === 0) {
    return <AdminEmpty>{t("admin.noRight")}</AdminEmpty>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="server-admin">
      <nav className="mb-2 flex flex-wrap gap-1 border-b border-border pb-2" aria-label={t("admin.title")}>
        {tabs.map((item) => {
          const Icon = TAB_ICONS[item];
          const selected = item === tab;
          return (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              aria-current={selected ? "page" : undefined}
              data-testid={`admin-tab-${item}`}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-sm px-2 text-[12px]",
                selected ? "bg-active text-foreground" : "text-muted hover:bg-hover hover:text-foreground",
              )}
            >
              <Icon className={cn("size-3.5", selected ? "text-accent" : "text-faint")} aria-hidden />
              {t(`admin.tabs.${item}`)}
            </button>
          );
        })}
        {membersLoading ? <span className="self-center text-[10px] text-faint">…</span> : null}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        {tab === "general" ? (
          <ServerGeneral server={state.server} canManageServer={manageServer} />
        ) : null}
        {tab === "roles" ? (
          <RoleEditor
            roles={roles}
            members={members}
            actorHighest={actorHighest}
            actorPermissions={serverPerms}
            manageServer={manageServer}
            canManageRoles={can("manageRoles")}
            onRolesChanged={() => void reloadMembers()}
            onMembersChanged={() => void reloadMembers()}
          />
        ) : null}
        {tab === "channels" ? (
          <ChannelEditor
            channels={state.channels}
            roles={roles}
            canManageChannels={can("manageChannels")}
            onChanged={() => void reloadMembers()}
          />
        ) : null}
        {tab === "invites" ? (
          <InvitesPanel
            roles={roles}
            actor={{
              highest: actorHighest,
              permissions: serverPerms,
              manageServer,
            }}
          />
        ) : null}
        {tab === "members" ? (
          <MembersPanel
            roles={roles}
            channels={state.channels}
            actor={{
              selfId: state.selfUserId,
              highest: actorHighest,
              permissions: serverPerms,
              manageServer,
            }}
            canManageRoles={can("manageRoles")}
            onChanged={() => void reloadMembers()}
          />
        ) : null}
        {tab === "audit" ? (
          <AuditPanel roles={roles} channels={state.channels} users={members} />
        ) : null}
        {tab === "tokens" ? (
          <ApiTokensPanel roles={roles} actorHighest={actorHighest} manageServer={manageServer} />
        ) : null}
      </div>
    </div>
  );
}
