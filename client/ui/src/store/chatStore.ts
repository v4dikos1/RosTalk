import { create } from "zustand";

import { coreApi } from "@/core";
import type {
  ChatProxyView,
  ChatTarget,
  MessageView,
  MessageDeletedDelta,
} from "@/core/api";
import {
  ChatHttpError,
  type ConversationKey,
  conversationKey,
  deletedConversationKey,
  fetchHistory,
  messageConversationKey,
} from "@/lib/chat";

/**
 * Per-conversation message cache (stage 4.1).
 *
 * The core owns the truth and forwards every stored message as a delta. This
 * store keeps the pages the UI has loaded and the pending uploads; it never
 * invents messages. History pages come through the core's loopback HTTP proxy,
 * not from the core snapshot.
 */
export interface ConversationState {
  key: ConversationKey;
  target: ChatTarget;
  messages: MessageView[];
  nextCursor: string;
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  error: ChatErrorKind | null;
  /**
   * The cached pages may be behind the server: the session was re-established
   * or refreshed and live deltas could have been lost while it was down. The
   * cache stays visible; the next open reloads the first page and merges it.
   */
  stale: boolean;
}

/**
 * Why a history request failed, as far as the UI can tell.
 *
 * The cache is never cleared for a reconnect to the same server, so an error
 * must not look like "the chat is empty". The categories are the three cases
 * the reader can act on.
 */
export type ChatErrorKind = "access" | "unreachable" | "load";

/** One in-app notification when the OS notification is unavailable. */
export interface ChatNotice {
  id: number;
  /** Conversation the notice opens; `null` for a plain status notice. */
  key: ConversationKey | null;
  title: string;
  body: string;
  mention: boolean;
  /** Voice-channel status (a move between rooms), not a chat message. */
  voice?: boolean;
}

/** Cap one conversation so a long-lived window does not grow forever. */
export const MAX_CACHED_MESSAGES = 400;

/**
 * How long the store waits for the core to publish the proxy coordinates.
 *
 * The core starts the loopback proxy right after the `Welcome` snapshot, so
 * the first history request can arrive a few milliseconds too early. The page
 * must not show "failed to load" for that: it waits and retries, and the proxy
 * setter retries again when the coordinates finally arrive.
 */
const PROXY_WAIT_ATTEMPTS = 10;
const PROXY_WAIT_MS = 150;

interface ChatState {
  conversations: Record<string, ConversationState>;
  activeKey: ConversationKey | null;
  proxy: ChatProxyView | null;
  notices: ChatNotice[];

  setProxy: (proxy: ChatProxyView | null) => void;
  setActive: (key: ConversationKey | null) => void;
  ensureConversation: (target: ChatTarget) => void;
  ensureLoaded: (target: ChatTarget) => Promise<void>;
  loadOlder: (target: ChatTarget) => Promise<void>;
  applyMessage: (message: MessageView, selfUserId: number) => void;
  removeMessage: (delta: MessageDeletedDelta, selfUserId: number) => void;
  markRead: (target: ChatTarget, upToMessageId: number) => Promise<void>;
  /** Marks every cached conversation for a first-page refresh. */
  markStale: () => void;
  pushNotice: (notice: Omit<ChatNotice, "id">) => void;
  dismissNotice: (id: number) => void;
  /** Drops the whole cache. Only a server change may do that. */
  clear: () => void;
}

let noticeId = 1;

/** Waits for the core to publish the proxy coordinates. */
async function proxyOrWait(current: ChatProxyView | null): Promise<ChatProxyView | null> {
  if (current) {
    return current;
  }
  for (let attempt = 0; attempt < PROXY_WAIT_ATTEMPTS; attempt += 1) {
    const proxy = await coreApi.chatProxy().catch(() => null);
    if (proxy) {
      return proxy;
    }
    if (attempt + 1 < PROXY_WAIT_ATTEMPTS) {
      await new Promise((resolve) => window.setTimeout(resolve, PROXY_WAIT_MS));
    }
  }
  return null;
}

/** Maps a failed history request to the screen the reader should see. */
export function chatErrorKind(error: unknown): ChatErrorKind {
  if (error instanceof ChatHttpError) {
    if (error.status === 403 || error.status === 404) {
      return "access";
    }
    if (error.status === 0 || error.status >= 500) {
      return "unreachable";
    }
  }
  return "load";
}

/** How the cache is trimmed when a page makes it longer than the cap. */
export type MergeOverflow = "newest" | "oldest";

/**
 * Sorted merge with deduplication by id.
 *
 * New messages and history pages use the opposite ends of the cap:
 * - `newest` (events, sends, the first page) keeps the last messages, so the
 *   live tail is never dropped;
 * - `oldest` (older history) keeps the first messages, so a page prepended at
 *   the top actually stays visible instead of being trimmed away again.
 */
export function mergeMessages(
  current: MessageView[],
  incoming: MessageView[],
  overflow: MergeOverflow = "newest",
): MessageView[] {
  const byID = new Map<number, MessageView>();
  for (const message of current) {
    byID.set(message.id, message);
  }
  for (const message of incoming) {
    byID.set(message.id, message);
  }
  const merged = [...byID.values()].sort((a, b) => a.id - b.id);
  return overflow === "oldest"
    ? merged.slice(0, MAX_CACHED_MESSAGES)
    : merged.slice(-MAX_CACHED_MESSAGES);
}

export const useChatStore = create<ChatState>()((set, get) => ({
  conversations: {},
  activeKey: null,
  proxy: null,
  notices: [],

  setProxy: (proxy) => {
    set({ proxy });
    if (!proxy) {
      return;
    }
    // A request that failed only because the proxy was not up yet, and the
    // conversation on screen when the cache was marked stale by a reconnect,
    // retry as soon as the coordinates are known. Other conversations reload
    // when the reader opens them; there is no point in fetching every cached
    // channel at once.
    const { activeKey } = get();
    for (const conversation of Object.values(get().conversations)) {
      const failedWithoutProxy = conversation.error === "unreachable";
      const openAndStale = conversation.stale && conversation.key === activeKey;
      if (failedWithoutProxy || openAndStale) {
        void get().ensureLoaded(conversation.target);
      }
    }
  },

  setActive: (activeKey) => set({ activeKey }),

  ensureConversation: (target) =>
    set((state) => {
      const key = conversationKey(target);
      if (state.conversations[key]) {
        return state;
      }
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [key]: {
            key,
            target,
            messages: [],
            nextCursor: "",
            hasMore: false,
            loaded: false,
            loading: false,
            error: null,
            stale: false,
          },
        },
      };
    }),

  ensureLoaded: async (target) => {
    const key = conversationKey(target);
    get().ensureConversation(target);
    const existing = get().conversations[key];
    if (!existing || existing.loading) {
      return;
    }
    if (existing.loaded && !existing.stale && !existing.error) {
      return;
    }
    const loadingState: ConversationState = {
      ...existing,
      loading: true,
      error: null,
    };
    set((state) => ({
      conversations: {
        ...state.conversations,
        [key]: loadingState,
      },
    }));
    const proxy = await proxyOrWait(get().proxy);
    if (!proxy) {
      // The core has not published the proxy yet (it starts right after
      // Welcome). Keep the cache and wait for `setProxy` instead of showing a
      // failure: nothing has actually failed yet.
      set((state) => {
        const conversation = state.conversations[key];
        if (!conversation) {
          return state;
        }
        return {
          conversations: {
            ...state.conversations,
            [key]: { ...conversation, loading: false, stale: true },
          },
        };
      });
      return;
    }
    set({ proxy });
    try {
      const page = await fetchHistory(proxy, target, "", 60);
      set((state) => {
        const conversation = state.conversations[key];
        if (!conversation) {
          return state;
        }
        const messages = mergeMessages(conversation.messages, page.messages);
        return {
          conversations: {
            ...state.conversations,
            [key]: {
              ...conversation,
              messages,
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
              loaded: true,
              loading: false,
              error: null,
              stale: false,
            },
          },
        };
      });
      const newest = page.messages.at(-1);
      if (newest) {
        void get().markRead(target, newest.id);
      }
    } catch (error) {
      const kind = chatErrorKind(error);
      set((state) => {
        const conversation = state.conversations[key];
        if (!conversation) {
          return state;
        }
        return {
          conversations: {
            ...state.conversations,
            [key]: {
              ...conversation,
              loading: false,
              // Keep the cache visible; only a genuinely empty conversation
              // shows the error screen.
              loaded: conversation.messages.length > 0,
              error: kind,
              stale: true,
            },
          },
        };
      });
    }
  },

  loadOlder: async (target) => {
    const key = conversationKey(target);
    const conversation = get().conversations[key];
    if (!conversation || !conversation.hasMore || conversation.loading) {
      return;
    }
    const loadingState: ConversationState = { ...conversation, loading: true };
    set((state) => ({
      conversations: {
        ...state.conversations,
        [key]: loadingState,
      },
    }));
    try {
      const proxy = await proxyOrWait(get().proxy);
      if (!proxy) {
        throw new Error("chat unavailable");
      }
      set({ proxy });
      const page = await fetchHistory(proxy, target, conversation.nextCursor, 50);
      set((state) => {
        const latest = state.conversations[key];
        if (!latest) {
          return state;
        }
        return {
          conversations: {
            ...state.conversations,
            [key]: {
              ...latest,
              messages: mergeMessages(latest.messages, page.messages, "oldest"),
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
              loading: false,
            },
          },
        };
      });
    } catch (error) {
      set((state) => {
        const latest = state.conversations[key];
        if (!latest) {
          return state;
        }
        return {
          conversations: {
            ...state.conversations,
            [key]: {
              ...latest,
              loading: false,
              error: chatErrorKind(error),
            },
          },
        };
      });
    }
  },

  applyMessage: (message, selfUserId) => {
    const key = messageConversationKey(message, selfUserId);
    set((state) => {
      const conversation = state.conversations[key];
      const target: ChatTarget =
        message.channelId !== 0
          ? { kind: "channel", channelId: message.channelId }
          : { kind: "dm", peerId: message.senderId === selfUserId ? message.recipientId : message.senderId };
      if (!conversation) {
        return {
          ...state,
          conversations: {
            ...state.conversations,
            [key]: {
              key,
              target,
              messages: [message],
              nextCursor: "",
              hasMore: false,
              loaded: false,
              loading: false,
              error: null,
              stale: false,
            },
          },
        };
      }
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [key]: {
            ...conversation,
            messages: mergeMessages(conversation.messages, [message]),
          },
        },
      };
    });
  },

  removeMessage: (delta, selfUserId) => {
    const key = deletedConversationKey(delta, selfUserId);
    set((state) => {
      const conversation = state.conversations[key];
      if (!conversation) {
        return state;
      }
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [key]: {
            ...conversation,
            messages: conversation.messages.filter(
              (message) => message.id !== delta.messageId,
            ),
          },
        },
      };
    });
  },

  markRead: async (target, upToMessageId) => {
    try {
      await coreApi.markRead(target, upToMessageId);
    } catch {
      // A read marker is advisory; the next open retries it.
    }
  },

  markStale: () =>
    set((state) => {
      const conversations: Record<string, ConversationState> = {};
      for (const [key, conversation] of Object.entries(state.conversations)) {
        conversations[key] = { ...conversation, stale: true };
      }
      return { ...state, conversations };
    }),

  pushNotice: (notice) =>
    set((state) => ({
      notices: [...state.notices.slice(-2), { ...notice, id: noticeId++ }],
    })),

  dismissNotice: (id) =>
    set((state) => ({
      notices: state.notices.filter((notice) => notice.id !== id),
    })),

  clear: () =>
    set({
      conversations: {},
      activeKey: null,
      proxy: null,
      notices: [],
    }),
}));

/** Conversation key of a target, for components. */
export { conversationKey };
