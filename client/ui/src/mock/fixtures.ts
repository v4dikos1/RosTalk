import type {
  ChannelView,
  ClientSettings,
  CoreState,
  DeviceInfo,
  DeviceList,
  RoleView,
  ServerBookmark,
  UserView,
} from "@/core/api";

/**
 * Static fixture of a connected server for the component gallery and the
 * Playwright screenshots. It is never read by the main screen in the desktop
 * application: the fixture adapter is only selected outside Tauri, and the
 * screenshots opt in with `?fixtures=1`.
 */

const roles: RoleView[] = [
  {
    id: 1,
    name: "Admin",
    color: "#f0a04b",
    position: 100,
    permissions: ["manageServer"],
    builtin: true,
  },
  {
    id: 2,
    name: "Moderator",
    color: "#fdd663",
    position: 50,
    permissions: [
      "manageRoles",
      "manageInvites",
      "viewAuditLog",
      "kick",
      "muteMembers",
      "moveMembers",
      "viewChannel",
      "joinChannel",
      "speak",
      "stream",
    ],
    builtin: true,
  },
  {
    id: 3,
    name: "Member",
    color: "#8ab4f8",
    position: 10,
    permissions: [
      "viewChannel",
      "joinChannel",
      "speak",
      "stream",
      "changeNickname",
    ],
    builtin: true,
  },
];

function voice(flags: Partial<UserView["voice"]> = {}): UserView["voice"] {
  return {
    selfMuted: false,
    selfDeafened: false,
    serverMuted: false,
    serverDeafened: false,
    away: false,
    prioritySpeaker: false,
    ...flags,
  };
}

const onlineSince = Date.UTC(2026, 10, 20, 12, 0);

const users: UserView[] = [
  {
    id: 1,
    nickname: "Alex",
    roleIds: [1],
    color: "#f0a04b",
    channelId: 3,
    voice: voice(),
    streaming: false,
    watchingUserIds: [],
    connectedAtUnixMs: onlineSince,
    avatarHash: "",
  },
  {
    id: 2,
    nickname: "Anya",
    roleIds: [1],
    color: "#8ab4f8",
    channelId: 3,
    voice: voice(),
    streaming: false,
    watchingUserIds: [],
    connectedAtUnixMs: onlineSince,
    avatarHash: "",
  },
  {
    id: 3,
    nickname: "Maxim",
    roleIds: [3],
    color: "#c58af9",
    channelId: 3,
    voice: voice({ selfMuted: true }),
    streaming: false,
    watchingUserIds: [],
    connectedAtUnixMs: onlineSince,
    avatarHash: "",
  },
  {
    id: 4,
    nickname: "Olya",
    roleIds: [3],
    color: "#f28b82",
    channelId: 3,
    voice: voice({ selfDeafened: true }),
    streaming: false,
    watchingUserIds: [],
    connectedAtUnixMs: onlineSince,
    avatarHash: "",
  },
  {
    id: 5,
    nickname: "Dima",
    roleIds: [3],
    color: "#81c995",
    channelId: 4,
    voice: voice({ away: true }),
    streaming: false,
    watchingUserIds: [6],
    connectedAtUnixMs: onlineSince,
    avatarHash: "",
  },
  {
    id: 6,
    nickname: "Kirill",
    roleIds: [3],
    color: "#fdd663",
    channelId: 4,
    voice: voice(),
    streaming: true,
    watchingUserIds: [],
    connectedAtUnixMs: onlineSince,
    avatarHash: "",
  },
  {
    id: 7,
    nickname: "Lena",
    roleIds: [3],
    color: "#78d9d2",
    channelId: 4,
    voice: voice({ selfMuted: true, away: true }),
    streaming: false,
    watchingUserIds: [6],
    connectedAtUnixMs: onlineSince,
    avatarHash: "",
  },
];

export function fixtureChannel(
  id: number,
  parentId: number,
  position: number,
  name: string,
  topic: string,
  kind: ChannelView["kind"],
  extra: Partial<ChannelView> = {},
): ChannelView {
  return {
    id,
    parentId,
    position,
    name,
    topic,
    kind,
    userLimit: 0,
    passwordProtected: false,
    temporary: false,
    userCount: users.filter((user) => user.channelId === id).length,
    voiceProfile: "voice",
    afk: false,
    ...extra,
  };
}

const channels: ChannelView[] = [
  fixtureChannel(100, 0, 0, "Текстовые", "Текстовые каналы", "text"),
  fixtureChannel(1, 100, 0, "Правила", "Прочитай, прежде чем писать", "text", {
    passwordProtected: true,
  }),
  fixtureChannel(2, 100, 1, "Объявления", "Новости сервера", "text"),
  fixtureChannel(101, 0, 1, "Голосовые", "Голосовые каналы", "voice"),
  fixtureChannel(3, 101, 0, "Общий", "Собираемся тут по вечерам", "voice"),
  fixtureChannel(4, 101, 1, "Игры", "Катки, катки, катки", "voice"),
  fixtureChannel(5, 101, 2, "АФК", "Микрофон выключен, вернусь позже", "voice", {
    afk: true,
  }),
  fixtureChannel(102, 0, 2, "Стримы", "Совместный просмотр", "voice"),
  fixtureChannel(6, 102, 0, "Кино", "Совместный просмотр по пятницам", "voice"),
];

const bookmark: ServerBookmark = {
  id: "192.168.0.13:7443",
  name: "Очаг друзей",
  host: "192.168.0.13:7443",
  fingerprint: "fixture-fingerprint",
  mode: "pinned",
  login: "invite",
  nickname: "Alex",
  serverId: "fixture-server",
  lastConnectedUnixMs: Date.now() - 2 * 60 * 60 * 1000,
  link: "rostalk://join?host=192.168.0.13:7443&fp=fixture-fingerprint",
};

/** A connected server used by the gallery and Playwright. */
export const fixtureState: CoreState = {
  connection: "connected",
  reconnect: null,
  server: {
    id: "fixture-server",
    name: "Очаг друзей",
    version: "0.1.0",
    protocolVersion: 1,
    loginMode: "invite",
    maxUsers: 50,
    onlineUsers: users.length,
    passwordSet: false,
    maxAttachmentBytes: 25 * 1024 * 1024,
  },
  roles,
  channels,
  users,
  selfUserId: 1,
  nickname: "Alex",
  profile: { nickname: "Alex" },
  permissions: {
    server: [
      "manageServer",
      "manageRoles",
      "manageChannels",
      "manageInvites",
      "viewAuditLog",
      "kick",
      "ban",
      "moveMembers",
      "muteMembers",
      "deafenMembers",
    ],
    channels: channels.map((channel) => ({
      channelId: channel.id,
      permissions: [
        "viewChannel",
        "joinChannel",
        "speak",
        "useVoiceActivation",
        "prioritySpeaker",
        "bypassUserLimit",
        "bypassChannelPassword",
        "stream",
        "streamHq",
        "sendMessages",
        "attachFiles",
        "manageMessages",
      ],
    })),
  },
  unread: [
    {
      channelId: 2,
      peerUserId: 0,
      unread: 3,
      mentions: 1,
      lastReadMessageId: 10,
      peerNickname: "",
      lastMessageId: 13,
    },
    {
      channelId: 0,
      peerUserId: 2,
      unread: 1,
      mentions: 0,
      lastReadMessageId: 5,
      peerNickname: "Anya",
      lastMessageId: 6,
    },
  ],
  servers: [bookmark],
  activeServerId: bookmark.id,
  error: null,
  protocolVersion: 1,
  clientVersion: "0.1.0",
};

/** Users assigned to one fixture channel. */
export function fixtureUsersIn(channelId: number): UserView[] {
  return users.filter((user) => user.channelId === channelId);
}

const input: DeviceInfo = {
  id: "fixture-mic",
  name: "Headset Microphone (USB Audio)",
  isDefault: true,
  channels: 2,
  sampleRate: 48_000,
  sampleFormat: "F32",
};

const output: DeviceInfo = {
  id: "fixture-headphones",
  name: "Headset Earphone (USB Audio)",
  isDefault: true,
  channels: 2,
  sampleRate: 48_000,
  sampleFormat: "F32",
};

/** Two devices so the settings selects are populated in screenshots. */
export const fixtureDevices: DeviceList = {
  inputs: [
    input,
    {
      id: "fixture-mic-2",
      name: "Webcam Microphone",
      isDefault: false,
      channels: 1,
      sampleRate: 44_100,
      sampleFormat: "I16",
    },
  ],
  outputs: [
    output,
    {
      id: "fixture-speakers",
      name: "Speakers (Realtek Audio)",
      isDefault: false,
      channels: 2,
      sampleRate: 48_000,
      sampleFormat: "F32",
    },
  ],
  defaultInput: input.id,
  defaultOutput: output.id,
};

/** Monitor state used by the gallery and screenshots. */
/** Settings shown in screenshots; the wizard is opened explicitly there. */
export const fixtureSettings: ClientSettings = {
  version: 3,
  theme: "dark",
  locale: "ru",
  compact: false,
  closeToTray: true,
  economyMode: true,
  economyModeIdleMinutes: 5,
  membersPaneOpen: true,
  onboardingComplete: true,
  nickname: "Alex",
  defaultChannelId: 3,
  selfMuted: false,
  selfDeafened: false,
  appearance: {
    preset: "rostalk",
    accent: "auto",
    density: "comfortable",
    radius: "default",
    fontScale: 100,
    chatBackground: "none",
  },
  diagnostics: { consent: "granted" },
  updateSource: null,
  autostart: false,
  voice: {
    inputDevice: null,
    outputDevice: null,
    gate: { mode: "voiceActivation", threshold_db: -45, hold_ms: 300 },
    processing: {
      echoCancellation: true,
      noiseSuppression: true,
      noiseModel: "rnNoise",
      gainControl: false,
      highPassFilter: true,
    },
    outputVolume: 100,
    activationThresholdDb: -45,
    levelVoices: true,
    backgroundHotkeys: false,
    sounds: {
      enabled: true,
      volume: 70,
      set: "soft",
      channel: true,
      microphone: true,
      sound: true,
      streams: true,
      messages: true,
      connection: true,
      pushToTalk: false,
    },
    hotkeys: [
      { action: "pushToTalk", accelerator: "X1/X2" },
      { action: "toggleMute", accelerator: "Ctrl+Shift+M" },
      { action: "toggleDeafen", accelerator: "Ctrl+Shift+D" },
      { action: "commandPalette", accelerator: "Ctrl+K" },
      { action: "openSettings", accelerator: "Ctrl+Comma" },
      { action: "leaveChannel", accelerator: "Ctrl+Shift+L" },
    ],
  },
  participants: [
    { key: "fixture-server:2", volume: 130, muted: false },
    { key: "fixture-server:3", volume: 100, muted: true },
  ],
};


