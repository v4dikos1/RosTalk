/* eslint-disable react-hooks/set-state-in-effect -- data screens synchronise with the core through async requests */
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { ChannelView } from "@/core/api";
import {
  channelCreate,
  channelDelete,
  channelMove,
  channelUpdate,
  overrideClear,
  overrideList,
  overrideSet,
  resultOverrides,
  type AdminOverride,
  type AdminRole,
} from "@/lib/admin";
import { namesToPermissions, PERMISSION_DEFINITIONS } from "@/lib/permissions";
import { roleName } from "@/lib/roles";
import { cn } from "@/lib/utils";

import { AdminCard, AdminEmpty, AdminErrorNotice, AdminPending, useAdminAction } from "./AdminCommon";

interface Draft {
  name: string;
  topic: string;
  kind: "voice" | "text";
  userLimit: number;
  voiceProfile: "voice" | "voiceHq" | "music";
  temporary: boolean;
  afk: boolean;
  password: string;
  clearPassword: boolean;
}

function draftOf(channel: ChannelView): Draft {
  return {
    name: channel.name,
    topic: channel.topic,
    kind: channel.kind,
    userLimit: channel.userLimit,
    voiceProfile: channel.voiceProfile,
    temporary: channel.temporary,
    afk: channel.afk,
    password: "",
    clearPassword: false,
  };
}

function orderedTree(channels: ChannelView[]): { channel: ChannelView; depth: number }[] {
  const byParent = new Map<number, ChannelView[]>();
  const ids = new Set(channels.map((channel) => channel.id));
  for (const channel of channels) {
    const parent = ids.has(channel.parentId) ? channel.parentId : 0;
    const list = byParent.get(parent) ?? [];
    list.push(channel);
    byParent.set(parent, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }
  const out: { channel: ChannelView; depth: number }[] = [];
  const seen = new Set<number>();
  function walk(parent: number, depth: number) {
    for (const channel of byParent.get(parent) ?? []) {
      if (seen.has(channel.id)) {
        continue;
      }
      seen.add(channel.id);
      out.push({ channel, depth });
      walk(channel.id, depth + 1);
    }
  }
  walk(0, 0);
  return out;
}

export function ChannelEditor({
  channels,
  roles,
  canManageChannels,
  onChanged,
}: {
  channels: ChannelView[];
  roles: AdminRole[];
  canManageChannels: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const action = useAdminAction();
  const overrideAction = useAdminAction();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState(0);
  const [newKind, setNewKind] = useState<"voice" | "text">("voice");
  const [newLimit, setNewLimit] = useState(0);
  const [newProfile, setNewProfile] = useState<"voice" | "voiceHq" | "music">("voice");
  const [newPassword, setNewPassword] = useState("");
  const [dragId, setDragId] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | "root" | null>(null);
  const [overrides, setOverrides] = useState<AdminOverride[]>([]);
  const [overrideRoleId, setOverrideRoleId] = useState<number>(0);
  const [allow, setAllow] = useState<string[]>([]);
  const [deny, setDeny] = useState<string[]>([]);

  const tree = useMemo(() => orderedTree(channels), [channels]);
  const selected = channels.find((channel) => channel.id === selectedId) ?? null;

  useEffect(() => {
    if (selected) {
      setDraft(draftOf(selected));
      setAllow([]);
      setDeny([]);
      setOverrideRoleId(roles[0]?.id ?? 0);
    } else {
      setDraft(null);
    }
  }, [selected, roles]);

  useEffect(() => {
    if (!selected) {
      setOverrides([]);
      return;
    }
    let cancelled = false;
    void overrideAction.run(overrideList(selected.id)).then((result) => {
      if (!cancelled && result) {
        setOverrides(resultOverrides(result));
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, channels]);

  useEffect(() => {
    const existing = overrides.find((item) => item.roleId === overrideRoleId);
    setAllow(existing?.allow ?? []);
    setDeny(existing?.deny ?? []);
  }, [overrideRoleId, overrides]);

  async function save() {
    if (!selected || !draft) {
      return;
    }
    const result = await action.run(
      channelUpdate({
        channelId: selected.id,
        name: draft.name,
        topic: draft.topic,
        kind: draft.kind,
        userLimit: draft.userLimit,
        voiceProfile: draft.voiceProfile,
        temporary: draft.temporary,
        afk: draft.afk,
        password: draft.clearPassword ? "" : draft.password === "" ? undefined : draft.password,
      }),
    );
    if (result) {
      setDraft((current) => (current ? { ...current, password: "", clearPassword: false } : current));
      onChanged();
    }
  }

  async function create() {
    const name = newName.trim();
    if (name === "") {
      return;
    }
    const result = await action.run(
      channelCreate({
        parentId: newParent,
        name,
        topic: "",
        kind: newKind,
        userLimit: newLimit,
        voiceProfile: newProfile,
        temporary: false,
        afk: false,
        password: newPassword,
      }),
    );
    if (result) {
      setNewName("");
      setNewLimit(0);
      setNewProfile("voice");
      setNewPassword("");
      onChanged();
    }
  }

  async function remove() {
    if (!selected) {
      return;
    }
    const result = await action.run(channelDelete(selected.id));
    if (result) {
      setSelectedId(null);
      onChanged();
    }
  }

  async function dropOn(parentId: number) {
    const source = dragId;
    setDragId(null);
    setDragOver(null);
    if (source === null || source === parentId) {
      return;
    }
    const result = await action.run(channelMove({ channelId: source, parentId }));
    if (result) {
      onChanged();
    }
  }

  function togglePermission(name: string, column: "allow" | "deny", checked: boolean) {
    const set = column === "allow" ? allow : deny;
    const other = column === "allow" ? deny : allow;
    const next = new Set(set);
    if (checked) {
      next.add(name);
    } else {
      next.delete(name);
    }
    const otherSet = new Set(other);
    if (checked) {
      otherSet.delete(name);
    }
    if (column === "allow") {
      setAllow([...next]);
      setDeny([...otherSet]);
    } else {
      setDeny([...next]);
      setAllow([...otherSet]);
    }
  }

  async function saveOverride() {
    if (!selected || overrideRoleId === 0) {
      return;
    }
    const result = await overrideAction.run(
      overrideSet({
        channelId: selected.id,
        roleId: overrideRoleId,
        allow: namesToPermissions(allow),
        deny: namesToPermissions(deny),
      }),
    );
    if (result) {
      onChanged();
    }
  }

  async function clearOverride() {
    if (!selected || overrideRoleId === 0) {
      return;
    }
    const result = await overrideAction.run(overrideClear(selected.id, overrideRoleId));
    if (result) {
      setAllow([]);
      setDeny([]);
      onChanged();
    }
  }

  if (!canManageChannels) {
    return <AdminEmpty>{t("admin.channels.noRight")}</AdminEmpty>;
  }

  const channelPermissions = PERMISSION_DEFINITIONS.filter(
    (definition) => definition.group === "channel",
  );

  return (
    <div className="grid min-h-0 grid-cols-[260px_1fr] gap-3" data-testid="channel-editor">
      <AdminCard
        title={t("admin.channels.title")}
        hint={t("admin.channels.dragHint")}
        actions={<AdminPending pending={action.pending} />}
        className="min-h-0"
      >
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver("root");
          }}
          onDragLeave={() => setDragOver(null)}
          onDrop={(event) => {
            event.preventDefault();
            void dropOn(0);
          }}
          className={cn(
            "mb-1 rounded-sm border border-dashed px-2 py-1 text-[11px]",
            dragOver === "root" ? "border-accent text-accent" : "border-border text-faint",
          )}
        >
          {t("admin.channels.root")}
        </div>
        <div className="space-y-0.5">
          {tree.map(({ channel, depth }) => (
            <div
              key={channel.id}
              draggable
              onDragStart={() => setDragId(channel.id)}
              onDragEnd={() => {
                setDragId(null);
                setDragOver(null);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(channel.id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                void dropOn(channel.id);
              }}
              onDragEnter={() => setDragOver(channel.id)}
              className={cn(
                "flex items-center gap-1 rounded-sm border px-1 py-1",
                selectedId === channel.id
                  ? "border-accent/60 bg-accent/10"
                  : "border-transparent hover:bg-hover",
                dragOver === channel.id && "border-accent",
                dragId === channel.id && "opacity-50",
              )}
              style={{ marginLeft: depth * 12 }}
              data-testid={`channel-row-${channel.id}`}
            >
              <GripVertical className="size-3.5 shrink-0 cursor-grab text-faint" aria-hidden />
              <button
                type="button"
                onClick={() => setSelectedId(channel.id)}
                data-testid={`channel-select-${channel.id}`}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                  {channel.name}
                </span>
                {channel.afk ? <Badge variant="secondary">{t("admin.channels.afk")}</Badge> : null}
                {channel.passwordProtected ? (
                  <Badge variant="outline">{t("admin.channels.locked")}</Badge>
                ) : null}
              </button>
              <span className="shrink-0 text-[10px] tabular-nums text-faint">
                {channel.userCount > 0 ? channel.userCount : ""}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 space-y-1.5 border-t border-border pt-2">
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder={t("admin.channels.newName")}
            maxLength={100}
            data-testid="channel-new-name"
          />
          <div className="flex gap-1.5">
            <Select
              value={newParent}
              onChange={(event) => setNewParent(Number(event.target.value))}
              aria-label={t("admin.channels.parent")}
            >
              <option value={0}>{t("admin.channels.root")}</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </Select>
            <Select
              value={newKind}
              onChange={(event) => setNewKind(event.target.value as "voice" | "text")}
              aria-label={t("admin.channels.kind")}
            >
              <option value="voice">{t("admin.channels.voice")}</option>
              <option value="text">{t("admin.channels.text")}</option>
            </Select>
          </div>
          <div className="flex gap-1.5">
            <Input
              type="number"
              min={0}
              value={newLimit}
              onChange={(event) =>
                setNewLimit(Math.max(0, Number(event.target.value) || 0))
              }
              placeholder={t("admin.channels.limit")}
              aria-label={t("admin.channels.limit")}
              className="w-20"
            />
            <Select
              value={newProfile}
              onChange={(event) =>
                setNewProfile(event.target.value as typeof newProfile)
              }
              aria-label={t("admin.channels.profile")}
              disabled={newKind === "text"}
            >
              <option value="voice">{t("admin.channels.profileVoice")}</option>
              <option value="voiceHq">{t("admin.channels.profileHq")}</option>
              <option value="music">{t("admin.channels.profileMusic")}</option>
            </Select>
            <Input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder={t("admin.channels.password")}
              aria-label={t("admin.channels.password")}
              autoComplete="new-password"
              className="flex-1"
            />
          </div>
          <Button
            size="sm"
            className="w-full"
            disabled={newName.trim().length === 0 || action.pending}
            onClick={() => void create()}
            data-testid="channel-create"
          >
            <Plus className="size-3.5" aria-hidden />
            {t("admin.channels.create")}
          </Button>
          <AdminErrorNotice error={action.error} />
        </div>
      </AdminCard>

      <div className="min-h-0 space-y-3 overflow-y-auto pr-0.5">
        {selected && draft ? (
          <>
            <AdminCard
              title={t("admin.channels.editTitle", { name: selected.name })}
              hint={t("admin.channels.editHint")}
              actions={
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-danger hover:text-danger"
                  onClick={() => void remove()}
                  data-testid="channel-delete"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  {t("admin.common.delete")}
                </Button>
              }
            >
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="text-[11px] text-muted">{t("admin.channels.name")}</span>
                  <Input
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    maxLength={100}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-muted">{t("admin.channels.topic")}</span>
                  <Input
                    value={draft.topic}
                    onChange={(event) => setDraft({ ...draft, topic: event.target.value })}
                    maxLength={512}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-muted">{t("admin.channels.kind")}</span>
                  <Select
                    value={draft.kind}
                    onChange={(event) =>
                      setDraft({ ...draft, kind: event.target.value as "voice" | "text" })
                    }
                  >
                    <option value="voice">{t("admin.channels.voice")}</option>
                    <option value="text">{t("admin.channels.text")}</option>
                  </Select>
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-muted">{t("admin.channels.limit")}</span>
                  <Input
                    type="number"
                    min={0}
                    value={draft.userLimit}
                    onChange={(event) =>
                      setDraft({ ...draft, userLimit: Math.max(0, Number(event.target.value) || 0) })
                    }
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-muted">{t("admin.channels.profile")}</span>
                  <Select
                    value={draft.voiceProfile}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        voiceProfile: event.target.value as Draft["voiceProfile"],
                      })
                    }
                  >
                    <option value="voice">{t("admin.channels.profileVoice")}</option>
                    <option value="voiceHq">{t("admin.channels.profileHq")}</option>
                    <option value="music">{t("admin.channels.profileMusic")}</option>
                  </Select>
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-muted">{t("admin.channels.password")}</span>
                  <Input
                    type="password"
                    value={draft.password}
                    onChange={(event) =>
                      setDraft({ ...draft, password: event.target.value, clearPassword: false })
                    }
                    placeholder={
                      selected.passwordProtected
                        ? t("admin.channels.passwordSet")
                        : t("admin.channels.passwordNone")
                    }
                    autoComplete="new-password"
                  />
                </label>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-1.5 text-[12px] text-muted">
                  <Switch
                    checked={draft.temporary}
                    onCheckedChange={(temporary) => setDraft({ ...draft, temporary })}
                  />
                  {t("admin.channels.temporary")}
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-muted">
                  <Switch
                    checked={draft.afk}
                    onCheckedChange={(afk) => setDraft({ ...draft, afk })}
                  />
                  {t("admin.channels.afk")}
                </label>
                {selected.passwordProtected ? (
                  <label className="flex items-center gap-1.5 text-[12px] text-muted">
                    <Switch
                      checked={draft.clearPassword}
                      onCheckedChange={(clearPassword) => setDraft({ ...draft, clearPassword })}
                    />
                    {t("admin.channels.clearPassword")}
                  </label>
                ) : null}
                <Button
                  size="sm"
                  className="ml-auto"
                  disabled={action.pending || draft.name.trim().length === 0}
                  onClick={() => void save()}
                  data-testid="channel-save"
                >
                  {t("common.save")}
                </Button>
              </div>
              <AdminErrorNotice error={action.error} />
            </AdminCard>

            <AdminCard
              title={t("admin.channels.overridesTitle")}
              hint={t("admin.channels.overridesHint")}
              actions={<AdminPending pending={overrideAction.pending} />}
            >
              <div className="flex items-center gap-1.5">
                <Select
                  value={overrideRoleId}
                  onChange={(event) => setOverrideRoleId(Number(event.target.value))}
                  aria-label={t("admin.channels.overrideRole")}
                  data-testid="override-role"
                >
                  <option value={0}>{t("admin.channels.pickRole")}</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {roleName(role, t)}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  disabled={overrideRoleId === 0 || overrideAction.pending}
                  onClick={() => void saveOverride()}
                  data-testid="override-save"
                >
                  {t("common.save")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={overrideRoleId === 0 || overrideAction.pending}
                  onClick={() => void clearOverride()}
                >
                  {t("admin.channels.overrideClear")}
                </Button>
              </div>
              <table className="mt-2 w-full text-[11px]">
                <thead>
                  <tr className="text-left text-faint">
                    <th className="py-1 font-medium">{t("admin.channels.permission")}</th>
                    <th className="w-16 py-1 text-center font-medium">
                      {t("admin.channels.allow")}
                    </th>
                    <th className="w-16 py-1 text-center font-medium">
                      {t("admin.channels.deny")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {channelPermissions.map((definition) => (
                    <tr key={definition.name} className="border-t border-border/60">
                      <td className="py-1 text-foreground">
                        {t(`admin.permission.${definition.name}.label`)}
                      </td>
                      <td className="py-1 text-center">
                        <input
                          type="checkbox"
                          className="accent-[var(--color-success)]"
                          checked={allow.includes(definition.name)}
                          onChange={(event) =>
                            togglePermission(definition.name, "allow", event.target.checked)
                          }
                          aria-label={`${t(`admin.permission.${definition.name}.label`)} ${t("admin.channels.allow")}`}
                        />
                      </td>
                      <td className="py-1 text-center">
                        <input
                          type="checkbox"
                          className="accent-[var(--color-danger)]"
                          checked={deny.includes(definition.name)}
                          onChange={(event) =>
                            togglePermission(definition.name, "deny", event.target.checked)
                          }
                          aria-label={`${t(`admin.permission.${definition.name}.label`)} ${t("admin.channels.deny")}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-[10px] text-faint">{t("admin.channels.overridesOrder")}</p>
              <AdminErrorNotice error={overrideAction.error} />
            </AdminCard>
          </>
        ) : (
          <AdminCard title={t("admin.channels.pickTitle")} hint={t("admin.channels.pickHint")}>
            <AdminEmpty>{t("admin.channels.pickEmpty")}</AdminEmpty>
          </AdminCard>
        )}
      </div>
    </div>
  );
}
