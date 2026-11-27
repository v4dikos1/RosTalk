import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoreEvent, CoreState, MessageView } from "@/core/api";
import { fixtureState } from "@/mock/fixtures";
import { useChatStore } from "@/store/chatStore";
import { useCoreStore } from "@/store/coreStore";

import { startChatMirror } from "./chatMirror";

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  chatProxy: vi.fn(),
  markRead: vi.fn(),
  playVoiceSound: vi.fn(),
}));

vi.mock("@/core", () => ({ coreApi: mocks }));

function message(id: number): MessageView {
  return {
    id,
    channelId: 1,
    senderId: 2,
    recipientId: 0,
    senderNickname: "Anya",
    body: `message ${id}`,
    createdAtUnixMs: 1_700_000_000_000 + id,
    editedAtUnixMs: 0,
    attachments: [],
    mentionUserIds: [],
  };
}

function seedConversation() {
  useChatStore.setState({
    conversations: {
      "channel:1": {
        key: "channel:1",
        target: { kind: "channel", channelId: 1 },
        messages: [message(1), message(2)],
        nextCursor: "",
        hasMore: false,
        loaded: true,
        loading: false,
        error: null,
        stale: false,
      },
    },
  });
}

function snapshot(activeServerId: string): CoreEvent {
  const payload: CoreState = {
    ...structuredClone(fixtureState),
    activeServerId,
  };
  return { type: "snapshot", payload };
}

function reset(activeServerId: string | null): CoreEvent {
  return {
    type: "delta",
    payload: {
      type: "reset",
      payload: {
        servers: [],
        activeServerId,
        profile: structuredClone(fixtureState.profile),
        error: null,
        protocolVersion: 1,
        clientVersion: "0.1.0",
      },
    },
  };
}

describe("chat mirror", () => {
  let listener: (event: CoreEvent) => void;

  beforeEach(() => {
    mocks.subscribe.mockReset();
    mocks.chatProxy.mockReset();
    mocks.markRead.mockReset();
    mocks.playVoiceSound.mockReset();
    mocks.chatProxy.mockResolvedValue({
      baseUrl: "http://127.0.0.1:9",
      token: "proxy",
    });
    mocks.subscribe.mockImplementation((callback: (event: CoreEvent) => void) => {
      listener = callback;
      return () => {};
    });
    mocks.markRead.mockResolvedValue(undefined);
    mocks.playVoiceSound.mockResolvedValue(undefined);
    useCoreStore.setState({
      state: structuredClone(fixtureState),
      hydrated: true,
      pending: [],
    });
    useChatStore.setState({
      conversations: {},
      activeKey: null,
      proxy: null,
      notices: [],
    });
  });

  it("keeps conversations but marks them stale on a reset of the same server", () => {
    const stop = startChatMirror();
    listener(snapshot("server-a"));
    seedConversation();

    listener(reset("server-a"));

    const conversations = useChatStore.getState().conversations;
    expect(conversations["channel:1"]?.messages.map((item) => item.id)).toEqual([
      1, 2,
    ]);
    expect(conversations["channel:1"]?.stale).toBe(true);
    stop();
  });

  it("drops the cache when the reset points at another server", () => {
    const stop = startChatMirror();
    listener(snapshot("server-a"));
    seedConversation();

    listener(reset("server-b"));

    expect(useChatStore.getState().conversations).toEqual({});
    stop();
  });

  it("drops the cache when a snapshot arrives from another server", () => {
    const stop = startChatMirror();
    listener(snapshot("server-a"));
    seedConversation();

    listener(snapshot("server-b"));

    expect(useChatStore.getState().conversations).toEqual({});
    stop();
  });

  it("drops the cache when the same address is a different server", () => {
    const stop = startChatMirror();
    listener(snapshot("192.168.0.13:7443"));
    seedConversation();

    const other = snapshot("192.168.0.13:7443");
    if (other.type === "snapshot") {
      other.payload = {
        ...other.payload,
        server: { ...other.payload.server!, id: "another-server" },
      };
    }
    listener(other);

    // The bookmark id is host:port, so a server re-provisioned on the same
    // address must still be recognised as a different conversation space.
    expect(useChatStore.getState().conversations).toEqual({});
    stop();
  });

  it("keeps the cache and marks it stale on a snapshot of the same server", () => {
    const stop = startChatMirror();
    listener(snapshot("server-a"));
    seedConversation();

    listener(snapshot("server-a"));

    const conversation = useChatStore.getState().conversations["channel:1"];
    expect(conversation?.messages.map((item) => item.id)).toEqual([1, 2]);
    expect(conversation?.stale).toBe(true);
    stop();
  });

  it("sounds a direct message in the core and keeps the system notification silent", () => {
    const notifications: { title: string; options?: NotificationOptions }[] = [];
    class FakeNotification {
      static permission: NotificationPermission = "granted";
      static requestPermission = vi.fn(async () => "granted" as NotificationPermission);
      constructor(title: string, options?: NotificationOptions) {
        notifications.push(options ? { title, options } : { title });
      }
    }
    vi.stubGlobal("Notification", FakeNotification);

    const stop = startChatMirror();
    listener(snapshot("server-a"));
    listener({
      type: "delta",
      payload: {
        type: "messageCreated",
        payload: {
          ...message(7),
          channelId: 0,
          recipientId: 1,
          mentionUserIds: [],
        },
      },
    });

    expect(mocks.playVoiceSound).toHaveBeenCalledWith("directMessage");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.options?.silent).toBe(true);
    stop();
    vi.unstubAllGlobals();
  });

  function created(overrides: Partial<MessageView>): CoreEvent {
    return {
      type: "delta",
      payload: {
        type: "messageCreated",
        payload: { ...message(9), ...overrides },
      },
    };
  }

  it("notifies a mentioned user once per message even with a repeated tag", () => {
    const stop = startChatMirror();
    listener(snapshot("server-a"));
    listener(created({ mentionUserIds: [1, 1] }));

    expect(mocks.playVoiceSound).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().notices).toHaveLength(1);
    expect(useChatStore.getState().notices[0]?.mention).toBe(true);
    stop();
  });

  it("does not notify a third participant of the same message", () => {
    const stop = startChatMirror();
    listener(snapshot("server-a"));
    listener(created({ mentionUserIds: [4] }));

    expect(mocks.playVoiceSound).not.toHaveBeenCalled();
    expect(useChatStore.getState().notices).toHaveLength(0);
    stop();
  });

  it("does not treat the author's own mention as incoming", () => {
    const stop = startChatMirror();
    listener(snapshot("server-a"));
    listener(created({ senderId: 1, mentionUserIds: [1] }));

    expect(mocks.playVoiceSound).not.toHaveBeenCalled();
    expect(useChatStore.getState().notices).toHaveLength(0);
    stop();
  });
});
