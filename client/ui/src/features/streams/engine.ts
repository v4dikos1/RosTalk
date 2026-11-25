// Screen-share engine (stage 5.1).
//
// One `livekit-client` Room per user, connected through the core's loopback
// WebSocket proxy. It only runs while the user is publishing or watching a
// stream; the media token, the certificate pin and the gateway URL stay in the
// Rust core (see `crates/core/src/stream_proxy.rs`).
//
// Tracks are distinguished by their source (`screen_share` and
// `screen_share_audio`), never by an identity suffix. The identity is only used
// to map a remote `<user id>:stream` participant back to a user id.
//
// Stream audio (stage P15, ADR 0027): when the desktop core is present it
// captures the computer audio without RosTalk's own sound and publishes it from
// the voice participant, and it plays the viewers' stream audio through its
// mixer (volume 0..200 %, echo-cancellation reference). The WebView then
// neither requests nor plays any audio. Without the core (the spike harness,
// the browser preview) or when the capture is unavailable, the old
// `getDisplayMedia` system audio is the fallback.

import {
  ConnectionState,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  VideoQuality,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
  type VideoPreset,
} from "livekit-client";

import {
  SVC_SCALABILITY_MODE,
  chooseStreamCodec,
  type StreamVideoCodec,
} from "./codec";

/**
 * Coordinates the engine needs to open the signalling connection. The core's
 * `StreamCredentialsView` satisfies this shape; the type lives here so the
 * engine can also be exercised by the spike harness without the client core.
 */
export interface StreamCredentials {
  url: string;
  room: string;
  participantIdentity: string;
  expiresInSeconds: number;
  presets: string[];
  /**
   * Only the spike harness sets this: it talks to the gateway directly and
   * has no loopback proxy to inject the token. The desktop core never returns
   * a token here.
   */
  token?: string;
}

export type StreamPresetName = "720p30" | "1080p30" | "1080p60" | "source";

export interface StreamPreset {
  name: StreamPresetName;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  label: string;
}

/**
 * Bitrates and resolutions of a screen share (stage P14).
 *
 * 1080p moved from 4/7 to 6/9 Mbit/s: the old numbers were the reason a
 * detailed desktop turned into mush as soon as anything moved. "source" keeps
 * the native resolution of the display (up to 1440p) and is offered only to
 * holders of the stream_hq permission, like 1080p60.
 */
export const STREAM_PRESETS: Record<StreamPresetName, StreamPreset> = {
  "720p30": {
    name: "720p30",
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 2_500_000,
    label: "720p · 30",
  },
  "1080p30": {
    name: "1080p30",
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 6_000_000,
    label: "1080p · 30",
  },
  "1080p60": {
    name: "1080p60",
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 9_000_000,
    label: "1080p · 60",
  },
  source: {
    name: "source",
    width: 2560,
    height: 1440,
    fps: 60,
    bitrate: 12_000_000,
    label: "1440p · 60",
  },
};

/**
 * Simulcast layers *below* the full-resolution one, lowest first.
 *
 * The previous code passed `videoSimulcastLayers` for a screen-share track,
 * which the SDK ignores for that source: the real layers were the defaults
 * (half resolution + full), and the viewer's tile requested 540p. 1080p now
 * publishes 360p + 720p + 1080p, so a viewer can pick a middle layer without
 * jumping straight from 1080 to 540.
 */
function screenShareLayers(preset: StreamPresetName): VideoPreset[] {
  if (preset === "720p30") {
    return [VideoPresets.h180];
  }
  return [VideoPresets.h360, VideoPresets.h720];
}

export type StreamQualityMode = "auto" | "high" | "low";


/** One simulcast/SVC layer of the publisher's video (stage P14). */
export interface StreamLayerStats {
  /** Simulcast rid (`q`, `h`, `f`) when the encoder exposes it. */
  rid?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  qualityLimitation?: string;
}

export interface StreamStats {
  codec?: string;
  encoder?: string;
  decoder?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  qualityLimitation?: string;
  powerEfficient?: boolean;
  /** All published layers, lowest first. Empty for a single-encoding stream. */
  layers?: StreamLayerStats[];
  /** Share of lost RTP packets on the receiving side, percent. */
  lossPercent?: number;
  framesDropped?: number;
}

/**
 * Where the own stream audio comes from: the core (everything except RosTalk)
 * or the WebView fallback (the whole system output, friends hear themselves).
 */
export type StreamAudioPath = "core" | "webview";

export interface LocalStreamState {
  streaming: boolean;
  preset: StreamPresetName;
  hasAudio: boolean;
  /** `null` while there is no audio. */
  audioPath: StreamAudioPath | null;
  stats: StreamStats | null;
}

export interface RemoteStreamState {
  userId: number;
  identity: string;
  hasVideo: boolean;
  hasAudio: boolean;
  subscribed: boolean;
  /** The video track has arrived and is attached to the tile element. */
  videoReady: boolean;
  /** The audio track has arrived and is attached to the hidden player. */
  audioReady: boolean;
  /** Requested simulcast layer: top layer, economical one, or by tile size. */
  quality: StreamQualityMode;
  stats: StreamStats | null;
}

export interface StreamEngineSnapshot {
  room: "idle" | "connecting" | "connected" | "reconnecting" | "failed";
  local: LocalStreamState;
  streams: RemoteStreamState[];
  watching: number[];
  visible: boolean;
  /** Failure of the last start/watch; `null` when healthy. */
  error: { code: string; message: string } | null;
}

/** Stream audio in the desktop core (stage P15). */
export interface StreamAudioBridge {
  /** Starts the core capture; rejects when it is unavailable. */
  start(): Promise<void>;
  stop(): Promise<void>;
  watch(userId: number, watching: boolean): Promise<void>;
  /** `volume` is percent, 0..200. */
  setVolume(userId: number, volume: number, muted: boolean): Promise<void>;
}

/** What the core reports about remote stream audio. */
export interface CoreStreamAudio {
  available: number[];
  playing: number[];
}

export interface StreamCredentialProvider {
  requestStreamCredentials(channelId: number): Promise<StreamCredentials>;
  /** Present only in the desktop client. */
  audio?: StreamAudioBridge;
  /**
   * Publishes the streams the user currently watches, so the server can show
   * the audience of every tile (stage P12). The whole set is sent every time;
   * the server keeps only live shares of the caller's own channel.
   */
  setWatching(streamerIds: number[]): Promise<void>;
}

type Listener = (snapshot: StreamEngineSnapshot) => void;

interface RemoteStreamEntry {
  userId: number;
  identity: string;
  participant: RemoteParticipant;
  videoPublication?: RemoteTrackPublication | undefined;
  audioPublication?: RemoteTrackPublication | undefined;
  videoTrack?: RemoteVideoTrack | undefined;
  audioTrack?: RemoteAudioTrack | undefined;
  stats: StreamStats | null;
}

/**
 * What the UI asked for, keyed by user id.
 *
 * The player elements and the volume live here rather than on the remote
 * entry: a tile mounts (and reports its elements) before the LiveKit
 * participant and its tracks exist, and the entry must not lose the request
 * while the room connects.
 */
interface DesiredStream {
  videoElement: HTMLVideoElement | null;
  audioElement: HTMLAudioElement | null;
  /** Percent, 0..200. */
  volume: number;
  muted: boolean;
  quality: StreamQualityMode;
  /** Tile size in device pixels, used by the "auto" quality mode. */
  qualitySize: { width: number; height: number } | null;
}

interface ByteSample {
  bytes: number;
  at: number;
}

const IDENTITY_PATTERN = /^(\d+):stream$/;
/** Refresh the 60-second media token well before LiveKit reconnects. */
const TOKEN_REFRESH_MS = 45_000;

function userIdFor(identity: string): number | null {
  const match = IDENTITY_PATTERN.exec(identity);
  if (!match) {
    return null;
  }
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Attaches a local preview track; used by the streamer's own tile. */
export class StreamEngine {
  private readonly provider: StreamCredentialProvider;
  private readonly listeners = new Set<Listener>();
  private snapshot: StreamEngineSnapshot = {
    room: "idle",
    local: {
      streaming: false,
      preset: "1080p30",
      hasAudio: false,
      audioPath: null,
      stats: null,
    },
    streams: [],
    watching: [],
    visible: true,
    error: null,
  };

  private channelId = 0;
  private room: Room | null = null;
  private roomFuture: Promise<Room> | null = null;
  private localStream: MediaStream | null = null;
  private localVideo: LocalVideoTrack | null = null;
  private localAudio: LocalAudioTrack | null = null;
  private localVideoElement: HTMLVideoElement | null = null;
  private readonly watching = new Set<number>();
  private readonly remote = new Map<number, RemoteStreamEntry>();
  private readonly desired = new Map<number, DesiredStream>();
  private readonly byteSamples = new Map<string, ByteSample>();
  private statsTimer: number | null = null;
  private tokenTimer: number | null = null;
  private generation = 0;
  /** Users whose stream audio the core was told to play. */
  private readonly coreWatched = new Set<number>();
  private coreAudio: CoreStreamAudio = { available: [], playing: [] };
  /** Last gain sent to the core per user, so re-renders do not repeat it. */
  private readonly coreGains = new Map<number, string>();

  constructor(provider: StreamCredentialProvider) {
    this.provider = provider;
  }

  /** Remote stream audio as the core reports it (`streamAudio` events). */
  setCoreAudio(state: CoreStreamAudio): void {
    this.coreAudio = { available: [...state.available], playing: [...state.playing] };
    this.syncStreams();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): StreamEngineSnapshot {
    return this.snapshot;
  }

  /** Sets the voice channel the engine belongs to. */
  setChannel(channelId: number): void {
    if (this.channelId === channelId) {
      return;
    }
    this.channelId = channelId;
    // A stream belongs to the channel it was started in.
    void this.stopLocal();
    this.watching.clear();
    this.setSnapshot({ watching: [] });
    this.reportWatching();
    this.syncCoreWatch();
    void this.disconnectIfIdle();
    this.emit();
  }

  /** Shows or hides the players. Hiding unsubscribes and frees the room. */
  async setVisible(visible: boolean): Promise<void> {
    if (this.snapshot.visible === visible) {
      return;
    }
    this.setSnapshot({ visible });
    // A hidden panel plays nothing, so the user stops counting as a viewer:
    // the streamer's audience must show who actually sees the picture.
    this.reportWatching();
    if (visible) {
      if (this.active()) {
        await this.ensureRoom();
        this.applySubscriptions();
      }
    } else {
      this.applySubscriptions();
      await this.disconnectIfIdle();
    }
  }

  /** Starts capturing the screen and publishes it. */
  async startLocal(options: {
    preset: StreamPresetName;
    includeAudio: boolean;
    /**
     * Forces a codec. The UI never sets it; the P14 measurement harness uses
     * it to compare codecs on machines without VP9/AV1 hardware encoders.
     */
    codec?: StreamVideoCodec;
  }): Promise<void> {
    if (this.snapshot.local.streaming) {
      return;
    }
    if (this.channelId === 0) {
      this.fail("notInChannel", "Join a voice channel before sharing the screen");
      return;
    }
    const preset = STREAM_PRESETS[options.preset];
    this.setError(null);
    this.setLocal({
      preset: options.preset,
      streaming: false,
      hasAudio: false,
      audioPath: null,
      stats: null,
    });
    // The core captures everything except RosTalk; the WebView system audio
    // (with the friends' voices in it) is only the fallback.
    let coreAudio = false;
    let coreAudioError: string | null = null;
    if (options.includeAudio && this.provider.audio) {
      try {
        await this.provider.audio.start();
        coreAudio = true;
      } catch (error) {
        coreAudioError = messageOf(error);
      }
    }
    let media: MediaStream;
    try {
      media = await this.capture(options.includeAudio && !coreAudio, preset);
    } catch (error) {
      if (coreAudio) {
        await this.provider.audio?.stop().catch(() => {});
      }
      this.fail("noSource", messageOf(error));
      return;
    }
    this.localStream = media;
    const video = media.getVideoTracks()[0];
    if (!video) {
      media.getTracks().forEach((track) => track.stop());
      this.localStream = null;
      if (coreAudio) {
        await this.provider.audio?.stop().catch(() => {});
      }
      this.fail("noSource", "The screen source returned no video track");
      return;
    }
    // A WebView audio track is never published while the core captures.
    const audio = coreAudio ? null : (media.getAudioTracks()[0] ?? null);
    if (audio) {
      // System audio must reach viewers untouched. The built-in
      // getDisplayMedia defaults enable the voice DSP, which pumps game audio
      // and adds noise; switching it off is the minimal stage 5.2 requirement.
      try {
        await audio.applyConstraints({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        });
      } catch {
        // Some WebView2 builds refuse these constraints; the track is still
        // usable, so publishing continues with the default processing.
      }
    }
    // A 60 fps share is judged by motion; lower presets can keep the sharp
    // details of text and UI. The old "text" mode forced `maintain-resolution`
    // for the whole stream, which is exactly what made games stutter.
    video.contentHint = preset.fps >= 60 ? "motion" : "detail";

    try {
      const room = await this.ensureRoom();
      // Codec choice happens per stream: a hardware VP9/AV1 encoder is the only
      // case where SVC is worth it (see codec.ts).
      const profile = {
        width: preset.width,
        height: preset.height,
        fps: preset.fps,
        bitrate: preset.bitrate,
      };
      const choice = options.codec
        ? { codec: options.codec, svc: options.codec !== "h264" }
        : await chooseStreamCodec(profile);
      const localVideo = new LocalVideoTrack(video, undefined, false);
      this.localVideo = localVideo;
      await room.localParticipant.publishTrack(localVideo, {
        source: Track.Source.ScreenShare,
        name: "screen",
        simulcast: !choice.svc,
        videoCodec: choice.codec,
        screenShareEncoding: {
          maxBitrate: preset.bitrate,
          maxFramerate: preset.fps,
        },
        degradationPreference: "balanced",
        ...(choice.svc
          ? {
              scalabilityMode: SVC_SCALABILITY_MODE,
              // A viewer without a VP9/AV1 decoder gets H.264 instead of
              // nothing; the SFU regresses all subscribers together.
              backupCodec: { codec: "h264" as const },
            }
          : { screenShareSimulcastLayers: screenShareLayers(options.preset) }),
      });
      let hasAudio = false;
      if (audio) {
        const localAudio = new LocalAudioTrack(audio, undefined, false);
        this.localAudio = localAudio;
        await room.localParticipant.publishTrack(localAudio, {
          source: Track.Source.ScreenShareAudio,
          name: "screen-audio",
          dtx: false,
          red: true,
        });
        hasAudio = true;
      }
      video.addEventListener("ended", () => {
        void this.stopLocal();
      });
      const audioPath: StreamAudioPath | null = coreAudio
        ? "core"
        : hasAudio
          ? "webview"
          : null;
      this.setLocal({
        streaming: true,
        hasAudio: hasAudio || coreAudio,
        audioPath,
        stats: null,
      });
      // The fallback is explicit: friends will hear themselves in this stream.
      this.setError(
        audioPath === "webview" && this.provider.audio
          ? {
              code: "audioFallback",
              message: coreAudioError ?? "core capture unavailable",
            }
          : null,
      );
      this.startStats();
      this.emit();
    } catch (error) {
      // Publishing failed: do not leave a dangling capture or half-open room.
      await this.stopLocal();
      this.fail(errorCode(error) ?? "publishFailed", messageOf(error));
    }
  }

  /** Stops own screen share, keeping the room if a player is still watched. */
  async stopLocal(): Promise<void> {
    const room = this.room;
    if (this.snapshot.local.audioPath === "core") {
      await this.provider.audio?.stop().catch(() => {});
    }
    if (this.localVideo) {
      const track = this.localVideo;
      this.localVideo = null;
      if (room) {
        await room.localParticipant.unpublishTrack(track, true).catch(() => {});
      }
      track.stop();
    }
    if (this.localAudio) {
      const track = this.localAudio;
      this.localAudio = null;
      if (room) {
        await room.localParticipant.unpublishTrack(track, true).catch(() => {});
      }
      track.stop();
    }
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    if (this.localVideoElement) {
      this.localVideoElement.srcObject = null;
    }
    this.setLocal({
      streaming: false,
      hasAudio: false,
      audioPath: null,
      stats: null,
    });
    await this.disconnectIfIdle();
    this.emit();
  }

  /** Adds a stream to the watched set and subscribes to it. */
  async watch(userId: number): Promise<void> {
    this.watching.add(userId);
    this.setSnapshot({ watching: [...this.watching] });
    this.reportWatching();
    if (!this.snapshot.visible) {
      return;
    }
    try {
      await this.ensureRoom();
      this.applySubscriptions();
    } catch (error) {
      this.fail(errorCode(error) ?? "connectFailed", messageOf(error));
    }
  }

  /** Removes a stream from the watched set and unsubscribes. */
  unwatch(userId: number): void {
    this.watching.delete(userId);
    this.setSnapshot({ watching: [...this.watching] });
    this.reportWatching();
    this.applySubscriptions();
    void this.disconnectIfIdle();
  }

  unwatchAll(): void {
    this.watching.clear();
    this.setSnapshot({ watching: [] });
    this.reportWatching();
    this.applySubscriptions();
    void this.disconnectIfIdle();
  }

  /** Own preview element; `null` detaches it. */
  attachLocal(element: HTMLVideoElement | null): void {
    this.localVideoElement = element;
    if (!element) {
      return;
    }
    if (this.localStream) {
      element.srcObject = this.localStream;
    }
    void element.play().catch(() => {});
  }

  /**
   * Remembers the tile's video element, even before the participant exists.
   *
   * The element is attached as soon as the track arrives (`handleSubscribed`).
   */
  attachVideo(userId: number, element: HTMLVideoElement | null): void {
    const desired = this.desiredFor(userId);
    if (desired.videoElement && desired.videoElement !== element) {
      this.remote.get(userId)?.videoTrack?.detach(desired.videoElement);
    }
    desired.videoElement = element;
    this.applyTracks(userId);
  }

  /**
   * Remembers the hidden player element, even before the participant exists.
   *
   * Without this the one-shot mount effect ran while `remote` was empty, the
   * element was forgotten, and the audio track subscribed with nowhere to go
   * — the "no sound at all" complaint.
   */
  attachAudio(userId: number, element: HTMLAudioElement | null): void {
    const desired = this.desiredFor(userId);
    if (desired.audioElement && desired.audioElement !== element) {
      this.remote.get(userId)?.audioTrack?.detach(desired.audioElement);
    }
    desired.audioElement = element;
    this.applyTracks(userId);
  }

  /** Per-stream playback volume, 0..200 %. Never throws. */
  setVolume(userId: number, volume: number): void {
    const desired = this.desiredFor(userId);
    desired.volume = Number.isFinite(volume)
      ? Math.min(200, Math.max(0, volume))
      : 100;
    this.applyAudio(userId);
  }

  setMuted(userId: number, muted: boolean): void {
    this.desiredFor(userId).muted = muted;
    this.applyAudio(userId);
  }

  /**
   * Requests a simulcast layer for a watched stream.
   *
   * `high` asks for the top layer explicitly. The stream room disables
   * `adaptiveStream`, because its tile-size heuristics used to pin a 1080p
   * source to the 540p layer; the layer now depends on this choice and on the
   * bandwidth estimate, never on the CSS width of the tile.
   */
  setQuality(
    userId: number,
    quality: StreamQualityMode,
    size?: { width: number; height: number },
  ): void {
    const desired = this.desiredFor(userId);
    const changed = desired.quality !== quality;
    desired.quality = quality;
    if (quality === "auto" && size && size.width > 0 && size.height > 0) {
      desired.qualitySize = {
        width: Math.round(size.width),
        height: Math.round(size.height),
      };
    }
    this.applyQuality(userId);
    if (changed) {
      this.syncStreams();
    }
  }

  /** Releases the room and all tracks; called on disconnect. */
  async shutdown(): Promise<void> {
    this.generation += 1;
    if (this.snapshot.local.audioPath === "core") {
      await this.provider.audio?.stop().catch(() => {});
    }
    this.watching.clear();
    this.reportWatching();
    this.syncCoreWatch();
    this.clearRemote();
    this.desired.clear();
    this.stopStats();
    this.stopTokenRefresh();
    const room = this.room;
    this.room = null;
    if (room) {
      await room.disconnect().catch(() => {});
    }
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.localVideo = null;
    this.localAudio = null;
    this.setSnapshot({
      room: "idle",
      watching: [],
      streams: [],
      error: null,
      local: {
        ...this.snapshot.local,
        streaming: false,
        hasAudio: false,
        audioPath: null,
        stats: null,
      },
    });
  }

  private active(): boolean {
    return (
      this.snapshot.local.streaming ||
      (this.snapshot.visible && this.watching.size > 0)
    );
  }

  private async capture(
    includeAudio: boolean,
    preset: StreamPreset,
  ): Promise<MediaStream> {
    const video: MediaTrackConstraints = {
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.fps, max: preset.fps },
    };
    if (!includeAudio) {
      return navigator.mediaDevices.getDisplayMedia({ video, audio: false });
    }
    try {
      return await navigator.mediaDevices.getDisplayMedia({
        video,
        audio: true,
      });
    } catch (error) {
      // The system-audio switch is optional and off by default in WebView2.
      // A failure here must not abort a video-only share.
      this.setError({
        code: "audioUnavailable",
        message: messageOf(error),
      });
      return navigator.mediaDevices.getDisplayMedia({ video, audio: false });
    }
  }

  /**
   * Publishes the viewer set to the control plane.
   *
   * A hidden panel or a channel without streams reports an empty set: the
   * streamer must see who actually watches, not who pressed "watch" an hour
   * ago. A failed request is not fatal here — the media path keeps working and
   * the next change re-sends the whole set.
   */
  private reportWatching(): void {
    const ids = this.snapshot.visible
      ? [...this.watching].sort((a, b) => a - b)
      : [];
    void this.provider.setWatching(ids).catch(() => {});
  }

  /**
   * Re-sends the current viewer set.
   *
   * The server clears the audience of a stream when it stops, so a streamer who
   * restarts keeps the tiles open without being counted. The stream panel calls
   * this when a watched stream goes live again; sending the same set twice is
   * harmless because the server replaces it.
   */
  refreshWatching(): void {
    this.reportWatching();
  }

  private async ensureRoom(): Promise<Room> {
    const current = this.room;
    if (current) {
      if (current.state === ConnectionState.Connected) {
        return current;
      }
      if (
        current.state === ConnectionState.Connecting &&
        this.roomFuture !== null
      ) {
        return this.roomFuture;
      }
      if (
        current.state === ConnectionState.Connecting ||
        current.state === ConnectionState.Reconnecting ||
        current.state === ConnectionState.SignalReconnecting
      ) {
        // A second room with the same identity makes LiveKit evict the
        // duplicate. Wait for the room that is already on its way instead.
        return this.waitForReconnect(current);
      }
      // Closed: the previous room must be gone before the same identity
      // connects again.
      this.room = null;
      this.clearRemote();
      this.stopStats();
      this.stopTokenRefresh();
      await current.disconnect().catch(() => {});
    }
    if (this.roomFuture) {
      return this.roomFuture;
    }
    let created: Room | null = null;
    const future = (async () => {
      if (this.channelId === 0) {
        throw new Error("no channel");
      }
      const credentials = await this.provider.requestStreamCredentials(
        this.channelId,
      );
      const generation = ++this.generation;
      const room = new Room({
        // The room exists only for screen shares and every watched tile states
        // the layer it wants. Adaptive stream sized the request from the tile
        // element, so a 1080p share landed on the 540p layer; it also made the
        // layer flap while the window was resized.
        adaptiveStream: false,
        dynacast: true,
        disconnectOnPageLeave: true,
        // The SDK then routes remote audio through its own GainNode, where a
        // 1.5x volume is legal. `HTMLMediaElement.volume` only accepts 0..1.
        webAudioMix: true,
      });
      created = room;
      this.room = room;
      // Entries of a previous room are stale; the desired volume and elements
      // stay in `desired` and are applied to the new participants.
      this.clearRemote();
      this.bindRoom(room);
      this.setSnapshot({ room: "connecting" });
      // The Rust proxy replaces this placeholder with the real media token;
      // the page never receives it. The spike harness passes a real token
      // because it has no proxy.
      await room.connect(credentials.url, credentials.token ?? "proxy", {
        autoSubscribe: false,
      });
      if (generation !== this.generation || this.room !== room) {
        await room.disconnect().catch(() => {});
        throw new Error("stream connection superseded");
      }
      this.setSnapshot({ room: "connected", error: null });
      this.seedParticipants(room);
      this.applySubscriptions();
      this.startStats();
      this.startTokenRefresh();
      return room;
    })();
    this.roomFuture = future;
    try {
      return await future;
    } catch (error) {
      // A failed connect must not leave a half-open room behind: the retry
      // button would otherwise see its state and never build a fresh one.
      if (created !== null && this.room === created) {
        this.room = null;
        this.clearRemote();
        this.stopStats();
        this.stopTokenRefresh();
      }
      this.setSnapshot({ room: this.active() ? "failed" : "idle" });
      throw error;
    } finally {
      this.roomFuture = null;
    }
  }

  /** Resolves when a connecting/reconnecting room is usable again. */
  private waitForReconnect(room: Room): Promise<Room> {
    return new Promise((resolve, reject) => {
      const done = () => {
        room.off(RoomEvent.Reconnected, onReconnected);
        room.off(RoomEvent.Disconnected, onDisconnected);
      };
      const onReconnected = () => {
        done();
        if (this.room === room) {
          resolve(room);
        } else {
          reject(new Error("stream connection superseded"));
        }
      };
      const onDisconnected = () => {
        done();
        reject(new Error("stream connection closed"));
      };
      room.on(RoomEvent.Reconnected, onReconnected);
      room.on(RoomEvent.Disconnected, onDisconnected);
      // The state may have changed between the caller's check and this call.
      if (room.state === ConnectionState.Connected) {
        done();
        resolve(room);
      } else if (this.room !== room) {
        done();
        reject(new Error("stream connection superseded"));
      }
    });
  }

  private bindRoom(room: Room): void {
    // Only the room stored in `this.room` may change engine state. A late
    // `Disconnected` from a replaced room used to clear the new room's
    // participants and audio (the "stream sometimes does not connect" bug).
    const current = () => this.room === room;
    room
      .on(RoomEvent.ParticipantConnected, (participant) => {
        if (current()) {
          this.upsertParticipant(participant);
        }
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (current()) {
          this.removeParticipant(participant.identity);
        }
      })
      .on(RoomEvent.TrackPublished, (publication, participant) => {
        if (!current()) {
          return;
        }
        this.upsertParticipant(participant);
        this.applyPublication(participant.identity, publication);
      })
      .on(RoomEvent.TrackUnpublished, (publication, participant) => {
        if (current()) {
          this.applyPublication(participant.identity, publication, true);
        }
      })
      .on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, publication, participant) => {
          if (current()) {
            this.handleSubscribed(track, publication, participant);
          }
        },
      )
      .on(
        RoomEvent.TrackUnsubscribed,
        (track: RemoteTrack, publication, participant) => {
          if (current()) {
            this.handleUnsubscribed(track, publication, participant);
          }
        },
      )
      .on(RoomEvent.TrackSubscriptionFailed, (_sid, _participant, reason) => {
        if (current() && this.watching.size > 0) {
          this.fail(
            "subscribeFailed",
            reason === undefined ? "track subscription failed" : String(reason),
          );
        }
      })
      .on(RoomEvent.Reconnecting, () => {
        if (current()) {
          this.setSnapshot({ room: "reconnecting" });
        }
      })
      .on(RoomEvent.Reconnected, () => {
        if (!current()) {
          return;
        }
        this.setSnapshot({ room: "connected" });
        this.seedParticipants(room);
        this.applySubscriptions();
      })
      .on(RoomEvent.Disconnected, () => {
        if (!current()) {
          return;
        }
        // The core stream audio must not outlive the screen share (a
        // moderator stop removes the `:stream` participant, ADR 0016).
        if (this.snapshot.local.audioPath === "core") {
          void this.provider.audio?.stop().catch(() => {});
          this.setLocal({ hasAudio: false, audioPath: null });
        }
        this.room = null;
        this.clearRemote();
        this.stopStats();
        this.stopTokenRefresh();
        const failed = this.active();
        this.setSnapshot({
          room: failed ? "failed" : "idle",
          streams: [],
          error: failed
            ? {
                code: "disconnected",
                message: "The stream connection was closed",
              }
            : null,
        });
      });
  }

  private seedParticipants(room: Room): void {
    for (const participant of room.remoteParticipants.values()) {
      this.upsertParticipant(participant);
      for (const publication of participant.trackPublications.values()) {
        this.applyPublication(participant.identity, publication);
      }
    }
    this.syncStreams();
  }

  private upsertParticipant(participant: RemoteParticipant): void {
    const userId = userIdFor(participant.identity);
    if (userId === null) {
      return;
    }
    const existing = this.remote.get(userId);
    if (existing) {
      existing.participant = participant;
      this.applyTracks(userId);
      return;
    }
    this.remote.set(userId, {
      userId,
      identity: participant.identity,
      participant,
      stats: null,
    });
    this.applyTracks(userId);
    this.syncStreams();
  }

  private applyPublication(
    identity: string,
    publication: RemoteTrackPublication,
    removed = false,
  ): void {
    const userId = userIdFor(identity);
    if (userId === null) {
      return;
    }
    const entry = this.remote.get(userId);
    if (!entry) {
      return;
    }
    const source = publication.source;
    if (source !== Track.Source.ScreenShare &&
        source !== Track.Source.ScreenShareAudio) {
      return;
    }
    if (source === Track.Source.ScreenShare) {
      entry.videoPublication = removed ? undefined : publication;
    } else {
      entry.audioPublication = removed ? undefined : publication;
    }
    this.applySubscriptions();
    this.syncStreams();
  }

  private handleSubscribed(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    const userId = userIdFor(participant.identity);
    if (userId === null) {
      return;
    }
    const entry = this.remote.get(userId);
    if (!entry) {
      return;
    }
    if (publication.source === Track.Source.ScreenShare && track.kind === Track.Kind.Video) {
      entry.videoTrack = track as RemoteVideoTrack;
      this.applyTracks(userId);
    } else if (
      publication.source === Track.Source.ScreenShareAudio &&
      track.kind === Track.Kind.Audio
    ) {
      entry.audioTrack = track as RemoteAudioTrack;
      this.applyTracks(userId);
    }
    this.syncStreams();
  }

  private handleUnsubscribed(
    _track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    const userId = userIdFor(participant.identity);
    if (userId === null) {
      return;
    }
    const entry = this.remote.get(userId);
    if (!entry) {
      return;
    }
    if (publication.source === Track.Source.ScreenShare) {
      this.detachVideo(userId);
      entry.videoTrack = undefined;
    } else if (publication.source === Track.Source.ScreenShareAudio) {
      this.detachAudio(userId);
      entry.audioTrack = undefined;
    }
    this.syncStreams();
  }

  private removeParticipant(identity: string): void {
    const userId = userIdFor(identity);
    if (userId === null) {
      return;
    }
    const entry = this.remote.get(userId);
    if (!entry) {
      return;
    }
    this.detachVideo(userId);
    this.detachAudio(userId);
    this.remote.delete(userId);
    if (this.watching.delete(userId)) {
      this.setSnapshot({ watching: [...this.watching] });
      this.reportWatching();
    }
    this.syncStreams();
  }

  private applySubscriptions(): void {
    const active = this.snapshot.visible;
    // With the core present it plays every stream audio, the WebView none:
    // one playback path, so nothing is heard twice.
    const webviewAudio = this.provider.audio === undefined;
    for (const entry of this.remote.values()) {
      const wanted = active && this.watching.has(entry.userId);
      entry.videoPublication?.setSubscribed(wanted);
      entry.audioPublication?.setSubscribed(wanted && webviewAudio);
      this.applyQuality(entry.userId);
    }
    this.syncCoreWatch();
    this.syncStreams();
  }

  /** Tells the core which users' stream audio to play. */
  private syncCoreWatch(): void {
    const audio = this.provider.audio;
    if (!audio) {
      return;
    }
    const wanted = new Set(this.snapshot.visible ? this.watching : []);
    for (const userId of [...this.coreWatched]) {
      if (!wanted.has(userId)) {
        this.coreWatched.delete(userId);
        void audio.watch(userId, false).catch(() => {});
      }
    }
    for (const userId of wanted) {
      if (!this.coreWatched.has(userId)) {
        this.coreWatched.add(userId);
        // The gain goes first, so the first frames already play at it.
        this.coreGains.delete(userId);
        this.applyAudio(userId);
        void audio.watch(userId, true).catch(() => {});
      }
    }
  }

  /**
   * Applies the requested layer to the remote publication.
   *
   * `setVideoQuality` is only a ceiling: the SFU still drops to a lower layer
   * when the subscriber's bandwidth estimate cannot carry it, which is what
   * makes `high` safe to be the default on a good network.
   */
  private applyQuality(userId: number): void {
    const publication = this.remote.get(userId)?.videoPublication;
    if (!publication) {
      return;
    }
    const desired = this.desiredFor(userId);
    try {
      if (desired.quality === "low") {
        publication.setVideoQuality(VideoQuality.LOW);
        return;
      }
      if (desired.quality === "auto" && desired.qualitySize) {
        publication.setVideoDimensions(desired.qualitySize);
        return;
      }
      publication.setVideoQuality(VideoQuality.HIGH);
    } catch {
      // A publication that went away mid-update must not break the tile.
    }
  }

  private syncStreams(): void {
    const streams: RemoteStreamState[] = [];
    const core = this.provider.audio !== undefined;
    for (const entry of this.remote.values()) {
      streams.push({
        userId: entry.userId,
        identity: entry.identity,
        hasVideo: entry.videoPublication !== undefined,
        hasAudio:
          entry.audioPublication !== undefined ||
          this.coreAudio.available.includes(entry.userId),
        subscribed: this.watching.has(entry.userId),
        videoReady: entry.videoTrack !== undefined,
        audioReady: core
          ? this.coreAudio.playing.includes(entry.userId)
          : entry.audioTrack !== undefined,
        quality: this.desiredFor(entry.userId).quality,
        stats: entry.stats,
      });
    }
    streams.sort((a, b) => a.userId - b.userId);
    this.setSnapshot({ streams });
  }

  private async disconnectIfIdle(): Promise<void> {
    if (this.active()) {
      return;
    }
    const room = this.room;
    this.room = null;
    this.stopStats();
    this.stopTokenRefresh();
    // Clear the entries of the room that is being closed, never a room that
    // `watch()` may create while `disconnect()` is still awaiting.
    this.clearRemote();
    if (room) {
      await room.disconnect().catch(() => {});
    }
    if (this.room === null) {
      this.setSnapshot({ room: "idle", streams: [] });
    }
  }

  private desiredFor(userId: number): DesiredStream {
    let desired = this.desired.get(userId);
    if (!desired) {
      desired = {
        videoElement: null,
        audioElement: null,
        volume: 100,
        muted: false,
        // A watched stream opens on the top layer: the old adaptive stream
        // request gave viewers 540p/360p of a 1080p share.
        quality: "high",
        qualitySize: null,
      };
      this.desired.set(userId, desired);
    }
    return desired;
  }

  /** Attaches whatever tracks already exist to the tile's elements. */
  private applyTracks(userId: number): void {
    const entry = this.remote.get(userId);
    if (!entry) {
      return;
    }
    const desired = this.desiredFor(userId);
    try {
      if (desired.videoElement && entry.videoTrack) {
        entry.videoTrack.attach(desired.videoElement);
        void desired.videoElement.play().catch(() => {});
      }
      if (desired.audioElement && entry.audioTrack) {
        entry.audioTrack.attach(desired.audioElement);
        void desired.audioElement.play().catch(() => {});
      }
    } catch {
      // An element that went away mid-attach must not break the session.
    }
    this.applyAudio(userId);
  }

  /**
   * Applies the requested volume and mute state.
   *
   * With `webAudioMix` the SDK owns a GainNode, so 0..2 is a valid gain; the
   * element fallback is clamped to 0..1 and can never throw
   * `IndexSizeError` (the old white-screen crash at 105 %).
   */
  private applyAudio(userId: number): void {
    const desired = this.desiredFor(userId);
    if (this.provider.audio) {
      // The core mixer owns the gain: 0..200 % without a WebView GainNode.
      const key = `${desired.volume}:${desired.muted}`;
      if (this.coreGains.get(userId) !== key) {
        this.coreGains.set(userId, key);
        void this.provider.audio
          .setVolume(userId, desired.volume, desired.muted)
          .catch(() => {});
      }
      return;
    }
    const entry = this.remote.get(userId);
    const gain = desired.muted
      ? 0
      : Math.min(2, Math.max(0, desired.volume / 100));
    try {
      if (entry?.audioTrack) {
        entry.audioTrack.setVolume(gain);
        return;
      }
      if (desired.audioElement) {
        desired.audioElement.volume = Math.min(1, gain);
        desired.audioElement.muted = desired.muted;
      }
    } catch {
      // Playback volume must never take the interface down.
    }
  }

  private detachVideo(userId: number): void {
    const element = this.desired.get(userId)?.videoElement;
    if (element) {
      this.remote.get(userId)?.videoTrack?.detach(element);
    }
  }

  private detachAudio(userId: number): void {
    const element = this.desired.get(userId)?.audioElement;
    if (element) {
      this.remote.get(userId)?.audioTrack?.detach(element);
    }
  }

  private clearRemote(): void {
    for (const entry of this.remote.values()) {
      this.detachVideo(entry.userId);
      this.detachAudio(entry.userId);
    }
    this.remote.clear();
  }

  private startStats(): void {
    if (this.statsTimer !== null) {
      return;
    }
    this.statsTimer = window.setInterval(() => {
      void this.collectStats();
    }, 1000);
  }

  private stopStats(): void {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  /**
   * The control plane issues a 60-second media token. Sliding a fresh one into
   * the core's proxy while the participant stays connected lets LiveKit's own
   * reconnect use a valid credential.
   */
  private startTokenRefresh(): void {
    if (this.tokenTimer !== null) {
      return;
    }
    this.tokenTimer = window.setInterval(() => {
      if (this.channelId === 0) {
        return;
      }
      void this.provider
        .requestStreamCredentials(this.channelId)
        .catch(() => {
          // A transient control-plane failure is retried on the next tick.
        });
    }, TOKEN_REFRESH_MS);
  }

  private stopTokenRefresh(): void {
    if (this.tokenTimer !== null) {
      window.clearInterval(this.tokenTimer);
      this.tokenTimer = null;
    }
  }

  private async collectStats(): Promise<void> {
    if (this.localVideo) {
      const stats = await readStats(this.localVideo, "local", this.byteSamples);
      if (stats) {
        this.setLocal({ stats });
      }
    }
    for (const entry of this.remote.values()) {
      if (!entry.videoTrack) {
        continue;
      }
      const stats = await readStats(
        entry.videoTrack,
        `remote-${entry.userId}`,
        this.byteSamples,
      );
      if (stats) {
        entry.stats = stats;
      }
    }
    this.syncStreams();
  }

  private setSnapshot(patch: Partial<StreamEngineSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  private setLocal(patch: Partial<LocalStreamState>): void {
    this.setSnapshot({ local: { ...this.snapshot.local, ...patch } });
  }

  private setError(error: StreamEngineSnapshot["error"]): void {
    this.setSnapshot({ error });
  }

  private fail(code: string, message: string): void {
    this.setSnapshot({
      room: this.room ? "connected" : "failed",
      error: { code, message },
    });
  }

  private emit(): void {
    this.setSnapshot({});
  }
}

async function readStats(
  track: LocalVideoTrack | RemoteVideoTrack,
  key: string,
  samples: Map<string, ByteSample>,
): Promise<StreamStats | null> {
  try {
    const report = await track.getRTCStatsReport();
    if (!report) {
      return null;
    }
    return parseVideoStats(report, key, samples, performance.now());
  } catch {
    return null;
  }
}

/** The subset of `RTCStatsReport` the parser needs; keeps it unit-testable. */
export interface StatsReportLike {
  forEach(callback: (value: unknown) => void): void;
  get(key: string): unknown;
}

interface VideoStatsEntry {
  rid: string | undefined;
  width: number | undefined;
  height: number | undefined;
  fps: number | undefined;
  codec: string | undefined;
  encoder: string | undefined;
  decoder: string | undefined;
  qualityLimitation: string | undefined;
  powerEfficient: boolean | undefined;
  bytes: number | undefined;
  packetsLost: number | undefined;
  packetsReceived: number | undefined;
  framesDropped: number | undefined;
}

function numberField(item: Record<string, unknown>, name: string): number | undefined {
  const value = item[name];
  return typeof value === "number" ? value : undefined;
}

function stringField(item: Record<string, unknown>, name: string): string | undefined {
  const value = item[name];
  return typeof value === "string" ? value : undefined;
}

function layerArea(entry: VideoStatsEntry): number {
  return (entry.width ?? 0) * (entry.height ?? 0);
}

function bitrateFor(
  key: string,
  bytes: number | undefined,
  samples: Map<string, ByteSample>,
  now: number,
): number | undefined {
  if (bytes === undefined) {
    return undefined;
  }
  const previous = samples.get(key);
  samples.set(key, { bytes, at: now });
  if (!previous || now <= previous.at || bytes < previous.bytes) {
    return undefined;
  }
  return Math.round(((bytes - previous.bytes) * 8) / (now - previous.at));
}

/**
 * Turns an RTP stats report into the tile's numbers.
 *
 * A simulcast publisher reports one `outbound-rtp` entry per layer, and the SDK
 * returns them in no particular order: the old code overwrote the whole result
 * with whichever entry came last, so the overlay could show the 360p layer as
 * "the stream". The highest-resolution entry is the one the viewer sees, the
 * rest become `layers` (stage P14 needs them to prove which layers exist).
 */
export function parseVideoStats(
  report: StatsReportLike,
  key: string,
  samples: Map<string, ByteSample>,
  now: number,
): StreamStats | null {
  const entries: VideoStatsEntry[] = [];
  report.forEach((value) => {
    const item = value as Record<string, unknown>;
    if (item.type !== "outbound-rtp" && item.type !== "inbound-rtp") {
      return;
    }
    if (item.kind !== "video") {
      return;
    }
    const codecId = stringField(item, "codecId");
    const codec = codecId ? (report.get(codecId) as Record<string, unknown> | undefined) : undefined;
    entries.push({
      rid: stringField(item, "rid"),
      width: numberField(item, "frameWidth"),
      height: numberField(item, "frameHeight"),
      fps: numberField(item, "framesPerSecond"),
      codec: codec ? stringField(codec, "mimeType") : undefined,
      encoder: stringField(item, "encoderImplementation"),
      decoder: stringField(item, "decoderImplementation"),
      qualityLimitation: stringField(item, "qualityLimitationReason"),
      powerEfficient: item.powerEfficientEncoder === true,
      bytes: numberField(item, "bytesSent") ?? numberField(item, "bytesReceived"),
      packetsLost: numberField(item, "packetsLost"),
      packetsReceived: numberField(item, "packetsReceived"),
      framesDropped: numberField(item, "framesDropped"),
    });
  });
  if (entries.length === 0) {
    return null;
  }
  // Layer bitrates first: the "active" layer (dynacast disables the ones
  // nobody subscribes to) is the one actually put on the wire.
  const layers: StreamLayerStats[] = entries
    .slice()
    .sort((a, b) => layerArea(a) - layerArea(b))
    .map((entry, index) => {
      const layer: StreamLayerStats = {};
      if (entry.rid !== undefined) {
        layer.rid = entry.rid;
      }
      if (entry.width !== undefined) {
        layer.width = entry.width;
      }
      if (entry.height !== undefined) {
        layer.height = entry.height;
      }
      if (entry.fps !== undefined) {
        layer.fps = entry.fps;
      }
      if (entry.qualityLimitation !== undefined) {
        layer.qualityLimitation = entry.qualityLimitation;
      }
      const layerBitrate = bitrateFor(
        `${key}#${entry.rid ?? index}`,
        entry.bytes,
        samples,
        now,
      );
      if (layerBitrate !== undefined) {
        layer.bitrateKbps = layerBitrate;
      }
      return layer;
    });
  const primary = entries.reduce((best, entry) =>
    layerArea(entry) > layerArea(best) ? entry : best,
  );
  // The encoder implementation is reported on whichever layer the browser
  // attaches it to (often only the top one), so take the first defined value.
  const withEncoder = entries.find((entry) => entry.encoder !== undefined);
  const withDecoder = entries.find((entry) => entry.decoder !== undefined);
  const withCodec = entries.find((entry) => entry.codec !== undefined);
  const stats: StreamStats = {};
  if (withCodec?.codec !== undefined) {
    stats.codec = withCodec.codec;
  }
  if (withEncoder?.encoder !== undefined) {
    stats.encoder = withEncoder.encoder;
  }
  if (withDecoder?.decoder !== undefined) {
    stats.decoder = withDecoder.decoder;
  }
  if (primary.width !== undefined) {
    stats.width = primary.width;
  }
  if (primary.height !== undefined) {
    stats.height = primary.height;
  }
  if (primary.fps !== undefined) {
    stats.fps = primary.fps;
  }
  // A disabled simulcast layer still reports `qualityLimitationReason`, so the
  // headline reason comes from the layer that is actually sending.
  const sendingIndex = layers.reduce(
    (best, layer, index) =>
      (layer.bitrateKbps ?? 0) > (layers[best]?.bitrateKbps ?? 0) ? index : best,
    0,
  );
  const hasSending = layers.some((layer) => (layer.bitrateKbps ?? 0) > 0);
  const headline = hasSending ? (layers[sendingIndex] ?? primary) : primary;
  if (headline?.qualityLimitation !== undefined) {
    stats.qualityLimitation = headline.qualityLimitation;
  }
  if (withEncoder !== undefined) {
    stats.powerEfficient = withEncoder.powerEfficient ?? false;
  }
  const bitrate = bitrateFor(key, primary.bytes, samples, now);
  if (bitrate !== undefined) {
    stats.bitrateKbps = bitrate;
  }
  if (primary.packetsLost !== undefined || primary.packetsReceived !== undefined) {
    const lost = primary.packetsLost ?? 0;
    const received = primary.packetsReceived ?? 0;
    if (lost + received > 0) {
      stats.lossPercent = Math.round((lost / (lost + received)) * 1000) / 10;
    }
  }
  if (primary.framesDropped !== undefined) {
    stats.framesDropped = primary.framesDropped;
  }
  if (entries.length > 1) {
    stats.layers = layers;
  }
  return stats;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A `CoreError` code, when the failure crossed the IPC boundary. */
function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}
