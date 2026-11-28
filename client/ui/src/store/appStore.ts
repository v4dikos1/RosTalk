import { create } from "zustand";

import type { LocalePreference, ThemePreference } from "@/core/api";

// UI-owned transient state only. Theme, language, density and every other
// persisted preference live in the core (stage 2.4 requirement 8) and are
// mirrored by `settingsStore`; connection, channels and users live in
// `coreStore` (design 5.1).

export type Locale = LocalePreference;
export type Theme = ThemePreference;
export type MainView = "chat" | "streams";
export type SettingsSection =
  | "profile"
  | "general"
  | "appearance"
  | "voice"
  | "hotkeys"
  | "identity"
  | "diagnostics"
  | "updates"
  | "plugins"
  | "about";

export interface UserMenuTarget {
  userId: number;
  x: number;
  y: number;
}

export interface MenuAnchor {
  x: number;
  y: number;
}

interface AppState {
  newYearTarget: { kind: "self" } | { kind: "peer"; userId: number; nickname: string } | null;
  openNewYear: (target: { kind: "self" } | { kind: "peer"; userId: number; nickname: string }) => void;
  closeNewYear: () => void;
  view: MainView;
  /** Selected channel in the tree; UI-only, not part of the core state. */
  selectedChannelId: number | null;
  /** Open direct conversation, UI-only. */
  dmPeerId: number | null;
  connectOpen: boolean;
  /** Link to prefill when the connect dialog is opened from a saved server. */
  connectLink: string | null;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  paletteOpen: boolean;
  wizardOpen: boolean;
  wizardLink: string | null;
  hostingOpen: boolean;
  userMenu: UserMenuTarget | null;
  /** Server actions menu (title bar or sidebar header). */
  serverMenu: MenuAnchor | null;
  /** Standalone administration dialog, separate from the client settings. */
  serverSettingsOpen: boolean;
  /** Saved-server list; the profile menu opens it as "switch server". */
  serverListOpen: boolean;
  /** Invite dialog opened from the server menu. */
  inviteOpen: boolean;
  channelPasswordId: number | null;

  setView: (view: MainView) => void;
  selectChannel: (channelId: number | null) => void;
  openDm: (peerId: number) => void;
  closeDm: () => void;
  openConnect: (link?: string) => void;
  closeConnect: () => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  openPalette: () => void;
  closePalette: () => void;
  openWizard: (link?: string) => void;
  closeWizard: () => void;
  openHosting: () => void;
  closeHosting: () => void;
  openUserMenu: (userId: number, x: number, y: number) => void;
  closeUserMenu: () => void;
  openServerMenu: (x: number, y: number) => void;
  closeServerMenu: () => void;
  openServerSettings: () => void;
  closeServerSettings: () => void;
  openServerList: () => void;
  closeServerList: () => void;
  openInvite: () => void;
  closeInvite: () => void;
  openChannelPassword: (channelId: number) => void;
  closeChannelPassword: () => void;
}

export const useAppStore = create<AppState>()((set) => ({
  newYearTarget: null,
  openNewYear: (newYearTarget) => set({ newYearTarget }),
  closeNewYear: () => set({ newYearTarget: null }),
  view: "chat",
  selectedChannelId: null,
  dmPeerId: null,
  connectOpen: false,
  connectLink: null,
  settingsOpen: false,
  settingsSection: "general",
  paletteOpen: false,
  wizardOpen: false,
  wizardLink: null,
  hostingOpen: false,
  userMenu: null,
  serverMenu: null,
  serverSettingsOpen: false,
  serverListOpen: false,
  inviteOpen: false,
  channelPasswordId: null,

  setView: (view) => set({ view }),
  selectChannel: (selectedChannelId) =>
    set({ selectedChannelId, dmPeerId: null }),
  openDm: (dmPeerId) =>
    set({ dmPeerId, view: "chat", selectedChannelId: null }),
  closeDm: () => set({ dmPeerId: null }),
  openConnect: (link) => set({ connectOpen: true, connectLink: link ?? null }),
  closeConnect: () => set({ connectOpen: false, connectLink: null }),
  openSettings: (section) =>
    set((state) => ({
      settingsOpen: true,
      settingsSection: section ?? state.settingsSection,
      serverMenu: null,
      serverSettingsOpen: false,
      serverListOpen: false,
      inviteOpen: false,
    })),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  openPalette: () => set({ paletteOpen: true, serverMenu: null, userMenu: null }),
  closePalette: () => set({ paletteOpen: false }),
  openWizard: (link) =>
    set({
      wizardOpen: true,
      wizardLink: link ?? null,
      serverMenu: null,
      serverSettingsOpen: false,
      inviteOpen: false,
    }),
  closeWizard: () => set({ wizardOpen: false, wizardLink: null }),
  openHosting: () => set({ hostingOpen: true }),
  closeHosting: () => set({ hostingOpen: false }),
  openUserMenu: (userId, x, y) =>
    set({ userMenu: { userId, x, y }, serverMenu: null, serverListOpen: false }),
  closeUserMenu: () => set({ userMenu: null }),
  openServerMenu: (x, y) =>
    set({ serverMenu: { x, y }, userMenu: null, serverListOpen: false }),
  closeServerMenu: () => set({ serverMenu: null }),
  openServerSettings: () =>
    set({
      serverSettingsOpen: true,
      serverMenu: null,
      settingsOpen: false,
    }),
  closeServerSettings: () => set({ serverSettingsOpen: false }),
  openServerList: () =>
    set({ serverListOpen: true, serverMenu: null, userMenu: null }),
  closeServerList: () => set({ serverListOpen: false }),
  openInvite: () => set({ inviteOpen: true, serverMenu: null }),
  closeInvite: () => set({ inviteOpen: false }),
  openChannelPassword: (channelPasswordId) => set({ channelPasswordId }),
  closeChannelPassword: () => set({ channelPasswordId: null }),
}));
