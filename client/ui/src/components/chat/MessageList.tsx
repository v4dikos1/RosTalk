import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { coreApi } from "@/core";
import type { ChatTarget } from "@/core/api";
import { conversationKey } from "@/lib/chat";
import { buildFeedRows, readAnchor } from "@/lib/chatFeed";
import type { DayLabel } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";
import { useCoreStore } from "@/store/coreStore";
import { runCoreAction } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

import { MessageItem } from "./MessageItem";

export interface MessageListProps {
  target: ChatTarget;
  canManage: boolean;
  /**
   * False while the chat is mounted but hidden behind another tab. The real
   * browser drops the scroll offset of a `display: none` scroller, so the
   * feed captures it when it becomes hidden and restores it when shown.
   */
  active?: boolean;
}

/**
 * Virtualized message feed.
 *
 * Older pages are requested by cursor when the viewport approaches the top;
 * the scroll position is kept stable while a page is prepended. New messages
 * scroll into view only when the reader is already at the bottom or wrote the
 * message themselves.
 *
 * The read anchor is captured once, when the feed opens (see `readAnchor`).
 */
export function MessageList({
  target,
  canManage,
  active = true,
}: MessageListProps) {
  const { t } = useTranslation();
  const key = conversationKey(target);
  const conversation = useChatStore((state) => state.conversations[key]);
  const proxy = useChatStore((state) => state.proxy);
  const ensureLoaded = useChatStore((state) => state.ensureLoaded);
  const loadOlder = useChatStore((state) => state.loadOlder);
  const markRead = useChatStore((state) => state.markRead);
  const state = useCoreStore((store) => store.state);
  const locale = useSettingsStore((store) => store.settings?.locale ?? "ru");
  const selfUserId = state?.selfUserId ?? 0;
  const serverId = state?.server?.id ?? null;
  const unread = state?.unread;

  // The "read up to" anchor is frozen while this conversation is open. The
  // live counter keeps moving as messages are read; following it moved the
  // separator on every message (playtest-1, complaint 7).
  const anchor = useRef<number | null>(null);
  if (anchor.current === null && state) {
    anchor.current = readAnchor(unread, target);
  }
  const lastReadMessageId = anchor.current ?? 0;

  const parentRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const previousCount = useRef(0);
  // Set only when the feed is about to be hidden; restoring it by hand is the
  // only reliable way across `display: none` (P31 tab switch).
  const savedOffset = useRef<number | null>(null);
  const visible = useRef(active);
  // The tab switch commits `display: none` after this render, so the last
  // visible offset has to be read here, before the browser drops it. Scrolling
  // itself does not need to update the ref: the next hide captures the value.
  if (active !== visible.current) {
    const element = parentRef.current;
    if (!active && element && element.clientHeight > 0) {
      savedOffset.current = element.scrollTop;
    }
    visible.current = active;
  }
  const messages = useMemo(
    () => conversation?.messages ?? [],
    [conversation?.messages],
  );
  const rows = useMemo(
    () => buildFeedRows(messages, lastReadMessageId, locale),
    [messages, lastReadMessageId, locale],
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual owns its memoization.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 84,
    overscan: 10,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  // `display: none` drops the offset of a real browser scroller, and the
  // virtualizer measures a zero-height viewport while the streams tab is open.
  // Restore before paint, then retry for a few frames until the measured rows
  // give the scroller enough height to accept the offset (P31).
  useLayoutEffect(() => {
    if (!active) {
      return;
    }
    const element = parentRef.current;
    if (!element) {
      return;
    }
    const offset = savedOffset.current;
    const atBottom = nearBottom.current;
    // A first page that finished while hidden has no captured offset, and a
    // feed that sat at its lower edge should follow messages that arrived in
    // the meantime. Only a scrolled-up feed gets its exact offset back.
    if (offset === null || atBottom) {
      if (conversation?.loaded && rows.length > 0) {
        const frame = requestAnimationFrame(() => {
          virtualizer.measure();
          virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
          nearBottom.current = true;
        });
        return () => cancelAnimationFrame(frame);
      }
      if (offset === null) {
        return;
      }
    }
    let frame = 0;
    let attempts = 0;
    const restore = () => {
      element.scrollTop = offset;
      if (Math.abs(element.scrollTop - offset) > 1 && attempts < 20) {
        attempts += 1;
        virtualizer.measure();
        frame = requestAnimationFrame(restore);
      }
    };
    restore();
    return () => cancelAnimationFrame(frame);
    // The loaded rows are read on the show transition only; adding them would
    // re-run the effect on every delivered message and fight the reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, virtualizer]);

  const stale = conversation?.stale ?? false;
  useEffect(() => {
    // A hidden chat must not load (and acknowledge) history behind the streams
    // tab. The effect runs again when the tab becomes active (P31).
    if (!active) {
      return;
    }
    // A reconnect marks the cache stale: the open conversation reloads its
    // first page and merges it instead of leaving a silent gap.
    if (stale || !conversation?.loaded) {
      void ensureLoaded(target);
    }
  }, [active, ensureLoaded, key, target, stale, conversation?.loaded]);

  // Scroll to the newest row after the first page arrives. If the page lands
  // while the feed is hidden, the show-time layout effect above takes over.
  useEffect(() => {
    if (!active) {
      return;
    }
    if (conversation?.loaded && rows.length > 0) {
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
        nearBottom.current = true;
      });
    }
    // Only the first successful load matters here; a later show is handled by
    // the restore effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.loaded, key]);

  // A read marker only moves while the feed is visible and at its lower edge.
  // Reading history must not clear the unread counter of messages the user has
  // not reached yet; a hidden feed must not clear messages the user has not
  // seen, and returning at the bottom acknowledges what arrived meanwhile.
  const newestId = messages.at(-1)?.id ?? 0;
  useEffect(() => {
    if (!active || !newestId || !nearBottom.current || document.hidden) {
      return;
    }
    void markRead(target, newestId);
  }, [active, newestId, target, markRead]);

  useEffect(() => {
    const onVisibility = () => {
      if (
        active &&
        !document.hidden &&
        nearBottom.current &&
        newestId > 0
      ) {
        void markRead(target, newestId);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [active, markRead, newestId, target]);

  // Auto-scroll on messages that arrive after the page was shown. A hidden
  // feed does not move; the show-time layout effect puts it back or follows
  // the newest row.
  useEffect(() => {
    const count = messages.length;
    if (!active) {
      previousCount.current = count;
      return;
    }
    if (count > previousCount.current && previousCount.current > 0) {
      const newest = messages[count - 1];
      if (nearBottom.current || newest?.senderId === selfUserId) {
        requestAnimationFrame(() => {
          virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
        });
      }
    }
    previousCount.current = count;
  }, [active, messages, rows.length, selfUserId, virtualizer]);

  const onScroll = useCallback(() => {
    const element = parentRef.current;
    if (!element) {
      return;
    }
    const distanceToBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    const wasNearBottom = nearBottom.current;
    nearBottom.current = distanceToBottom < 120;
    if (
      active &&
      !wasNearBottom &&
      nearBottom.current &&
      newestId > 0 &&
      !document.hidden
    ) {
      void markRead(target, newestId);
    }
    if (element.scrollTop < 100 && conversation?.hasMore && !conversation.loading) {
      const before = element.scrollHeight;
      void loadOlder(target).then(() => {
        // Keep the reading position: the prepended page grows the content
        // above the viewport, so add the same amount to scrollTop.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const after = element.scrollHeight;
            element.scrollTop += after - before;
          });
        });
      });
    }
  }, [
    active,
    conversation?.hasMore,
    conversation?.loading,
    loadOlder,
    target,
    newestId,
    markRead,
  ]);

  if (!conversation) {
    return <MessageSkeleton label={t("chat.loadingSkeleton")} />;
  }

  if (conversation.error && messages.length === 0) {
    const title =
      conversation.error === "access"
        ? t("chat.errorAccess")
        : conversation.error === "unreachable"
          ? t("chat.errorUnreachable")
          : t("chat.errorLoad");
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
        data-testid="chat-error"
        data-error={conversation.error}
      >
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        <p className="text-[12px] text-muted">{t("chat.errorHint")}</p>
        <Button size="sm" onClick={() => void ensureLoaded(target)}>
          {t("chat.retry")}
        </Button>
      </div>
    );
  }

  if (!conversation.loaded && messages.length === 0) {
    return <MessageSkeleton label={t("chat.loadingSkeleton")} />;
  }

  if (conversation.loaded && messages.length === 0) {
    return (
      <EmptyState
        className="flex-1"
        title={t("chat.emptyConversationTitle")}
        description={t("chat.emptyConversationHint")}
      />
    );
  }

  return (
    <div
      ref={parentRef}
      onScroll={onScroll}
      tabIndex={0}
      role="region"
      aria-label={t("chat.messagesLabel")}
      className="chat-surface flex min-h-0 flex-1 flex-col overflow-y-auto bg-background select-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      data-testid="message-list"
      data-conversation={key}
    >
      {conversation.loading && messages.length > 0 ? (
        <div className="flex items-center justify-center gap-1.5 py-2 text-[11px] text-faint">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          {t("chat.loadingOlder")}
        </div>
      ) : null}
      <div
        data-testid="message-column"
        className="relative mt-auto w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) {
            return null;
          }
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className={cn("absolute left-0 top-0 w-full")}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.kind === "date" ? (
                <DaySeparator label={row.label} />
              ) : row.kind === "new" ? (
                <FeedSeparator tone="accent" text={t("chat.newMessages")} />
              ) : (
                <MessageItem
                  message={row.message}
                  continued={row.continued}
                  selfUserId={selfUserId}
                  authorColor={
                    state?.users.find((user) => user.id === row.message.senderId)
                      ?.color ?? null
                  }
                  authorAvatarHash={
                    state?.users.find((user) => user.id === row.message.senderId)
                      ?.avatarHash ?? ""
                  }
                  serverId={serverId}
                  proxy={proxy}
                  canManage={canManage}
                  onEdit={async (messageId, body) => {
                    await runCoreAction(() =>
                      coreApi.editMessage(messageId, body),
                    );
                  }}
                  onDelete={async (messageId) => {
                    await runCoreAction(() => coreApi.deleteMessage(messageId));
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One separator in the feed: a date, or the unread boundary. The date is quiet
 * neutral text between two lines; only the unread boundary takes the accent.
 */
function FeedSeparator({
  text,
  tone = "neutral",
}: {
  text: string;
  tone?: "neutral" | "accent";
}) {
  const accent = tone === "accent";
  return (
    <div
      role="separator"
      aria-label={text}
      data-testid={accent ? "new-messages-line" : "date-separator"}
      className="flex items-center gap-2 px-3 py-2"
    >
      <span
        aria-hidden
        className={cn("h-px flex-1", accent ? "bg-accent/40" : "bg-border")}
      />
      <span
        className={cn(
          "shrink-0 text-[11px] font-medium leading-none",
          accent ? "text-accent" : "text-faint",
        )}
      >
        {text}
      </span>
      <span
        aria-hidden
        className={cn("h-px flex-1", accent ? "bg-accent/40" : "bg-border")}
      />
    </div>
  );
}

function MessageSkeleton({ label }: { label: string }) {
  return (
    <div
      className="flex flex-1 flex-col gap-3 p-3"
      data-testid="message-skeleton"
      aria-busy="true"
    >
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex animate-pulse gap-2.5" aria-hidden>
          <div className="size-7 shrink-0 rounded-lg bg-active" />
          <div className="flex-1 space-y-1.5 pt-0.5">
            <div className="h-2 w-24 rounded-full bg-active" />
            <div className="h-2 w-3/4 rounded-full bg-active/80" />
            <div className="h-2 w-1/2 rounded-full bg-active/60" />
          </div>
        </div>
      ))}
      <p className="sr-only">{label}</p>
    </div>
  );
}

function DaySeparator({ label }: { label: DayLabel }) {
  const { t } = useTranslation();
  let text: string;
  if (label.kind === "date") {
    text = label.text;
  } else {
    text = label.kind === "today" ? t("chat.today") : t("chat.yesterday");
  }
  return <FeedSeparator text={text} />;
}
