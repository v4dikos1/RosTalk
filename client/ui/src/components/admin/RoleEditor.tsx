/* eslint-disable react-hooks/set-state-in-effect -- data screens synchronise with the core through async requests */
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  colorToHex,
  hexToColor,
  roleAssign,
  roleCreate,
  roleDelete,
  roleReorder,
  roleUnassign,
  roleUpdate,
  type AdminRole,
  type AdminUser,
} from "@/lib/admin";
import { canGrantRole, namesToPermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";

import { AdminCard, AdminEmpty, AdminErrorNotice, AdminPending, useAdminAction } from "./AdminCommon";
import { PermissionMatrix } from "./PermissionMatrix";

export function RoleEditor({
  roles,
  members,
  actorHighest,
  actorPermissions,
  manageServer,
  canManageRoles,
  onRolesChanged,
  onMembersChanged,
}: {
  roles: AdminRole[];
  members: AdminUser[];
  actorHighest: number;
  actorPermissions: string[];
  manageServer: boolean;
  canManageRoles: boolean;
  onRolesChanged: () => void;
  onMembersChanged: () => void;
}) {
  const { t } = useTranslation();
  const rolesAction = useAdminAction();
  const assignAction = useAdminAction();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState("#8ab4f8");
  const [draftPermissions, setDraftPermissions] = useState<string[]>([]);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#8ab4f8");
  const [dragging, setDragging] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const dragId = useRef<number | null>(null);

  const ordered = useMemo(
    () => roles.slice().sort((a, b) => b.position - a.position || b.id - a.id),
    [roles],
  );
  const selected = roles.find((role) => role.id === selectedId) ?? null;

  useEffect(() => {
    if (selected) {
      setDraftName(selected.name);
      setDraftColor(colorToHex(selected.color));
      setDraftPermissions([...selected.permissions]);
    }
  }, [selected]);

  function canEdit(role: AdminRole): boolean {
    return canManageRoles && (manageServer || role.position < actorHighest);
  }

  async function saveRole() {
    if (!selected) {
      return;
    }
    const result = await rolesAction.run(
      roleUpdate({
        roleId: selected.id,
        name: draftName.trim() === selected.name ? undefined : draftName.trim(),
        color: hexToColor(draftColor),
        permissions: namesToPermissions(draftPermissions),
      }),
    );
    if (result) {
      onRolesChanged();
    }
  }

  async function createRole() {
    const name = newName.trim();
    if (name.length === 0) {
      return;
    }
    const result = await rolesAction.run(
      roleCreate({
        name,
        color: hexToColor(newColor),
        permissions: [],
      }),
    );
    if (result) {
      setNewName("");
      onRolesChanged();
    }
  }

  async function removeRole(role: AdminRole) {
    const result = await rolesAction.run(roleDelete(role.id));
    if (result) {
      setSelectedId(null);
      onRolesChanged();
    }
  }

  async function dropOn(targetId: number) {
    const source = dragId.current;
    dragId.current = null;
    setDragging(null);
    setDragOver(null);
    if (source === null || source === targetId) {
      return;
    }
    const next = ordered.slice();
    const from = next.findIndex((role) => role.id === source);
    const to = next.findIndex((role) => role.id === targetId);
    if (from === -1 || to === -1) {
      return;
    }
    const [moved] = next.splice(from, 1);
    if (!moved) {
      return;
    }
    next.splice(to, 0, moved);
    const ascending = next.slice().reverse().map((role) => role.id);
    const result = await rolesAction.run(roleReorder(ascending));
    if (result) {
      onRolesChanged();
    }
  }

  async function toggleAssignment(user: AdminUser, role: AdminRole) {
    const held = user.roleIds.includes(role.id);
    const result = await assignAction.run(
      held ? roleUnassign(user.id, role.id) : roleAssign(user.id, role.id),
    );
    if (result) {
      onMembersChanged();
    }
  }

  if (!canManageRoles) {
    return <AdminEmpty>{t("admin.roles.noRight")}</AdminEmpty>;
  }

  return (
    <div className="grid min-h-0 grid-cols-[240px_1fr] gap-3" data-testid="role-editor">
      <AdminCard
        title={t("admin.roles.title")}
        hint={t("admin.roles.dragHint")}
        className="min-h-0"
        actions={<AdminPending pending={rolesAction.pending} />}
      >
        <div className="space-y-1">
          {ordered.map((role) => {
            const editable = canEdit(role);
            return (
              <div
                key={role.id}
                draggable={editable}
                onDragStart={() => {
                  dragId.current = role.id;
                  setDragging(role.id);
                }}
                onDragEnd={() => {
                  dragId.current = null;
                  setDragging(null);
                  setDragOver(null);
                }}
                onDragOver={(event) => {
                  if (!editable) {
                    return;
                  }
                  event.preventDefault();
                  setDragOver(role.id);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  void dropOn(role.id);
                }}
                className={cn(
                  "flex items-center gap-1.5 rounded-sm border px-1.5 py-1",
                  selectedId === role.id
                    ? "border-accent/60 bg-accent/10"
                    : "border-transparent hover:bg-hover",
                  dragging === role.id && "opacity-50",
                  dragOver === role.id && "border-accent",
                  !editable && "opacity-60",
                )}
                data-testid={`role-row-${role.id}`}
              >
                <GripVertical
                  className={cn("size-3.5 shrink-0", editable ? "cursor-grab text-faint" : "text-faint/40")}
                  aria-hidden
                />
                <button
                  type="button"
                  onClick={() => setSelectedId(role.id)}
                  data-testid={`role-select-${role.id}`}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full border border-white/10"
                    style={{ backgroundColor: colorToHex(role.color) }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                    {role.name}
                  </span>
                  {role.builtin ? (
                    <Badge variant="secondary" className="shrink-0">
                      {t("admin.roles.builtin")}
                    </Badge>
                  ) : null}
                </button>
              </div>
            );
          })}
          {ordered.length === 0 ? <AdminEmpty>{t("admin.roles.empty")}</AdminEmpty> : null}
        </div>

        <div className="mt-3 space-y-1.5 border-t border-border pt-2">
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder={t("admin.roles.newName")}
            maxLength={64}
            data-testid="role-new-name"
          />
          <div className="flex items-center gap-1.5">
            <input
              type="color"
              value={newColor}
              onChange={(event) => setNewColor(event.target.value)}
              aria-label={t("admin.roles.color")}
              className="h-8 w-9 cursor-pointer rounded-sm border border-border bg-raised p-0.5"
            />
            <Button
              size="sm"
              className="flex-1"
              disabled={newName.trim().length === 0 || rolesAction.pending}
              onClick={() => void createRole()}
              data-testid="role-create"
            >
              <Plus className="size-3.5" aria-hidden />
              {t("admin.roles.create")}
            </Button>
          </div>
          <AdminErrorNotice error={rolesAction.error} />
        </div>
      </AdminCard>

      <div className="min-h-0 space-y-3 overflow-y-auto pr-0.5">
        {selected ? (
          <>
            <AdminCard
              title={t("admin.roles.editTitle", { name: selected.name })}
              hint={
                canEdit(selected)
                  ? t("admin.roles.editHint")
                  : t("admin.roles.hierarchyHint")
              }
              actions={
                !selected.builtin && canEdit(selected) ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-danger hover:text-danger"
                    onClick={() => void removeRole(selected)}
                    data-testid="role-delete"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                    {t("admin.common.delete")}
                  </Button>
                ) : null
              }
            >
              <div className="flex items-end gap-2">
                <label className="flex-1 space-y-1">
                  <span className="text-[11px] text-muted">{t("admin.roles.name")}</span>
                  <Input
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    maxLength={64}
                    disabled={!canEdit(selected)}
                    data-testid="role-name"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-muted">{t("admin.roles.color")}</span>
                  <input
                    type="color"
                    value={draftColor}
                    onChange={(event) => setDraftColor(event.target.value)}
                    disabled={!canEdit(selected)}
                    className="block h-8 w-10 cursor-pointer rounded-sm border border-border bg-raised p-0.5"
                    data-testid="role-color"
                  />
                </label>
                <Button
                  size="sm"
                  disabled={!canEdit(selected) || rolesAction.pending}
                  onClick={() => void saveRole()}
                  data-testid="role-save"
                >
                  {t("common.save")}
                </Button>
              </div>
              <div className="mt-3">
                <PermissionMatrix
                  value={draftPermissions}
                  onChange={setDraftPermissions}
                  disabled={!canEdit(selected)}
                />
              </div>
              <AdminErrorNotice error={rolesAction.error} />
            </AdminCard>

            <AdminCard
              title={t("admin.roles.membersTitle")}
              hint={t("admin.roles.membersHint")}
              actions={<AdminPending pending={assignAction.pending} />}
            >
              <div className="max-h-56 space-y-0.5 overflow-y-auto pr-1">
                {members.map((user) => {
                  const held = user.roleIds.includes(selected.id);
                  const grantable = canGrantRole(
                    { position: selected.position, permissions: selected.permissions },
                    {
                      highest: actorHighest,
                      permissions: actorPermissions,
                      manageServer,
                    },
                  );
                  return (
                    <div
                      key={user.id}
                      className="flex items-center justify-between gap-2 rounded-sm px-1.5 py-1 hover:bg-hover"
                    >
                      <span className="min-w-0 truncate text-[12px] text-foreground">
                        {user.nickname}
                        {user.online ? (
                          <span className="ml-1 text-[10px] text-success">●</span>
                        ) : null}
                      </span>
                      <Switch
                        checked={held}
                        disabled={!canEdit(selected) || (!held && !grantable)}
                        onCheckedChange={() => void toggleAssignment(user, selected)}
                        aria-label={t("admin.roles.assignTo", { name: user.nickname })}
                      />
                    </div>
                  );
                })}
                {members.length === 0 ? (
                  <AdminEmpty>{t("admin.roles.noMembers")}</AdminEmpty>
                ) : null}
              </div>
              <AdminErrorNotice error={assignAction.error} />
            </AdminCard>
          </>
        ) : (
          <AdminCard title={t("admin.roles.pickTitle")} hint={t("admin.roles.pickHint")}>
            <AdminEmpty>{t("admin.roles.pickEmpty")}</AdminEmpty>
          </AdminCard>
        )}
      </div>
    </div>
  );
}
