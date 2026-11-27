import type { MessageView } from "@/core/api";
import { coreApi } from "@/core";
import {
  ChatHttpError,
  deletedConversationKey,
  fetchHistory,
  messageConversationKey,
} from "@/lib/chat";

import { chatErrorKind, MAX_CACHED_MESSAGES, mergeMessages, useChatStore } from "./chatStore";

const chatProxyMock = vi.mocked(coreApi.chatProxy);

vi.mock("@/core", () => ({
  coreApi: {
    chatProxy: vi.fn(),
    markRead: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat")>();
  return { ...actual, fetchHistory: vi.fn() };
});

const fetchHistoryMock = vi.mocked(fetchHistory);

function message(id: number, overrides: Partial<MessageView> = {}): MessageView {
  return {
    id,
    channelId: 10,
    senderId: 2,
    recipientId: 0,
    senderNickname: "Anya",
    body: `message ${id}`,
    createdAtUnixMs: 1_700_000_000_000 + id,
    editedAtUnixMs: 0,
    attachments: [],
    mentionUserIds: [],
    ...overrides,
  };
}

function conversation(messages: MessageView[], nextCursor: string) {
  return {
    "channel:10": {
      key: "channel:10" as const,
      target: { kind: "channel" as const, channelId: 10 },
      messages,
      nextCursor,
      hasMore: true,
      loaded: true,
      loading: false,
      error: null,
      stale: false,
    },
  };
}

describe("chat store", () => {
  beforeEach(() => {
    fetchHistoryMock.mockReset();
    chatProxyMock.mockReset();
    chatProxyMock.mockResolvedValue({
      baseUrl: "http://127.0.0.1:9",
      token: "proxy",
    });
    useChatStore.setState({
      conversations: {},
      activeKey: null,
      proxy: null,
      notices: [],
    });
  });

  it("merges pages in id order and deduplicates the reply and the event", () => {
    const merged = mergeMessages(
      [message(2), message(3)],
      [message(1), message(3), message(4)],
    );
    expect(merged.map((item) => item.id)).toEqual([1, 2, 3, 4]);
  });

  it("caps the cache from the oldest side", () => {
    const all = Array.from({ length: MAX_CACHED_MESSAGES + 5 }, (_, index) =>
      message(index + 1),
    );
    const merged = mergeMessages(all, [message(MAX_CACHED_MESSAGES + 6)]);
    expect(merged).toHaveLength(MAX_CACHED_MESSAGES);
    expect(merged[0]?.id).toBe(7);
    expect(merged.at(-1)?.id).toBe(MAX_CACHED_MESSAGES + 6);
  });

  it("caps an older page from the newest side so the page stays visible", () => {
    const current = Array.from({ length: MAX_CACHED_MESSAGES }, (_, index) =>
      message(500 + index),
    );
    const older = Array.from({ length: 50 }, (_, index) => message(450 + index));
    const merged = mergeMessages(current, older, "oldest");
    expect(merged).toHaveLength(MAX_CACHED_MESSAGES);
    // The page the user just scrolled to is at the top instead of being
    // trimmed away exactly as before the load.
    expect(merged[0]?.id).toBe(450);
    expect(merged.some((item) => item.id === 499)).toBe(true);
  });

  it("loads older messages from 400+ history without losing the newest ones", async () => {
    // 300 cached messages, 450 on the server: two older pages fit under the cap
    // and must all become visible.
    const cached = Array.from({ length: 300 }, (_, index) => message(700 + index));
    useChatStore.setState({
      conversations: conversation(cached, "700"),
      proxy: { baseUrl: "fixture://chat", token: "proxy" },
    });
    fetchHistoryMock.mockResolvedValue({
      messages: Array.from({ length: 50 }, (_, index) => message(650 + index)),
      nextCursor: "650",
      hasMore: true,
    });

    await useChatStore.getState().loadOlder({ kind: "channel", channelId: 10 });

    let messages =
      useChatStore.getState().conversations["channel:10"]?.messages ?? [];
    expect(messages).toHaveLength(350);
    expect(messages[0]?.id).toBe(650);
    expect(messages.at(-1)?.id).toBe(999);

    fetchHistoryMock.mockResolvedValue({
      messages: Array.from({ length: 50 }, (_, index) => message(600 + index)),
      nextCursor: "600",
      hasMore: true,
    });
    await useChatStore.getState().loadOlder({ kind: "channel", channelId: 10 });
    messages = useChatStore.getState().conversations["channel:10"]?.messages ?? [];
    expect(messages).toHaveLength(400);
    expect(messages[0]?.id).toBe(600);
    expect(messages.at(-1)?.id).toBe(999);

    // A message that arrives after the history load is still appended: the
    // caps of the two directions do not fight each other.
    useChatStore.getState().applyMessage(message(1_000), 1);
    messages = useChatStore.getState().conversations["channel:10"]?.messages ?? [];
    expect(messages.at(-1)?.id).toBe(1_000);
  });

  it("loads older messages when the cache is already at its cap", async () => {
    const cached = Array.from({ length: MAX_CACHED_MESSAGES }, (_, index) =>
      message(500 + index),
    );
    useChatStore.setState({
      conversations: conversation(cached, "500"),
      proxy: { baseUrl: "fixture://chat", token: "proxy" },
    });
    fetchHistoryMock.mockResolvedValue({
      messages: Array.from({ length: 50 }, (_, index) => message(450 + index)),
      nextCursor: "450",
      hasMore: true,
    });

    await useChatStore.getState().loadOlder({ kind: "channel", channelId: 10 });

    const state = useChatStore.getState().conversations["channel:10"];
    expect(state?.nextCursor).toBe("450");
    // The cursor and the list move together now.
    expect(state?.messages[0]?.id).toBe(450);
    expect(state?.messages).toHaveLength(MAX_CACHED_MESSAGES);
  });

  it("derives the direct conversation peer for both sides", () => {
    const own = message(1, {
      channelId: 0,
      senderId: 1,
      recipientId: 2,
    });
    const incoming = message(2, {
      channelId: 0,
      senderId: 2,
      recipientId: 1,
    });
    expect(messageConversationKey(own, 1)).toBe("dm:2");
    expect(messageConversationKey(incoming, 1)).toBe("dm:2");
    expect(messageConversationKey(message(3), 1)).toBe("channel:10");
    expect(
      deletedConversationKey(
        { channelId: 0, senderId: 2, recipientId: 1 },
        1,
      ),
    ).toBe("dm:2");
  });

  it("applies an event only once and removes a deleted message", () => {
    const store = useChatStore.getState();
    store.applyMessage(message(1), 1);
    store.applyMessage(message(2, { senderId: 1, recipientId: 0, channelId: 10 }), 1);
    store.applyMessage(message(2), 1);
    expect(useChatStore.getState().conversations["channel:10"]?.messages).toHaveLength(2);

    store.removeMessage(
      { messageId: 2, channelId: 10, senderId: 2, recipientId: 0 },
      1,
    );
    const messages = useChatStore.getState().conversations["channel:10"]?.messages;
    expect(messages?.map((item) => item.id)).toEqual([1]);
  });

  it("keeps at most three notices", () => {
    const store = useChatStore.getState();
    for (let index = 0; index < 5; index += 1) {
      store.pushNotice({
        key: "channel:10",
        title: "t",
        body: String(index),
        mention: false,
      });
    }
    expect(useChatStore.getState().notices).toHaveLength(3);
  });

  it("reloads the first page and merges it once the cache is stale", async () => {
    useChatStore.setState({
      conversations: {
        ...conversation([message(1), message(2)], ""),
        "channel:10": {
          ...conversation([message(1), message(2)], "")["channel:10"],
          stale: true,
        },
      },
      proxy: { baseUrl: "http://127.0.0.1:9", token: "proxy" },
    });
    fetchHistoryMock.mockResolvedValue({
      messages: [message(3), message(4)],
      nextCursor: "",
      hasMore: false,
    });

    await useChatStore
      .getState()
      .ensureLoaded({ kind: "channel", channelId: 10 });

    const state = useChatStore.getState().conversations["channel:10"];
    expect(fetchHistoryMock).toHaveBeenCalledTimes(1);
    // The cached messages stay: a reconnect does not erase the conversation,
    // it catches up from the first page.
    expect(state?.messages.map((item) => item.id)).toEqual([1, 2, 3, 4]);
    expect(state?.stale).toBe(false);
    expect(state?.error).toBeNull();
  });

  it("does not acknowledge a first page loaded while its panel is hidden", async () => {
    const markRead = vi.mocked(coreApi.markRead);
    markRead.mockClear();
    const cached = () => ({
      ...conversation([], "")["channel:10"],
      loaded: false,
      stale: true,
      hasMore: false,
    });
    fetchHistoryMock.mockResolvedValue({
      messages: [message(7)],
      nextCursor: "",
      hasMore: false,
    });
    useChatStore.setState({
      conversations: { "channel:10": cached() },
      activeKey: null,
      proxy: { baseUrl: "http://127.0.0.1:9", token: "proxy" },
    });

    await useChatStore
      .getState()
      .ensureLoaded({ kind: "channel", channelId: 10 });

    expect(markRead).not.toHaveBeenCalled();

    // The open panel acknowledges it when the reader returns.
    fetchHistoryMock.mockResolvedValue({
      messages: [message(8)],
      nextCursor: "",
      hasMore: false,
    });
    useChatStore.setState({
      conversations: { "channel:10": cached() },
      activeKey: "channel:10",
    });
    await useChatStore
      .getState()
      .ensureLoaded({ kind: "channel", channelId: 10 });

    expect(markRead).toHaveBeenCalledWith(
      { kind: "channel", channelId: 10 },
      8,
    );
  });

  it("does not acknowledge a first page while the window is hidden", async () => {
    const markRead = vi.mocked(coreApi.markRead);
    markRead.mockClear();
    const cached = () => ({
      ...conversation([], "")["channel:10"],
      loaded: false,
      stale: true,
      hasMore: false,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    try {
      fetchHistoryMock.mockResolvedValue({
        messages: [message(9)],
        nextCursor: "",
        hasMore: false,
      });
      useChatStore.setState({
        conversations: { "channel:10": cached() },
        activeKey: "channel:10",
        proxy: { baseUrl: "http://127.0.0.1:9", token: "proxy" },
      });

      await useChatStore
        .getState()
        .ensureLoaded({ kind: "channel", channelId: 10 });

      expect(markRead).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(document, "hidden");
    }

    // Visible again: the next first page is acknowledged.
    fetchHistoryMock.mockResolvedValue({
      messages: [message(10)],
      nextCursor: "",
      hasMore: false,
    });
    useChatStore.setState({
      conversations: { "channel:10": cached() },
    });
    await useChatStore
      .getState()
      .ensureLoaded({ kind: "channel", channelId: 10 });

    expect(markRead).toHaveBeenCalledWith(
      { kind: "channel", channelId: 10 },
      10,
    );
  });

  it("does not report an error while the proxy is missing and retries when it appears", async () => {
    chatProxyMock.mockResolvedValue(null);
    useChatStore.setState({
      conversations: {
        "channel:10": {
          ...conversation([message(1)], "")["channel:10"],
          loaded: false,
          stale: true,
        },
      },
      // The panel of this conversation is open: that is the one that retries.
      activeKey: "channel:10",
    });

    await useChatStore
      .getState()
      .ensureLoaded({ kind: "channel", channelId: 10 });

    let state = useChatStore.getState().conversations["channel:10"];
    // The core starts the proxy right after Welcome; this is not an error the
    // reader should see, and the cached message is still there.
    expect(state?.error).toBeNull();
    expect(state?.stale).toBe(true);
    expect(state?.messages.map((item) => item.id)).toEqual([1]);
    expect(fetchHistoryMock).not.toHaveBeenCalled();

    fetchHistoryMock.mockResolvedValue({
      messages: [message(1), message(2)],
      nextCursor: "",
      hasMore: false,
    });
    chatProxyMock.mockResolvedValue({
      baseUrl: "http://127.0.0.1:9",
      token: "proxy",
    });
    useChatStore.getState().setProxy({
      baseUrl: "http://127.0.0.1:9",
      token: "proxy",
    });

    await vi.waitFor(() => {
      expect(fetchHistoryMock).toHaveBeenCalledTimes(1);
    });
    state = useChatStore.getState().conversations["channel:10"];
    expect(state?.messages.map((item) => item.id)).toEqual([1, 2]);
    expect(state?.loaded).toBe(true);
    expect(state?.stale).toBe(false);
  });

  it("keeps the cached messages and the reason when a refresh fails", async () => {
    useChatStore.setState({
      conversations: {
        "channel:10": {
          ...conversation([message(1), message(2)], "")["channel:10"],
          stale: true,
        },
      },
      proxy: { baseUrl: "http://127.0.0.1:9", token: "proxy" },
    });
    fetchHistoryMock.mockRejectedValue(new ChatHttpError(503, "internal", "down"));

    await useChatStore
      .getState()
      .ensureLoaded({ kind: "channel", channelId: 10 });

    const state = useChatStore.getState().conversations["channel:10"];
    expect(state?.messages.map((item) => item.id)).toEqual([1, 2]);
    expect(state?.error).toBe("unreachable");
    // A conversation with messages never looks empty, so it never shows the
    // full-screen error.
    expect(state?.loaded).toBe(true);
  });

  it("classifies history failures into the three error screens", () => {
    expect(chatErrorKind(new ChatHttpError(403, "permission_denied", "no"))).toBe(
      "access",
    );
    expect(chatErrorKind(new ChatHttpError(404, "not_found", "no"))).toBe("access");
    expect(chatErrorKind(new ChatHttpError(0, "network", "no"))).toBe(
      "unreachable",
    );
    expect(chatErrorKind(new ChatHttpError(500, "internal", "no"))).toBe(
      "unreachable",
    );
    expect(chatErrorKind(new ChatHttpError(400, "invalid_request", "no"))).toBe(
      "load",
    );
    expect(chatErrorKind(new Error("boom"))).toBe("load");
  });

  it("marks every cached conversation stale, keeping the messages", () => {
    useChatStore.setState({
      conversations: {
        "channel:10": conversation([message(2)], "")["channel:10"],
      },
    });
    useChatStore.getState().markStale();
    const state = useChatStore.getState().conversations["channel:10"];
    expect(state?.stale).toBe(true);
    expect(state?.messages.map((item) => item.id)).toEqual([2]);
  });
});
