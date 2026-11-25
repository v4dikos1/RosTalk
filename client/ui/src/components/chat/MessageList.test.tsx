import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

import type { MessageView } from "@/core/api";
import { fixtureState } from "@/mock/fixtures";
import { useChatStore } from "@/store/chatStore";
import { useCoreStore } from "@/store/coreStore";

import { MessageList } from "./MessageList";

// TanStack Virtual measures DOM nodes; jsdom has no layout. The mock returns
// every item so the test exercises the real MessageItem tree.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 80,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 80,
      })),
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

function message(
  id: number,
  body: string,
  createdAtUnixMs = 1_700_000_000_000 + id,
): MessageView {
  return {
    id,
    channelId: 1,
    senderId: 2,
    recipientId: 0,
    senderNickname: "Anya",
    body,
    createdAtUnixMs,
    editedAtUnixMs: 0,
    attachments: [],
    mentionUserIds: [],
  };
}

function loadMessages(messages: MessageView[]) {
  useChatStore.setState({
    conversations: {
      "channel:1": {
        key: "channel:1",
        target: { kind: "channel", channelId: 1 },
        messages,
        nextCursor: "",
        hasMore: false,
        loaded: true,
        loading: false,
        error: null,
        stale: false,
      },
    },
    activeKey: "channel:1",
    proxy: null,
    notices: [],
  });
}

describe("MessageList", () => {
  it("renders messages and keeps HTML in the body inert", () => {
    const messages = [
      message(1, "hello **world**"),
      message(2, '<img src=x onerror="alert(1)"><script>alert(2)</script>'),
    ];
    useChatStore.setState({
      conversations: {
        "channel:1": {
          key: "channel:1",
          target: { kind: "channel", channelId: 1 },
          messages,
          nextCursor: "",
          hasMore: false,
          loaded: true,
          loading: false,
          error: null,
          stale: false,
        },
      },
      activeKey: "channel:1",
      proxy: null,
      notices: [],
    });

    const { container } = render(
      <MessageList
        target={{ kind: "channel", channelId: 1 }}
        canManage={false}
      />,
    );

    expect(screen.getAllByTestId("message")).toHaveLength(2);
    expect(container.querySelector("strong")?.textContent).toBe("world");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
  });

  it("hides the avatar and name on a continuation row", () => {
    loadMessages([message(1, "one"), message(2, "two")]);
    render(
      <MessageList
        target={{ kind: "channel", channelId: 1 }}
        canManage={false}
      />,
    );

    const rows = screen.getAllByTestId("message");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("Anya")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByText("Anya")).toBeNull();
    // The continuation keeps only the hover time in the avatar gutter.
    expect(within(rows[1] as HTMLElement).queryByTestId("avatar-image")).toBeNull();
  });

  it("does not mark a new message read while the reader is scrolled up", async () => {
    const markRead = vi.fn().mockResolvedValue(undefined);
    const messages = [message(1, "one"), message(2, "two")];
    useChatStore.setState({
      conversations: {
        "channel:1": {
          key: "channel:1",
          target: { kind: "channel", channelId: 1 },
          messages,
          nextCursor: "",
          hasMore: false,
          loaded: true,
          loading: false,
          error: null,
          stale: false,
        },
      },
      activeKey: "channel:1",
      proxy: null,
      notices: [],
      markRead,
    });

    render(
      <MessageList
        target={{ kind: "channel", channelId: 1 }}
        canManage={false}
      />,
    );
    const list = screen.getByTestId("message-list");
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
    await waitFor(() => expect(markRead).toHaveBeenCalled());
    markRead.mockClear();

    list.scrollTop = 0;
    fireEvent.scroll(list);
    act(() => {
      useChatStore.getState().applyMessage(message(3, "three"), 2);
    });

    expect(markRead).not.toHaveBeenCalled();
  });

  it("shows the empty state once an empty page is loaded", () => {
    useChatStore.setState({
      conversations: {
        "channel:1": {
          key: "channel:1",
          target: { kind: "channel", channelId: 1 },
          messages: [],
          nextCursor: "",
          hasMore: false,
          loaded: true,
          loading: false,
          error: null,
          stale: false,
        },
      },
      activeKey: "channel:1",
      proxy: null,
      notices: [],
    });
    render(
      <MessageList
        target={{ kind: "channel", channelId: 1 }}
        canManage={false}
      />,
    );
    expect(screen.queryByTestId("message-list")).toBeNull();
    expect(screen.getByText("Здесь пока пусто")).toBeInTheDocument();
  });

  it("inserts day separators between messages from different days", () => {
    const now = Date.now();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);
    loadMessages([
      message(1, "old", yesterday.getTime()),
      message(2, "new", now),
    ]);
    render(
      <MessageList
        target={{ kind: "channel", channelId: 1 }}
        canManage={false}
      />,
    );
    expect(screen.getAllByTestId("date-separator")).toHaveLength(2);
    expect(screen.getByText("Сегодня")).toBeInTheDocument();
    expect(screen.getByText("Вчера")).toBeInTheDocument();
    // The date is quiet neutral text between two lines (stage P9).
    expect(screen.getByText("Сегодня").className).toContain("text-faint");
    expect(screen.getByText("Сегодня").className).not.toContain("rounded-full");
  });

  it("marks a mention with an ember rule and keeps the role colour in the name", () => {
    const mentioned = {
      ...message(1, "привет"),
      mentionUserIds: [1],
    };
    loadMessages([mentioned]);
    useCoreStore.setState({
      state: { ...structuredClone(fixtureState), selfUserId: 1 },
    });
    render(
      <MessageList
        target={{ kind: "channel", channelId: 1 }}
        canManage={false}
      />,
    );

    const row = screen.getByTestId("message");
    expect(row.className).toContain("inset_2px_0_0_0_var(--accent)");
    expect(row.className).not.toContain("bg-danger");

    // Stage P9: the role colour is drawn in the nickname, not in a shield icon.
    const author = screen.getByText("Anya");
    expect(author.className).toContain("text-foreground");
    expect(author.getAttribute("style")).toContain("color-mix");
  });

  it("marks the first unread message with a new-messages line", () => {
    const state = structuredClone(fixtureState);
    state.unread = [
      {
        channelId: 1,
        peerUserId: 0,
        unread: 1,
        mentions: 0,
        lastReadMessageId: 1,
        peerNickname: "",
        lastMessageId: 2,
      },
    ];
    useCoreStore.setState({ state });
    loadMessages([message(1, "read"), message(2, "unread")]);
    render(
      <MessageList
        target={{ kind: "channel", channelId: 1 }}
        canManage={false}
      />,
    );
    expect(screen.getByTestId("new-messages-line")).toBeInTheDocument();
    expect(screen.getAllByTestId("message")).toHaveLength(2);

    const line = screen.getByTestId("new-messages-line");
    const pill = within(line).getByText("Новые сообщения");
    expect(line.className).not.toContain("uppercase");
    expect(line.className).not.toContain("danger");
    expect(pill.className).toContain("text-accent");
  });

  it("lets the feed use the full pane width with inner padding", () => {
    loadMessages([message(1, "one")]);
    render(
      <MessageList
        target={{ kind: "channel", channelId: 1 }}
        canManage={false}
      />,
    );

    // P8: the 860 px column left empty space on a wide desktop window and made
    // long messages wrap early. The feed now fills the pane; its own rows keep
    // the inner padding (px-3) and the composer is full width too.
    const column = screen.getByTestId("message-column");
    expect(column.className).toContain("w-full");
    expect(column.className).not.toContain("max-w-[860px]");
    expect(column.className).not.toContain("mx-auto");
  });

  it("lets a moderator delete someone else's message but not edit it", () => {
    useCoreStore.setState({
      state: { ...structuredClone(fixtureState), selfUserId: 1 },
    });
    loadMessages([message(2, "someone else")]);
    render(
      <MessageList
        target={{ kind: "channel", channelId: 1 }}
        canManage
      />,
    );

    // manage_messages moderates and deletes; editing another user's message is
    // not allowed, because an edit would be shown as that user's words.
    expect(screen.queryByTestId("message-edit")).toBeNull();
    expect(screen.getByTestId("message-delete")).toBeInTheDocument();
  });

  it("lets the author edit and delete their own message", () => {
    useCoreStore.setState({
      state: { ...structuredClone(fixtureState), selfUserId: 2 },
    });
    loadMessages([message(2, "mine")]);
    render(
      <MessageList
        target={{ kind: "channel", channelId: 1 }}
        canManage={false}
      />,
    );

    expect(screen.getByTestId("message-edit")).toBeInTheDocument();
    expect(screen.getByTestId("message-delete")).toBeInTheDocument();
  });

  it("keeps the unread separator at the message that was unread on open", () => {
    const state = structuredClone(fixtureState);
    state.selfUserId = 1;
    state.unread = [
      {
        channelId: 1,
        peerUserId: 0,
        unread: 1,
        mentions: 0,
        lastReadMessageId: 1,
        peerNickname: "",
        lastMessageId: 2,
      },
    ];
    useCoreStore.setState({ state });
    loadMessages([message(1, "read"), message(2, "unread")]);
    render(
      <MessageList
        target={{ kind: "channel", channelId: 1 }}
        canManage={false}
      />,
    );

    const firstAfterSeparator = () =>
      screen
        .getByTestId("new-messages-line")
        .parentElement?.nextElementSibling?.querySelector("[data-message-id]")
        ?.getAttribute("data-message-id");
    expect(firstAfterSeparator()).toBe("2");

    // The server advances the read marker as the feed shows messages. The
    // separator is anchored to the moment the conversation was opened, so it
    // must not jump down on every delivered message and read receipt.
    for (const [id, lastRead] of [
      [3, 2],
      [4, 3],
      [5, 4],
    ] as const) {
      act(() => {
        useChatStore.getState().applyMessage(message(id, `next ${id}`), 2);
      });
      act(() => {
        useCoreStore.setState({
          state: {
            ...useCoreStore.getState().state!,
            unread: [
              {
                channelId: 1,
                peerUserId: 0,
                unread: 2,
                mentions: 0,
                lastReadMessageId: lastRead,
                peerNickname: "",
                lastMessageId: id + 1,
              },
            ],
          },
        });
      });
      expect(firstAfterSeparator()).toBe("2");
    }
  });

  it("does not create an unread separator for messages that arrive while reading", () => {
    const state = structuredClone(fixtureState);
    state.selfUserId = 1;
    state.unread = [
      {
        channelId: 1,
        peerUserId: 0,
        unread: 0,
        mentions: 0,
        lastReadMessageId: 2,
        peerNickname: "",
        lastMessageId: 2,
      },
    ];
    useCoreStore.setState({ state });
    loadMessages([message(1, "read"), message(2, "also read")]);
    render(
      <MessageList
        target={{ kind: "channel", channelId: 1 }}
        canManage={false}
      />,
    );
    expect(screen.queryByTestId("new-messages-line")).toBeNull();

    act(() => {
      for (const id of [3, 4, 5]) {
        useChatStore.getState().applyMessage(message(id, `next ${id}`), 2);
      }
    });

    // The reader is at the bottom, so these messages are read as they land;
    // nothing was unread when the conversation opened.
    expect(screen.queryByTestId("new-messages-line")).toBeNull();
  });

  it("shows the reason a history load failed and lets the reader retry", async () => {
    const ensureLoaded = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      conversations: {
        "channel:1": {
          key: "channel:1",
          target: { kind: "channel", channelId: 1 },
          messages: [],
          nextCursor: "",
          hasMore: false,
          loaded: false,
          loading: false,
          error: "access",
          stale: true,
        },
      },
      activeKey: "channel:1",
      proxy: null,
      notices: [],
      ensureLoaded,
    });
    render(
      <MessageList
        target={{ kind: "channel", channelId: 1 }}
        canManage={false}
      />,
    );

    const screenBox = screen.getByTestId("chat-error");
    expect(screenBox).toHaveAttribute("data-error", "access");
    expect(within(screenBox).getByText("Нет доступа к каналу")).toBeInTheDocument();

    // The panel retried once on mount; the button must retry again.
    ensureLoaded.mockClear();
    fireEvent.click(within(screenBox).getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(ensureLoaded).toHaveBeenCalledTimes(1));
  });

  it("renders video and audio with a player and archives as downloads", () => {
    // Regression for complaint 13: video used to be rejected at upload, and
    // even a stored one had no player in the message.
    const media = message(1, "");
    media.attachments = [
      {
        id: 5,
        fileName: "clip.mp4",
        contentType: "video/mp4",
        sizeBytes: 5_000_000,
        width: 0,
        height: 0,
        image: false,
      },
      {
        id: 6,
        fileName: "voice.ogg",
        contentType: "audio/ogg",
        sizeBytes: 200_000,
        width: 0,
        height: 0,
        image: false,
      },
      {
        id: 7,
        fileName: "pack.zip",
        contentType: "application/zip",
        sizeBytes: 3_000_000,
        width: 0,
        height: 0,
        image: false,
      },
    ];
    loadMessages([media]);
    useChatStore.setState({
      proxy: { baseUrl: "http://127.0.0.1:9", token: "proxy" },
    });

    render(
      <MessageList
        target={{ kind: "channel", channelId: 1 }}
        canManage={false}
      />,
    );

    const video = screen.getByTestId("attachment-video");
    expect(video.tagName).toBe("VIDEO");
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("preload", "metadata");
    expect(video).toHaveAttribute(
      "src",
      "http://127.0.0.1:9/chat/attachments/5?pt=proxy",
    );

    const audio = screen.getByTestId("attachment-audio");
    expect(audio.tagName).toBe("AUDIO");
    expect(audio).toHaveAttribute("controls");
    expect(audio).toHaveAttribute("preload", "metadata");

    // Archives are never a player: they stay a download link.
    expect(screen.getByTestId("attachment-file")).toHaveAttribute(
      "download",
      "pack.zip",
    );
    expect(screen.queryByTestId("attachment-image")).toBeNull();
  });
});
