import { beforeEach, describe, expect, it, vi } from "vitest";

const { rooms } = vi.hoisted(() => ({
  rooms: [] as FakeRoom[],
}));

interface FakeRoom {
  handlers: Map<string, Set<(...args: unknown[]) => void>>;
  state: string;
  options: Record<string, unknown>;
  remoteParticipants: Map<string, unknown>;
  localParticipant: {
    publishTrack: ReturnType<typeof vi.fn>;
    unpublishTrack: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  on: (event: string, callback: (...args: never[]) => void) => FakeRoom;
  off: (event: string, callback: (...args: never[]) => void) => FakeRoom;
  emit: (event: string, ...args: unknown[]) => void;
}

vi.mock("livekit-client", () => {
  class Room implements FakeRoom {
    handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    state = "disconnected";
    options: Record<string, unknown>;
    remoteParticipants = new Map<string, unknown>();
    localParticipant = {
      publishTrack: vi.fn(async () => {}),
      unpublishTrack: vi.fn(async () => {}),
    };

    constructor(options: Record<string, unknown> = {}) {
      this.options = options;
      rooms.push(this);
    }

    connect = vi.fn(async () => {
      this.state = "connected";
    });

    disconnect = vi.fn(async () => {
      this.state = "disconnected";
      this.emit("disconnected");
    });

    on(event: string, callback: (...args: never[]) => void) {
      const set = this.handlers.get(event) ?? new Set();
      set.add(callback as (...args: unknown[]) => void);
      this.handlers.set(event, set);
      return this;
    }

    off(event: string, callback: (...args: never[]) => void) {
      this.handlers.get(event)?.delete(callback as (...args: unknown[]) => void);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      for (const callback of this.handlers.get(event) ?? []) {
        callback(...args);
      }
    }
  }

  const RoomEvent = {
    ParticipantConnected: "participantConnected",
    ParticipantDisconnected: "participantDisconnected",
    TrackPublished: "trackPublished",
    TrackUnpublished: "trackUnpublished",
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    TrackSubscriptionFailed: "trackSubscriptionFailed",
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
    Disconnected: "disconnected",
  };
  const ConnectionState = {
    Disconnected: "disconnected",
    Connecting: "connecting",
    Connected: "connected",
    Reconnecting: "reconnecting",
    SignalReconnecting: "signalReconnecting",
  };
  const Track = {
    Source: {
      ScreenShare: "screen_share",
      ScreenShareAudio: "screen_share_audio",
    },
    Kind: { Video: "video", Audio: "audio" },
  };
  const VideoQuality = { LOW: 0, MEDIUM: 1, HIGH: 2 };

  return {
    Room,
    RoomEvent,
    ConnectionState,
    Track,
    VideoQuality,
    VideoPresets: {
      h180: { name: "h180" },
      h360: { name: "h360" },
      h720: { name: "h720" },
    },
    LocalVideoTrack: class {
      track: unknown;
      stop = vi.fn();
      constructor(track: unknown) {
        this.track = track;
      }
    },
    LocalAudioTrack: class {
      track: unknown;
      stop = vi.fn();
      constructor(track: unknown) {
        this.track = track;
      }
    },
  };
});

import { StreamEngine, parseVideoStats, type StreamPresetName } from "./engine";

/** Minimal `RTCStatsReport` stand-in: the parser only reads entries and codecs. */
function statsReport(items: Record<string, unknown>[]): {
  forEach: (callback: (value: unknown) => void) => void;
  get: (key: string) => unknown;
} {
  const byId = new Map<string, unknown>(items.map((item, index) => [`s${index}`, item]));
  return {
    forEach: (callback) => {
      for (const value of byId.values()) {
        callback(value);
      }
    },
    get: (key) => byId.get(key),
  };
}


function participant(id: number) {
  return { identity: `${id}:stream`, trackPublications: new Map() };
}

function audioTrack() {
  return {
    kind: "audio",
    attach: vi.fn(),
    detach: vi.fn(),
    setVolume: vi.fn(),
  };
}

function videoTrack() {
  return {
    kind: "video",
    attach: vi.fn(),
    detach: vi.fn(),
  };
}

function audioElement(): HTMLAudioElement {
  const element = document.createElement("audio");
  element.play = vi.fn(async () => {});
  return element;
}

function videoElement(): HTMLVideoElement {
  const element = document.createElement("video");
  element.play = vi.fn(async () => {});
  return element;
}

/** Replaces the screen capture with a video-track stand-in. */
function stubScreenCapture() {
  const video = {
    contentHint: "",
    stop: vi.fn(),
    addEventListener: vi.fn(),
    applyConstraints: vi.fn(async () => {}),
  };
  const stream = {
    getVideoTracks: () => [video],
    getAudioTracks: () => [],
    getTracks: () => [video],
  };
  const getDisplayMedia = vi.fn(async (constraints?: MediaStreamConstraints) => {
    void constraints;
    return stream;
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getDisplayMedia },
  });
  return { video, getDisplayMedia };
}

/** Viewer lists the engine published, newest last (stage P12). */
const watchingCalls: number[][] = [];

function engineWithProvider() {
  watchingCalls.length = 0;
  return new StreamEngine({
    requestStreamCredentials: async () => ({
      url: "ws://127.0.0.1:1",
      room: "channel-4",
      participantIdentity: "1:stream",
      expiresInSeconds: 60,
      presets: ["720p30", "1080p30", "1080p60"],
    }),
    setWatching: async (streamerIds) => {
      watchingCalls.push(streamerIds);
    },
  });
}

function coreBridge(options: { startFails?: boolean } = {}) {
  return {
    start: vi.fn(async () => {
      if (options.startFails) {
        throw new Error("process loopback unavailable");
      }
    }),
    stop: vi.fn(async () => {}),
    watch: vi.fn(async () => {}),
    setVolume: vi.fn(async () => {}),
  };
}

function engineWithCore(audio: ReturnType<typeof coreBridge>) {
  return new StreamEngine({
    requestStreamCredentials: async () => ({
      url: "ws://127.0.0.1:1",
      room: "channel-4",
      participantIdentity: "1:stream",
      expiresInSeconds: 60,
      presets: ["720p30", "1080p30"],
    }),
    audio,
    setWatching: async () => {},
  });
}

function fakeDisplay(withAudio: boolean) {
  const video = {
    contentHint: "",
    stop: vi.fn(),
    addEventListener: vi.fn(),
    applyConstraints: vi.fn(async () => {}),
  };
  const audio = {
    stop: vi.fn(),
    applyConstraints: vi.fn(async () => {}),
  };
  const tracks = withAudio ? [video, audio] : [video];
  const getDisplayMedia = vi.fn(
    async (constraints: { audio: boolean }) => ({
      getVideoTracks: () => [video],
      getAudioTracks: () => (constraints.audio ? [audio] : []),
      getTracks: () => tracks,
    }),
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getDisplayMedia },
  });
  return getDisplayMedia;
}

function currentRoom(index = 0): FakeRoom {
  const room = rooms[index];
  if (!room) {
    throw new Error("room was not created");
  }
  return room;
}

describe("StreamEngine", () => {
  beforeEach(() => {
    rooms.length = 0;
    vi.useRealTimers();
  });

  it("attaches audio that was requested before the participant existed", async () => {
    const engine = engineWithProvider();
    engine.setChannel(4);
    const element = audioElement();

    // The tile mounts before the room: this used to be a no-op and the
    // subscribed track had nowhere to go ("no sound at all").
    engine.attachAudio(7, element);
    await engine.watch(7);

    const room = currentRoom();
    const peer = participant(7);
    room.emit("participantConnected", peer);
    const track = audioTrack();
    room.emit(
      "trackSubscribed",
      track,
      { source: "screen_share_audio" },
      peer,
    );

    expect(track.attach).toHaveBeenCalledWith(element);
    expect(element.play).toHaveBeenCalled();
  });

  it("applies 150 % as a 1.5 gain and never touches illegal element volumes", async () => {
    const engine = engineWithProvider();
    engine.setChannel(4);
    const element = audioElement();
    engine.attachAudio(7, element);
    await engine.watch(7);

    const room = currentRoom();
    const peer = participant(7);
    room.emit("participantConnected", peer);

    // Before the track exists the element fallback stays inside 0..1. The old
    // code assigned 1.5 here and `IndexSizeError` unmounted the whole UI.
    expect(() => engine.setVolume(7, 150)).not.toThrow();
    expect(element.volume).toBe(1);

    const track = audioTrack();
    room.emit(
      "trackSubscribed",
      track,
      { source: "screen_share_audio" },
      peer,
    );
    engine.setVolume(7, 150);

    expect(track.setVolume).toHaveBeenCalledWith(1.5);
    expect(() => engine.setVolume(7, 500)).not.toThrow();
    expect(track.setVolume).toHaveBeenLastCalledWith(2);
    expect(() => engine.setVolume(7, -20)).not.toThrow();
    expect(track.setVolume).toHaveBeenLastCalledWith(0);
  });

  it("ignores Disconnected from a replaced room", async () => {
    const engine = engineWithProvider();
    engine.setChannel(4);
    await engine.watch(6);

    const roomA = currentRoom();
    const peerA = participant(6);
    roomA.emit("participantConnected", peerA);

    engine.unwatch(6);
    await vi.waitFor(() => {
      expect(engine.getSnapshot().room).toBe("idle");
    });

    await engine.watch(8);
    const roomB = currentRoom(1);
    const peerB = participant(8);
    roomB.emit("participantConnected", peerB);
    expect(engine.getSnapshot().streams.map((entry) => entry.userId)).toEqual([8]);

    // A late event from the closed room must not wipe the new room.
    roomA.emit("disconnected");
    expect(engine.getSnapshot().streams.map((entry) => entry.userId)).toEqual([8]);
    expect(engine.getSnapshot().room).toBe("connected");
  });

  it("waits for a reconnecting room instead of opening a duplicate", async () => {
    const engine = engineWithProvider();
    engine.setChannel(4);
    await engine.watch(6);
    const room = currentRoom();
    room.state = "reconnecting";
    room.emit("reconnecting");

    const watching = engine.watch(8);
    expect(rooms).toHaveLength(1);

    room.state = "connected";
    room.emit("reconnected");
    await watching;

    expect(rooms).toHaveLength(1);
    expect(engine.getSnapshot().room).toBe("connected");
  });

  it("does not duplicate a room that is still connecting", async () => {
    const engine = engineWithProvider();
    engine.setChannel(4);
    const first = engine.watch(6);
    const second = engine.watch(8);
    await Promise.all([first, second]);
    expect(rooms).toHaveLength(1);
  });

  it("reports the watched streams, and nothing while the panel is hidden", async () => {
    const engine = engineWithProvider();
    engine.setChannel(4);
    await engine.watch(9);
    await engine.watch(7);
    // The whole set is sent, sorted, so the server can replace it in one go.
    expect(watchingCalls.at(-1)).toEqual([7, 9]);

    engine.unwatch(9);
    expect(watchingCalls.at(-1)).toEqual([7]);

    // A hidden panel plays nothing, so the user stops counting as a viewer.
    await engine.setVisible(false);
    expect(watchingCalls.at(-1)).toEqual([]);
    await engine.setVisible(true);
    expect(watchingCalls.at(-1)).toEqual([7]);

    // Leaving the channel ends every watch.
    engine.setChannel(5);
    expect(watchingCalls.at(-1)).toEqual([]);
    expect(engine.getSnapshot().watching).toEqual([]);
  });

  it("uses motion for 60 fps and detail otherwise, with balanced degradation", async () => {
    const engine = engineWithProvider();
    engine.setChannel(4);
    const { video } = stubScreenCapture();

    const publish = async (preset: StreamPresetName) => {
      await engine.startLocal({ preset, includeAudio: false });
      const room = currentRoom(rooms.length - 1);
      return room.localParticipant.publishTrack;
    };

    let publishTrack = await publish("1080p60");
    expect(video.contentHint).toBe("motion");
    expect(publishTrack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ degradationPreference: "balanced" }),
    );
    await engine.stopLocal();

    video.contentHint = "";
    publishTrack = await publish("720p30");
    expect(video.contentHint).toBe("detail");
    expect(publishTrack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ degradationPreference: "balanced" }),
    );
    await engine.stopLocal();
  });

  it("publishes 1080p at 6 Mbit/s with 360p and 720p simulcast layers", async () => {
    const engine = engineWithProvider();
    engine.setChannel(4);
    stubScreenCapture();
    await engine.startLocal({ preset: "1080p30", includeAudio: false });
    const room = currentRoom();
    const options = room.localParticipant.publishTrack.mock.calls[0]?.[1] as {
      screenShareEncoding: { maxBitrate: number; maxFramerate: number };
      screenShareSimulcastLayers: Array<{ name: string }>;
      videoSimulcastLayers?: unknown;
      simulcast: boolean;
      videoCodec: string;
    };

    expect(options.screenShareEncoding).toEqual({
      maxBitrate: 6_000_000,
      maxFramerate: 30,
    });
    // `videoSimulcastLayers` is ignored for screen_share; the SDK only reads
    // `screenShareSimulcastLayers` (the pre-P14 code passed the wrong one and
    // the real layers were half-resolution + full).
    expect(options.videoSimulcastLayers).toBeUndefined();
    expect(options.screenShareSimulcastLayers.map((layer) => layer.name)).toEqual([
      "h360",
      "h720",
    ]);
    expect(options.simulcast).toBe(true);
    expect(options.videoCodec).toBe("h264");
    // The screen-share room must not resize the request from the tile element.
    expect(room.options.adaptiveStream).toBe(false);
    await engine.stopLocal();
  });

  it("publishes 1080p60 at 9 Mbit/s and the native preset at 12 Mbit/s", async () => {
    const engine = engineWithProvider();
    engine.setChannel(4);
    const { getDisplayMedia } = stubScreenCapture();

    await engine.startLocal({ preset: "1080p60", includeAudio: false });
    let options = currentRoom(rooms.length - 1).localParticipant.publishTrack.mock
      .calls[0]?.[1] as { screenShareEncoding: { maxBitrate: number } };
    expect(options.screenShareEncoding.maxBitrate).toBe(9_000_000);
    await engine.stopLocal();

    await engine.startLocal({ preset: "source", includeAudio: false });
    options = currentRoom(rooms.length - 1).localParticipant.publishTrack.mock
      .calls[0]?.[1] as { screenShareEncoding: { maxBitrate: number } };
    expect(options.screenShareEncoding.maxBitrate).toBe(12_000_000);
    const constraints = getDisplayMedia.mock.calls.at(-1)?.[0] as {
      video: { width: { ideal: number }; height: { ideal: number }; frameRate: { ideal: number } };
    };
    expect(constraints.video.width.ideal).toBe(2560);
    expect(constraints.video.height.ideal).toBe(1440);
    expect(constraints.video.frameRate.ideal).toBe(60);
    await engine.stopLocal();
  });

  it("publishes VP9 SVC with an H.264 backup when asked for a SVC codec", async () => {
    const engine = engineWithProvider();
    engine.setChannel(4);
    stubScreenCapture();
    await engine.startLocal({
      preset: "1080p30",
      includeAudio: false,
      codec: "vp9",
    });
    const options = currentRoom().localParticipant.publishTrack.mock.calls[0]?.[1] as {
      simulcast: boolean;
      videoCodec: string;
      scalabilityMode: string;
      backupCodec: { codec: string };
      screenShareSimulcastLayers?: unknown;
    };
    expect(options.videoCodec).toBe("vp9");
    expect(options.simulcast).toBe(false);
    expect(options.scalabilityMode).toBe("L3T3_KEY");
    expect(options.backupCodec).toEqual({ codec: "h264" });
    expect(options.screenShareSimulcastLayers).toBeUndefined();
    await engine.stopLocal();
  });

  it("requests the top layer by default and follows the tile choice", async () => {
    const engine = engineWithProvider();
    engine.setChannel(4);
    await engine.watch(7);
    const room = currentRoom();
    const peer = participant(7);
    const publication = {
      source: "screen_share",
      setSubscribed: vi.fn(),
      setVideoQuality: vi.fn(),
      setVideoDimensions: vi.fn(),
    };
    room.emit("participantConnected", peer);
    room.emit("trackPublished", publication, peer);

    expect(publication.setVideoQuality).toHaveBeenLastCalledWith(2);
    expect(engine.getSnapshot().streams[0]?.quality).toBe("high");

    engine.setQuality(7, "low");
    expect(publication.setVideoQuality).toHaveBeenLastCalledWith(0);
    expect(engine.getSnapshot().streams[0]?.quality).toBe("low");

    engine.setQuality(7, "auto", { width: 1280, height: 720 });
    expect(publication.setVideoDimensions).toHaveBeenCalledWith({
      width: 1280,
      height: 720,
    });

    engine.setQuality(7, "high");
    expect(publication.setVideoQuality).toHaveBeenLastCalledWith(2);
  });

  it("attaches video that was requested before the participant existed", async () => {
    const engine = engineWithProvider();
    engine.setChannel(4);
    const element = videoElement();
    engine.attachVideo(7, element);
    await engine.watch(7);

    const room = currentRoom();
    const peer = participant(7);
    room.emit("participantConnected", peer);
    const track = videoTrack();
    room.emit("trackSubscribed", track, { source: "screen_share" }, peer);

    expect(track.attach).toHaveBeenCalledWith(element);
  });

  // Stage P15 (ADR 0027): with the core present the computer audio comes from
  // the core capture, the WebView neither requests nor publishes audio.
  it("captures the stream audio in the core and asks the picker for video only", async () => {
    const audio = coreBridge();
    const engine = engineWithCore(audio);
    engine.setChannel(4);
    const getDisplayMedia = fakeDisplay(true);

    await engine.startLocal({ preset: "1080p30", includeAudio: true });

    expect(audio.start).toHaveBeenCalledTimes(1);
    expect(getDisplayMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: false }),
    );
    const publishTrack = currentRoom().localParticipant.publishTrack;
    const sources = publishTrack.mock.calls.map(
      (call) => (call[1] as { source: string }).source,
    );
    expect(sources).toEqual(["screen_share"]);
    expect(engine.getSnapshot().local).toMatchObject({
      streaming: true,
      hasAudio: true,
      audioPath: "core",
    });
    expect(engine.getSnapshot().error).toBeNull();

    await engine.stopLocal();
    expect(audio.stop).toHaveBeenCalledTimes(1);
  });

  it("falls back to the WebView system audio with an explicit warning", async () => {
    const audio = coreBridge({ startFails: true });
    const engine = engineWithCore(audio);
    engine.setChannel(4);
    const getDisplayMedia = fakeDisplay(true);

    await engine.startLocal({ preset: "1080p30", includeAudio: true });

    expect(getDisplayMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: true }),
    );
    const sources = currentRoom()
      .localParticipant.publishTrack.mock.calls.map(
        (call) => (call[1] as { source: string }).source,
      );
    expect(sources).toEqual(["screen_share", "screen_share_audio"]);
    expect(engine.getSnapshot().local.audioPath).toBe("webview");
    expect(engine.getSnapshot().error?.code).toBe("audioFallback");

    await engine.stopLocal();
    expect(audio.stop).not.toHaveBeenCalled();
  });

  it("does not start the core capture for a video-only stream", async () => {
    const audio = coreBridge();
    const engine = engineWithCore(audio);
    engine.setChannel(4);
    fakeDisplay(false);

    await engine.startLocal({ preset: "720p30", includeAudio: false });

    expect(audio.start).not.toHaveBeenCalled();
    expect(engine.getSnapshot().local).toMatchObject({
      hasAudio: false,
      audioPath: null,
    });
  });

  it("plays watched stream audio in the core, never in the WebView", async () => {
    const audio = coreBridge();
    const engine = engineWithCore(audio);
    engine.setChannel(4);
    engine.setVolume(7, 150);
    await engine.watch(7);

    expect(audio.watch).toHaveBeenCalledWith(7, true);
    expect(audio.setVolume).toHaveBeenCalledWith(7, 150, false);

    const room = currentRoom();
    const subscribe = vi.fn();
    const peer = {
      identity: "7:stream",
      trackPublications: new Map([
        ["TR_a", { source: "screen_share_audio", setSubscribed: subscribe }],
      ]),
    };
    room.remoteParticipants.set(peer.identity, peer);
    room.emit("participantConnected", peer);
    room.emit("trackPublished", peer.trackPublications.get("TR_a"), peer);
    // One playback path: the WebView never subscribes to the audio itself.
    expect(subscribe).not.toHaveBeenCalledWith(true);

    engine.setCoreAudio({ available: [7], playing: [7] });
    expect(engine.getSnapshot().streams[0]).toMatchObject({
      userId: 7,
      hasAudio: true,
      audioReady: true,
    });

    engine.setMuted(7, true);
    expect(audio.setVolume).toHaveBeenLastCalledWith(7, 150, true);

    engine.unwatch(7);
    expect(audio.watch).toHaveBeenLastCalledWith(7, false);
  });

  it("stops the core capture when the screen-share room is closed", async () => {
    const audio = coreBridge();
    const engine = engineWithCore(audio);
    engine.setChannel(4);
    fakeDisplay(false);
    await engine.startLocal({ preset: "1080p30", includeAudio: true });

    // A moderator stop removes the `:stream` participant (ADR 0016).
    currentRoom().emit("disconnected");

    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot().local.audioPath).toBeNull();
  });
});

describe("parseVideoStats", () => {
  const codec = { type: "codec", mimeType: "video/H264" };

  it("reports the top simulcast layer and keeps every layer", () => {
    const samples = new Map<string, { bytes: number; at: number }>();
    const report = () =>
      statsReport([
        codec,
        {
          type: "outbound-rtp",
          kind: "video",
          codecId: "s0",
          rid: "q",
          frameWidth: 640,
          frameHeight: 360,
          framesPerSecond: 30,
          bytesSent: 100_000,
          qualityLimitationReason: "none",
        },
        {
          type: "outbound-rtp",
          kind: "video",
          codecId: "s0",
          rid: "h",
          frameWidth: 1280,
          frameHeight: 720,
          framesPerSecond: 30,
          bytesSent: 400_000,
        },
        {
          type: "outbound-rtp",
          kind: "video",
          codecId: "s0",
          rid: "f",
          frameWidth: 1920,
          frameHeight: 1080,
          framesPerSecond: 30,
          bytesSent: 900_000,
          encoderImplementation: "NvidiaVideoEncoder",
          powerEfficientEncoder: true,
          qualityLimitationReason: "bandwidth",
        },
      ]);

    const first = parseVideoStats(report(), "local", samples, 1_000);
    expect(first).not.toBeNull();
    // The old parser kept whichever outbound entry came last, so the 360p
    // layer could be shown as "the stream". The top layer is the real one.
    expect(first?.width).toBe(1920);
    expect(first?.height).toBe(1080);
    expect(first?.encoder).toBe("NvidiaVideoEncoder");
    expect(first?.powerEfficient).toBe(true);
    expect(first?.qualityLimitation).toBe("bandwidth");
    expect(first?.layers?.map((layer) => layer.rid)).toEqual(["q", "h", "f"]);
    expect(first?.bitrateKbps).toBeUndefined();

    // One second later each layer has grown by its own bitrate.
    const second = parseVideoStats(
      statsReport([
        codec,
        { type: "outbound-rtp", kind: "video", codecId: "s0", rid: "q", frameWidth: 640, frameHeight: 360, bytesSent: 112_500 },
        { type: "outbound-rtp", kind: "video", codecId: "s0", rid: "h", frameWidth: 1280, frameHeight: 720, bytesSent: 475_000 },
        { type: "outbound-rtp", kind: "video", codecId: "s0", rid: "f", frameWidth: 1920, frameHeight: 1080, bytesSent: 1_050_000 },
      ]),
      "local",
      samples,
      2_000,
    );
    // (1_050_000 - 900_000) * 8 / 1000 ms = 1200 kbit/s
    expect(second?.bitrateKbps).toBe(1_200);
    expect(second?.layers?.map((layer) => layer.bitrateKbps)).toEqual([
      100, 600, 1_200,
    ]);
  });

  it("turns inbound counters into loss percent and dropped frames", () => {
    const samples = new Map<string, { bytes: number; at: number }>();
    const stats = parseVideoStats(
      statsReport([
        codec,
        {
          type: "inbound-rtp",
          kind: "video",
          codecId: "s0",
          frameWidth: 1920,
          frameHeight: 1080,
          framesPerSecond: 59,
          bytesReceived: 1_000_000,
          packetsLost: 25,
          packetsReceived: 4_975,
          framesDropped: 3,
          decoderImplementation: "FFmpeg",
        },
      ]),
      "remote-7",
      samples,
      500,
    );
    expect(stats?.lossPercent).toBe(0.5);
    expect(stats?.framesDropped).toBe(3);
    expect(stats?.decoder).toBe("FFmpeg");
    expect(stats?.bitrateKbps).toBeUndefined();
  });

  it("returns null when the report has no video entries", () => {
    expect(
      parseVideoStats(
        statsReport([{ type: "inbound-rtp", kind: "audio" }]),
        "remote-7",
        new Map(),
        1,
      ),
    ).toBeNull();
  });

  it("takes the quality reason from the layer that is actually sending", () => {
    const samples = new Map<string, { bytes: number; at: number }>();
    const layers = (topBytes: number) =>
      statsReport([
        codec,
        {
          type: "outbound-rtp",
          kind: "video",
          codecId: "s0",
          rid: "q",
          frameWidth: 640,
          frameHeight: 360,
          bytesSent: topBytes,
          qualityLimitationReason: "cpu",
          encoderImplementation: "OpenH264",
        },
        {
          type: "outbound-rtp",
          kind: "video",
          codecId: "s0",
          rid: "f",
          frameWidth: 1920,
          frameHeight: 1080,
          bytesSent: 900_000,
          qualityLimitationReason: "bandwidth",
        },
      ]);
    // Dynacast keeps only the subscribed layer moving: the 1080p layer's byte
    // counter is frozen, so its "bandwidth" reason describes a disabled layer.
    parseVideoStats(layers(100_000), "local", samples, 1_000);
    const stats = parseVideoStats(layers(140_000), "local", samples, 2_000);
    expect(stats?.qualityLimitation).toBe("cpu");
    expect(stats?.encoder).toBe("OpenH264");
    expect(stats?.width).toBe(1920);
    expect(stats?.layers?.find((layer) => layer.rid === "q")?.bitrateKbps).toBe(320);
  });
});
