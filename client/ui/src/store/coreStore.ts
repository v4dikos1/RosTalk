import { create } from "zustand";

import { coreApi } from "@/core";
import type {
  CoreError,
  CoreEvent,
  CoreState,
  StateDelta,
  UserView,
} from "@/core/api";

export { useVoiceStore, voiceLevelForUser } from "./voiceStore";

/**
 * The UI half of the state mirror (design 5.1).
 *
 * `CoreHandle` owns the truth. This store keeps the last snapshot and applies
 * deltas; it never changes connection or channel state on its own. Commands go
 * back to the core through `CoreApi`.
 *
 * `applyDelta` is a pure function and is covered by unit tests.
 */
export function applyDelta(state: CoreState, delta: StateDelta): CoreState {
  switch (delta.type) {
    case "connection":
      return {
        ...state,
        connection: delta.payload.connection,
        reconnect: delta.payload.reconnect,
        error: delta.payload.error,
      };
    case "reset":
      return {
        connection: "disconnected",
        reconnect: null,
        server: null,
        roles: [],
        channels: [],
        users: [],
        selfUserId: 0,
        nickname: "",
        profile: delta.payload.profile,
        permissions: null,
        unread: [],
        servers: delta.payload.servers,
        activeServerId: delta.payload.activeServerId,
        error: delta.payload.error,
        protocolVersion: delta.payload.protocolVersion,
        clientVersion: delta.payload.clientVersion,
      };
    case "userJoined":
      return {
        ...state,
        users: upsertUser(state.users, delta.payload),
      };
    case "userLeft":
      return {
        ...state,
        users: state.users.filter((user) => user.id !== delta.payload.userId),
      };
    case "userMoved":
      return {
        ...state,
        users: state.users.map((user) =>
          user.id === delta.payload.userId
            ? {
                ...user,
                channelId: delta.payload.toChannelId,
                // A viewer list only names streams of one channel and the move
                // event carries none: a user in another channel watches nothing.
                watchingUserIds: [],
              }
            : user,
        ),
      };
    case "userUpdated":
      return {
        ...state,
        users: upsertUser(state.users, delta.payload),
        nickname:
          delta.payload.id === state.selfUserId
            ? delta.payload.nickname
            : state.nickname,
      };
    case "channelCreated":
    case "channelUpdated":
      return {
        ...state,
        channels: upsertChannel(state.channels, delta.payload),
      };
    case "channelDeleted":
      return {
        ...state,
        channels: state.channels.filter(
          (channel) => channel.id !== delta.payload.channelId,
        ),
      };
    case "serverUpdated":
      return { ...state, server: delta.payload };
    case "rolesUpdated":
      return { ...state, roles: delta.payload };
    case "permissionsUpdated":
      return { ...state, permissions: delta.payload };
    case "unreadUpdated": {
      const next = state.unread.slice();
      const index = next.findIndex(
        (counter) =>
          counter.channelId === delta.payload.channelId &&
          counter.peerUserId === delta.payload.peerUserId,
      );
      if (index === -1) {
        next.push(delta.payload);
      } else {
        next[index] = delta.payload;
      }
      return { ...state, unread: next };
    }
    case "messageCreated":
    case "messageUpdated":
    case "messageDeleted":
      // Messages live in the chat store, not in the connection snapshot.
      return state;
    case "bookmarks":
      return { ...state, servers: delta.payload };
    case "profile":
      return { ...state, profile: delta.payload };
  }
}

function upsertUser(users: UserView[], user: UserView): UserView[] {
  const index = users.findIndex((item) => item.id === user.id);
  if (index === -1) {
    return [...users, user];
  }
  const next = users.slice();
  next[index] = user;
  return next;
}

function upsertChannel(
  channels: CoreState["channels"],
  channel: CoreState["channels"][number],
): CoreState["channels"] {
  const index = channels.findIndex((item) => item.id === channel.id);
  if (index === -1) {
    return [...channels, channel];
  }
  const next = channels.slice();
  next[index] = channel;
  return next;
}

interface CoreMirror {
  /** Last known snapshot, `null` until the first hydration. */
  state: CoreState | null;
  /** True after the first snapshot or `getState` reply. */
  hydrated: boolean;
  /** Last failed UI action (not a connection error, those live in state). */
  actionError: CoreError | null;
  /** Channel or action the failed command belonged to, for the notice strip. */
  actionContext: string | null;
  pending: StateDelta[];

  /** Initial reply to `getState`; ignored if a snapshot already arrived. */
  hydrate: (state: CoreState) => void;
  /** A full snapshot from the core; always replaces the mirror. */
  snapshot: (state: CoreState) => void;
  /** A delta from the core. */
  delta: (delta: StateDelta) => void;
  /** Stores a failed command for the notice strip. */
  setActionError: (error: CoreError | null, context?: string | null) => void;
}

/** Media identity of a user is `<user id>:voice`; the UI knows only the id. */

export const useCoreStore = create<CoreMirror>()((set) => ({
  state: null,
  hydrated: false,
  actionError: null,
  actionContext: null,
  pending: [],

  hydrate: (state) =>
    set((current) => {
      if (current.hydrated) {
        return current;
      }
      // Deltas that arrived between `subscribe` and `getState` are replayed on
      // top of the reply; the reply may be a few microseconds old.
      const merged = current.pending.reduce(
        (acc, delta) => applyDelta(acc, delta),
        state,
      );
      return { ...current, state: merged, hydrated: true, pending: [] };
    }),

  snapshot: (state) =>
    set({
      state,
      hydrated: true,
      pending: [],
    }),

  delta: (delta) =>
    set((current) => {
      if (!current.state) {
        return { ...current, pending: [...current.pending, delta] };
      }
      return { ...current, state: applyDelta(current.state, delta) };
    }),

  setActionError: (actionError, actionContext = null) =>
    set({ actionError, actionContext }),
}));

/**
 * Starts the mirror: subscribes to core events and hydrates from `getState`.
 * Returns the unsubscribe function. Call once from the root component.
 */
export function startCoreMirror(): () => void {
  const unsubscribe = coreApi.subscribe((event: CoreEvent) => {
    const store = useCoreStore.getState();
    if (event.type === "snapshot") {
      store.snapshot(event.payload);
    } else {
      store.delta(event.payload);
    }
  });

  void coreApi
    .getState()
    .then((state) => useCoreStore.getState().hydrate(state))
    .catch((error: unknown) => {
      useCoreStore.getState().setActionError({
        code: "internal",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        actionUrl: null,
        serverCode: null,
      });
    });

  return () => {
    unsubscribe();
  };
}

/** Runs a core command and exposes failures in the notice strip. */
export async function runCoreAction(
  action: () => Promise<unknown>,
  context?: string,
): Promise<boolean> {
  try {
    await action();
    useCoreStore.getState().setActionError(null);
    return true;
  } catch (error) {
    useCoreStore.getState().setActionError(toCoreError(error), context ?? null);
    return false;
  }
}

function toCoreError(error: unknown): CoreError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error
  ) {
    return error as CoreError;
  }
  return {
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    actionUrl: null,
    serverCode: null,
  };
}
