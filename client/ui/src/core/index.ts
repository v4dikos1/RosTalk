import type { CoreApi } from "./api";
import { hasTauriRuntime, tauriCoreApi } from "./tauri/adapter";
import { tauriWindowChrome } from "./tauri/windowChrome";
import { browserWindowChrome, type WindowChromeApi } from "@/lib/windowChrome";
import { fixtureCoreApi } from "@/mock/fixtureApi";

/**
 * The process-wide core API.
 *
 * The desktop application always uses the Tauri adapter. Outside Tauri (the
 * component gallery, Playwright, a plain Vite preview) the fixture adapter is
 * used so the layout can be reviewed without a server; it is explicit in a
 * production build (`?fixtures=1`) and automatic only under `vite dev`.
 */
function selectAdapter(): CoreApi {
  if (hasTauriRuntime()) {
    return tauriCoreApi;
  }
  if (typeof window === "undefined") {
    return fixtureCoreApi;
  }
  const fixtures = new URLSearchParams(window.location.search).has("fixtures");
  return fixtures || import.meta.env.DEV ? fixtureCoreApi : tauriCoreApi;
}

/** The one instance every component and store uses. */
export const coreApi: CoreApi = selectAdapter();

/** True when the UI is running inside the desktop shell. */
export const isDesktop = hasTauriRuntime();

/**
 * Window controls of the custom title bar. The desktop shell uses Tauri; the
 * browser preview records the intent for tests and never moves a real window.
 */
export const windowChrome: WindowChromeApi = isDesktop
  ? tauriWindowChrome
  : browserWindowChrome;

export type {
  AppearanceAccent,
  AppearanceDensity,
  AppearanceFontScale,
  AppearancePreset,
  AppearanceRadius,
  AppearanceSettings,
  AttachmentView,
  AudioCounters,
  AudioProcessing,
  BookmarkLogin,
  ChannelKindView,
  ChannelPermissionsView,
  ChannelView,
  ChatBackground,
  ChatProxyView,
  ChatTarget,
  ClientSettings,
  ConnectRequest,
  ConnectTarget,
  ConnectionDelta,
  ConnectionPhase,
  CoreApi,
  CoreError,
  CoreErrorCode,
  CoreEvent,
  CoreState,
  CueSettings,
  DeviceInfo,
  DiagnosticsConsent,
  DiagnosticsSettings,
  DeviceList,
  GateMode,
  GateSettings,
  HotkeyAction,
  HotkeyBinding,
  IdentityInfo,
  LocalePreference,
  LoginModeView,
  MediaPhase,
  MessageDeletedDelta,
  MessageView,
  NoiseModel,
  NoiseSuppressor,
  ParticipantLevel,
  ParticipantSettings,
  PermissionsView,
  PingReply,
  ProcessingSettings,
  ProfileView,
  PttHookState,
  PttStatus,
  ReconnectInfo,
  ResetDelta,
  RoleView,
  ServerBookmark,
  ServerErrorCode,
  ServerMode,
  ServerProbeView,
  ServerView,
  SoundEvent,
  SoundSet,
  SoundSettings,
  StateDelta,
  StreamAudioState,
  StreamAudioSupport,
  StreamCaptureState,
  StreamCredentialsView,
  ThemePreference,
  UnreadView,
  UserView,
  VoiceEvent,
  VoiceLevels,
  VoiceProfileView,
  VoiceSettings,
  VoiceState,
  VoiceStatePatch,
  VoiceStateView,
  VoiceStats,
} from "./api";
