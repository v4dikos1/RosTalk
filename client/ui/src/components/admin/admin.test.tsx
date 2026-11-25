import { create } from "@bufbuild/protobuf";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import {
  sendAdmin,
  type AdminRole,
  type AdminUser,
} from "@/lib/admin";
import { AdminResultSchema, type AdminAction } from "@/proto/rostalk/v1/admin_pb";
import type { ChannelView } from "@/core/api";

import { ChannelEditor } from "./ChannelEditor";
import { PermissionMatrix } from "./PermissionMatrix";
import { RoleEditor } from "./RoleEditor";

vi.mock("@/lib/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin")>();
  return { ...actual, sendAdmin: vi.fn() };
});

const roles: AdminRole[] = [
  { id: 4, name: "Admin", color: 0xf28b82, position: 100, builtin: true, permissions: ["manageServer"] },
  { id: 3, name: "Moderator", color: 0xfdd663, position: 50, builtin: true, permissions: ["kick", "manageRoles"] },
  { id: 2, name: "Member", color: 0x8ab4f8, position: 10, builtin: true, permissions: ["speak"] },
  { id: 5, name: "Guest", color: 0, position: 0, builtin: true, permissions: [] },
];

const members: AdminUser[] = [
  { id: 1, nickname: "Alex", roleIds: [4], online: true, lastSeenAtUnixMs: Date.now(), channelId: 3 },
  { id: 2, nickname: "Anya", roleIds: [2], online: true, lastSeenAtUnixMs: Date.now(), channelId: 3 },
];

const channels: ChannelView[] = [
  {
    id: 3,
    parentId: 0,
    position: 0,
    name: "General",
    topic: "",
    kind: "voice",
    userLimit: 0,
    passwordProtected: false,
    temporary: false,
    userCount: 2,
    voiceProfile: "voice",
    afk: false,
  },
  {
    id: 4,
    parentId: 0,
    position: 1,
    name: "Games",
    topic: "",
    kind: "voice",
    userLimit: 6,
    passwordProtected: true,
    temporary: false,
    userCount: 0,
    voiceProfile: "voiceHq",
    afk: false,
  },
];

function okResult() {
  return create(AdminResultSchema, {
    result: { case: "ok", value: true } as never,
  });
}

function renderWithProviders(element: ReactElement) {
  return render(<TooltipProvider>{element}</TooltipProvider>);
}

describe("admin UI", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    vi.mocked(sendAdmin).mockReset();
    vi.mocked(sendAdmin).mockResolvedValue(okResult());
  });

  it("hides the role editor without the role right", () => {
    renderWithProviders(
      <RoleEditor
        roles={roles}
        members={members}
        actorHighest={10}
        actorPermissions={[]}
        manageServer={false}
        canManageRoles={false}
        onRolesChanged={() => {}}
        onMembersChanged={() => {}}
      />,
    );
    expect(screen.getByText("Нет права на управление ролями")).toBeInTheDocument();
    expect(screen.queryByTestId("role-editor")).not.toBeInTheDocument();
  });

  it("does not let a role at the actor's level be edited and saves a lower one", async () => {
    renderWithProviders(
      <RoleEditor
        roles={roles}
        members={members}
        actorHighest={50}
        actorPermissions={["manageRoles", "kick"]}
        manageServer={false}
        canManageRoles
        onRolesChanged={() => {}}
        onMembersChanged={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId("role-select-3"));
    expect(screen.getByTestId("role-save")).toBeDisabled();

    fireEvent.click(screen.getByTestId("role-select-2"));
    const save = screen.getByTestId("role-save");
    expect(save).not.toBeDisabled();
    await waitFor(() => expect(screen.getByTestId("role-name")).toHaveValue("Member"));
    fireEvent.click(save);

    await waitFor(() => expect(sendAdmin).toHaveBeenCalled());
    const action = vi.mocked(sendAdmin).mock.calls[0]![0] as AdminAction;
    expect(action.action?.case).toBe("roleUpdate");
  });

  it("reorders roles by dragging and sends every id ascending", async () => {
    renderWithProviders(
      <RoleEditor
        roles={roles}
        members={members}
        actorHighest={100}
        actorPermissions={["manageServer"]}
        manageServer
        canManageRoles
        onRolesChanged={() => {}}
        onMembersChanged={() => {}}
      />,
    );

    fireEvent.dragStart(screen.getByTestId("role-row-5"));
    fireEvent.dragOver(screen.getByTestId("role-row-4"));
    fireEvent.drop(screen.getByTestId("role-row-4"));

    await waitFor(() => expect(sendAdmin).toHaveBeenCalled());
    const action = vi.mocked(sendAdmin).mock.calls[0]![0] as AdminAction;
    expect(action.action?.case).toBe("roleReorder");
    if (action.action?.case === "roleReorder") {
      expect(action.action.value.roleIds.map(Number)).toEqual([2, 3, 4, 5]);
    }
  });

  it("shows a human hierarchy error from the server", async () => {
    vi.mocked(sendAdmin).mockRejectedValue({
      code: "serverError",
      message: "target is not below the actor",
      retryable: false,
      actionUrl: null,
      serverCode: "hierarchy",
    });
    renderWithProviders(
      <RoleEditor
        roles={roles}
        members={members}
        actorHighest={100}
        actorPermissions={["manageServer"]}
        manageServer
        canManageRoles
        onRolesChanged={() => {}}
        onMembersChanged={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("role-select-2"));
    fireEvent.click(screen.getByTestId("role-save"));
    await waitFor(() =>
      expect(
        screen.getAllByText(
          "Роль этого участника не ниже вашей.",
        ).length,
      ).toBeGreaterThan(0),
    );
  });

  it("validates a new channel name and creates one with a password", async () => {
    renderWithProviders(
      <ChannelEditor
        channels={channels}
        roles={roles}
        canManageChannels
        onChanged={() => {}}
      />,
    );
    const create = screen.getByTestId("channel-create");
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByTestId("channel-new-name"), {
      target: { value: "Music" },
    });
    expect(create).not.toBeDisabled();
    fireEvent.click(create);

    await waitFor(() => expect(sendAdmin).toHaveBeenCalled());
    const action = vi.mocked(sendAdmin).mock.calls[0]![0] as AdminAction;
    expect(action.action?.case).toBe("channelCreate");
    if (action.action?.case === "channelCreate") {
      expect(action.action.value.name).toBe("Music");
    }
  });

  it("moves a channel under another one by dragging", async () => {
    renderWithProviders(
      <ChannelEditor
        channels={channels}
        roles={roles}
        canManageChannels
        onChanged={() => {}}
      />,
    );
    fireEvent.dragStart(screen.getByTestId("channel-row-4"));
    fireEvent.dragOver(screen.getByTestId("channel-row-3"));
    fireEvent.drop(screen.getByTestId("channel-row-3"));
    await waitFor(() => expect(sendAdmin).toHaveBeenCalled());
    const action = vi.mocked(sendAdmin).mock.calls[0]![0] as AdminAction;
    expect(action.action?.case).toBe("channelMove");
    if (action.action?.case === "channelMove") {
      expect(Number(action.action.value.channelId)).toBe(4);
      expect(Number(action.action.value.parentId)).toBe(3);
    }
  });

  it("toggles permission matrix entries", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <PermissionMatrix value={["speak"]} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId("permission-kick"));
    expect(onChange).toHaveBeenCalledWith(["speak", "kick"]);
  });
});
