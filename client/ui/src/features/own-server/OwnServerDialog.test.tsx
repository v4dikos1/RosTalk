import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { LINUX_INSTALL_COMMAND, RELEASE_REPO, RELEASES_URL } from "@/lib/release";
import { useAppStore } from "@/store/appStore";

import { OwnServerDialog } from "./OwnServerDialog";

describe("OwnServerDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useAppStore.setState({ hostingOpen: true });
  });

  it("points at the GitHub releases of the configured repository", () => {
    expect(RELEASE_REPO).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    expect(RELEASES_URL).toBe(`https://github.com/${RELEASE_REPO}/releases/latest`);
    expect(LINUX_INSTALL_COMMAND).toBe(
      `curl -fsSL https://github.com/${RELEASE_REPO}/releases/latest/download/install.sh | sudo sh`,
    );
  });

  it("shows the addresses with Copy buttons and no link to open", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<OwnServerDialog />);

    expect(screen.getByTestId("own-server-releases")).toHaveValue(RELEASES_URL);
    expect(screen.getByTestId("own-server-linux")).toHaveValue(LINUX_INSTALL_COMMAND);
    // ADR 0023: nothing clickable that would open a browser.
    expect(document.querySelector("a[href]")).toBeNull();

    await user.click(screen.getByTestId("own-server-releases-copy"));
    expect(writeText).toHaveBeenCalledWith(RELEASES_URL);
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("explains a failed copy", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(<OwnServerDialog />);
    await user.click(screen.getByTestId("own-server-linux-copy"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("renders nothing while closed", () => {
    useAppStore.setState({ hostingOpen: false });
    render(<OwnServerDialog />);
    expect(screen.queryByTestId("own-server-dialog")).not.toBeInTheDocument();
  });
});
