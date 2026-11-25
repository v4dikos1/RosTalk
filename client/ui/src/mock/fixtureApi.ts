import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import type {
  ChatProxyView,
  ClientSettings,
  CoreApi,
  CoreEvent,
  CoreState,
  DeviceList,
  IdentityInfo,
  ParticipantSettings,
  ServerBookmark,
  ServerProbeView,
  StreamCredentialsView,
  UpdateCheck,
  VoiceEvent,
  VoiceState,
} from "@/core/api";
import {
  AdminActionSchema,
  AdminResultSchema,
  type AdminAction,
  type AdminResult,
} from "@/proto/rostalk/v1/admin_pb";
import {
  ChannelSchema,
  RoleSchema,
  type Channel,
  type Role,
} from "@/proto/rostalk/v1/state_pb";
import { namesToPermissions } from "@/lib/permissions";

import { subscribeFixtureAvatars } from "./avatarFixtures";
import { fixtureDevices, fixtureSettings, fixtureState } from "./fixtures";

const fixtureVoiceState: VoiceState = {
  media: "connected",
  publishing: true,
  publishAllowed: true,
  channelId: 3,
  selfMuted: false,
  deafened: false,
  micTest: false,
  gate: { mode: "voiceActivation", threshold_db: -45, hold_ms: 300 },
  pushToTalk: { hook: "active", binding: "X1/X2", error: null },
  inputDevice: "fixture-mic",
  outputDevice: "fixture-headphones",
  error: null,
};

/**
 * Browser adapter used only by the component gallery and Playwright
 * screenshots (design 5.1: a real browser adapter arrives after the MVP).
 *
 * It performs no network I/O and is never selected inside the desktop shell:
 * `src/core/index.ts` picks it only when there is no Tauri runtime and either
 * `?fixtures=1` is present or the Vite dev server is running.
 */

let settings: ClientSettings = structuredClone(fixtureSettings);
let devices: DeviceList = structuredClone(fixtureDevices);
let voice: VoiceState = structuredClone(fixtureVoiceState);
const coreListeners = new Set<(event: CoreEvent) => void>();

// An upload on another page (or this one) arrives as the same userUpdated
// delta the real core would send after the server broadcast.
subscribeFixtureAvatars(({ userId }) => {
  const user = fixtureState.users.find((item) => item.id === userId);
  if (!user) {
    return;
  }
  const event: CoreEvent = {
    type: "delta",
    payload: { type: "userUpdated", payload: structuredClone(user) },
  };
  for (const listener of coreListeners) {
    listener(event);
  }
});

/** Alternate screens for state screenshots (`?state=banned`, …). */
function stateForQuery(): CoreState {
  const params = new URLSearchParams(window.location.search);
  const variant = params.get("state");
  const base = structuredClone(fixtureState);
  if (variant === "disconnected") {
    return {
      ...base,
      connection: "disconnected",
      server: null,
      roles: [],
      channels: [],
      users: [],
      selfUserId: 0,
      nickname: "",
      permissions: null,
      unread: [],
      error: null,
    };
  }
  if (variant === "banned") {
    return {
      ...base,
      connection: "disconnected",
      server: null,
      roles: [],
      channels: [],
      users: [],
      selfUserId: 0,
      nickname: "",
      permissions: null,
      unread: [],
      error: {
        code: "serverError",
        message: "server rejected the handshake: banned",
        retryable: false,
        actionUrl: null,
        serverCode: "banned",
      },
    };
  }
  if (variant === "outdated") {
    return {
      ...base,
      connection: "disconnected",
      server: null,
      roles: [],
      channels: [],
      users: [],
      selfUserId: 0,
      nickname: "",
      permissions: null,
      unread: [],
      error: {
        code: "protocolVersionUnsupported",
        message: "server speaks protocol 2, client 1",
        retryable: false,
        actionUrl: "https://example.invalid/rostalk/download",
        serverCode: "protocolVersionUnsupported",
      },
    };
  }
  if (variant === "reconnecting") {
    return {
      ...base,
      connection: "reconnecting",
      reconnect: { attempt: 3, delayMs: 4000 },
    };
  }
  if (variant === "connecting") {
    return {
      ...base,
      connection: "connecting",
      server: null,
      roles: [],
      channels: [],
      users: [],
      selfUserId: 0,
      nickname: "",
      permissions: null,
      unread: [],
    };
  }
  if (params.get("admin") === "0" && base.permissions) {
    // The same connected server without administration rights: the menu and
    // the settings must hide the server section, the server still decides.
    base.permissions = {
      ...base.permissions,
      server: ["changeNickname"],
    };
    const self = base.users.find((user) => user.id === base.selfUserId);
    if (self) {
      self.roleIds = [3];
    }
  }
  return base;
}

// ------------------------------------------------------- admin fixture ---

let fixtureRolesAdmin = structuredClone(fixtureState.roles);
let fixtureChannelsAdmin = structuredClone(fixtureState.channels);
// A fixed clock keeps Playwright screenshots byte-identical between runs.
const FIXTURE_NOW = Date.UTC(2026, 10, 21, 12, 0);

let fixtureInvites = [
  {
    id: 1,
    roleId: 3,
    createdBy: 1,
    createdAtUnixMs: FIXTURE_NOW - 86_400_000,
    expiresAtUnixMs: FIXTURE_NOW + 6 * 86_400_000,
    maxUses: 5,
    usedCount: 2,
    revokedAtUnixMs: 0,
    url: "",
  },
  {
    id: 2,
    roleId: 3,
    createdBy: 1,
    createdAtUnixMs: FIXTURE_NOW - 3_600_000,
    expiresAtUnixMs: 0,
    maxUses: 1,
    usedCount: 1,
    revokedAtUnixMs: 0,
    url: "",
  },
];
const fixtureBans = [
  {
    id: 9,
    userId: 0,
    publicKey: "ab".repeat(32),
    ip: "",
    reason: "spam",
    createdBy: 1,
    createdAtUnixMs: FIXTURE_NOW - 7_200_000,
    expiresAtUnixMs: 0,
    expired: false,
  },
];
let fixtureTokens = [
  {
    id: 1,
    name: "deploy-bot",
    roleId: 3,
    createdBy: 1,
    createdAtUnixMs: FIXTURE_NOW - 172_800_000,
    expiresAtUnixMs: FIXTURE_NOW + 30 * 86_400_000,
    revokedAtUnixMs: 0,
    lastUsedAtUnixMs: FIXTURE_NOW - 300_000,
    token: "",
  },
];
const fixtureAudit = [
  { id: 5, actorId: 1, actorName: "Alex", action: "member.kick", targetUserId: 4, targetChannelId: 0, targetRoleId: 0, details: "AFK", createdAtUnixMs: FIXTURE_NOW - 1_800_000 },
  { id: 4, actorId: 1, actorName: "Alex", action: "role.update", targetUserId: 0, targetChannelId: 0, targetRoleId: 2, details: "Moderator", createdAtUnixMs: FIXTURE_NOW - 3_600_000 },
  { id: 3, actorId: 1, actorName: "Alex", action: "invite.create", targetUserId: 0, targetChannelId: 0, targetRoleId: 3, details: "uses=5", createdAtUnixMs: FIXTURE_NOW - 7_200_000 },
  { id: 2, actorId: 0, actorName: "cli", action: "settings.update", targetUserId: 0, targetChannelId: 0, targetRoleId: 0, details: "name", createdAtUnixMs: FIXTURE_NOW - 86_400_000 },
];

function protoRole(role: (typeof fixtureState.roles)[number]): Role {
  return create(RoleSchema, {
    id: BigInt(role.id),
    name: role.name,
    color: role.color ? Number.parseInt(role.color.replace("#", ""), 16) : 0,
    position: role.position,
    builtin: role.builtin,
    permissions: { permissions: namesToPermissions(role.permissions) },
  });
}

function protoChannel(channel: (typeof fixtureState.channels)[number]): Channel {
  return create(ChannelSchema, {
    id: BigInt(channel.id),
    parentId: BigInt(channel.parentId),
    position: channel.position,
    name: channel.name,
    topic: channel.topic,
    kind: channel.kind === "text" ? 2 : 1,
    userLimit: channel.userLimit,
    passwordProtected: channel.passwordProtected,
    voiceProfile:
      channel.voiceProfile === "voiceHq" ? 2 : channel.voiceProfile === "music" ? 3 : 1,
    temporary: channel.temporary,
    userCount: channel.userCount,
    afk: channel.afk,
  });
}

function adminOK(): AdminResult {
  return create(AdminResultSchema, {
    result: { case: "ok", value: true } as never,
  });
}

function adminResult<T extends string>(resultCase: T, value: never): AdminResult {
  return create(AdminResultSchema, {
    result: { case: resultCase, value } as never,
  });
}

async function fixtureAdminAction(request: Uint8Array): Promise<Uint8Array> {
  const action = fromBinary(AdminActionSchema, request) as AdminAction;
  const result = dispatchAdmin(action);
  return toBinary(AdminResultSchema, result);
}

function dispatchAdmin(action: AdminAction): AdminResult {
  const payload = action.action;
  if (!payload) {
    return adminOK();
  }
  switch (payload.case) {
    case "roleCreate": {
      const role = {
        id: Math.max(...fixtureRolesAdmin.map((item) => item.id)) + 1,
        name: payload.value.name,
        color: `#${payload.value.color.toString(16).padStart(6, "0")}`,
        position: Math.max(...fixtureRolesAdmin.map((item) => item.position)) + 10,
        permissions: [],
        builtin: false,
      };
      fixtureRolesAdmin = [...fixtureRolesAdmin, role];
      return adminResult("role", protoRole(role) as never);
    }
    case "roleUpdate": {
      const id = Number(payload.value.roleId);
      fixtureRolesAdmin = fixtureRolesAdmin.map((role) =>
        role.id === id
          ? {
              ...role,
              name: payload.value.name ?? role.name,
              color:
                payload.value.color !== undefined
                  ? `#${payload.value.color.toString(16).padStart(6, "0")}`
                  : role.color,
            }
          : role,
      );
      const updated = fixtureRolesAdmin.find((role) => role.id === id);
      return updated ? adminResult("role", protoRole(updated) as never) : adminOK();
    }
    case "roleDelete":
      fixtureRolesAdmin = fixtureRolesAdmin.filter(
        (role) => role.id !== Number(payload.value.roleId),
      );
      return adminOK();
    case "roleReorder":
      fixtureRolesAdmin = fixtureRolesAdmin
        .slice()
        .sort(
          (a, b) =>
            payload.value.roleIds.map(Number).indexOf(a.id) -
            payload.value.roleIds.map(Number).indexOf(b.id),
        )
        .map((role, index) => ({ ...role, position: index }));
      return adminResult("roles", { roles: fixtureRolesAdmin.map(protoRole) } as never);
    case "channelCreate": {
      const id = Math.max(...fixtureChannelsAdmin.map((item) => item.id)) + 1;
      const channel = {
        id,
        parentId: Number(payload.value.parentId),
        position: fixtureChannelsAdmin.length,
        name: payload.value.name,
        topic: payload.value.topic,
        kind: payload.value.kind === 2 ? "text" : "voice",
        userLimit: payload.value.userLimit,
        passwordProtected: payload.value.password.length > 0,
        temporary: payload.value.temporary,
        userCount: 0,
        voiceProfile: "voice",
        afk: payload.value.afk,
      } as (typeof fixtureChannelsAdmin)[number];
      fixtureChannelsAdmin = [...fixtureChannelsAdmin, channel];
      return adminResult("channel", protoChannel(channel) as never);
    }
    case "channelUpdate": {
      const id = Number(payload.value.channelId);
      fixtureChannelsAdmin = fixtureChannelsAdmin.map((channel) =>
        channel.id === id
          ? {
              ...channel,
              name: payload.value.name ?? channel.name,
              topic: payload.value.topic ?? channel.topic,
            }
          : channel,
      );
      const updated = fixtureChannelsAdmin.find((channel) => channel.id === id);
      return updated ? adminResult("channel", protoChannel(updated) as never) : adminOK();
    }
    case "channelDelete":
      fixtureChannelsAdmin = fixtureChannelsAdmin.filter(
        (channel) => channel.id !== Number(payload.value.channelId),
      );
      return adminOK();
    case "channelMove": {
      const id = Number(payload.value.channelId);
      fixtureChannelsAdmin = fixtureChannelsAdmin.map((channel) =>
        channel.id === id ? { ...channel, parentId: Number(payload.value.parentId) } : channel,
      );
      const moved = fixtureChannelsAdmin.find((channel) => channel.id === id);
      return moved ? adminResult("channel", protoChannel(moved) as never) : adminOK();
    }
    case "channelOverrideList":
      return adminResult(
        "overrides",
        { overrides: [] } as never,
      );
    case "channelOverrideSet":
      return adminResult(
        "override",
        {
          channelId: payload.value.channelId,
          roleId: payload.value.roleId,
          allow: payload.value.allow,
          deny: payload.value.deny,
        } as never,
      );
    case "channelOverrideClear":
      return adminOK();
    case "memberList":
      return adminResult(
        "users",
        {
          users: fixtureState.users.map((user) => ({
            id: BigInt(user.id),
            nickname: user.nickname,
            roleIds: user.roleIds.map(BigInt),
            online: true,
            lastSeenAtUnixMs: BigInt(user.connectedAtUnixMs),
            channelId: BigInt(user.channelId),
          })),
        } as never,
      );
    case "roleAssign":
    case "roleUnassign":
    case "memberKick":
    case "memberBan":
    case "memberUnban":
    case "memberMove":
    case "memberSetMuted":
    case "memberSetDeafened":
    case "serverSettingsSet":
      return adminOK();
    case "inviteList":
      return adminResult("invites", { invites: fixtureInvites } as never);
    case "inviteCreate": {
      const invite = {
        id: Math.max(0, ...fixtureInvites.map((item) => item.id)) + 1,
        roleId: Number(payload.value.roleId),
        createdBy: 1,
        createdAtUnixMs: Date.now(),
        expiresAtUnixMs: payload.value.expiresInSeconds > 0 ? Date.now() + payload.value.expiresInSeconds * 1000 : 0,
        maxUses: payload.value.maxUses,
        usedCount: 0,
        revokedAtUnixMs: 0,
        url: `rostalk://join?host=192.168.0.13:7443&fp=${"ab".repeat(32)}&invite=fixture-${Date.now()}`,
      };
      fixtureInvites = [invite, ...fixtureInvites];
      return adminResult("invite", invite as never);
    }
    case "inviteRevoke":
      fixtureInvites = fixtureInvites.map((invite) =>
        invite.id === Number(payload.value.inviteId)
          ? { ...invite, revokedAtUnixMs: Date.now() }
          : invite,
      );
      return adminOK();
    case "banList":
      return adminResult("bans", { bans: fixtureBans } as never);
    case "apiTokenCreate": {
      const token = {
        id: Math.max(0, ...fixtureTokens.map((item) => item.id)) + 1,
        name: payload.value.name,
        roleId: Number(payload.value.roleId),
        createdBy: 1,
        createdAtUnixMs: Date.now(),
        expiresAtUnixMs: payload.value.expiresInSeconds > 0 ? Date.now() + payload.value.expiresInSeconds * 1000 : 0,
        revokedAtUnixMs: 0,
        lastUsedAtUnixMs: 0,
        token: `rostalk_api_${Math.random().toString(36).slice(2)}`,
      };
      fixtureTokens = [token, ...fixtureTokens];
      return adminResult("apiToken", token as never);
    }
    case "apiTokenList":
      return adminResult("apiTokens", { tokens: fixtureTokens } as never);
    case "apiTokenRevoke":
      fixtureTokens = fixtureTokens.map((token) =>
        token.id === Number(payload.value.tokenId)
          ? { ...token, revokedAtUnixMs: Date.now() }
          : token,
      );
      return adminOK();
    case "auditList":
      return adminResult(
        "audit",
        {
          entries: fixtureAudit,
          nextBeforeId: 0n,
          hasMore: false,
        } as never,
      );
    default:
      return adminOK();
  }
}

export const fixtureCoreApi: CoreApi = {
  async ping() {
    return {
      message: "pong",
      protocolVersion: 1,
      clientVersion: fixtureState.clientVersion,
    };
  },

  async getState(): Promise<CoreState> {
    return stateForQuery();
  },

  async connect(): Promise<CoreState> {
    return structuredClone(fixtureState);
  },

  async probeServer(host: string): Promise<ServerProbeView> {
    const [hostname, port] = host.includes(":")
      ? [
          host.slice(0, host.lastIndexOf(":")),
          Number(host.slice(host.lastIndexOf(":") + 1)),
        ]
      : [host, 7443];
    return {
      host,
      hostname,
      port,
      mode: "pinned",
      fingerprint: "ab".repeat(32),
      knownName: "Очаг друзей",
      knownFingerprint: "ab".repeat(32),
      certificateChanged: false,
    };
  },

  async disconnect(): Promise<void> {
    // The fixture stays connected so the gallery keeps its data.
  },

  async joinChannel(): Promise<void> {},
  async leaveChannel(): Promise<void> {},

  async sendMessage(): Promise<void> {
    // The gallery has no server: messages are read-only fixtures.
  },

  async editMessage(): Promise<void> {},
  async deleteMessage(): Promise<void> {},
  async markRead(): Promise<void> {},

  async chatProxy(): Promise<ChatProxyView | null> {
    return { baseUrl: "fixture://chat", token: "fixture-token" };
  },

  async requestStreamCredentials(
    channelId: number,
  ): Promise<StreamCredentialsView> {
    // The gallery and Playwright have no media server. The stream engine
    // reports a connection failure instead of pretending to publish.
    return {
      url: "ws://127.0.0.1:9/rtc?pt=fixture",
      room: `channel-${channelId}`,
      participantIdentity: "1:stream",
      channelId,
      expiresInSeconds: 60,
      presets: ["720p30", "1080p30", "1080p60", "source"],
    };
  },

  async setVoiceState(): Promise<void> {},
  async setNickname(): Promise<void> {},

  // The fixture presence already carries a viewer list, so the browser mock
  // accepts the report without changing it (stage P12).
  async setWatching(): Promise<void> {},

  async removeServer(): Promise<ServerBookmark[]> {
    return [];
  },

  async identityInfo(): Promise<IdentityInfo> {
    return {
      publicKey: "fixture-public-key",
      fingerprint: "fixture-fingerprint",
    };
  },

  async exportIdentity(): Promise<void> {
    throw new Error("identity export is unavailable in the browser fixture");
  },

  async importIdentity(): Promise<IdentityInfo> {
    throw new Error("identity import is unavailable in the browser fixture");
  },

  async pickIdentityPath(): Promise<string | null> {
    return null;
  },

  async adminAction(request: Uint8Array): Promise<Uint8Array> {
    return fixtureAdminAction(request);
  },

  async getSettings(): Promise<ClientSettings> {
    const nickname = new URLSearchParams(window.location.search).get("nickname");
    const snapshot = structuredClone(settings);
    if (nickname !== null) {
      snapshot.nickname = nickname;
    }
    return snapshot;
  },

  async updateSettings(next: ClientSettings): Promise<ClientSettings> {
    settings = structuredClone(next);
    voice = {
      ...voice,
      gate: settings.voice.gate,
      selfMuted: settings.selfMuted,
      deafened: settings.selfDeafened,
      inputDevice: settings.voice.inputDevice,
      outputDevice: settings.voice.outputDevice,
    };
    return structuredClone(settings);
  },

  async setParticipantPreference(
    key: string,
    volume: number,
    muted: boolean,
  ): Promise<ParticipantSettings[]> {
    const existing = settings.participants.find((item) => item.key === key);
    if (existing) {
      existing.volume = volume;
      existing.muted = muted;
    } else {
      settings.participants.push({ key, volume, muted });
    }
    return structuredClone(settings.participants);
  },

  async completeOnboarding(nickname: string): Promise<ClientSettings> {
    settings.onboardingComplete = true;
    settings.nickname = nickname;
    return structuredClone(settings);
  },

  async resetOnboarding(): Promise<ClientSettings> {
    settings.onboardingComplete = false;
    return structuredClone(settings);
  },

  async exportDiagnostics(): Promise<string | null> {
    // The browser fixture has no native dialog and no filesystem; it reports
    // a path so the gallery can show the confirmation state.
    return "rostalk-diagnostics-fixture.log";
  },

  async clearDiagnostics(): Promise<void> {},

  // The fixture has no diagnostics file; the error still reaches the console.
  async logUiError(): Promise<void> {},

  async getVoiceState(): Promise<VoiceState> {
    return structuredClone(voice);
  },

  async getVoiceDevices(): Promise<DeviceList> {
    return structuredClone(devices);
  },

  async setVoiceInputDevice(id: string | null): Promise<void> {
    voice = { ...voice, inputDevice: id };
    settings.voice.inputDevice = id;
  },

  async setVoiceOutputDevice(id: string | null): Promise<void> {
    voice = { ...voice, outputDevice: id };
    settings.voice.outputDevice = id;
  },

  async setVoiceGate(gate): Promise<void> {
    voice = { ...voice, gate };
    settings.voice.gate = gate;
  },

  async setVoiceProcessing(processing): Promise<void> {
    settings.voice.processing = processing;
  },

  async setVoiceOutputVolume(volume: number): Promise<void> {
    settings.voice.outputVolume = volume;
  },

  async setVoiceParticipantVolume(): Promise<void> {},
  async setVoiceParticipantMuted(): Promise<void> {},

  async setVoiceMicTest(enabled: boolean): Promise<void> {
    voice = { ...voice, micTest: enabled };
  },

  async setVoiceSounds(sounds): Promise<void> {
    settings.voice.sounds = sounds;
  },

  // The browser preview has no voices to play; the action is accepted so the
  // settings window and the stream mirror behave the same as in the shell.
  async playVoiceSound(): Promise<void> {},
  async previewVoiceSound(): Promise<void> {},

  async setVoicePttBinding(accelerator: string | null): Promise<void> {
    settings.voice.hotkeys = settings.voice.hotkeys.map((binding) =>
      binding.action === "pushToTalk" ? { ...binding, accelerator } : binding,
    );
  },

  async readClipboardText(): Promise<string> {
    return "fixture clipboard";
  },

  // The browser preview has no core audio: the stream dialog shows the
  // fallback, and the engine keeps using the WebView player.
  async streamAudioSupport() {
    return { supported: false, error: "no core in the browser preview" };
  },

  async getStreamAudioState() {
    return { capture: "off" as const, error: null, available: [], playing: [] };
  },

  async startStreamAudio(): Promise<void> {
    throw new Error("no core in the browser preview");
  },

  async stopStreamAudio(): Promise<void> {},

  async watchStreamAudio(): Promise<void> {},

  async setStreamAudioVolume(): Promise<void> {},

  // The browser preview has no native zoom; the stylesheet scales it instead.
  async setInterfaceScale(): Promise<void> {},

  // The fixture uses the DOM Fullscreen API; there is no desktop window.
  async setWindowFullscreen(): Promise<void> {},

  async takePendingLink(): Promise<string | null> {
    return new URLSearchParams(window.location.search).get("link");
  },

  async checkForUpdate(): Promise<UpdateCheck> {
    return {
      configured: false,
      source: null,
      currentVersion: "0.1.0",
      available: null,
    };
  },

  async installUpdate(): Promise<void> {
    throw new Error("updates are unavailable in the browser fixture");
  },

  subscribeUpdateProgress(): () => void {
    return () => {};
  },

  subscribe(listener: (event: CoreEvent) => void): () => void {
    coreListeners.add(listener);
    const event: CoreEvent = {
      type: "snapshot",
      payload: stateForQuery(),
    };
    queueMicrotask(() => listener(event));
    return () => {
      coreListeners.delete(listener);
    };
  },

  subscribeVoice(listener: (event: VoiceEvent) => void): () => void {
    // One snapshot-like burst: the fixture user is speaking, a second one is
    // quiet, so the gallery can show both states.
    queueMicrotask(() => {
      listener({ type: "state", payload: structuredClone(voice) });
      listener({
        type: "levels",
        payload: {
          selfLevelDb: -18,
          selfSpeaking: true,
          participants: [
            { identity: "2:voice", levelDb: -14, speaking: true },
            { identity: "3:voice", levelDb: -62, speaking: false },
          ],
        },
      });
      listener({
        type: "stats",
        payload: {
          pingMs: 32,
          packetLossPercent: 0.4,
          jitterMs: 8,
          audio: {
            captureUnderruns: 0,
            partialCaptureFrames: 0,
            inputOverflows: 0,
            resamplerOverflows: 0,
            publishOverflows: 0,
            publishUnderruns: 0,
            playbackUnderruns: 0,
            mixerUnderruns: 0,
            trackTrims: 0,
            referenceTrims: 0,
            apmErrors: 0,
          },
        },
      });
      listener({ type: "devices", payload: structuredClone(devices) });
    });
    return () => {};
  },

  subscribeDeepLinks(): () => void {
    return () => {};
  },
};

/** Test helper: reset the fixture settings between tests. */
export function resetFixtureSettings(): void {
  settings = structuredClone(fixtureSettings);
  devices = structuredClone(fixtureDevices);
  voice = structuredClone(fixtureVoiceState);
}
