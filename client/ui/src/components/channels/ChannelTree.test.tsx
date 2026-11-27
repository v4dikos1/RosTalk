import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { fixtureState } from "@/mock/fixtures";
import { useSettingsStore } from "@/store/settingsStore";

import { ChannelTree } from "./ChannelTree";

function renderTree(selectedChannelId: number | null = 3) {
  const onSelectChannel = vi.fn();
  const onJoinChannel = vi.fn();
  const onUserContextMenu = vi.fn();
  render(
    <ChannelTree
      channels={fixtureState.channels}
      users={fixtureState.users}
      roles={fixtureState.roles}
      selfUserId={fixtureState.selfUserId}
      selectedChannelId={selectedChannelId}
      onSelectChannel={onSelectChannel}
      onJoinChannel={onJoinChannel}
      onUserContextMenu={onUserContextMenu}
      speakingUserIds={new Set([2])}
      serverId="fixture-server"
    />,
  );
  return { onSelectChannel, onJoinChannel, onUserContextMenu };
}

describe("ChannelTree", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    useSettingsStore.setState({ settings: null, loaded: false });
  });

  it("renders a valid ARIA tree with treeitems for channels and people", () => {
    renderTree();

    const tree = screen.getByRole("tree", { name: "Каналы" });
    expect(tree).toBeInTheDocument();
    // Every channel and every person is a treeitem; no invalid nested groups.
    const channels = screen.getAllByRole("treeitem");
    expect(channels.length).toBe(
      fixtureState.channels.length + fixtureState.users.length,
    );
    expect(screen.getByTestId("channel-3")).toHaveAttribute(
      "role",
      "treeitem",
    );
    expect(screen.getByTestId("user-2")).toHaveAttribute("role", "treeitem");
    expect(screen.getByTestId("user-2")).toHaveAttribute("aria-level", "3");
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("marks the selected channel and expands categories", async () => {
    const user = userEvent.setup();
    renderTree(4);

    expect(screen.getByTestId("channel-4")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("channel-101")).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    const toggle = screen.getByTestId("channel-toggle-101");
    await user.click(toggle);
    expect(screen.getByTestId("channel-101")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByTestId("channel-3")).not.toBeInTheDocument();
  });

  it("leaves air between top-level channel groups only", () => {
    renderTree();

    // The very first row starts the list; the next top-level groups get a gap.
    expect(screen.getByTestId("channel-100")).not.toHaveAttribute(
      "data-group-start",
    );
    expect(screen.getByTestId("channel-101")).toHaveAttribute(
      "data-group-start",
      "true",
    );
    expect(screen.getByTestId("channel-102")).toHaveAttribute(
      "data-group-start",
      "true",
    );
    // Nested rows stay inside their group, without the extra gap.
    expect(screen.getByTestId("channel-1")).not.toHaveAttribute(
      "data-group-start",
    );
  });

  it("calls onSelectChannel when a channel is clicked", async () => {
    const user = userEvent.setup();
    const { onSelectChannel, onJoinChannel } = renderTree();

    await user.click(screen.getByTestId("channel-4"));

    expect(onSelectChannel).toHaveBeenCalledWith(4);
    expect(onJoinChannel).not.toHaveBeenCalled();
  });

  it("joins a voice channel on double click and Enter", async () => {
    const user = userEvent.setup();
    const { onJoinChannel } = renderTree();
    const channel = fixtureState.channels.find((item) => item.id === 4);
    expect(channel).toBeDefined();

    await user.dblClick(screen.getByTestId("channel-4"));
    expect(onJoinChannel).toHaveBeenCalledWith(channel);

    screen.getByTestId("channel-4").focus();
    await user.keyboard("{Enter}");
    expect(onJoinChannel).toHaveBeenCalledTimes(2);
  });

  it("does not try to join a text channel", async () => {
    const user = userEvent.setup();
    const { onJoinChannel } = renderTree();

    await user.dblClick(screen.getByTestId("channel-2"));

    expect(onJoinChannel).not.toHaveBeenCalled();
  });

  it("moves focus with the arrow keys", async () => {
    const user = userEvent.setup();
    renderTree();
    const first = screen.getByTestId("channel-100");
    first.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByTestId("channel-1"));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(first);
  });

  it("shows the speaking indicator measured by the client", () => {
    renderTree();
    expect(screen.getByTestId("user-2")).toHaveAttribute(
      "data-speaking",
      "true",
    );
    expect(screen.getByLabelText("Говорит")).toBeInTheDocument();
  });

  it("renders the control-plane user flags with accessible labels", () => {
    renderTree();

    expect(screen.getAllByLabelText("Микрофон выключен")).toHaveLength(2);
    expect(screen.getAllByLabelText("Звук выключен")).toHaveLength(1);
    expect(screen.getAllByLabelText("Отошёл")).toHaveLength(2);
    expect(screen.getAllByLabelText("Стримит")).toHaveLength(1);
  });

  it("shows how many people watch a streamer", () => {
    renderTree();

    const count = screen.getByTestId("user-viewers-6");
    expect(count).toHaveAttribute("data-count", "2");
    expect(count).toHaveTextContent("2");
    expect(count).toHaveAttribute("aria-label", "Зрителей: 2");
    // Only the streamer carries the badge.
    expect(screen.queryByTestId("user-viewers-5")).toBeNull();
  });

  it("opens the user menu on right click", () => {
    const { onUserContextMenu } = renderTree();

    fireEvent.contextMenu(screen.getByTestId("user-2"));

    expect(onUserContextMenu).toHaveBeenCalledTimes(1);
    expect(onUserContextMenu.mock.calls[0]?.[0]).toMatchObject({ id: 2 });
  });

  it("opens the user menu from the keyboard", () => {
    const { onUserContextMenu } = renderTree();
    const row = screen.getByTestId("user-2");
    row.focus();
    fireEvent.keyDown(row, { key: "ContextMenu" });

    expect(onUserContextMenu).toHaveBeenCalledTimes(1);
    expect(onUserContextMenu.mock.calls[0]?.[0]).toMatchObject({ id: 2 });
  });

  it("renders no placeholder row for leaf voice channels without people", () => {
    renderTree();
    expect(screen.queryByText("Здесь никого")).not.toBeInTheDocument();
  });

  it("shows the empty tree state", () => {
    render(
      <ChannelTree
        channels={[]}
        users={[]}
        roles={[]}
        selfUserId={0}
        selectedChannelId={null}
        onSelectChannel={vi.fn()}
      />,
    );

    expect(screen.getByText("Каналов пока нет")).toBeInTheDocument();
  });
});
