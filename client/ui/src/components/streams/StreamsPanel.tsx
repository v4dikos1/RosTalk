import {
  BarChart3,
  Cast,
  EyeOff,
  Maximize2,
  Minimize2,
  MonitorOff,
  MonitorUp,
  Radio,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/common/EmptyState";
import { ErrorState } from "@/components/common/ErrorState";
import { UserAvatar } from "@/components/common/UserAvatar";
import { LiveBadge } from "@/components/streams/LiveBadge";
import { StreamViewers } from "@/components/streams/StreamViewers";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { isDesktop } from "@/core";
import type { ChannelView, UserView } from "@/core/api";
import {
  STREAM_PRESETS,
  type RemoteStreamState,
  type StreamEngineSnapshot,
  type StreamQualityMode,
  type StreamStats,
} from "@/features/streams/engine";
import { useFullscreen } from "@/hooks/useFullscreen";
import { streamViewers } from "@/lib/streamViewers";
import { watchStreamInChannel } from "@/lib/streams";
import { cn } from "@/lib/utils";
import { useCoreStore } from "@/store/coreStore";
import { streamEngine, useStreamStore } from "@/store/streamStore";

/**
 * Grid of the channel's live screens (stage 5.1).
 *
 * A tile only subscribes when the user asked to watch it: `autoSubscribe` is
 * off in the engine. Leaving the panel unsubscribes everything and, when the
 * user is not streaming either, closes the `*:stream` participant.
 */
export function StreamsPanel({ channel }: { channel: ChannelView }) {
  const { t } = useTranslation();
  const state = useCoreStore((core) => core.state);
  const connection = state?.connection;
  const local = useStreamStore((stream) => stream.local);
  const watching = useStreamStore((stream) => stream.watching);
  const remote = useStreamStore((stream) => stream.streams);
  const room = useStreamStore((stream) => stream.room);
  const error = useStreamStore((stream) => stream.error);

  const streamers = (state?.users ?? []).filter(
    (user) => user.channelId === channel.id && user.streaming,
  );
  const self = state?.users.find((user) => user.id === state.selfUserId);
  const serverId = state?.server?.id ?? null;
  const remoteStreamers = streamers.filter((user) => user.id !== self?.id);
  // A watched stream that just ended keeps its tile (with an explicit
  // "stream ended" state) until the viewer closes it.
  const endedStreamers = (state?.users ?? []).filter(
    (user) =>
      user.channelId === channel.id &&
      user.id !== self?.id &&
      !user.streaming &&
      watching.includes(user.id),
  );

  // A stream that stopped had its audience cleared on the server. When it goes
  // live again the open tiles keep watching, so the list is published again
  // instead of leaving the streamer with a permanent zero (stage P12).
  const watchingKey = watching.join(",");
  const liveKey = streamers
    .map((user) => user.id)
    .join(",");
  useEffect(() => {
    streamEngine.refreshWatching();
  }, [channel.id, watchingKey, liveKey]);

  // A keyboard user must not lose focus when the tile's own action disappears
  // (the ended-stream "Close" unmounts the tile). Prefer the same tile's Watch
  // button, then any remaining stream action, then the streams tab/panel.
  function unwatchAndRestoreFocus(userId: number) {
    useStreamStore.getState().unwatch(userId);
    if (typeof window === "undefined") {
      return;
    }
    window.setTimeout(() => {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active.isConnected
      ) {
        return;
      }
      const watch = document.querySelector<HTMLElement>(
        `[data-testid="watch-${userId}"]`,
      );
      if (watch?.isConnected) {
        watch.focus();
        return;
      }
      const next = document.querySelector<HTMLElement>(
        '[data-testid^="unwatch-"], [data-testid^="watch-"], [data-testid^="retry-"], [data-testid^="close-"], [data-testid="main-tab-streams"], [data-testid="streams-panel"]',
      );
      next?.focus();
    }, 0);
  }

  if (connection !== "connected") {
    return (
      <ErrorState
        className="flex-1"
        title={t("streams.errorTitle")}
        description={t("streams.errorHint")}
      />
    );
  }

  const tileCount =
    (local.streaming ? 1 : 0) +
    remoteStreamers.length +
    endedStreamers.length;
  const watchError =
    error !== null &&
    error.code !== "noSource" &&
    error.code !== "audioUnavailable" &&
    error.code !== "audioFallback" &&
    error.code !== "captureBorder"
      ? error
      : null;

  return (
    <div
      data-testid="streams-panel"
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background p-4"
    >
      {watchError ? (
        <div
          role="alert"
          className="mb-2 rounded-sm border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[12px] text-warning"
        >
          {watchError.code === "disconnected"
            ? t("streams.disconnected")
            : watchError.code === "permissionDenied"
              ? t("streams.noPermission")
              : t("streams.watchFailed", { message: watchError.message })}
        </div>
      ) : null}

      {tileCount === 0 ? (
        <EmptyState
          className="flex-1"
          icon={Radio}
          title={t("streams.emptyTitle")}
          description={t("streams.emptyHint")}
        />
      ) : (
        <div
          data-testid="streams-grid"
          className={cn(
            "grid min-h-0 grid-cols-1 gap-3",
            tileCount > 1 && "sm:grid-cols-2",
          )}
        >
        {local.streaming ? (
          <LocalTile
            viewers={streamViewers(state?.users ?? [], state?.selfUserId ?? 0)}
            serverId={serverId}
          />
        ) : null}
        {remoteStreamers.map((user) => {
          const info = remote.find((entry) => entry.userId === user.id);
          const isWatched = watching.includes(user.id);
          return (
            <RemoteTile
              key={user.id}
              user={user}
              info={info}
              watched={isWatched}
              room={room}
              error={watchError}
              viewers={streamViewers(state?.users ?? [], user.id)}
              serverId={serverId}
              onWatch={() => void watchStreamInChannel(channel.id, user.id)}
              onUnwatch={() => unwatchAndRestoreFocus(user.id)}
            />
          );
        })}
        {endedStreamers.map((user) => (
          <RemoteTile
            key={user.id}
            user={user}
            info={undefined}
            watched
            room={room}
            error={null}
            viewers={[]}
            serverId={serverId}
            onWatch={() => void watchStreamInChannel(channel.id, user.id)}
            onUnwatch={() => unwatchAndRestoreFocus(user.id)}
          />
        ))}
        </div>
      )}
    </div>
  );
}

function LocalTile({
  viewers,
  serverId,
}: {
  viewers: UserView[];
  serverId: string | null;
}) {
  const { t } = useTranslation();
  const local = useStreamStore((stream) => stream.local);
  const stop = useStreamStore((stream) => stream.stop);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const fullscreen = useFullscreen(containerRef);

  useEffect(() => {
    streamEngine.attachLocal(videoRef.current);
    return () => streamEngine.attachLocal(null);
  }, []);

  return (
    <section
      ref={containerRef}
      data-testid="stream-local"
      data-fullscreen={fullscreen.active ? "true" : undefined}
      onDoubleClick={(event) => {
        if (!(event.target instanceof Element) || !event.target.closest("button")) {
          void fullscreen.toggle();
        }
      }}
      className={cn(
        "relative flex aspect-video min-h-[180px] w-full flex-col overflow-hidden rounded-lg bg-black ring-1 ring-accent/50",
        fullscreen.active && "fixed inset-0 z-50 aspect-auto max-w-none rounded-none",
      )}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        className={cn(
          "min-h-0 flex-1 object-contain",
          local.native && "hidden",
        )}
      />
      {local.native ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 text-white/70">
          <MonitorUp className="size-6" aria-hidden />
          <span className="text-[12px]">
            {local.nativeStatus === "reconnecting"
              ? t("streams.nativeReconnecting")
              : t("streams.nativeTile")}
          </span>
          <span className="text-[11px] text-white/45">
            {STREAM_PRESETS[local.preset].label}
          </span>
        </div>
      ) : null}
      <header className="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/60 to-transparent px-3 py-2.5">
        <LiveBadge onMedia />
        <span className="min-w-0 truncate text-[12px] font-medium text-white">
          {t("streams.yourStream")}
        </span>
        <StreamViewers
          viewers={viewers}
          serverId={serverId}
          testId="stream-viewers-local"
        />
        <span className="ml-auto rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] text-white/80">
          {local.audioPath === "webview" && isDesktop
            ? t("streams.withAudioEcho")
            : local.hasAudio
              ? t("streams.withAudio")
              : t("streams.videoOnly")}
        </span>
        <TileActions
          statsOpen={statsOpen}
          onToggleStats={() => setStatsOpen((open) => !open)}
          onFullscreen={() => void fullscreen.toggle()}
          fullscreen={fullscreen.active}
          label={
            fullscreen.active
              ? t("streams.exitFullscreen")
              : t("streams.fullscreen")
          }
          statsLabel={t("streams.stats")}
        />
      </header>
      <footer className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/60 to-transparent px-3 py-2.5">
        <Button
          size="xs"
          variant="danger"
          className="pointer-events-auto"
          onClick={() => void stop()}
          data-testid="stream-stop"
        >
          <MonitorOff className="size-3" aria-hidden />
          {t("streams.stop")}
        </Button>
        <span className="ml-auto text-[11px] text-white/70">
          {STREAM_PRESETS[local.preset].label}
        </span>
      </footer>
      {statsOpen ? <StatsOverlay stats={local.stats} /> : null}
    </section>
  );
}

type TileState =
  | "idle"
  | "connecting"
  | "waiting"
  | "live"
  | "reconnecting"
  | "failed"
  | "ended";

function tileState(
  user: UserView,
  info: RemoteStreamState | undefined,
  watched: boolean,
  room: StreamEngineSnapshot["room"],
  error: { code: string } | null,
): TileState {
  if (!user.streaming) {
    return watched ? "ended" : "idle";
  }
  if (!watched) {
    return "idle";
  }
  if (error) {
    return "failed";
  }
  if (room === "failed") {
    return "failed";
  }
  if (room === "reconnecting") {
    return "reconnecting";
  }
  if (info?.subscribed && info.videoReady) {
    return "live";
  }
  if (info?.subscribed && info.hasVideo) {
    return "waiting";
  }
  return "connecting";
}

function RemoteTile({
  user,
  info,
  watched,
  room,
  error,
  viewers,
  serverId,
  onWatch,
  onUnwatch,
}: {
  user: UserView;
  info: RemoteStreamState | undefined;
  watched: boolean;
  room: StreamEngineSnapshot["room"];
  error: { code: string } | null;
  viewers: UserView[];
  serverId: string | null;
  onWatch: () => void;
  onUnwatch: () => void;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const watchRef = useRef<HTMLButtonElement>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [restoreFocus, setRestoreFocus] = useState(false);
  const fullscreen = useFullscreen(containerRef);
  const exitFullscreen = fullscreen.exit;
  const fullscreenActive = useRef(fullscreen.active);

  const state = tileState(user, info, watched, room, error);
  const showVideo = state === "live";
  const quality = info?.quality ?? "high";
  const showFooter = watched && user.streaming;

  useEffect(() => {
    fullscreenActive.current = fullscreen.active;
  }, [fullscreen.active]);

  // Leaving the tile (the streamer stopped, the channel changed) must not
  // leave a stale desktop-window fullscreen behind. The room's DOM fullscreen
  // is dropped by the browser when the element goes away; the window needs
  // the explicit call from the hook.
  useEffect(
    () => () => {
      if (fullscreenActive.current) {
        void exitFullscreen();
      }
    },
    [exitFullscreen],
  );

  // After "Stop watching" the stream is still live, so the tile stays with a
  // Watch button. Put keyboard focus there once React has rendered it.
  useEffect(() => {
    if (restoreFocus && !watched && watchRef.current) {
      watchRef.current.focus();
      setRestoreFocus(false);
    }
  }, [restoreFocus, watched]);

  function stopWatching() {
    // Unsubscribe first: the other tile and the room must react immediately.
    onUnwatch();
    if (fullscreen.active) {
      void fullscreen.exit();
    }
    setRestoreFocus(true);
  }

  useEffect(() => {
    streamEngine.attachVideo(user.id, showVideo ? videoRef.current : null);
    return () => streamEngine.attachVideo(user.id, null);
  }, [user.id, showVideo]);

  useEffect(() => {
    streamEngine.attachAudio(user.id, audioRef.current);
    return () => streamEngine.attachAudio(user.id, null);
  }, [user.id]);

  useEffect(() => {
    streamEngine.setVolume(user.id, volume);
  }, [user.id, volume]);

  useEffect(() => {
    streamEngine.setMuted(user.id, muted);
  }, [user.id, muted]);

  useEffect(() => {
    streamEngine.setQuality(user.id, quality);
  }, [user.id, quality]);

  // "Auto" asks for the layer the tile can actually show, in device pixels:
  // a small grid tile gets 720p, a fullscreen one gets the top layer.
  useEffect(() => {
    if (quality !== "auto") {
      return;
    }
    const element = containerRef.current;
    if (!element) {
      return;
    }
    const apply = () => {
      const rect = element.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      streamEngine.setQuality(user.id, "auto", {
        width: rect.width * dpr,
        height: rect.height * dpr,
      });
    };
    apply();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => observer.disconnect();
  }, [user.id, quality]);

  const message =
    state === "idle"
      ? t("streams.watchHint")
      : state === "connecting"
        ? t("streams.stateConnecting")
        : state === "waiting"
          ? t("streams.stateWaiting", { name: user.nickname })
          : state === "reconnecting"
            ? t("streams.stateReconnecting")
            : state === "failed"
              ? t("streams.stateFailed")
              : state === "ended"
                ? t("streams.stateEnded")
                : "";

  return (
    <section
      ref={containerRef}
      data-testid={`stream-${user.id}`}
      data-state={state}
      data-fullscreen={fullscreen.active ? "true" : undefined}
      onDoubleClick={(event) => {
        if (showVideo) {
          void fullscreen.toggle();
          return;
        }
        if (!(event.target instanceof Element) || !event.target.closest("button")) {
          void fullscreen.toggle();
        }
      }}
      className={cn(
        "relative flex aspect-video min-h-[180px] w-full flex-col overflow-hidden rounded-lg bg-black",
        fullscreen.active && "fixed inset-0 z-50 aspect-auto max-w-none rounded-none",
      )}
    >
      {showVideo ? (
        <video
          ref={videoRef}
          playsInline
          autoPlay
          className="min-h-0 flex-1 object-contain"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-3 pb-14 pt-12 text-center">
          <span className="flex size-10 items-center justify-center rounded-full border border-[var(--media-ember-border)] text-[var(--media-ember-ink)]">
            <Cast className="size-5" aria-hidden />
          </span>
          <p className="text-[13px] font-medium text-white">
            {user.nickname}
          </p>
          <p
            data-testid={`stream-state-${user.id}`}
            className="max-w-[240px] text-[11px] text-white/60"
          >
            {message}
          </p>
          {state === "idle" ? (
            <Button
              ref={watchRef}
              size="xs"
              onClick={onWatch}
              data-testid={`watch-${user.id}`}
            >
              {t("streams.watch")}
            </Button>
          ) : null}
          {state === "failed" ? (
            <>
              <p className="max-w-[240px] text-[11px] text-white/45">
                {t("streams.failedHint")}
              </p>
              <Button
                size="xs"
                onClick={onWatch}
                data-testid={`retry-${user.id}`}
              >
                {t("streams.retry")}
              </Button>
            </>
          ) : null}
          {state === "ended" ? (
            <Button
              size="xs"
              variant="secondary"
              onClick={stopWatching}
              data-testid={`close-${user.id}`}
            >
              <X className="size-3" aria-hidden />
              {t("streams.close")}
            </Button>
          ) : null}
        </div>
      )}
      <audio ref={audioRef} className="hidden" />
      <header className="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/60 to-transparent px-3 py-2.5">
        <LiveBadge onMedia />
        <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-black/50 py-0.5 pl-0.5 pr-2">
          <UserAvatar
            name={user.nickname}
            color={user.color}
            avatarHash={user.avatarHash}
            serverId={serverId}
            userId={user.id}
            size="sm"
          />
          <span className="min-w-0 truncate text-[12px] font-medium text-white">
            {user.nickname}
          </span>
        </span>
        <StreamViewers
          viewers={viewers}
          serverId={serverId}
          testId={`stream-viewers-${user.id}`}
        />
        <TileActions
          statsOpen={statsOpen}
          onToggleStats={() => setStatsOpen((open) => !open)}
          onFullscreen={() => void fullscreen.toggle()}
          fullscreen={fullscreen.active}
          label={
            fullscreen.active
              ? t("streams.exitFullscreen")
              : t("streams.fullscreen")
          }
          statsLabel={t("streams.stats")}
        />
      </header>
      {showFooter ? (
        <footer className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-2 bg-gradient-to-t from-black/60 to-transparent px-3 py-2.5">
          <button
            type="button"
            onClick={stopWatching}
            data-testid={`unwatch-${user.id}`}
            aria-label={t("streams.unwatchHint", { name: user.nickname })}
            title={t("streams.unwatchHint", { name: user.nickname })}
            className="pointer-events-auto flex h-6 shrink-0 items-center gap-1 rounded-full bg-white/15 px-2 text-[10px] font-medium text-white transition-colors duration-150 hover:bg-white/25"
          >
            <EyeOff className="size-3" aria-hidden />
            {t("streams.unwatch")}
          </button>
          <Select
            className="pointer-events-auto h-6 max-w-28 rounded-full border-white/25 bg-black/45 px-2 text-[10px] text-white"
            value={quality}
            aria-label={t("streams.quality")}
            data-testid={`stream-quality-${user.id}`}
            onChange={(event) =>
              streamEngine.setQuality(
                user.id,
                event.target.value as StreamQualityMode,
              )
            }
          >
            <option value="high">{t("streams.qualityHigh")}</option>
            <option value="auto">{t("streams.qualityAuto")}</option>
            <option value="low">{t("streams.qualityLow")}</option>
          </Select>
          <span className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-black/45 px-2 py-1">
            <button
              type="button"
              aria-label={muted ? t("streams.unmute") : t("streams.mute")}
              title={muted ? t("streams.unmute") : t("streams.mute")}
              onClick={() => setMuted((value) => !value)}
              className="text-white/80 hover:text-white"
            >
              {muted ? (
                <VolumeX className="size-4" aria-hidden />
              ) : (
                <Volume2 className="size-4" aria-hidden />
              )}
            </button>
            <Slider
              className="h-1 max-w-28"
              min={0}
              max={200}
              step={5}
              value={volume}
              aria-label={t("streams.volume")}
              onChange={(event) => setVolume(Number(event.target.value))}
            />
            <span className="w-8 text-[10px] tabular-nums text-white/70">
              {volume}%
            </span>
          </span>
        </footer>
      ) : null}
      {statsOpen ? <StatsOverlay stats={info?.stats ?? null} /> : null}
    </section>
  );
}

function TileActions({
  statsOpen,
  onToggleStats,
  onFullscreen,
  fullscreen,
  statsLabel,
  label,
}: {
  statsOpen: boolean;
  onToggleStats: () => void;
  onFullscreen: () => void;
  fullscreen: boolean;
  statsLabel: string;
  label: string;
}) {
  return (
    <span className="ml-auto flex items-center gap-1 text-white/85">
      <button
        type="button"
        aria-label={statsLabel}
        title={statsLabel}
        aria-pressed={statsOpen}
        onClick={onToggleStats}
        className="inline-flex size-7 items-center justify-center rounded-sm bg-black/40 hover:bg-white/15 hover:text-white"
      >
        <BarChart3 className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={fullscreen}
        onClick={onFullscreen}
        className="inline-flex size-7 items-center justify-center rounded-sm bg-black/40 hover:bg-white/15 hover:text-white"
      >
        {fullscreen ? (
          <Minimize2 className="size-3.5" aria-hidden />
        ) : (
          <Maximize2 className="size-3.5" aria-hidden />
        )}
      </button>
    </span>
  );
}

function StatsOverlay({ stats }: { stats: StreamStats | null }) {
  const { t } = useTranslation();
  return (
    <dl
      data-testid="stream-stats"
      className="absolute right-2 top-9 grid grid-cols-[auto_auto] gap-x-2 gap-y-0.5 rounded-sm bg-black/70 px-2 py-1.5 text-[11px] text-white/85"
    >
      <dt>{t("streams.statsResolution")}</dt>
      <dd className="tabular-nums">
        {stats?.width && stats?.height
          ? `${stats.width}×${stats.height}`
          : "—"}
      </dd>
      <dt>{t("streams.statsFps")}</dt>
      <dd className="tabular-nums">{stats?.fps?.toFixed(0) ?? "—"}</dd>
      <dt>{t("streams.statsBitrate")}</dt>
      <dd className="tabular-nums">
        {stats?.bitrateKbps ? `${stats.bitrateKbps} kbit/s` : "—"}
      </dd>
      <dt>{t("streams.statsCodec")}</dt>
      <dd className="max-w-28 truncate">
        {stats?.codec?.replace("video/", "") ?? "—"}
      </dd>
      <dt>{t("streams.statsEncoder")}</dt>
      <dd className="max-w-28 truncate">
        {stats?.encoder ?? stats?.decoder ?? "—"}
      </dd>
    </dl>
  );
}
