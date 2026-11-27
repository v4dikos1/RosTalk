import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { HostingWizard } from "./HostingWizard";
import type {
  HostingApi,
  HostingEvent,
  HostingHostKeyView,
  HostingPreflightView,
} from "./types";

let hostingListener: ((event: HostingEvent) => void) | null = null;

const {
  bundleMock,
  probeMock,
  preflightMock,
  installMock,
  cancelMock,
  pickMock,
  savedMock,
} = vi.hoisted(() => ({
  bundleMock: vi.fn(),
  probeMock: vi.fn(),
  preflightMock: vi.fn(),
  installMock: vi.fn(),
  cancelMock: vi.fn(),
  pickMock: vi.fn(),
  savedMock: vi.fn(),
}));

// The wizard receives its IPC as a prop (P13): rostalk-server-setup passes the
// Tauri adapter, tests pass these mocks.
const api: HostingApi = {
  hostingBundleStatus: bundleMock,
  hostingProbe: probeMock,
  hostingPreflight: preflightMock,
  hostingInstallStart: installMock,
  hostingCancel: cancelMock,
  hostingPickKey: pickMock,
  hostingLoadCredentials: savedMock,
  hostingForgetCredentials: vi.fn(),
  subscribeHosting: (listener: (event: HostingEvent) => void) => {
    hostingListener = listener;
    return () => {
      hostingListener = null;
    };
  },
};

const fingerprint = "ab".repeat(32);

function hostKey(
  status: HostingHostKeyView["status"] = "known",
): HostingHostKeyView {
  return {
    fingerprint,
    algorithm: "ssh-ed25519",
    status,
    savedFingerprint: status === "new" ? null : "cd".repeat(32),
  };
}

function report(overrides: Partial<HostingPreflightView> = {}): HostingPreflightView {
  return {
    osName: "Ubuntu",
    osId: "ubuntu",
    osVersion: "24.04",
    kernelArch: "x86_64",
    arch: "amd64",
    supported: true,
    problems: [],
    systemd: true,
    systemdVersion: "systemd 255",
    hasTar: true,
    hasSha256sum: true,
    hasOpenssl: true,
    opensslVersion: "OpenSSL 3.0.13",
    opensslRawin: true,
    hasSs: true,
    hasApt: true,
    hasDnf: false,
    freeDiskMb: 10_000,
    ports: [],
    existing: null,
    firewall: "ufw",
    isRoot: false,
    domain: null,
    firewallCommands: ["sudo ufw allow 7443/tcp"],
    missingPackages: [],
    ...overrides,
  };
}

async function reachCheckStep(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByTestId("hosting-address"), "203.0.113.5");
  await user.click(screen.getByRole("button", { name: "Password" }));
  await user.type(screen.getByTestId("hosting-password"), "secret");
  await user.click(screen.getByTestId("hosting-check-host"));
  await screen.findByTestId("hosting-host-key");
  await user.click(screen.getByTestId("hosting-next"));
  await screen.findByTestId("hosting-step-check");
}

describe("HostingWizard", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    hostingListener = null;
    await i18n.changeLanguage("en");
    bundleMock.mockResolvedValue({
      available: true,
      directory: "resources/server",
      version: "0.1.0",
      error: null,
    });
    probeMock.mockResolvedValue(hostKey());
    preflightMock.mockResolvedValue(report());
    installMock.mockResolvedValue("op-1");
    cancelMock.mockResolvedValue(true);
    savedMock.mockResolvedValue({ hasPassword: false, hasSudoPassword: false });
    pickMock.mockResolvedValue(null);
  });

  it("asks for the host key and refuses a changed key", async () => {
    const user = userEvent.setup();
    probeMock.mockResolvedValue(hostKey("mismatch"));
    render(<HostingWizard api={api} />);

    await user.type(screen.getByTestId("hosting-address"), "203.0.113.5");
    await user.click(screen.getByRole("button", { name: "Password" }));
    await user.type(screen.getByTestId("hosting-password"), "secret");
    await user.click(screen.getByTestId("hosting-check-host"));

    expect(await screen.findByText("Server key changed")).toBeInTheDocument();
    expect(screen.queryByTestId("hosting-trust")).not.toBeInTheDocument();
    expect(screen.getByTestId("hosting-next")).toBeDisabled();
  });

  it("requires an explicit confirmation for a new host key", async () => {
    const user = userEvent.setup();
    probeMock.mockResolvedValue(hostKey("new"));
    render(<HostingWizard api={api} />);

    await user.type(screen.getByTestId("hosting-address"), "203.0.113.5");
    await user.click(screen.getByRole("button", { name: "Password" }));
    await user.type(screen.getByTestId("hosting-password"), "secret");
    await user.click(screen.getByTestId("hosting-check-host"));
    await screen.findByText("New server key");

    expect(screen.getByTestId("hosting-next")).toBeDisabled();
    await user.click(screen.getByTestId("hosting-trust"));
    expect(screen.getByTestId("hosting-next")).toBeEnabled();
  });

  it("uses a remembered password without exposing it to the form", async () => {
    const user = userEvent.setup();
    savedMock.mockResolvedValue({ hasPassword: true, hasSudoPassword: true });
    render(<HostingWizard api={api} />);

    await user.type(screen.getByTestId("hosting-address"), "203.0.113.5");
    await user.click(screen.getByRole("button", { name: "Password" }));
    expect(await screen.findByTestId("hosting-saved-password")).toBeInTheDocument();
    expect(screen.getByTestId("hosting-saved-sudo")).toBeInTheDocument();
    // The value never enters the DOM or React state.
    expect(screen.getByTestId("hosting-password")).toHaveValue("");
    expect(screen.getByTestId("hosting-sudo")).toHaveValue("");

    await user.click(screen.getByTestId("hosting-check-host"));
    await screen.findByTestId("hosting-host-key");
    expect(screen.getByTestId("hosting-host-fingerprint")).toHaveClass(
      "select-text",
    );
    await user.click(screen.getByTestId("hosting-next"));
    await screen.findByTestId("hosting-step-check");
    await user.click(screen.getByTestId("hosting-install"));

    await waitFor(() => expect(installMock).toHaveBeenCalled());
    const request = installMock.mock.calls.at(-1)?.[0];
    expect(request?.credentials.password).toBeNull();
    expect(request?.credentials.sudoPassword).toBeNull();
  });

  it("warns that OpenSSL 1.1.1 cannot check Ed25519 on the server", async () => {
    const user = userEvent.setup();
    preflightMock.mockResolvedValue(
      report({
        opensslVersion: "OpenSSL 1.1.1k  25 Mar 2021",
        opensslRawin: false,
      }),
    );
    render(<HostingWizard api={api} />);
    await reachCheckStep(user);
    expect(
      await screen.findByTestId("hosting-openssl-warning"),
    ).toBeInTheDocument();
    expect(screen.getByText(/already verified/i)).toBeInTheDocument();
  });

  it("shows the preflight summary and finishes with links", async () => {
    const user = userEvent.setup();
    render(<HostingWizard api={api} />);
    await reachCheckStep(user);

    expect(screen.getByText("Ubuntu 24.04")).toBeInTheDocument();
    expect(screen.getByText("systemd 255")).toBeInTheDocument();
    await user.click(screen.getByTestId("hosting-install"));

    await waitFor(() => expect(installMock).toHaveBeenCalled());
    await screen.findByTestId("hosting-step-install");

    act(() => {
      hostingListener?.({
        operationId: "op-1",
        stage: "done",
        percent: 100,
        message: "The server is installed and answering.",
        detail: null,
        finished: true,
        outcome: {
          adminLink: `rostalk://join?host=203.0.113.5:7443&fp=${fingerprint}&invite=admin`,
          memberLink: `rostalk://join?host=203.0.113.5:7443&fp=${fingerprint}&invite=member`,
          publicHost: "203.0.113.5",
          serverVersion: "0.1.0",
          hostFingerprint: fingerprint,
          backupPath: null,
          firewallCommands: ["sudo ufw allow 7443/tcp"],
          firewallApplied: false,
          warnings: [],
          journal: null,
        },
        error: null,
      });
    });

    expect(await screen.findByTestId("hosting-step-done")).toBeInTheDocument();
    expect(screen.getByTestId("hosting-admin-link")).toHaveValue(
      `rostalk://join?host=203.0.113.5:7443&fp=${fingerprint}&invite=admin`,
    );
    expect(screen.getByTestId("hosting-member-link")).toBeInTheDocument();
    expect(screen.getByText(/cloud panel/i)).toBeInTheDocument();
    // The installer hands the link over; it does not connect anywhere itself.
    expect(screen.getByText(/open RosTalk, choose Connect and paste/i)).toBeInTheDocument();
    expect(screen.queryByTestId("hosting-connect")).not.toBeInTheDocument();
  });

  it("blocks the installation when the server folder is missing", async () => {
    const user = userEvent.setup();
    bundleMock.mockResolvedValue({
      available: false,
      directory: "",
      version: null,
      error: "No server bundle found.",
    });
    render(<HostingWizard api={api} />);
    await reachCheckStep(user);
    expect(screen.getByText(/Unpack the whole archive/i)).toBeInTheDocument();
    expect(screen.getByTestId("hosting-install")).toBeDisabled();
  });

  it("keeps a failed install on the progress step with a redacted journal", async () => {
    const user = userEvent.setup();
    render(<HostingWizard api={api} />);
    await reachCheckStep(user);
    await user.click(screen.getByTestId("hosting-install"));
    await screen.findByTestId("hosting-step-install");

    act(() => {
      hostingListener?.({
        operationId: "op-1",
        stage: "failed",
        percent: 100,
        message: "The service did not answer /healthz.",
        detail: "systemctl restart rostalk-server failed",
        finished: true,
        outcome: null,
        error: {
          code: "healthcheckFailed",
          message: "The service did not answer /healthz.",
          detail: "systemctl restart rostalk-server failed",
          fingerprint: null,
        },
      });
    });

    expect(await screen.findByTestId("hosting-error")).toBeInTheDocument();
    expect(screen.getAllByText(/did not answer \/healthz/i).length).toBeGreaterThan(0);
    expect(screen.getByTestId("hosting-journal")).toBeInTheDocument();
  });

  it("cancels a running operation", async () => {
    const user = userEvent.setup();
    render(<HostingWizard api={api} />);
    await reachCheckStep(user);
    await user.click(screen.getByTestId("hosting-install"));
    await screen.findByTestId("hosting-step-install");
    await user.click(screen.getByTestId("hosting-cancel"));
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith("op-1"));
  });
});
