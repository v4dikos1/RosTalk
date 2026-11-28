// The only contract the UI knows about the Rust core (design 5.1).
//
// Components import this interface, never `@tauri-apps/*`. The Tauri adapter
// lives in `src/core/tauri/`; a browser adapter arrives after the MVP. The
// fixture adapter in `src/mock/` keeps the component gallery and Playwright
// screenshots working without a desktop window.
//
// The core owns all truth. The UI mirrors a `CoreState` snapshot and applies
// `StateDelta`s; it never invents connection or channel state of its own.

/** Reply to the stage 2.1 IPC health check. */
export interface PingReply {
  message: string;
  protocolVersion: number;
  clientVersion: string;
}

/** Connection phase of the core. */
export type ConnectionPhase =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

/** How the TLS certificate is trusted (ADR 0001). */
export type ServerMode = "pinned" | "webPki";

/** How the user signed in to a saved server (ADR 0008). */
export type BookmarkLogin = "invite" | "direct";

/** Server admission policy. */
export type LoginModeView = "invite" | "password" | "open";

/** Voice or text channel. */
export type ChannelKindView = "voice" | "text";

/** Per-channel Opus/APM preset. */
export type VoiceProfileView = "voice" | "voiceHq" | "music";

/** Failure categories of the core itself. */
export type CoreErrorCode =
  | "invalidLink"
  | "invalidFingerprint"
  | "identityUnavailable"
  | "identityFile"
  | "invalidPassword"
  | "tlsFingerprintMismatch"
  | "tls"
  | "connectionFailed"
  | "timeout"
  | "protocolVersionUnsupported"
  | "serverIdMismatch"
  | "serverIdChanged"
  | "serverCertificateChanged"
  | "serverError"
  | "notConnected"
  | "invalidRequest"
  | "internal";

/** Mirrors `rostalk.v1.ErrorCode`. */
export type ServerErrorCode =
  | "unspecified"
  | "invalidFrame"
  | "invalidRequest"
  | "protocolVersionUnsupported"
  | "unauthenticated"
  | "authFailed"
  | "inviteInvalid"
  | "inviteExpired"
  | "banned"
  | "wrongPassword"
  | "rateLimited"
  | "sessionReplaced"
  | "permissionDenied"
  | "notFound"
  | "channelPasswordRequired"
  | "channelPasswordInvalid"
  | "channelFull"
  | "rejected"
  | "internal"
  | "serverShuttingDown"
  | "kicked"
  | "hierarchy";

export interface CoreError {
  code: CoreErrorCode;
  /** English technical detail for logs. Never shown to users as is. */
  message: string;
  retryable: boolean;
  actionUrl: string | null;
  serverCode: ServerErrorCode | null;
}

export interface ReconnectInfo {
  attempt: number;
  delayMs: number;
}

export interface RoleView {
  id: number;
  name: string;
  color: string | null;
  position: number;
  /** Permission names, camelCase; advisory for the admin UI. */
  permissions: string[];
  /** Built-in roles cannot be deleted. */
  builtin: boolean;
}

export interface ServerView {
  /** Server identity (Ed25519 key fingerprint), not the TLS fingerprint. */
  id: string;
  name: string;
  version: string;
  protocolVersion: number;
  loginMode: LoginModeView;
  maxUsers: number;
  onlineUsers: number;
  /** A server password is configured; the value itself stays on the server. */
  passwordSet: boolean;
  /** Largest file the server accepts as one attachment, in bytes. */
  maxAttachmentBytes: number;
}

export interface ChannelView {
  id: number;
  parentId: number;
  position: number;
  name: string;
  topic: string;
  kind: ChannelKindView;
  userLimit: number;
  passwordProtected: boolean;
  temporary: boolean;
  userCount: number;
  /** Opus/APM preset applied to the channel. */
  voiceProfile: VoiceProfileView;
  /** Server's idle channel: its occupants are muted by the server (ADR 0009). */
  afk: boolean;
}

export interface VoiceStateView {
  selfMuted: boolean;
  selfDeafened: boolean;
  serverMuted: boolean;
  serverDeafened: boolean;
  away: boolean;
  prioritySpeaker: boolean;
}

export interface UserView {
  id: number;
  nickname: string;
  roleIds: number[];
  color: string | null;
  /** 0 when connected but not in a channel. */
  channelId: number;
  voice: VoiceStateView;
  streaming: boolean;
  /**
   * Screen shares this user watches, by streamer id (stage P12). Only live
   * shares of the same voice channel appear here; the server clears the list
   * when the user leaves, the stream stops or either session ends.
   */
  watchingUserIds: number[];
  connectedAtUnixMs: number;
  /** SHA-256 hex of the 256x256 avatar, empty when the user has none (P11). */
  avatarHash: string;
}

export interface ChannelPermissionsView {
  channelId: number;
  permissions: string[];
}

export interface PermissionsView {
  server: string[];
  channels: ChannelPermissionsView[];
}

/** One uploaded file of a message. */
export interface AttachmentView {
  id: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  width: number;
  height: number;
  /** Raster image that may be previewed inline. */
  image: boolean;
}

/**
 * One chat message. `recipientId` is the stored recipient of a direct message
 * (0 in a channel); the conversation peer is `recipientId` for an own message
 * and `senderId` for an incoming one.
 */
export interface MessageView {
  id: number;
  channelId: number;
  senderId: number;
  recipientId: number;
  senderNickname: string;
  body: string;
  createdAtUnixMs: number;
  editedAtUnixMs: number;
  attachments: AttachmentView[];
  mentionUserIds: number[];
}

/** Unread and mention counters of one conversation. */
export interface UnreadView {
  /** Channel conversation, 0 for a direct message. */
  channelId: number;
  /** The other participant of a direct conversation, 0 for a channel. */
  peerUserId: number;
  unread: number;
  mentions: number;
  lastReadMessageId: number;
  /** Nickname of an offline direct-message peer. */
  peerNickname: string;
  lastMessageId: number;
}

/** Target of a chat request. */
export type ChatTarget =
  | { kind: "channel"; channelId: number }
  | { kind: "dm"; peerId: number };

/** Loopback proxy coordinates; the server token stays in the core. */
export interface ChatProxyView {
  baseUrl: string;
  token: string;
}

/**
 * Screen-share signalling coordinates (stage 5.1).
 *
 * `url` is the loopback WebSocket proxy, not the server gateway. The media
 * token and the certificate pin never reach the page: the core injects them
 * into the upstream connection.
 */
export interface StreamCredentialsView {
  /** Local proxy base URL; `livekit-client` appends the signalling path. */
  url: string;
  room: string;
  participantIdentity: string;
  channelId: number;
  expiresInSeconds: number;
  /** `720p30`, `1080p30`; `1080p60` and `source` only with stream_hq. */
  presets: string[];
}

/** OS/API support for the optional native screen publisher (stage P16). */
export interface NativeStreamSupport {
  supported: boolean;
  /** `IsCursorCaptureEnabled` exists (Windows 10 2004+). */
  cursorCaptureAvailable: boolean;
  /** `IsBorderRequired` exists (Windows 11 22000+). */
  borderApiAvailable: boolean;
  /** Token-free reason when the native mode cannot run here. */
  reason: string | null;
}

/** One token-free event of the optional native publisher. */
export type NativeStreamEvent =
  | { type: "picking" }
  | {
      type: "publishing";
      preset: string;
      cursorDisabled: boolean;
      borderRemoved: boolean;
    }
  | { type: "cancelled" }
  | { type: "reconnecting" }
  | { type: "ended"; reason: string }
  | { type: "error"; code: string; message: string }
  | { type: "stopped" };

/** An event and the caller run id it belongs to. */
export interface NativeStreamMessage {
  runId: string;
  event: NativeStreamEvent;
}

export interface ServerBookmark {
  /** `host:port`; stable across certificate changes (ADR 0004, ADR 0008). */
  id: string;
  name: string;
  host: string;
  fingerprint: string;
  mode: ServerMode;
  /** Which login flow saved this server. */
  login: BookmarkLogin;
  /** Last nickname used here, so a return visit does not ask again. */
  nickname: string;
  serverId: string | null;
  lastConnectedUnixMs: number;
  /** Canonical link without the invite token. */
  link: string;
}

/** The local profile the core keeps across restarts. */
export interface ProfileView {
  nickname: string;
}

/** The certificate a direct login would pin (ADR 0008). */
export interface ServerProbeView {
  /** `host:port` exactly as it will be used. */
  host: string;
  hostname: string;
  port: number;
  mode: ServerMode;
  /** SHA-256 of the presented leaf certificate, lowercase hex. */
  fingerprint: string;
  knownName: string | null;
  knownFingerprint: string | null;
  /** The presented certificate differs from the saved one. */
  certificateChanged: boolean;
}

/** Everything the UI mirrors from the core. */
export interface CoreState {
  connection: ConnectionPhase;
  reconnect: ReconnectInfo | null;
  server: ServerView | null;
  roles: RoleView[];
  channels: ChannelView[];
  users: UserView[];
  selfUserId: number;
  nickname: string;
  /** Local profile; survives disconnects and restarts. */
  profile: ProfileView;
  permissions: PermissionsView | null;
  /** Unread and mention counters per conversation. */
  unread: UnreadView[];
  servers: ServerBookmark[];
  activeServerId: string | null;
  error: CoreError | null;
  protocolVersion: number;
  clientVersion: string;
}

export interface ConnectionDelta {
  connection: ConnectionPhase;
  reconnect: ReconnectInfo | null;
  error: CoreError | null;
}

export interface UserLeftDelta {
  userId: number;
}

export interface UserMovedDelta {
  userId: number;
  fromChannelId: number;
  toChannelId: number;
}

export interface ChannelDeletedDelta {
  channelId: number;
}

/** A message disappeared. */
export interface MessageDeletedDelta {
  messageId: number;
  channelId: number;
  senderId: number;
  recipientId: number;
}

/** The session is gone; only the saved servers and profile survive. */
export interface ResetDelta {
  servers: ServerBookmark[];
  activeServerId: string | null;
  profile: ProfileView;
  error: CoreError | null;
  protocolVersion: number;
  clientVersion: string;
}

/** One incremental change of the mirrored state. */
export type StateDelta =
  | { type: "connection"; payload: ConnectionDelta }
  | { type: "reset"; payload: ResetDelta }
  | { type: "userJoined"; payload: UserView }
  | { type: "userLeft"; payload: UserLeftDelta }
  | { type: "userMoved"; payload: UserMovedDelta }
  | { type: "userUpdated"; payload: UserView }
  | { type: "channelCreated"; payload: ChannelView }
  | { type: "channelUpdated"; payload: ChannelView }
  | { type: "channelDeleted"; payload: ChannelDeletedDelta }
  | { type: "serverUpdated"; payload: ServerView }
  | { type: "rolesUpdated"; payload: RoleView[] }
  | { type: "permissionsUpdated"; payload: PermissionsView }
  | { type: "messageCreated"; payload: MessageView }
  | { type: "messageUpdated"; payload: MessageView }
  | { type: "messageDeleted"; payload: MessageDeletedDelta }
  | { type: "unreadUpdated"; payload: UnreadView }
  | { type: "bookmarks"; payload: ServerBookmark[] }
  | { type: "profile"; payload: ProfileView };

/** A full snapshot (after `Welcome`) or one delta. */
export type CoreEvent =
  | { type: "snapshot"; payload: CoreState }
  | { type: "delta"; payload: StateDelta };

/** How the client reaches the server (ADR 0008). */
export type ConnectTarget =
  | { mode: "link"; link: string }
  | {
      mode: "direct";
      /** Host or `host:port` exactly as typed. */
      host: string;
      /** 0 means "the port from host, or 7443". */
      port: number;
      /** Confirmed certificate fingerprint; required for an IP host. */
      fingerprint?: string | null;
    };

export interface ConnectRequest {
  target: ConnectTarget;
  /** Empty means "use the nickname saved for this server or in the profile". */
  nickname?: string;
  /** Server password (never the channel password). */
  password?: string | null;
  /** Set only after the user has seen and accepted a certificate change. */
  acceptNewCertificate?: boolean;
}

export interface VoiceStatePatch {
  selfMuted?: boolean | null;
  selfDeafened?: boolean | null;
  away?: boolean | null;
}

/** Which own voice flag the control-bar button or a global hotkey toggles. */
export type VoiceToggle = "mute" | "deafen";

export interface IdentityInfo {
  publicKey: string;
  fingerprint: string;
}

/** Theme selected by the user. Derived from the appearance preset. */
export type ThemePreference = "dark" | "light";

/** Interface language. */
export type LocalePreference = "ru" | "en";

/** Design preset: surfaces, text and semantic colours in one choice. */
export type AppearancePreset =
  | "rostalk"
  | "graphite"
  | "paper"
  | "amoled"
  | "contrast";

/** Accent layered over a preset; `auto` keeps the preset's own accent. */
export type AppearanceAccent =
  | "auto"
  | "ember"
  | "ice"
  | "violet"
  | "moss"
  | "rose"
  | "mono";

export type AppearanceDensity = "comfortable" | "compact";
export type AppearanceRadius = "sharp" | "default" | "round";

/** Interface scale in percent. */
export type AppearanceFontScale = 100 | 112 | 125;

export type ChatBackground = "none" | "dots" | "grid";

/** Appearance section of the client settings (stage UI polish). */
export interface AppearanceSettings {
  preset: AppearancePreset;
  accent: AppearanceAccent;
  density: AppearanceDensity;
  radius: AppearanceRadius;
  fontScale: AppearanceFontScale;
  chatBackground: ChatBackground;
}

/** Whether the local diagnostics log may be written. */
export type DiagnosticsConsent = "undecided" | "granted" | "denied";

/** Diagnostics section of the client settings. Nothing is ever uploaded. */
export interface DiagnosticsSettings {
  consent: DiagnosticsConsent;
}

/** How the microphone is gated before transmission. */
export type GateSettings =
  | { mode: "continuous" }
  | { mode: "pushToTalk" }
  | {
      mode: "voiceActivation";
      // serde does not camelCase enum struct-variant fields.
      threshold_db: number | null;
      hold_ms: number;
    };

/** Which noise suppressor runs on the capture path. */
export type NoiseSuppressor = "off" | "webRtc" | "rnNoise" | "deepFilter";

/** APM stage switches. */
export interface AudioProcessing {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  noiseModel: NoiseSuppressor;
  gainControl: boolean;
  highPassFilter: boolean;
}

/** Which generated cue set is used (P10). */
export type SoundSet = "soft" | "bright";

/** Event cue settings (P10 groups; stage 2.4 had join/leave/mute). */
export interface CueSettings {
  enabled: boolean;
  /** 0..100 %. */
  volume: number;
  set: SoundSet;
  /** Self and other participants joining/leaving a channel. */
  channel: boolean;
  /** Own microphone muted/unmuted. */
  microphone: boolean;
  /** Incoming sound (deafen) on/off. */
  sound: boolean;
  /** Screen shares starting and stopping. */
  streams: boolean;
  /** Direct messages and mentions. */
  messages: boolean;
  /** Lost and restored media connection. */
  connection: boolean;
  /** Push-to-talk pressed/released; off by default. */
  pushToTalk: boolean;
}

/** Actions that can be bound to a shortcut. */
export type HotkeyAction =
  | "pushToTalk"
  | "toggleMute"
  | "toggleDeafen"
  | "commandPalette"
  | "openSettings"
  | "leaveChannel";

/** One hotkey assignment; `null` means unbound. */
export interface HotkeyBinding {
  action: HotkeyAction;
  accelerator: string | null;
}

/** Per-user playback preference, keyed by `serverId:userId`. */
export interface ParticipantSettings {
  key: string;
  /** 0..200 %. */
  volume: number;
  muted: boolean;
}

/** Voice settings from design 5.2. */
export interface VoiceSettings {
  inputDevice: string | null;
  outputDevice: string | null;
  gate: GateSettings;
  processing: AudioProcessing;
  /** 0..200 %. */
  outputVolume: number;
  /** Last voice-activation threshold, kept across mode changes. */
  activationThresholdDb: number;
  /** Level the loudness of incoming voices (P17). */
  levelVoices: boolean;
  /**
   * Capture configured modifier combinations (for example `Ctrl+Shift+M`) in
   * the background. Off by default; a single key or mouse button is global
   * without it (ADR 0012).
   */
  backgroundHotkeys: boolean;
  sounds: CueSettings;
  hotkeys: HotkeyBinding[];
}

export type NewYearPluginState = "absent" | "enabled" | "disabled";

export interface PluginSettings {
  newYear: NewYearPluginState;
}

/** Settings owned and persisted by the core (requirement 8). */
export interface ClientSettings {
  version: number;
  /** Derived from `appearance.preset`; kept for the tray and older bundles. */
  theme: ThemePreference;
  locale: LocalePreference;
  /** Derived from `appearance.density`; kept for older bundles. */
  compact: boolean;
  closeToTray: boolean;
  /** Destroy the WebView after the window sits in the tray (design 5.5). */
  economyMode: boolean;
  /** Minutes in the tray before the WebView is destroyed. */
  economyModeIdleMinutes: number;
  /**
   * The right-hand channel member pane is open (stage P8). Only the wide
   * layout persists it; on a narrow window the pane is an overlay.
   */
  membersPaneOpen: boolean;
  onboardingComplete: boolean;
  nickname: string;
  defaultChannelId: number | null;
  /** Own microphone was muted on the last run. */
  selfMuted: boolean;
  /** Playback was muted on the last run. */
  selfDeafened: boolean;
  appearance: AppearanceSettings;
  diagnostics: DiagnosticsSettings;
  plugins: PluginSettings;
  /** Update source: https URL to latest.json or a local directory. */
  updateSource: string | null;
  /** Start at Windows logon, minimized to the tray. */
  autostart: boolean;
  voice: VoiceSettings;
  participants: ParticipantSettings[];
}

/** A newer signed release announced by the update source (stage 6.2). */
export interface UpdateInfo {
  currentVersion: string;
  version: string;
  notes: string | null;
  date: string | null;
  /** Source description without credentials or query strings. */
  source: string;
}

/** Result of a manual update check. */
export interface UpdateCheck {
  configured: boolean;
  source: string | null;
  currentVersion: string;
  available: UpdateInfo | null;
}

/** Download progress while the update installs. */
export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

/** Phase of the media (voice room) connection. */
export type MediaPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

/** How the microphone decides whether to transmit (engine type). */
export type GateMode =
  | { mode: "continuous" }
  | { mode: "pushToTalk" }
  | {
      mode: "voiceActivation";
      // serde does not camelCase enum struct-variant fields.
      threshold_db: number | null;
      hold_ms: number;
    };

/** Which noise suppressor the engine runs. */
export type NoiseModel = "off" | "webRtc" | "rnNoise" | "deepFilter";

/** APM stage switches handed to the engine. */
export interface ProcessingSettings {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  noiseModel: NoiseModel;
  gainControl: boolean;
  highPassFilter: boolean;
}

/** Event cue that can be played or previewed (P10). */
export type SoundEvent =
  | "selfJoin"
  | "selfLeave"
  | "userJoin"
  | "userLeave"
  | "micOff"
  | "micOn"
  | "soundOff"
  | "soundOn"
  | "streamStarted"
  | "selfStreamStarted"
  | "selfStreamEnded"
  | "streamViewerJoined"
  | "directMessage"
  | "connectionLost"
  | "connectionRestored"
  | "pttDown"
  | "pttUp";

/** Engine cue switches; mirrors the persisted settings. */
export interface SoundSettings {
  enabled: boolean;
  /** 0..100 %. */
  volume: number;
  set: SoundSet;
  channel: boolean;
  microphone: boolean;
  sound: boolean;
  streams: boolean;
  messages: boolean;
  connection: boolean;
  pushToTalk: boolean;
}

/** Whether the global push-to-talk input is running. */
export type PttHookState =
  | "unknown"
  | "active"
  | "unavailable"
  | "unsupported";

/** Push-to-talk binding and input status. */
export interface PttStatus {
  hook: PttHookState;
  /** Human-readable binding, for example `X1/X2 + F8`. */
  binding: string;
  /** Token-free installation error when Raw Input is unavailable. */
  error: string | null;
}

/**
 * Which actions the global Raw Input registration delivers.
 *
 * Push-to-talk, mute and deafen are independent: an invalid PTT binding must
 * not make the valid toggles look window-only.
 */
export interface GlobalInputStatus {
  registered: boolean;
  keyboardCaptured: boolean;
  pushToTalk: boolean;
  toggleMute: boolean;
  toggleDeafen: boolean;
}

/** Voice engine state. */
export interface VoiceState {
  media: MediaPhase;
  publishing: boolean;
  publishAllowed: boolean;
  channelId: number;
  selfMuted: boolean;
  deafened: boolean;
  micTest: boolean;
  gate: GateMode;
  pushToTalk: PttStatus;
  globalInput: GlobalInputStatus;
  inputDevice: string | null;
  outputDevice: string | null;
  error: string | null;
}

/** Level of one remote participant. */
export interface ParticipantLevel {
  identity: string;
  levelDb: number | null;
  speaking: boolean;
}

/** Level meter snapshot, at most ten times a second. */
export interface VoiceLevels {
  selfLevelDb: number | null;
  selfSpeaking: boolean;
  participants: ParticipantLevel[];
}

/** Audio-pipeline counters reported by the voice engine. */
export interface AudioCounters {
  captureUnderruns: number;
  partialCaptureFrames: number;
  inputOverflows: number;
  resamplerOverflows: number;
  publishOverflows: number;
  publishUnderruns: number;
  playbackUnderruns: number;
  mixerUnderruns: number;
  trackTrims: number;
  referenceTrims: number;
  apmErrors: number;
}

export interface VoiceStats {
  pingMs: number | null;
  packetLossPercent: number | null;
  jitterMs: number | null;
  audio: AudioCounters;
}

/** One input or output device. */
export interface DeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
  channels: number;
  sampleRate: number;
  sampleFormat: string;
}

export interface DeviceList {
  inputs: DeviceInfo[];
  outputs: DeviceInfo[];
  defaultInput: string | null;
  defaultOutput: string | null;
}

/** Whether the core can capture the computer audio without RosTalk (P15). */
export interface StreamAudioSupport {
  supported: boolean;
  /** Token-free reason when it cannot (old Windows, driver error). */
  error: string | null;
}

/** Own stream-audio capture in the core. */
export type StreamCaptureState = "off" | "live" | "failed";

/** Stream audio as the core sees it (stage P15, ADR 0027). */
export interface StreamAudioState {
  capture: StreamCaptureState;
  error: string | null;
  /** Users in the room who publish stream audio. */
  available: number[];
  /** Users whose stream audio the core is playing. */
  playing: number[];
}

export type VoiceEvent =
  | { type: "state"; payload: VoiceState }
  | { type: "levels"; payload: VoiceLevels }
  | { type: "stats"; payload: VoiceStats }
  | { type: "devices"; payload: DeviceList }
  | { type: "streamAudio"; payload: StreamAudioState };

export interface CoreApi {
  /** Round-trips through the typed IPC bridge. */
  ping(): Promise<PingReply>;

  /** Current snapshot. Called once when the window mounts. */
  getState(): Promise<CoreState>;

  /** Connects by invitation link or a direct address; resolves after `Welcome`. */
  connect(request: ConnectRequest): Promise<CoreState>;

  /** Reads a server certificate for the direct-login confirmation (ADR 0008). */
  probeServer(host: string): Promise<ServerProbeView>;

  /** Closes the session and clears the tree. */
  disconnect(): Promise<void>;

  joinChannel(channelId: number, password?: string | null): Promise<void>;
  leaveChannel(): Promise<void>;

  /** Posts a channel or direct message. */
  sendMessage(
    target: ChatTarget,
    body: string,
    attachmentIds: number[],
  ): Promise<void>;
  /** Replaces the body of a message the caller may edit. */
  editMessage(messageId: number, body: string): Promise<void>;
  /** Removes a message and its attachments. */
  deleteMessage(messageId: number): Promise<void>;
  /** Advances the read marker of a conversation. */
  markRead(target: ChatTarget, upToMessageId: number): Promise<void>;
  /**
   * Loopback proxy for history, uploads and attachment reads, `null` while
   * disconnected. The server session token and the pinned certificate never
   * reach the page.
   */
  chatProxy(): Promise<ChatProxyView | null>;

  /**
   * Asks the core for screen-share credentials for the caller's channel. The
   * reply carries a loopback URL and the presets; the token stays in the core.
   */
  requestStreamCredentials(
    channelId: number,
  ): Promise<StreamCredentialsView>;

  /**
   * Replaces the set of screen shares the caller watches (stage P12). The whole
   * set is sent after every watch/unwatch; the server keeps only live shares of
   * the caller's own channel. The audience comes back in the presence of every
   * participant as `watchingUserIds`.
   */
  setWatching(streamerIds: number[]): Promise<void>;

  /** Whether the optional native WGC publisher can run on this Windows build. */
  nativeStreamSupport(): Promise<NativeStreamSupport>;

  /**
   * Starts the optional native publisher after the system picker. Returns once
   * the picker is queued; `subscribeNativeStream` carries the result. A
   * cancelled picker does not start a capture. `runId` is the caller's key for
   * both the start and the matching stop.
   */
  startNativeStream(
    runId: string,
    channelId: number,
    preset: "720p30" | "1080p30",
    includeAudio: boolean,
  ): Promise<void>;

  /**
   * Stops the native publisher and its stream audio. A run id stops exactly
   * that caller's run; `null` is the privileged app-wide shutdown path.
   */
  stopNativeStream(runId: string | null): Promise<void>;

  /** Last native event, for a dialog that opens after the stream started. */
  getNativeStreamState(): Promise<NativeStreamMessage | null>;

  /** Subscribes to native publisher events (picking/publishing/ended/...). */
  subscribeNativeStream(
    listener: (message: NativeStreamMessage) => void,
  ): () => void;

  setVoiceState(patch: VoiceStatePatch): Promise<void>;
  /** Flips mute/deafen from the core's latest persisted value. */
  toggleVoiceState(field: VoiceToggle): Promise<void>;
  setNickname(nickname: string): Promise<void>;
  removeServer(id: string): Promise<ServerBookmark[]>;
  identityInfo(): Promise<IdentityInfo>;
  exportIdentity(path: string, password: string): Promise<void>;
  importIdentity(path: string, password: string): Promise<IdentityInfo>;

  /** Opens a native file dialog; `null` when the user cancels. */
  pickIdentityPath(mode: "open" | "save"): Promise<string | null>;

  /**
   * Sends one encoded `rostalk.v1.AdminAction` and returns the encoded
   * `AdminResult`. The generated protobuf messages are the single source of
   * truth; the UI never opens a network connection itself.
   */
  adminAction(request: Uint8Array): Promise<Uint8Array>;

  /** Persisted settings owned by the core. */
  getSettings(): Promise<ClientSettings>;
  updateSettings(settings: ClientSettings): Promise<ClientSettings>;
  setParticipantPreference(
    key: string,
    volume: number,
    muted: boolean,
  ): Promise<ParticipantSettings[]>;
  completeOnboarding(nickname: string): Promise<ClientSettings>;
  resetOnboarding(): Promise<ClientSettings>;

  /**
   * Saves the diagnostics report through a native dialog; the path is never
   * supplied by the page. `null` when the user cancels.
   */
  exportDiagnostics(): Promise<string | null>;
  /** Deletes `rostalk.log` and `rostalk.log.1`. */
  clearDiagnostics(): Promise<void>;

  /**
   * Writes one interface error into the local diagnostics log. Only the panel
   * name, the error message and the component stack are sent.
   */
  logUiError(scope: string, message: string, stack: string | null): Promise<void>;
  /** Checks the configured source for a newer signed release. */
  checkForUpdate(): Promise<UpdateCheck>;
  /**
   * Downloads, verifies and installs the announced release. The client exits
   * on Windows and the installer restarts it; call only after the user agrees.
   */
  installUpdate(): Promise<void>;
  /** Download progress while an update installs. */
  subscribeUpdateProgress(listener: (event: UpdateProgress) => void): () => void;

  /** Voice engine state, for a window that opened after the last event. */
  getVoiceState(): Promise<VoiceState>;
  getVoiceDevices(): Promise<DeviceList>;
  setVoiceInputDevice(id: string | null): Promise<void>;
  setVoiceOutputDevice(id: string | null): Promise<void>;
  setVoiceGate(mode: GateMode): Promise<void>;
  setVoiceProcessing(settings: ProcessingSettings): Promise<void>;
  setVoiceOutputVolume(volume: number): Promise<void>;
  setVoiceParticipantVolume(identity: string, volume: number): Promise<void>;
  setVoiceParticipantMuted(identity: string, muted: boolean): Promise<void>;
  setVoiceMicTest(enabled: boolean): Promise<void>;
  setVoiceSounds(settings: SoundSettings): Promise<void>;
  /** Plays one event cue (streams, messages); the engine applies switches. */
  playVoiceSound(sound: SoundEvent): Promise<void>;
  /** Plays one cue for the settings window, ignoring the switches. */
  previewVoiceSound(sound: SoundEvent): Promise<void>;
  setVoicePttBinding(accelerator: string | null): Promise<void>;

  /**
   * Stream audio through the core (stage P15, ADR 0027): the streamer's core
   * captures everything except RosTalk, a viewer's core plays the stream audio
   * through its mixer (volume 0..200 %, echo cancellation reference).
   */
  streamAudioSupport(): Promise<StreamAudioSupport>;
  getStreamAudioState(): Promise<StreamAudioState>;
  startStreamAudio(): Promise<void>;
  stopStreamAudio(): Promise<void>;
  watchStreamAudio(userId: number, watching: boolean): Promise<void>;
  /** `volume` is percent, 0..200. */
  setStreamAudioVolume(
    userId: number,
    volume: number,
    muted: boolean,
  ): Promise<void>;

  /**
   * Reads text from the OS clipboard for the custom right-click menu.
   * Never used for anything else and never logged.
   */
  readClipboardText(): Promise<string>;

  /**
   * Native webview zoom of the interface, 1 = 100%. The desktop shell uses the
   * WebView2 zoom level, which keeps popovers and hit-testing aligned; the
   * browser preview falls back to CSS zoom because it has no native call.
   */
  setInterfaceScale(scale: number): Promise<void>;

  /**
   * Fullscreen of the desktop window, used by the stream player at runtime.
   * The window is never created fullscreen: `tao` synthesizes Alt there
   * (anti-cheat hygiene).
   */
  setWindowFullscreen(fullscreen: boolean): Promise<void>;

  /** `rostalk://` link received before the window was ready. */
  takePendingLink(): Promise<string | null>;


  /**
   * Subscribes to snapshots and deltas. Returns an unsubscribe function.
   * There is no network access in the UI: this is IPC only.
   */
  subscribe(listener: (event: CoreEvent) => void): () => void;

  /** Subscribes to voice state, levels, statistics and device changes. */
  subscribeVoice(listener: (event: VoiceEvent) => void): () => void;

  /** Subscribes to `rostalk://` links that arrive while the window is open. */
  subscribeDeepLinks(listener: (link: string) => void): () => void;
}
