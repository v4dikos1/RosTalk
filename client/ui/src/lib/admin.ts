import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import type {
  ChannelKindView,
  ChannelView,
  LoginModeView,
  VoiceProfileView,
} from "@/core/api";
import type { Channel, Role } from "@/proto/rostalk/v1/state_pb";
import { coreApi } from "@/core";
import {
  AdminActionSchema,
  AdminResultSchema,
  ApiTokenCreateSchema,
  ApiTokenListQuerySchema,
  ApiTokenRevokeSchema,
  AuditListSchema,
  BanListQuerySchema,
  ChannelCreateSchema,
  ChannelDeleteSchema,
  ChannelMoveSchema,
  ChannelOverrideClearSchema,
  ChannelOverrideListQuerySchema,
  ChannelOverrideSetSchema,
  ChannelUpdateSchema,
  InviteCreateSchema,
  InviteListQuerySchema,
  InviteRevokeSchema,
  MemberBanSchema,
  MemberKickSchema,
  MemberListQuerySchema,
  MemberMoveSchema,
  MemberSetDeafenedSchema,
  MemberSetMutedSchema,
  MemberUnbanSchema,
  RoleAssignSchema,
  RoleCreateSchema,
  RoleDeleteSchema,
  RoleReorderSchema,
  RoleUnassignSchema,
  RoleUpdateSchema,
  ServerSettingsSetSchema,
  type AdminAction,
  type AdminResult,
  type ApiToken,
  type AuditEntry,
  type BanEntry,
  type ChannelOverride,
  type Invite,
  type UserListEntry,
} from "@/proto/rostalk/v1/admin_pb";
import { ChannelKind, LoginMode, VoiceProfile } from "@/proto/rostalk/v1/state_pb";
import { permissionsToNames } from "@/lib/permissions";

/**
 * Typed access to the administration protocol (stage 3.2).
 *
 * The UI builds the generated protobuf messages and sends their bytes through
 * the core. There is no second DTO layer, so `admin.proto` stays the single
 * source of truth; the view helpers below only turn bigint ids and enums into
 * values React can render.
 */
export async function sendAdmin(action: AdminAction): Promise<AdminResult> {
  const reply = await coreApi.adminAction(
    toBinary(AdminActionSchema, action),
  );
  return fromBinary(AdminResultSchema, reply);
}

function wrap<Case extends string, Value>(
  actionCase: Case,
  value: Value,
): AdminAction {
  return create(AdminActionSchema, {
    action: { case: actionCase, value } as never,
  });
}

// -------------------------------------------------------------- results ---

export function resultUsers(result: AdminResult): AdminUser[] {
  return result.result?.case === "users"
    ? result.result.value.users.map(userView)
    : [];
}

export function resultInvites(result: AdminResult): AdminInvite[] {
  return result.result?.case === "invites"
    ? result.result.value.invites.map(inviteView)
    : [];
}

export function resultInvite(result: AdminResult): AdminInvite | null {
  return result.result?.case === "invite"
    ? inviteView(result.result.value)
    : null;
}

export function resultBans(result: AdminResult): AdminBan[] {
  return result.result?.case === "bans"
    ? result.result.value.bans.map(banView)
    : [];
}

export function resultAudit(result: AdminResult): {
  entries: AdminAuditEntry[];
  hasMore: boolean;
  nextBeforeId: number;
} {
  if (result.result?.case !== "audit") {
    return { entries: [], hasMore: false, nextBeforeId: 0 };
  }
  const page = result.result.value;
  return {
    entries: page.entries.map(auditView),
    hasMore: page.hasMore,
    nextBeforeId: Number(page.nextBeforeId),
  };
}

export function resultTokens(result: AdminResult): AdminToken[] {
  return result.result?.case === "apiTokens"
    ? result.result.value.tokens.map(tokenView)
    : [];
}

export function resultToken(result: AdminResult): AdminToken | null {
  return result.result?.case === "apiToken"
    ? tokenView(result.result.value)
    : null;
}

export function resultOverrides(result: AdminResult): AdminOverride[] {
  return result.result?.case === "overrides"
    ? result.result.value.overrides.map(overrideView)
    : [];
}

// ---------------------------------------------------------------- views ---

export interface AdminRole {
  id: number;
  name: string;
  color: number;
  position: number;
  builtin: boolean;
  permissions: string[];
}

export function roleView(role: Role): AdminRole {
  return {
    id: Number(role.id),
    name: role.name,
    color: role.color,
    position: role.position,
    builtin: role.builtin,
    permissions: permissionsToNames(role.permissions?.permissions ?? []),
  };
}

export function roleViews(roles: readonly Role[]): AdminRole[] {
  return roles.map(roleView);
}

export interface AdminUser {
  id: number;
  nickname: string;
  roleIds: number[];
  online: boolean;
  lastSeenAtUnixMs: number;
  channelId: number;
}

export function userView(user: UserListEntry): AdminUser {
  return {
    id: Number(user.id),
    nickname: user.nickname,
    roleIds: user.roleIds.map(Number),
    online: user.online,
    lastSeenAtUnixMs: Number(user.lastSeenAtUnixMs),
    channelId: Number(user.channelId),
  };
}

export interface AdminInvite {
  id: number;
  roleId: number;
  createdBy: number;
  createdAtUnixMs: number;
  expiresAtUnixMs: number;
  maxUses: number;
  usedCount: number;
  revokedAtUnixMs: number;
  url: string;
}

export function inviteView(invite: Invite): AdminInvite {
  return {
    id: Number(invite.id),
    roleId: Number(invite.roleId),
    createdBy: Number(invite.createdBy),
    createdAtUnixMs: Number(invite.createdAtUnixMs),
    expiresAtUnixMs: Number(invite.expiresAtUnixMs),
    maxUses: invite.maxUses,
    usedCount: invite.usedCount,
    revokedAtUnixMs: Number(invite.revokedAtUnixMs),
    url: invite.url,
  };
}

export interface AdminBan {
  id: number;
  userId: number;
  publicKey: string;
  ip: string;
  reason: string;
  createdBy: number;
  createdAtUnixMs: number;
  expiresAtUnixMs: number;
  expired: boolean;
}

export function banView(ban: BanEntry): AdminBan {
  return {
    id: Number(ban.id),
    userId: Number(ban.userId),
    publicKey: ban.publicKey,
    ip: ban.ip,
    reason: ban.reason,
    createdBy: Number(ban.createdBy),
    createdAtUnixMs: Number(ban.createdAtUnixMs),
    expiresAtUnixMs: Number(ban.expiresAtUnixMs),
    expired: ban.expired,
  };
}

export interface AdminAuditEntry {
  id: number;
  actorId: number;
  actorName: string;
  action: string;
  targetUserId: number;
  targetChannelId: number;
  targetRoleId: number;
  details: string;
  createdAtUnixMs: number;
}

export function auditView(entry: AuditEntry): AdminAuditEntry {
  return {
    id: Number(entry.id),
    actorId: Number(entry.actorId),
    actorName: entry.actorName,
    action: entry.action,
    targetUserId: Number(entry.targetUserId),
    targetChannelId: Number(entry.targetChannelId),
    targetRoleId: Number(entry.targetRoleId),
    details: entry.details,
    createdAtUnixMs: Number(entry.createdAtUnixMs),
  };
}

export interface AdminToken {
  id: number;
  name: string;
  roleId: number;
  createdBy: number;
  createdAtUnixMs: number;
  expiresAtUnixMs: number;
  revokedAtUnixMs: number;
  lastUsedAtUnixMs: number;
  token: string;
}

export function tokenView(token: ApiToken): AdminToken {
  return {
    id: Number(token.id),
    name: token.name,
    roleId: Number(token.roleId),
    createdBy: Number(token.createdBy),
    createdAtUnixMs: Number(token.createdAtUnixMs),
    expiresAtUnixMs: Number(token.expiresAtUnixMs),
    revokedAtUnixMs: Number(token.revokedAtUnixMs),
    lastUsedAtUnixMs: Number(token.lastUsedAtUnixMs),
    token: token.token,
  };
}

export interface AdminOverride {
  channelId: number;
  roleId: number;
  allow: string[];
  deny: string[];
}

export function overrideView(override: ChannelOverride): AdminOverride {
  return {
    channelId: Number(override.channelId),
    roleId: Number(override.roleId),
    allow: permissionsToNames(override.allow?.permissions ?? []),
    deny: permissionsToNames(override.deny?.permissions ?? []),
  };
}

export function channelKindName(kind: ChannelKind): ChannelKindView {
  return kind === ChannelKind.TEXT ? "text" : "voice";
}

export function channelKindValue(kind: ChannelKindView): ChannelKind {
  return kind === "text" ? ChannelKind.TEXT : ChannelKind.VOICE;
}

export function voiceProfileName(profile: VoiceProfile): VoiceProfileView {
  switch (profile) {
    case VoiceProfile.VOICE_HQ:
      return "voiceHq";
    case VoiceProfile.MUSIC:
      return "music";
    default:
      return "voice";
  }
}

export function voiceProfileValue(profile: VoiceProfileView): VoiceProfile {
  switch (profile) {
    case "voiceHq":
      return VoiceProfile.VOICE_HQ;
    case "music":
      return VoiceProfile.MUSIC;
    default:
      return VoiceProfile.VOICE;
  }
}

export function loginModeName(mode: LoginMode): LoginModeView {
  switch (mode) {
    case LoginMode.PASSWORD:
      return "password";
    case LoginMode.OPEN:
      return "open";
    default:
      return "invite";
  }
}

export function loginModeValue(mode: LoginModeView): LoginMode {
  switch (mode) {
    case "password":
      return LoginMode.PASSWORD;
    case "open":
      return LoginMode.OPEN;
    default:
      return LoginMode.INVITE;
  }
}

/** Admin channel as the tree editor needs it (counts included). */
export function channelView(channel: Channel): ChannelView {
  return {
    id: Number(channel.id),
    parentId: Number(channel.parentId),
    position: channel.position,
    name: channel.name,
    topic: channel.topic,
    kind: channelKindName(channel.kind),
    userLimit: channel.userLimit,
    passwordProtected: channel.passwordProtected,
    temporary: channel.temporary,
    userCount: channel.userCount,
    voiceProfile: voiceProfileName(channel.voiceProfile),
    afk: channel.afk,
  };
}

export function colorToHex(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
}

export function hexToColor(hex: string): number {
  const value = Number.parseInt(hex.replace(/^#/, ""), 16);
  return Number.isFinite(value) ? value >>> 0 : 0;
}

// ------------------------------------------------------------- actions ---

export function roleCreate(value: {
  name: string;
  color: number;
  position?: number;
  permissions: number[];
}): AdminAction {
  return wrap(
    "roleCreate",
    create(RoleCreateSchema, {
      name: value.name,
      color: value.color,
      position: value.position,
      permissions: { permissions: value.permissions },
    }),
  );
}

export function roleUpdate(value: {
  roleId: number;
  name?: string | undefined;
  color?: number | undefined;
  position?: number | undefined;
  permissions?: number[] | undefined;
}): AdminAction {
  return wrap(
    "roleUpdate",
    create(RoleUpdateSchema, {
      roleId: BigInt(value.roleId),
      name: value.name,
      color: value.color,
      position: value.position,
      permissions:
        value.permissions !== undefined
          ? { permissions: value.permissions }
          : undefined,
    }),
  );
}

export function roleDelete(roleId: number): AdminAction {
  return wrap("roleDelete", create(RoleDeleteSchema, { roleId: BigInt(roleId) }));
}

export function roleReorder(roleIds: number[]): AdminAction {
  return wrap(
    "roleReorder",
    create(RoleReorderSchema, { roleIds: roleIds.map(BigInt) }),
  );
}

export function roleAssign(userId: number, roleId: number): AdminAction {
  return wrap(
    "roleAssign",
    create(RoleAssignSchema, {
      userId: BigInt(userId),
      roleId: BigInt(roleId),
    }),
  );
}

export function roleUnassign(userId: number, roleId: number): AdminAction {
  return wrap(
    "roleUnassign",
    create(RoleUnassignSchema, {
      userId: BigInt(userId),
      roleId: BigInt(roleId),
    }),
  );
}

export function serverSettingsSet(value: {
  name?: string | undefined;
  loginMode?: LoginModeView | undefined;
  maxUsers?: number | undefined;
  password?: string | undefined;
  /** Bytes; the admin form edits MiB but the wire field is bytes. */
  maxAttachmentBytes?: number | undefined;
}): AdminAction {
  return wrap(
    "serverSettingsSet",
    create(ServerSettingsSetSchema, {
      name: value.name,
      loginMode:
        value.loginMode !== undefined
          ? loginModeValue(value.loginMode)
          : undefined,
      maxUsers: value.maxUsers,
      password: value.password,
      maxAttachmentBytes:
        value.maxAttachmentBytes !== undefined
          ? BigInt(value.maxAttachmentBytes)
          : undefined,
    }),
  );
}

export function inviteCreate(value: {
  roleId: number;
  expiresInSeconds: number;
  maxUses: number;
}): AdminAction {
  return wrap(
    "inviteCreate",
    create(InviteCreateSchema, {
      roleId: BigInt(value.roleId),
      expiresInSeconds: value.expiresInSeconds,
      maxUses: value.maxUses,
    }),
  );
}

export function inviteRevoke(inviteId: number): AdminAction {
  return wrap(
    "inviteRevoke",
    create(InviteRevokeSchema, { inviteId: BigInt(inviteId) }),
  );
}

export function inviteList(includeInactive = false): AdminAction {
  return wrap(
    "inviteList",
    create(InviteListQuerySchema, { includeInactive }),
  );
}

export function memberList(query = "", includeOffline = true): AdminAction {
  return wrap(
    "memberList",
    create(MemberListQuerySchema, { query, includeOffline }),
  );
}

export function memberKick(userId: number, reason: string): AdminAction {
  return wrap(
    "memberKick",
    create(MemberKickSchema, { userId: BigInt(userId), reason }),
  );
}

export function memberBan(value: {
  userId: number;
  reason: string;
  expiresInSeconds: number;
  byKey: boolean;
  byIp: boolean;
}): AdminAction {
  return wrap(
    "memberBan",
    create(MemberBanSchema, {
      userId: BigInt(value.userId),
      reason: value.reason,
      expiresInSeconds: value.expiresInSeconds,
      byKey: value.byKey,
      byIp: value.byIp,
    }),
  );
}

export function memberUnban(value: { userId?: number; ip?: string }): AdminAction {
  return wrap(
    "memberUnban",
    create(MemberUnbanSchema, {
      userId: BigInt(value.userId ?? 0),
      ip: value.ip ?? "",
    }),
  );
}

export function memberMove(userId: number, channelId: number): AdminAction {
  return wrap(
    "memberMove",
    create(MemberMoveSchema, {
      userId: BigInt(userId),
      channelId: BigInt(channelId),
    }),
  );
}

export function memberSetMuted(userId: number, muted: boolean): AdminAction {
  return wrap(
    "memberSetMuted",
    create(MemberSetMutedSchema, { userId: BigInt(userId), muted }),
  );
}

export function memberSetDeafened(
  userId: number,
  deafened: boolean,
): AdminAction {
  return wrap(
    "memberSetDeafened",
    create(MemberSetDeafenedSchema, {
      userId: BigInt(userId),
      deafened,
    }),
  );
}

export function auditList(value: {
  limit?: number;
  beforeId?: number;
  actionPrefix?: string;
  actorId?: number;
}): AdminAction {
  return wrap(
    "auditList",
    create(AuditListSchema, {
      limit: value.limit ?? 50,
      beforeId: BigInt(value.beforeId ?? 0),
      actionPrefix: value.actionPrefix ?? "",
      actorId: BigInt(value.actorId ?? 0),
    }),
  );
}

export function banList(includeExpired = false): AdminAction {
  return wrap("banList", create(BanListQuerySchema, { includeExpired }));
}

export function channelCreate(value: {
  parentId: number;
  name: string;
  topic: string;
  kind: ChannelKindView;
  userLimit: number;
  voiceProfile: VoiceProfileView;
  temporary: boolean;
  afk: boolean;
  password: string;
  position?: number;
}): AdminAction {
  return wrap(
    "channelCreate",
    create(ChannelCreateSchema, {
      parentId: BigInt(value.parentId),
      name: value.name,
      topic: value.topic,
      kind: channelKindValue(value.kind),
      userLimit: value.userLimit,
      voiceProfile: voiceProfileValue(value.voiceProfile),
      temporary: value.temporary,
      afk: value.afk,
      password: value.password,
      position: value.position,
    }),
  );
}

export function channelUpdate(value: {
  channelId: number;
  name?: string | undefined;
  topic?: string | undefined;
  kind?: ChannelKindView | undefined;
  userLimit?: number | undefined;
  voiceProfile?: VoiceProfileView | undefined;
  temporary?: boolean | undefined;
  afk?: boolean | undefined;
  password?: string | undefined;
}): AdminAction {
  return wrap(
    "channelUpdate",
    create(ChannelUpdateSchema, {
      channelId: BigInt(value.channelId),
      name: value.name,
      topic: value.topic,
      kind:
        value.kind !== undefined ? channelKindValue(value.kind) : undefined,
      userLimit: value.userLimit,
      voiceProfile:
        value.voiceProfile !== undefined
          ? voiceProfileValue(value.voiceProfile)
          : undefined,
      temporary: value.temporary,
      afk: value.afk,
      password: value.password,
    }),
  );
}

export function channelDelete(channelId: number): AdminAction {
  return wrap(
    "channelDelete",
    create(ChannelDeleteSchema, { channelId: BigInt(channelId) }),
  );
}

export function channelMove(value: {
  channelId: number;
  parentId: number;
  position?: number;
}): AdminAction {
  return wrap(
    "channelMove",
    create(ChannelMoveSchema, {
      channelId: BigInt(value.channelId),
      parentId: BigInt(value.parentId),
      position: value.position,
    }),
  );
}

export function overrideList(channelId: number): AdminAction {
  return wrap(
    "channelOverrideList",
    create(ChannelOverrideListQuerySchema, {
      channelId: BigInt(channelId),
    }),
  );
}

export function overrideSet(value: {
  channelId: number;
  roleId: number;
  allow: number[];
  deny: number[];
}): AdminAction {
  return wrap(
    "channelOverrideSet",
    create(ChannelOverrideSetSchema, {
      channelId: BigInt(value.channelId),
      roleId: BigInt(value.roleId),
      allow: { permissions: value.allow },
      deny: { permissions: value.deny },
    }),
  );
}

export function overrideClear(channelId: number, roleId = 0): AdminAction {
  return wrap(
    "channelOverrideClear",
    create(ChannelOverrideClearSchema, {
      channelId: BigInt(channelId),
      roleId: BigInt(roleId),
    }),
  );
}

export function tokenCreate(value: {
  name: string;
  roleId: number;
  expiresInSeconds: number;
}): AdminAction {
  return wrap(
    "apiTokenCreate",
    create(ApiTokenCreateSchema, {
      name: value.name,
      roleId: BigInt(value.roleId),
      expiresInSeconds: value.expiresInSeconds,
    }),
  );
}

export function tokenList(): AdminAction {
  return wrap(
    "apiTokenList",
    create(ApiTokenListQuerySchema, {}),
  );
}

export function tokenRevoke(tokenId: number): AdminAction {
  return wrap(
    "apiTokenRevoke",
    create(ApiTokenRevokeSchema, { tokenId: BigInt(tokenId) }),
  );
}
