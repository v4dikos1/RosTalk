import { describe, expect, it } from "vitest";

import type { CoreState, StateDelta, UserView } from "@/core/api";
import { fixtureState } from "@/mock/fixtures";

import { applyDelta } from "./coreStore";

function state(): CoreState {
  return structuredClone(fixtureState);
}

function user(id: number, patch: Partial<UserView> = {}): UserView {
  return {
    id,
    nickname: `user-${id}`,
    roleIds: [],
    color: null,
    channelId: 0,
    voice: {
      selfMuted: false,
      selfDeafened: false,
      serverMuted: false,
      serverDeafened: false,
      away: false,
      prioritySpeaker: false,
    },
    streaming: false,
    watchingUserIds: [],
    connectedAtUnixMs: 0,
    avatarHash: "",
    ...patch,
  };
}

describe("applyDelta", () => {
  it("replaces connection fields", () => {
    const delta: StateDelta = {
      type: "connection",
      payload: {
        connection: "reconnecting",
        reconnect: { attempt: 2, delayMs: 2000 },
        error: null,
      },
    };
    const next = applyDelta(state(), delta);
    expect(next.connection).toBe("reconnecting");
    expect(next.reconnect).toEqual({ attempt: 2, delayMs: 2000 });
  });

  it("clears the session on reset but keeps saved servers", () => {
    const before = state();
    const saved = [...before.servers];
    const next = applyDelta(before, {
      type: "reset",
      payload: {
        servers: saved,
        activeServerId: "fixture-fingerprint",
        profile: { nickname: "Alex" },
        error: null,
        protocolVersion: 1,
        clientVersion: "0.1.0",
      },
    });

    expect(next.connection).toBe("disconnected");
    expect(next.reconnect).toBeNull();
    expect(next.server).toBeNull();
    expect(next.roles).toEqual([]);
    expect(next.channels).toEqual([]);
    expect(next.users).toEqual([]);
    expect(next.selfUserId).toBe(0);
    expect(next.nickname).toBe("");
    expect(next.permissions).toBeNull();
    expect(next.servers).toEqual(saved);
    expect(next.activeServerId).toBe("fixture-fingerprint");
    // The local profile is not part of the session.
    expect(next.profile).toEqual({ nickname: "Alex" });
  });

  it("keeps a fatal error from the reset delta", () => {
    const error = {
      code: "tlsFingerprintMismatch" as const,
      message: "mismatch",
      retryable: false,
      actionUrl: null,
      serverCode: null,
    };
    const next = applyDelta(state(), {
      type: "reset",
      payload: {
        servers: [],
        activeServerId: null,
        profile: { nickname: "" },
        error,
        protocolVersion: 1,
        clientVersion: "0.1.0",
      },
    });
    expect(next.error).toEqual(error);
    expect(next.users).toEqual([]);
  });

  it("applies a profile delta", () => {
    const next = applyDelta(state(), {
      type: "profile",
      payload: { nickname: "alice" },
    });
    expect(next.profile.nickname).toBe("alice");
  });

  it("adds a joined user without mutating the previous state", () => {
    const before = state();
    const next = applyDelta(before, {
      type: "userJoined",
      payload: user(99, { nickname: "new", channelId: 3 }),
    });
    expect(next.users.some((item) => item.id === 99)).toBe(true);
    expect(before.users.some((item) => item.id === 99)).toBe(false);
  });

  it("removes a user who left", () => {
    const next = applyDelta(state(), {
      type: "userLeft",
      payload: { userId: 3 },
    });
    expect(next.users.some((item) => item.id === 3)).toBe(false);
  });

  it("follows a move delta", () => {
    const next = applyDelta(state(), {
      type: "userMoved",
      payload: { userId: 2, fromChannelId: 3, toChannelId: 4 },
    });
    expect(next.users.find((item) => item.id === 2)?.channelId).toBe(4);
  });

  it("drops the viewer list of a user who changes channel", () => {
    // The move event carries no viewer list and a stream of the old channel
    // cannot be watched from the new one, so the mirror clears it (stage P12).
    const base = state();
    const watcher = base.users.find((item) => item.id === 5);
    expect(watcher?.watchingUserIds).toEqual([6]);
    const next = applyDelta(base, {
      type: "userMoved",
      payload: { userId: 5, fromChannelId: 4, toChannelId: 3 },
    });
    expect(next.users.find((item) => item.id === 5)?.watchingUserIds).toEqual(
      [],
    );
  });

  it("updates a user and the own nickname", () => {
    const next = applyDelta(state(), {
      type: "userUpdated",
      payload: user(fixtureState.selfUserId, {
        nickname: "renamed",
        channelId: 3,
      }),
    });
    expect(next.nickname).toBe("renamed");
    expect(next.users.find((item) => item.id === fixtureState.selfUserId)?.nickname).toBe(
      "renamed",
    );
  });

  it("keeps the own nickname when another user changes", () => {
    const next = applyDelta(state(), {
      type: "userUpdated",
      payload: user(3, { nickname: "maxim2", channelId: 3 }),
    });
    expect(next.nickname).toBe(fixtureState.nickname);
    expect(next.users.find((item) => item.id === 3)?.nickname).toBe("maxim2");
  });

  it("creates, updates and deletes a channel", () => {
    const base = state();
    const channel = { ...base.channels[1]!, id: 999, name: "Temp", parentId: 0 };
    let next = applyDelta(base, { type: "channelCreated", payload: channel });
    expect(next.channels.some((item) => item.id === 999)).toBe(true);

    next = applyDelta(next, {
      type: "channelUpdated",
      payload: { ...channel, name: "Renamed", userCount: 3 },
    });
    expect(next.channels.find((item) => item.id === 999)?.name).toBe("Renamed");
    expect(next.channels.filter((item) => item.id === 999)).toHaveLength(1);

    next = applyDelta(next, {
      type: "channelDeleted",
      payload: { channelId: 999 },
    });
    expect(next.channels.some((item) => item.id === 999)).toBe(false);
  });

  it("replaces server info and bookmarks", () => {
    const base = state();
    const server = { ...base.server!, name: "Renamed", onlineUsers: 9 };
    let next = applyDelta(base, { type: "serverUpdated", payload: server });
    expect(next.server?.name).toBe("Renamed");
    expect(next.server?.onlineUsers).toBe(9);

    next = applyDelta(next, { type: "bookmarks", payload: [] });
    expect(next.servers).toEqual([]);
  });
});
