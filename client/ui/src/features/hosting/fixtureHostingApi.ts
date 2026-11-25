import type {
  HostingApi,
  HostingBundleView,
  HostingEvent,
  HostingHostKeyView,
  HostingInstallRequest,
  HostingPreflightView,
  HostingSavedCredentials,
} from "./types";

/**
 * Fixture IPC of the server installer for tests, the browser preview and
 * screenshots (`server-setup.html?fixtures=1`). It performs no network I/O.
 * Query switches: `hostingHostKey=new|mismatch`, `hostingExisting=1`,
 * `hostingFail=1`, `hostingNoBundle=1`.
 */
const hostingListeners = new Set<(event: HostingEvent) => void>();

export const fixtureHostingApi: HostingApi = {
  async hostingPickKey(): Promise<string | null> {
    return "C:\\Users\\fixture\\.ssh\\id_ed25519";
  },

  async hostingProbe(): Promise<HostingHostKeyView> {
    const variant = new URLSearchParams(window.location.search).get(
      "hostingHostKey",
    );
    if (variant === "mismatch") {
      return {
        fingerprint: "cd".repeat(32),
        algorithm: "ssh-ed25519",
        status: "mismatch",
        savedFingerprint: "ab".repeat(32),
      };
    }
    return {
      fingerprint: "ab".repeat(32),
      algorithm: "ssh-ed25519",
      status: variant === "new" ? "new" : "known",
      savedFingerprint: variant === "new" ? null : "ab".repeat(32),
    };
  },

  async hostingPreflight(): Promise<HostingPreflightView> {
    const existing =
      new URLSearchParams(window.location.search).get("hostingExisting") ===
      "1";
    return {
      osName: "Ubuntu 24.04.1 LTS",
      osId: "ubuntu",
      osVersion: "24.04",
      kernelArch: "x86_64",
      arch: "amd64",
      supported: true,
      problems: [],
      systemd: true,
      systemdVersion: "systemd 255 (255.4-1ubuntu8)",
      hasTar: true,
      hasSha256sum: true,
      hasOpenssl: true,
      opensslVersion: "OpenSSL 3.0.13 30 Jan 2024",
      opensslRawin: true,
      hasSs: true,
      hasApt: true,
      hasDnf: false,
      freeDiskMb: 38_400,
      ports: [
        { port: 7443, protocol: "tcp", checked: true, inUse: false },
        { port: 7881, protocol: "tcp", checked: true, inUse: false },
        { port: 7882, protocol: "udp", checked: true, inUse: false },
      ],
      existing: existing
        ? {
            version: "rostalk-server 0.1.0-dev",
            dataDirExists: true,
            databaseExists: true,
            adminInvitePending: false,
          }
        : null,
      firewall: "ufw",
      isRoot: false,
      domain: null,
      firewallCommands: [
        "sudo ufw allow 7443/tcp",
        "sudo ufw allow 7881/tcp",
        "sudo ufw allow 7882/udp",
        "Open the same ports in the provider panel (Hetzner, OVH, …): SSH cannot change it.",
      ],
      missingPackages: [],
    };
  },

  async hostingBundleStatus(): Promise<HostingBundleView> {
    if (new URLSearchParams(window.location.search).get("hostingNoBundle") === "1") {
      return {
        available: false,
        directory: "",
        version: null,
        error: "No server bundle found.",
      };
    }
    return {
      available: true,
      directory: "server",
      version: "0.1.0-dev",
      error: null,
    };
  },

  async hostingInstallStart(request: HostingInstallRequest): Promise<string> {
    const id = `fixture-host-${Date.now()}`;
    const fail = new URLSearchParams(window.location.search).get("hostingFail") === "1";
    const stages: Array<[string, number, string]> = [
      ["connecting", 5, "Connecting to the server over SSH…"],
      ["preflight", 16, "Checking the remote system…"],
      ["verifying", 28, "Bundle 0.1.0-dev verified (signature and SHA-256)."],
      ["uploading", 38, "Uploading the server bundle…"],
      ["installing", 50, "Installing the RosTalk server…"],
      ["configuring", 68, "Applying the server settings…"],
      ["firewall", 76, "Opening the RosTalk ports in the remote firewall…"],
      ["healthcheck", 84, "Waiting for /healthz…"],
      ["links", 96, "Invite links are ready."],
    ];
    const emit = (event: HostingEvent) => {
      hostingListeners.forEach((listener) => listener(event));
    };
    stages.forEach(([stage, percent, message], index) => {
      window.setTimeout(() => {
        emit({
          operationId: id,
          stage,
          percent,
          message,
          detail: null,
          finished: false,
          outcome: null,
          error: null,
        });
      }, 120 * (index + 1));
    });
    window.setTimeout(() => {
      if (fail) {
        emit({
          operationId: id,
          stage: "failed",
          percent: 100,
          message:
            "The service did not answer /healthz after installation. The previous binary was restored.",
          detail:
            "rostalk-server: healthcheck: https://127.0.0.1:7443/healthz is not answering",
          finished: true,
          outcome: null,
          error: {
            code: "healthcheckFailed",
            message:
              "The service did not answer /healthz after installation. The previous binary was restored.",
            detail:
              "rostalk-server: healthcheck: https://127.0.0.1:7443/healthz is not answering",
            fingerprint: null,
          },
        });
        return;
      }
      emit({
        operationId: id,
        stage: "done",
        percent: 100,
        message: "The server is installed and answering.",
        detail: null,
        finished: true,
        outcome: {
          adminLink: `rostalk://join?host=203.0.113.5:7443&fp=${"ab".repeat(32)}&invite=fixture-admin`,
          memberLink: `rostalk://join?host=203.0.113.5:7443&fp=${"ab".repeat(32)}&invite=fixture-member`,
          publicHost: request.publicHost || "203.0.113.5",
          serverVersion: "0.1.0-dev",
          hostFingerprint: "ab".repeat(32),
          backupPath: null,
          firewallCommands: [
            "sudo ufw allow 7443/tcp",
            "sudo ufw allow 7881/tcp",
            "sudo ufw allow 7882/udp",
            "Open the same ports in the provider panel (Hetzner, OVH, …): SSH cannot change it.",
          ],
          firewallApplied: request.openFirewall,
          warnings: [],
          journal: null,
        },
        error: null,
      });
    }, 120 * (stages.length + 1));
    return id;
  },

  async hostingCancel(): Promise<boolean> {
    return true;
  },

  async hostingLoadCredentials(): Promise<HostingSavedCredentials> {
    return { hasPassword: false, hasSudoPassword: false };
  },

  async hostingForgetCredentials(): Promise<void> {},

  subscribeHosting(listener: (event: HostingEvent) => void): () => void {
    hostingListeners.add(listener);
    return () => {
      hostingListeners.delete(listener);
    };
  },
};
