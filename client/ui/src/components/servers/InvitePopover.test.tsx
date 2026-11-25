import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { fixtureState } from "@/mock/fixtures";
import { useCoreStore } from "@/store/coreStore";

import { InvitePopover } from "./InvitePopover";

const { sendAdminMock, createMock } = vi.hoisted(() => ({
  sendAdminMock: vi.fn(),
  createMock: vi.fn(() => ({ kind: "inviteCreate" })),
}));

vi.mock("@/lib/admin", () => ({
  sendAdmin: sendAdminMock,
  inviteCreate: createMock,
  resultInvite: () => ({ url: "rostalk://join?host=example&invite=quick" }),
}));

function prepare(permissions: string[]) {
  const state = structuredClone(fixtureState);
  state.connection = "connected";
  state.permissions = { server: permissions, channels: [] };
  useCoreStore.setState({
    state,
    hydrated: true,
    pending: [],
    actionError: null,
  });
}

describe("InvitePopover", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sendAdminMock.mockResolvedValue({});
    await i18n.changeLanguage("ru");
  });

  it("creates a 24h Member invite and shows the link once", async () => {
    const user = userEvent.setup();
    prepare(["manageInvites"]);
    render(<InvitePopover />);

    await user.click(screen.getByTestId("invite-open"));
    await user.click(screen.getByTestId("invite-create"));

    await waitFor(() =>
      expect(screen.getByTestId("invite-link")).toHaveValue(
        "rostalk://join?host=example&invite=quick",
      ),
    );
    // The default action targets the Member role, 24 hours, five joins.
    expect(createMock).toHaveBeenCalledWith({
      roleId: 0,
      expiresInSeconds: 86_400,
      maxUses: 5,
    });
  });

  it("explains that an administrator has to create the invite", async () => {
    const user = userEvent.setup();
    prepare(["speak"]);
    render(<InvitePopover />);

    await user.click(screen.getByTestId("invite-open"));
    expect(screen.getByTestId("invite-popover")).toHaveTextContent(
      "Приглашения создаёт админ сервера",
    );
    expect(screen.queryByTestId("invite-create")).not.toBeInTheDocument();
  });
});
