/**
 * Types and IPC surface of the server installation wizard.
 *
 * Stage 6.1a installed a server from the desktop client over SSH (ADR 0021);
 * P13 moved the wizard into the separate `rostalk-server-setup` application
 * (ADR 0026). The wizard only talks to [`HostingApi`]; the UI never opens a
 * socket.
 */

/** One error of the hosting wizard. */
export interface HostingErrorView {
  code: string;
  message: string;
  detail: string | null;
  fingerprint: string | null;
}

/** SSH credentials typed in step 1. */
export interface HostingCredentials {
  /** `key` or `password`. */
  method: "key" | "password";
  host: string;
  port: number;
  username: string;
  keyPath: string | null;
  keyPassphrase: string | null;
  password: string | null;
  sudoPassword: string | null;
}

export interface HostingProbeRequest {
  host: string;
  port: number;
  username: string;
}

/** How the SSH host key is trusted. */
export type HostingHostKeyStatus = "known" | "new" | "mismatch";

export interface HostingHostKeyView {
  /** Lowercase SHA-256 hex. */
  fingerprint: string;
  algorithm: string;
  status: HostingHostKeyStatus;
  savedFingerprint: string | null;
}

export interface HostingPreflightRequest {
  credentials: HostingCredentials;
  expectedHostKey: string | null;
  trustHostKey: boolean;
  domain: string | null;
}

export interface HostingProblemView {
  code: string;
  message: string;
}

export interface HostingPortView {
  port: number;
  protocol: string;
  checked: boolean;
  inUse: boolean;
}

export interface HostingExistingView {
  version: string | null;
  dataDirExists: boolean;
  databaseExists: boolean;
  adminInvitePending: boolean;
}

export interface HostingDomainView {
  domain: string;
  domainAddresses: string[];
  serverAddresses: string[];
  matches: boolean;
}

export interface HostingPreflightView {
  osName: string;
  osId: string;
  osVersion: string;
  kernelArch: string;
  /** `amd64` or `arm64`. */
  arch: string;
  supported: boolean;
  problems: HostingProblemView[];
  systemd: boolean;
  systemdVersion: string | null;
  hasTar: boolean;
  hasSha256sum: boolean;
  hasOpenssl: boolean;
  opensslVersion: string | null;
  /** OpenSSL supports `pkeyutl -rawin`; false on 1.1.1 (client verified). */
  opensslRawin: boolean;
  hasSs: boolean;
  hasApt: boolean;
  hasDnf: boolean;
  freeDiskMb: number;
  ports: HostingPortView[];
  existing: HostingExistingView | null;
  /** `none`, `ufw` or `firewalld`. */
  firewall: "none" | "ufw" | "firewalld";
  isRoot: boolean;
  domain: HostingDomainView | null;
  firewallCommands: string[];
  missingPackages: string[];
}

export type HostingExistingAction = "fresh" | "update" | "reinstall";
export type HostingLoginMode = "invite" | "password" | "open";

export interface HostingInstallRequest {
  credentials: HostingCredentials;
  expectedHostKey: string | null;
  trustHostKey: boolean;
  serverName: string | null;
  domain: string | null;
  publicHost: string;
  advertiseIp: string | null;
  loginMode: HostingLoginMode;
  serverPassword: string | null;
  maxUsers: number | null;
  openFirewall: boolean;
  installPackages: boolean;
  existingAction: HostingExistingAction;
  rememberPassword: boolean;
}

export interface HostingBundleView {
  available: boolean;
  directory: string;
  version: string | null;
  error: string | null;
}

export interface HostingOutcomeView {
  adminLink: string | null;
  memberLink: string | null;
  publicHost: string;
  serverVersion: string;
  hostFingerprint: string;
  backupPath: string | null;
  firewallCommands: string[];
  firewallApplied: boolean;
  warnings: string[];
  journal: string | null;
}

/** Progress or terminal event of one hosting operation. */
export interface HostingEvent {
  operationId: string;
  stage: string;
  percent: number;
  message: string;
  detail: string | null;
  finished: boolean;
  outcome: HostingOutcomeView | null;
  error: HostingErrorView | null;
}

/**
 * Which remembered SSH credentials exist for a host and user.
 *
 * The values never cross the IPC bridge: an empty password field in the
 * wizard is filled from the keychain inside the Rust core.
 */
export interface HostingSavedCredentials {
  hasPassword: boolean;
  hasSudoPassword: boolean;
}

/** IPC of `rostalk-server-setup` (or a fixture in tests and screenshots). */
export interface HostingApi {
  /** Opens a file dialog for an OpenSSH private key; `null` on cancel. */
  hostingPickKey(): Promise<string | null>;
  /** Reads the SSH host key without sending a credential. */
  hostingProbe(request: HostingProbeRequest): Promise<HostingHostKeyView>;
  /** Read-only checks on the remote machine. */
  hostingPreflight(request: HostingPreflightRequest): Promise<HostingPreflightView>;
  /** Whether a signed server bundle ships next to the installer. */
  hostingBundleStatus(): Promise<HostingBundleView>;
  /** Starts installation; progress arrives via `subscribeHosting`. */
  hostingInstallStart(request: HostingInstallRequest): Promise<string>;
  /** Requests cancellation of one operation. */
  hostingCancel(operationId: string): Promise<boolean>;
  /** Optional remembered SSH credentials from the OS keychain. */
  hostingLoadCredentials(
    host: string,
    username: string,
  ): Promise<HostingSavedCredentials>;
  hostingForgetCredentials(host: string, username: string): Promise<void>;
  /** Subscribes to hosting progress and results. */
  subscribeHosting(listener: (event: HostingEvent) => void): () => void;
}
