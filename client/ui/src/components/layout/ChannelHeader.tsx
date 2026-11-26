import {
  Hash,
  LogIn,
  MonitorOff,
  MonitorUp,
  PanelRight,
  PanelRightClose,
  Volume2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { LiveBadge } from "@/components/streams/LiveBadge";
import { Button } from "@/components/ui/button";
import type { ChannelView } from "@/core/api";

const channelIcon = {
  text: Hash,
  voice: Volume2,
} as const;

export interface ChannelHeaderProps {
  channel: ChannelView;
  memberCount: number;
  connected: boolean;
  onJoin: () => void;
  /** Live screen shares of channel members. */
  streamingCount?: number;
  /** The caller's own screen share is live in this channel. */
  selfStreaming?: boolean;
  onWatchStreams?: () => void;
  onStartStream?: () => void;
  onStopStream?: () => void;
  /** Right-hand member pane (stage P8). */
  membersOpen?: boolean;
  onToggleMembers?: () => void;
}

/**
 * Channel identity and its actions.
 *
 * The groups wrap instead of overlapping: a long name or topic, several live
 * streams, the participant counter and the buttons each keep their own space
 * (playtest-2, complaint 3). The leave action is not here — it is part of the
 * voice group in the sidebar.
 */
export function ChannelHeader({
  channel,
  memberCount,
  connected,
  onJoin,
  streamingCount = 0,
  selfStreaming = false,
  onWatchStreams,
  onStartStream,
  onStopStream,
  membersOpen = false,
  onToggleMembers,
}: ChannelHeaderProps) {
  const { t } = useTranslation();
  const Icon = channelIcon[channel.kind];
  const liveLabel = `${t("streams.live")} ${streamingCount}`;
  const topic = channel.topic || t("main.noTopic");
  const members = `${t("main.members", { count: memberCount })}${
    channel.userLimit > 0 ? ` / ${channel.userLimit}` : ""
  }`;

  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2">
      <div className="flex min-w-[220px] flex-1 items-center gap-2">
        <Icon className="size-4 shrink-0 text-faint" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <h2
              className="min-w-0 max-w-full truncate text-[15px] font-medium text-foreground"
              title={channel.name}
            >
              {channel.name}
            </h2>
            {connected ? (
              <span
                data-testid="channel-you-are-here"
                className="flex shrink-0 items-center gap-1 text-[11px] text-muted"
              >
                <span
                  className="size-1.5 rounded-full bg-accent"
                  aria-hidden
                />
                {t("channel.connected")}
              </span>
            ) : null}
            {streamingCount > 0 ? (
              <button
                type="button"
                data-testid="channel-live"
                onClick={onWatchStreams}
                aria-label={liveLabel}
                title={liveLabel}
                className="flex shrink-0 items-center rounded-md transition-opacity duration-150 hover:opacity-80"
              >
                <LiveBadge count={streamingCount} />
              </button>
            ) : null}
            {channel.passwordProtected ? (
              <span className="shrink-0 text-[10px] text-faint">
                {t("tree.locked")}
              </span>
            ) : null}
          </div>
          <p
            className="truncate text-[12px] text-faint"
            title={topic}
          >
            {topic}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        <span data-testid="channel-members" className="text-[12px] text-faint">
          {members}
        </span>

        {channel.kind === "voice" ? (
          connected ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={selfStreaming ? onStopStream : onStartStream}
                data-testid="toggle-stream"
              >
                {selfStreaming ? (
                  <MonitorOff className="size-3.5" aria-hidden />
                ) : (
                  <MonitorUp className="size-3.5" aria-hidden />
                )}
                <span className="hidden sm:inline">
                  {selfStreaming ? t("streams.stop") : t("streams.start")}
                </span>
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={onJoin} data-testid="join-channel">
              <LogIn className="size-3.5" aria-hidden />
              {t("channel.join")}
            </Button>
          )
        ) : null}

        {onToggleMembers ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={membersOpen ? t("members.hide") : t("members.show")}
            title={membersOpen ? t("members.hide") : t("members.show")}
            aria-pressed={membersOpen}
            onClick={onToggleMembers}
            data-testid="toggle-members"
          >
            {membersOpen ? (
              <PanelRightClose className="size-4" aria-hidden />
            ) : (
              <PanelRight className="size-4" aria-hidden />
            )}
          </Button>
        ) : null}
      </div>
    </header>
  );
}
