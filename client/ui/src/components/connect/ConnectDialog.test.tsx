import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoreState, ServerProbeView } from "@/core/api";
import { i18n } from "@/i18n";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

import { ConnectDialog } from "./ConnectDialog";

const { connectMock, probeMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  probeMock: vi.fn(),
}));

vi.mock("@/core", () => ({
  coreApi: {
    connect: connectMock,
    probeServer: probeMock,
  },
}));

const fingerprint =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function disconnectedState(profileNickname = ""): CoreState {
  return {
    ...structuredClone(fixtureState),
    connection: "disconnected",
    server: null,
    roles: [],
    channels: [],
    users: [],
    selfUserId: 0,
    nickname: "",
    profile: { nickname: profileNickname },
    permissions: null,
    servers: [],
    activeServerId: null,
    error: null,
  };
}

function probe(overrides: Partial<ServerProbeView> = {}): ServerProbeView {
  return {
    host: "192.168.0.13:7443",
    hostname: "192.168.0.13",
    port: 7443,
    mode: "pinned",
    fingerprint,
    knownName: null,
    knownFingerprint: null,
    certificateChanged: false,
    ...overrides,
  };
}

function renderDialog(profileNickname = "") {
  useCoreStore.setState({
    state: disconnectedState(profileNickname),
    hydrated: true,
    pending: [],
    actionError: null,
  });
  useAppStore.setState({ connectOpen: true, connectLink: null });
  useSettingsStore.setState({
    settings: { ...structuredClone(fixtureSettings), nickname: profileNickname },
    loaded: true,
    error: null,
  });
  return render(<ConnectDialog />);
}

describe("ConnectDialog", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
    connectMock.mockResolvedValue(structuredClone(fixtureState));
  });

  it("switches between the invite-link and the direct-address modes", async () => {
    const user = userEvent.setup();
    renderDialog("alice");

    expect(screen.getByTestId("connect-link")).toBeInTheDocument();
    expect(screen.queryByTestId("connect-host")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("connect-mode-direct"));

    expect(screen.queryByTestId("connect-link")).not.toBeInTheDocument();
    expect(screen.getByTestId("connect-host")).toBeInTheDocument();
    expect(screen.getByTestId("connect-password")).toBeInTheDocument();
    // A saved profile nickname is used without asking again.
    expect(screen.queryByTestId("connect-nickname")).not.toBeInTheDocument();
    expect(screen.getByText("Nickname from the profile: alice")).toBeInTheDocument();
  });

  it("keeps connect disabled while a required field is empty", async () => {
    const user = userEvent.setup();
    renderDialog();

    // No nickname and no link yet.
    expect(screen.getByTestId("connect-submit")).toBeDisabled();

    await user.type(screen.getByTestId("connect-nickname"), "alice");
    expect(screen.getByTestId("connect-submit")).toBeDisabled();

    await user.type(
      screen.getByTestId("connect-link"),
      `rostalk://join?host=10.0.0.1:7443&fp=${fingerprint}`,
    );
    expect(screen.getByTestId("connect-submit")).toBeEnabled();

    // The direct mode additionally needs a confirmed certificate.
    await user.click(screen.getByTestId("connect-mode-direct"));
    await user.type(screen.getByTestId("connect-host"), "192.168.0.13");
    expect(screen.getByTestId("connect-submit")).toBeDisabled();
  });

  it("explains why the direct login is disabled and offers the probe", async () => {
    const user = userEvent.setup();
    renderDialog("alice");

    await user.click(screen.getByTestId("connect-mode-direct"));
    expect(screen.getByTestId("connect-reason")).toHaveTextContent(
      "Enter the server address.",
    );

    await user.type(screen.getByTestId("connect-host"), "192.168.0.13:7443");
    expect(screen.getByTestId("connect-reason")).toHaveTextContent(
      "Check the server certificate first.",
    );
    expect(screen.getByTestId("connect-probe")).toBeInTheDocument();
  });

  it("sends an invite link without probing", async () => {
    const user = userEvent.setup();
    renderDialog("alice");
    const link = `rostalk://join?host=10.0.0.1:7443&fp=${fingerprint}&invite=tok`;

    await user.type(screen.getByTestId("connect-link"), link);
    await user.click(screen.getByTestId("connect-submit"));

    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));
    expect(connectMock.mock.calls[0]?.[0]).toMatchObject({
      target: { mode: "link", link },
      nickname: "alice",
    });
    expect(probeMock).not.toHaveBeenCalled();
  });

  it("probes on blur, shows the certificate and connects with the confirmed fingerprint", async () => {
    const user = userEvent.setup();
    probeMock.mockResolvedValue(probe());
    renderDialog("alice");

    await user.click(screen.getByTestId("connect-mode-direct"));
    await user.type(screen.getByTestId("connect-host"), "192.168.0.13:7443");
    // Leaving the address field is enough: no hidden extra click.
    await user.click(screen.getByTestId("connect-password"));

    await waitFor(() =>
      expect(screen.getByTestId("connect-fingerprint")).toHaveTextContent(
        fingerprint,
      ),
    );
    expect(probeMock).toHaveBeenCalledWith("192.168.0.13:7443");
    // First contact with an IP host must be confirmed before connecting.
    expect(screen.getByTestId("connect-submit")).toBeDisabled();
    await user.click(screen.getByTestId("connect-trust"));
    await user.type(screen.getByTestId("connect-password"), "server-secret");

    await user.click(screen.getByTestId("connect-submit"));
    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));
    expect(connectMock.mock.calls[0]?.[0]).toMatchObject({
      target: {
        mode: "direct",
        host: "192.168.0.13:7443",
        fingerprint,
      },
      nickname: "alice",
      password: "server-secret",
      acceptNewCertificate: false,
    });
  });

  it("blocks a changed certificate until the user confirms it", async () => {
    const user = userEvent.setup();
    probeMock.mockResolvedValue(
      probe({
        fingerprint: "11".repeat(32),
        knownFingerprint: "22".repeat(32),
        certificateChanged: true,
        knownName: "RosTalk",
      }),
    );
    renderDialog("alice");

    await user.click(screen.getByTestId("connect-mode-direct"));
    await user.type(screen.getByTestId("connect-host"), "192.168.0.13:7443");
    await user.click(screen.getByTestId("connect-password"));

    await waitFor(() =>
      expect(screen.getByText("The certificate changed")).toBeInTheDocument(),
    );
    // Nothing is sent while the change is unconfirmed.
    expect(screen.getByTestId("connect-submit")).toBeDisabled();

    await user.click(screen.getByTestId("connect-trust"));
    expect(screen.getByTestId("connect-submit")).toBeEnabled();

    await user.click(screen.getByTestId("connect-submit"));
    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));
    expect(connectMock.mock.calls[0]?.[0]).toMatchObject({
      target: { mode: "direct", fingerprint: "11".repeat(32) },
      acceptNewCertificate: true,
    });
  });

  it("lets a manually typed fingerprint win over the automatic probe", async () => {
    const user = userEvent.setup();
    probeMock.mockResolvedValue(probe());
    renderDialog("alice");

    await user.click(screen.getByTestId("connect-mode-direct"));
    await user.type(screen.getByTestId("connect-host"), "192.168.0.13:7443");
    await user.click(screen.getByTestId("connect-advanced"));
    await user.type(
      screen.getByTestId("connect-fingerprint-input"),
      fingerprint.toUpperCase(),
    );

    expect(screen.getByTestId("connect-submit")).toBeEnabled();
    await user.click(screen.getByTestId("connect-submit"));

    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));
    expect(connectMock.mock.calls[0]?.[0]).toMatchObject({
      target: {
        mode: "direct",
        host: "192.168.0.13:7443",
        fingerprint: fingerprint.toUpperCase(),
      },
      // A fingerprint typed from the server console is a confirmation.
      acceptNewCertificate: true,
    });
  });

  it("rejects a malformed manual fingerprint", async () => {
    const user = userEvent.setup();
    renderDialog("alice");

    await user.click(screen.getByTestId("connect-mode-direct"));
    await user.type(screen.getByTestId("connect-host"), "192.168.0.13:7443");
    await user.click(screen.getByTestId("connect-advanced"));
    await user.type(screen.getByTestId("connect-fingerprint-input"), "abc");

    expect(
      screen.getAllByText(
        "A fingerprint is 64 hexadecimal characters (SHA-256).",
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId("connect-submit")).toBeDisabled();
  });

  it("shows a fingerprint error instead of connecting", async () => {
    const user = userEvent.setup();
    probeMock.mockRejectedValue({
      code: "invalidFingerprint",
      message: "not a digest",
      retryable: false,
      actionUrl: null,
      serverCode: null,
    });
    renderDialog("alice");

    await user.click(screen.getByTestId("connect-mode-direct"));
    await user.type(screen.getByTestId("connect-host"), "192.168.0.13:7443");
    await user.click(screen.getByTestId("connect-password"));

    await waitFor(() =>
      expect(screen.getByTestId("connect-error")).toHaveTextContent(
        "invalid certificate fingerprint",
      ),
    );
    expect(screen.queryByTestId("connect-certificate")).not.toBeInTheDocument();
    expect(screen.getByTestId("connect-submit")).toBeDisabled();
    expect(connectMock).not.toHaveBeenCalled();
  });
});
