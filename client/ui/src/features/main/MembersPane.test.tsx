import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { fixtureState } from "@/mock/fixtures";
import { useChatStore } from "@/store/chatStore";

import { MembersPane } from "./MembersPane";

const HASH = "a".repeat(64);

function renderPane(options: {
  channelId?: number;
  users?: typeof fixtureState.users;
  serverId?: string | null;
  onOpenProfile?: () => void;
  onUserMenu?: (user: unknown, position: { x: number; y: number }) => void;
} = {}) {
  const channel = fixtureState.channels.find(
    (item) => item.id === (options.channelId ?? 4),
  );
  if (!channel) {
    throw new Error("fixture channel is missing");
  }
  const props = {
    channel,
    users: options.users ?? fixtureState.users,
    channels: fixtureState.channels,
    roles: fixtureState.roles,
    selfUserId: fixtureState.selfUserId,
    speakingUserIds: new Set<number>(),
    serverId:
      options.serverId === undefined ? "fixture-server" : options.serverId,
    connected: true,
    onClose: vi.fn(),
    onUserMenu: options.onUserMenu ?? vi.fn(),
    onOpenProfile: options.onOpenProfile ?? vi.fn(),
  };
  return { ...render(<MembersPane {...props} />), props };
}

describe("MembersPane", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    useChatStore.setState({
      proxy: { baseUrl: "http://127.0.0.1:7777", token: "test-token" },
    });
  });

  it("counts the viewers of a streamer", () => {
    renderPane();

    const count = screen.getByTestId("member-viewers-6");
    expect(count).toHaveAttribute("data-count", "2");
    expect(count).toHaveTextContent("2");
    expect(count).toHaveAttribute("aria-label", "Зрителей: 2");
    // A member who is not streaming has no audience badge.
    expect(screen.queryByTestId("member-viewers-5")).toBeNull();
  });

  it("opens the avatar viewer on a primary click and keeps the menu on right click", async () => {
    const onUserMenu = vi.fn();
    renderPane({ channelId: 3, onUserMenu });

    await userEvent.click(screen.getByTestId("member-pane-2"));

    expect(screen.getByTestId("avatar-viewer")).toBeInTheDocument();
    expect(screen.getByTestId("avatar-viewer-state")).toHaveTextContent(
      "У участника нет аватара — показаны инициалы",
    );
    expect(screen.getByTestId("avatar-viewer-fallback")).toHaveTextContent(
      "AN",
    );
    expect(onUserMenu).not.toHaveBeenCalled();

    // The context action still opens the user menu.
    await userEvent.keyboard("{Escape}");
    fireEvent.contextMenu(screen.getByTestId("member-pane-2"), {
      clientX: 120,
      clientY: 80,
    });
    expect(onUserMenu).toHaveBeenCalledTimes(1);
  });

  it("opens the user menu from the keyboard with Shift+F10", () => {
    const onUserMenu = vi.fn();
    renderPane({ channelId: 3, onUserMenu });
    const row = screen.getByTestId("member-pane-2");

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });

    expect(onUserMenu).toHaveBeenCalledTimes(1);
    expect(onUserMenu.mock.calls[0]?.[0]).toMatchObject({ id: 2 });
    expect(screen.queryByTestId("avatar-viewer")).toBeNull();
  });

  it("shows the stored picture, follows a new hash and restores focus on Escape", async () => {
    const users = structuredClone(fixtureState.users);
    const anya = users.find((user) => user.id === 2);
    if (anya) {
      anya.avatarHash = HASH;
    }
    const { rerender, props } = renderPane({ channelId: 3, users });
    const row = screen.getByTestId("member-pane-2");
    await userEvent.click(row);

    const image = screen.getByTestId("avatar-viewer-image");
    expect(image).toHaveAttribute("src", expect.stringContaining(HASH));
    expect(image).toHaveAttribute("width", "256");
    expect(screen.getByTestId("avatar-viewer-state")).toHaveTextContent(
      "Сохранённый размер: 256 × 256",
    );

    // A failed read falls back to the initials with a clear state.
    fireEvent.error(image);
    expect(screen.queryByTestId("avatar-viewer-image")).toBeNull();
    expect(screen.getByTestId("avatar-viewer-fallback")).toHaveTextContent(
      "AN",
    );
    expect(screen.getByTestId("avatar-viewer-state")).toHaveTextContent(
      "Аватар недоступен — показаны инициалы",
    );

    // A fresh hash while the dialog is open swaps the picture in place.
    const changed = structuredClone(users);
    const changedAnya = changed.find((user) => user.id === 2);
    if (changedAnya) {
      changedAnya.avatarHash = "b".repeat(64);
    }
    rerender(<MembersPane {...props} users={changed} />);
    expect(screen.getByTestId("avatar-viewer-image")).toHaveAttribute(
      "src",
      expect.stringContaining("b".repeat(64)),
    );

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("avatar-viewer")).toBeNull();
    expect(row).toHaveFocus();
  });

  it("closes the viewer when the active server changes and never reopens it by itself", async () => {
    const { rerender, props } = renderPane({ channelId: 3 });
    const row = screen.getByTestId("member-pane-2");
    await userEvent.click(row);
    expect(screen.getByTestId("avatar-viewer")).toBeInTheDocument();

    rerender(<MembersPane {...props} serverId="another-server" />);
    expect(screen.queryByTestId("avatar-viewer")).toBeNull();
    // The same row still exists: focus goes back to it after the forced close.
    expect(row).toHaveFocus();

    // Returning to the previous server must not resurrect the old open state.
    rerender(<MembersPane {...props} serverId="fixture-server" />);
    expect(screen.queryByTestId("avatar-viewer")).toBeNull();

    await userEvent.click(screen.getByTestId("member-pane-2"));
    expect(screen.getByTestId("avatar-viewer")).toBeInTheDocument();
  });

  it("does not reopen when the same participant returns after leaving", async () => {
    const withAnya = structuredClone(fixtureState.users);
    const { rerender, props } = renderPane({ channelId: 3, users: withAnya });
    await userEvent.click(screen.getByTestId("member-pane-2"));
    expect(screen.getByTestId("avatar-viewer")).toBeInTheDocument();

    const withoutAnya = withAnya.filter((user) => user.id !== 2);
    rerender(<MembersPane {...props} users={withoutAnya} />);
    expect(screen.queryByTestId("avatar-viewer")).toBeNull();

    // Anya joins again; the viewer must wait for another click.
    rerender(<MembersPane {...props} users={withAnya} />);
    expect(screen.getByTestId("member-pane-2")).toBeInTheDocument();
    expect(screen.queryByTestId("avatar-viewer")).toBeNull();

    await userEvent.click(screen.getByTestId("member-pane-2"));
    expect(screen.getByTestId("avatar-viewer")).toBeInTheDocument();
  });

  it("retries the same avatar URL after a temporary failure on a new open", async () => {
    const users = structuredClone(fixtureState.users);
    const anya = users.find((user) => user.id === 2);
    if (anya) {
      anya.avatarHash = HASH;
    }
    renderPane({ channelId: 3, users });

    await userEvent.click(screen.getByTestId("member-pane-2"));
    fireEvent.error(screen.getByTestId("avatar-viewer-image"));
    expect(screen.queryByTestId("avatar-viewer-image")).toBeNull();
    expect(screen.getByTestId("avatar-viewer-state")).toHaveTextContent(
      "Аватар недоступен — показаны инициалы",
    );

    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByTestId("member-pane-2"));

    expect(screen.getByTestId("avatar-viewer-image")).toHaveAttribute(
      "src",
      expect.stringContaining(HASH),
    );
    expect(screen.getByTestId("avatar-viewer-state")).toHaveTextContent(
      "Сохранённый размер: 256 × 256",
    );
  });

  it("opens the profile from your own row", async () => {
    const onOpenProfile = vi.fn();
    renderPane({ channelId: 3, onOpenProfile });

    await userEvent.click(screen.getByTestId("member-pane-1"));

    expect(onOpenProfile).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("avatar-viewer")).toBeNull();
  });
});
