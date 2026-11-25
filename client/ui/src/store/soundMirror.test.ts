import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoreEvent, UserView, VoiceState } from "@/core/api";
import { useCoreStore } from "@/store/coreStore";
import { useVoiceStore } from "@/store/voiceStore";

import {
  VIEWER_CUE_MIN_INTERVAL_MS,
  notifyStreamViewerJoined,
  selfStreamViewers,
  startSoundMirror,
  streamCues,
  viewerCueDue,
} from "./soundMirror";

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  playVoiceSound: vi.fn(),
}));

vi.mock("@/core", () => ({ coreApi: mocks }));

function user(id: number, channelId: number, streaming: boolean): UserView {
  return {
    id,
    nickname: `user ${id}`,
    roleIds: [],
    color: null,
    channelId,
    voice: {
      selfMuted: false,
      selfDeafened: false,
      serverMuted: false,
      serverDeafened: false,
      away: false,
      prioritySpeaker: false,
    },
    streaming,
    watchingUserIds: [],
    connectedAtUnixMs: 0,
    avatarHash: "",
  };
}

/** A user in `channelId` who watches the stream of `streamerId` (stage P12). */
function watcher(id: number, channelId: number, streamerId: number): UserView {
  return { ...user(id, channelId, false), watchingUserIds: [streamerId] };
}

function voiceState(channelId: number): VoiceState {
  return {
    media: "connected",
    publishing: false,
    publishAllowed: true,
    channelId,
    selfMuted: false,
    deafened: false,
    micTest: false,
    gate: { mode: "voiceActivation", threshold_db: -45, hold_ms: 300 },
    pushToTalk: { hook: "unknown", binding: "X1/X2", error: null },
    inputDevice: null,
    outputDevice: null,
    error: null,
  };
}

function presence(users: UserView[]) {
  return new Map(
    users.map((item) => [
      item.id,
      {
        channelId: item.channelId,
        streaming: item.streaming,
        watching: [...item.watchingUserIds],
      },
    ]),
  );
}

describe("viewer cue", () => {
  it("collects only the audience of the own stream", () => {
    const viewers = selfStreamViewers(
      presence([
        user(1, 5, true),
        watcher(2, 5, 1),
        watcher(3, 5, 1),
        watcher(4, 5, 2),
      ]),
      1,
    );
    expect([...viewers].sort()).toEqual([2, 3]);
  });

  it("fires only for a growing audience and no more often than the interval", () => {
    const none = new Set<number>();
    const one = new Set([2]);
    const two = new Set([2, 3]);
    expect(viewerCueDue(none, one, 0, VIEWER_CUE_MIN_INTERVAL_MS)).toBe(true);
    expect(viewerCueDue(one, two, 0, 0)).toBe(false);
    expect(viewerCueDue(one, one, 0, 10 * VIEWER_CUE_MIN_INTERVAL_MS)).toBe(
      false,
    );
    expect(viewerCueDue(two, one, 0, 10 * VIEWER_CUE_MIN_INTERVAL_MS)).toBe(
      false,
    );
  });
});

describe("stream cues", () => {
  it("sounds a stream that starts in the user's channel", () => {
    expect(
      streamCues(presence([]), presence([user(2, 5, true)]), 1, 5),
    ).toEqual(["streamStarted"]);
    expect(streamCues(presence([]), presence([user(1, 5, true)]), 1, 5)).toEqual(
      ["selfStreamStarted"],
    );
  });

  it("sounds only the own stream end", () => {
    expect(
      streamCues(presence([user(1, 5, true), user(2, 5, true)]), presence([]), 1, 5),
    ).toEqual(["selfStreamEnded"]);
  });

  it("ignores streamers in other channels and a silent voice state", () => {
    expect(
      streamCues(presence([]), presence([user(2, 7, true)]), 1, 5),
    ).toEqual([]);
    expect(
      streamCues(presence([]), presence([user(2, 0, true)]), 1, 5),
    ).toEqual([]);
    expect(streamCues(presence([]), presence([user(2, 5, true)]), 1, 0)).toEqual(
      [],
    );
  });

  it("does not announce a move or a repeated presence update", () => {
    const streaming = presence([user(2, 5, true)]);
    expect(streamCues(streaming, streaming, 1, 5)).toEqual([]);
    expect(
      streamCues(
        presence([user(2, 5, true)]),
        presence([user(2, 6, false)]),
        1,
        5,
      ),
    ).toEqual([]);
  });
});

describe("sound mirror", () => {
  let listener: (event: CoreEvent) => void;

  beforeEach(() => {
    mocks.subscribe.mockReset();
    mocks.playVoiceSound.mockReset();
    mocks.playVoiceSound.mockResolvedValue(undefined);
    mocks.subscribe.mockImplementation((callback: (event: CoreEvent) => void) => {
      listener = callback;
      return () => {};
    });
    useVoiceStore.setState({ state: voiceState(5) });
    useCoreStore.setState({ state: null, hydrated: false, pending: [] });
  });

  it("never beeps for the users already streaming in the first snapshot", () => {
    const stop = startSoundMirror();
    listener({
      type: "snapshot",
      payload: {
        connection: "connected",
        reconnect: null,
        server: null,
        roles: [],
        channels: [],
        users: [user(1, 5, true), user(2, 5, true)],
        selfUserId: 1,
        nickname: "me",
        profile: { nickname: "me" },
        permissions: null,
        unread: [],
        servers: [],
        activeServerId: null,
        error: null,
        protocolVersion: 1,
        clientVersion: "0.1.0",
      },
    });
    expect(mocks.playVoiceSound).not.toHaveBeenCalled();
    stop();
  });

  it("asks the core for a cue when a presence delta starts a stream", () => {
    const stop = startSoundMirror();
    listener({
      type: "snapshot",
      payload: {
        connection: "connected",
        reconnect: null,
        server: null,
        roles: [],
        channels: [],
        users: [user(1, 5, false)],
        selfUserId: 1,
        nickname: "me",
        profile: { nickname: "me" },
        permissions: null,
        unread: [],
        servers: [],
        activeServerId: null,
        error: null,
        protocolVersion: 1,
        clientVersion: "0.1.0",
      },
    });
    listener({
      type: "delta",
      payload: { type: "userUpdated", payload: user(2, 5, true) },
    });
    expect(mocks.playVoiceSound).toHaveBeenCalledWith("streamStarted");
    stop();
  });

  it("has the viewer cue ready for P12", () => {
    notifyStreamViewerJoined();
    expect(mocks.playVoiceSound).toHaveBeenCalledWith("streamViewerJoined");
  });

  it("tells the streamer about a new viewer without spam", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    const stop = startSoundMirror();
    listener({
      type: "snapshot",
      payload: {
        connection: "connected",
        reconnect: null,
        server: null,
        roles: [],
        channels: [],
        users: [user(1, 5, true)],
        selfUserId: 1,
        nickname: "me",
        profile: { nickname: "me" },
        permissions: null,
        unread: [],
        servers: [],
        activeServerId: null,
        error: null,
        protocolVersion: 1,
        clientVersion: "0.1.0",
      },
    });
    listener({
      type: "delta",
      payload: { type: "userUpdated", payload: watcher(2, 5, 1) },
    });
    expect(mocks.playVoiceSound).toHaveBeenLastCalledWith("streamViewerJoined");

    // A second viewer within the interval is silent: five friends opening the
    // tile together must not be five beeps.
    listener({
      type: "delta",
      payload: { type: "userUpdated", payload: watcher(3, 5, 1) },
    });
    expect(
      mocks.playVoiceSound.mock.calls.filter(
        ([sound]) => sound === "streamViewerJoined",
      ),
    ).toHaveLength(1);

    // After the interval the next new viewer is announced again.
    vi.setSystemTime(
      new Date(Date.now() + VIEWER_CUE_MIN_INTERVAL_MS + 1_000),
    );
    listener({
      type: "delta",
      payload: { type: "userUpdated", payload: watcher(4, 5, 1) },
    });
    expect(
      mocks.playVoiceSound.mock.calls.filter(
        ([sound]) => sound === "streamViewerJoined",
      ),
    ).toHaveLength(2);

    // A viewer leaving and coming back within the interval is silent too.
    listener({
      type: "delta",
      payload: { type: "userUpdated", payload: watcher(5, 5, 1) },
    });
    listener({
      type: "delta",
      payload: { type: "userLeft", payload: { userId: 5 } },
    });
    listener({
      type: "delta",
      payload: { type: "userUpdated", payload: watcher(5, 5, 1) },
    });
    expect(
      mocks.playVoiceSound.mock.calls.filter(
        ([sound]) => sound === "streamViewerJoined",
      ),
    ).toHaveLength(2);
    stop();
    vi.useRealTimers();
  });
});
