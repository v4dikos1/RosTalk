import type { RoleView } from "@/core/api";
import { Permission } from "@/proto/rostalk/v1/state_pb";

/**
 * UI mirror of `rostalk.v1.Permission`. The server is the authority; these names
 * only hide controls and pre-check the permission matrix. `manageServer`
 * bypasses every other server right, exactly like on the server.
 */
export const PERMISSION_NAMES: Record<Permission, string> = {
  [Permission.UNSPECIFIED]: "unspecified",
  [Permission.MANAGE_SERVER]: "manageServer",
  [Permission.MANAGE_ROLES]: "manageRoles",
  [Permission.MANAGE_CHANNELS]: "manageChannels",
  [Permission.MANAGE_INVITES]: "manageInvites",
  [Permission.VIEW_AUDIT_LOG]: "viewAuditLog",
  [Permission.KICK]: "kick",
  [Permission.BAN]: "ban",
  [Permission.MOVE_MEMBERS]: "moveMembers",
  [Permission.MUTE_MEMBERS]: "muteMembers",
  [Permission.DEAFEN_MEMBERS]: "deafenMembers",
  [Permission.VIEW_CHANNEL]: "viewChannel",
  [Permission.JOIN_CHANNEL]: "joinChannel",
  [Permission.SPEAK]: "speak",
  [Permission.USE_VOICE_ACTIVATION]: "useVoiceActivation",
  [Permission.PRIORITY_SPEAKER]: "prioritySpeaker",
  [Permission.BYPASS_USER_LIMIT]: "bypassUserLimit",
  [Permission.BYPASS_CHANNEL_PASSWORD]: "bypassChannelPassword",
  [Permission.STREAM]: "stream",
  [Permission.STREAM_HQ]: "streamHq",
  [Permission.CREATE_TEMP_CHANNEL]: "createTempChannel",
  [Permission.CHANGE_NICKNAME]: "changeNickname",
  [Permission.SEND_MESSAGES]: "sendMessages",
  [Permission.ATTACH_FILES]: "attachFiles",
  [Permission.MANAGE_MESSAGES]: "manageMessages",
};

const BY_NAME = new Map<string, Permission>(
  Object.entries(PERMISSION_NAMES).map(([value, name]) => [
    name,
    Number(value) as Permission,
  ]),
);

export function permissionName(value: Permission): string {
  return PERMISSION_NAMES[value] ?? "unspecified";
}

export function permissionsToNames(values: readonly Permission[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const name = permissionName(value);
    if (name !== "unspecified") {
      seen.add(name);
    }
  }
  return [...seen].sort();
}

export function namesToPermissions(names: readonly string[]): Permission[] {
  const out = new Set<Permission>();
  for (const name of names) {
    const value = BY_NAME.get(name);
    if (value !== undefined) {
      out.add(value);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export type AdminTabId =
  | "general"
  | "roles"
  | "channels"
  | "invites"
  | "members"
  | "audit"
  | "tokens";

/**
 * Which administration tabs a permission set may see. This is the same rule the
 * server enforces, mirrored so a section is not offered when it would only
 * produce a 403. `manageServer` implies every tab.
 */
export function adminTabIds(permissions: readonly string[] | null | undefined): AdminTabId[] {
  const out: AdminTabId[] = [];
  if (hasPermission(permissions, "manageServer")) {
    out.push("general");
  }
  if (hasPermission(permissions, "manageRoles")) {
    out.push("roles");
  }
  if (hasPermission(permissions, "manageChannels")) {
    out.push("channels");
  }
  if (hasPermission(permissions, "manageInvites")) {
    out.push("invites");
  }
  if (
    hasPermission(permissions, "manageRoles") ||
    hasPermission(permissions, "kick") ||
    hasPermission(permissions, "ban") ||
    hasPermission(permissions, "moveMembers") ||
    hasPermission(permissions, "muteMembers") ||
    hasPermission(permissions, "deafenMembers")
  ) {
    out.push("members");
  }
  if (hasPermission(permissions, "viewAuditLog")) {
    out.push("audit");
  }
  if (hasPermission(permissions, "manageServer")) {
    out.push("tokens");
  }
  return out;
}

/** True when a permission set contains the right; `manageServer` wins. */
export function hasPermission(names: readonly string[] | null | undefined, name: string): boolean {
  if (!names) {
    return false;
  }
  if (names.includes("manageServer")) {
    return true;
  }
  return names.includes(name);
}

/** Only the explicit bit, without the `manageServer` bypass. */
export function hasExplicit(names: readonly string[] | null | undefined, name: string): boolean {
  return names?.includes(name) ?? false;
}

export interface PermissionDefinition {
  name: string;
  permission: Permission;
  group: "server" | "moderation" | "channel" | "misc";
}

export const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  { name: "manageServer", permission: Permission.MANAGE_SERVER, group: "server" },
  { name: "manageRoles", permission: Permission.MANAGE_ROLES, group: "server" },
  { name: "manageChannels", permission: Permission.MANAGE_CHANNELS, group: "server" },
  { name: "manageInvites", permission: Permission.MANAGE_INVITES, group: "server" },
  { name: "viewAuditLog", permission: Permission.VIEW_AUDIT_LOG, group: "server" },
  { name: "kick", permission: Permission.KICK, group: "moderation" },
  { name: "ban", permission: Permission.BAN, group: "moderation" },
  { name: "moveMembers", permission: Permission.MOVE_MEMBERS, group: "moderation" },
  { name: "muteMembers", permission: Permission.MUTE_MEMBERS, group: "moderation" },
  { name: "deafenMembers", permission: Permission.DEAFEN_MEMBERS, group: "moderation" },
  { name: "viewChannel", permission: Permission.VIEW_CHANNEL, group: "channel" },
  { name: "joinChannel", permission: Permission.JOIN_CHANNEL, group: "channel" },
  { name: "speak", permission: Permission.SPEAK, group: "channel" },
  { name: "useVoiceActivation", permission: Permission.USE_VOICE_ACTIVATION, group: "channel" },
  { name: "prioritySpeaker", permission: Permission.PRIORITY_SPEAKER, group: "channel" },
  { name: "bypassUserLimit", permission: Permission.BYPASS_USER_LIMIT, group: "channel" },
  { name: "bypassChannelPassword", permission: Permission.BYPASS_CHANNEL_PASSWORD, group: "channel" },
  { name: "stream", permission: Permission.STREAM, group: "channel" },
  { name: "streamHq", permission: Permission.STREAM_HQ, group: "channel" },
  { name: "sendMessages", permission: Permission.SEND_MESSAGES, group: "channel" },
  { name: "attachFiles", permission: Permission.ATTACH_FILES, group: "channel" },
  { name: "manageMessages", permission: Permission.MANAGE_MESSAGES, group: "channel" },
  { name: "createTempChannel", permission: Permission.CREATE_TEMP_CHANNEL, group: "misc" },
  { name: "changeNickname", permission: Permission.CHANGE_NICKNAME, group: "misc" },
];

export const PERMISSION_GROUPS: { id: PermissionDefinition["group"]; permissions: PermissionDefinition[] }[] = [
  { id: "server", permissions: PERMISSION_DEFINITIONS.filter((item) => item.group === "server") },
  { id: "moderation", permissions: PERMISSION_DEFINITIONS.filter((item) => item.group === "moderation") },
  { id: "channel", permissions: PERMISSION_DEFINITIONS.filter((item) => item.group === "channel") },
  { id: "misc", permissions: PERMISSION_DEFINITIONS.filter((item) => item.group === "misc") },
];

/** Highest role position of a user; -1 when the user has no role. */
export function highestPosition(
  roleIds: readonly number[],
  roles: readonly Pick<RoleView, "id" | "position">[],
): number {
  let highest = -1;
  for (const role of roles) {
    if (roleIds.includes(role.id) && role.position > highest) {
      highest = role.position;
    }
  }
  return highest;
}

/**
 * The server refuses to act on a role at or above the actor's highest role.
 * The UI mirrors it so a doomed control is not offered in the first place.
 */
export function canManagePosition(
  actorHighest: number,
  targetHighest: number,
  manageServer: boolean,
): boolean {
  if (manageServer) {
    return true;
  }
  return targetHighest < actorHighest;
}

export function canManageRole(
  role: Pick<RoleView, "position">,
  actorHighest: number,
  manageServer: boolean,
): boolean {
  return canManagePosition(actorHighest, role.position, manageServer);
}

/** True when a role can be handed out: below the actor and not richer. */
export function canGrantRole(
  role: { position: number; permissions: readonly string[] },
  actor: { highest: number; permissions: readonly string[]; manageServer: boolean },
): boolean {
  if (actor.manageServer) {
    return true;
  }
  if (!canManagePosition(actor.highest, role.position, false)) {
    return false;
  }
  return role.permissions.every((permission) => actor.permissions.includes(permission));
}
