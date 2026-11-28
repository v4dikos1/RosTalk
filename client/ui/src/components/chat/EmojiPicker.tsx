import { useVirtualizer } from "@tanstack/react-virtual";
import { Search, Smile } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  filterEmoji,
  groupEmoji,
  type EmojiMatch,
  type EmojiSource,
} from "@/lib/emoji";
import { cn } from "@/lib/utils";

const GRID_COLUMNS = 8;
const CELL_SIZE = 24;
const CELL_GAP = 2;
const ROW_HEIGHT = CELL_SIZE + CELL_GAP;

/**
 * One shared promise for the generated data: the first open starts the
 * dynamic import, every later open reuses it. Keeping it module-level means a
 * closed and reopened picker never fetches or parses the file twice.
 */
let emojiSourcePromise: Promise<EmojiSource> | null = null;

function loadEmojiSource(): Promise<EmojiSource> {
  emojiSourcePromise ??= import("@/lib/emojiData").then((data) => ({
    groups: data.EMOJI_GROUPS,
    keywords: data.EMOJI_KEYWORDS,
  }));
  return emojiSourcePromise;
}

export interface EmojiPickerProps {
  /** Inserts the chosen glyph at the caret of the composer. */
  onSelect: (char: string) => void;
}

/**
 * Full Unicode emoji picker for the message composer (P33).
 *
 * The generated data is imported on the first open, so the composer's initial
 * chunk stays small. Radix Popover owns Escape, outside-click and collision
 * handling; the grid is virtualized by rows, because the set has ~4000
 * entries. Category labels come from i18n; keywords are ru/en data.
 */
export function EmojiPicker({ onSelect }: EmojiPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [source, setSource] = useState<EmojiSource | null>(null);
  const [failed, setFailed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const picked = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);

  useEffect(() => {
    if (!open || source || failed) {
      return;
    }
    let cancelled = false;
    loadEmojiSource().then(
      (loaded) => {
        if (!cancelled) {
          setSource(loaded);
        }
      },
      () => {
        // Let a later open retry instead of caching a rejected promise.
        emojiSourcePromise = null;
        if (!cancelled) {
          setFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, source, failed]);

  const activeGroupId = group ?? source?.groups[0]?.id ?? "";
  const queryText = query.trim();
  const items = useMemo<EmojiMatch[]>(() => {
    if (!source) {
      return [];
    }
    if (queryText.length > 0) {
      return filterEmoji(queryText, source);
    }
    const groupIndex = source.groups.findIndex(
      (item) => item.id === activeGroupId,
    );
    const active = source.groups[groupIndex] ?? source.groups[0];
    return active ? groupEmoji(active, source.keywords, groupIndex) : [];
  }, [source, queryText, activeGroupId]);

  const rowCount = Math.ceil(items.length / GRID_COLUMNS);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual owns its memoization.
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 4,
  });

  // A new query or category starts at the top of the list.
  useEffect(() => {
    setActiveIndex(0);
    virtualizer.scrollToOffset(0);
  }, [queryText, activeGroupId, source, virtualizer]);

  // Arrow navigation may land on a row that was just scrolled in; focus it as
  // soon as the virtualizer has rendered it.
  useEffect(() => {
    if (!pendingFocus.current) {
      return;
    }
    const node = gridRef.current?.querySelector<HTMLButtonElement>(
      `[data-emoji-index="${activeIndex}"]`,
    );
    if (node) {
      pendingFocus.current = false;
      node.focus();
    }
  }, [activeIndex, items]);

  const focusIndex = useCallback(
    (index: number) => {
      if (items.length === 0) {
        return;
      }
      const next = Math.min(items.length - 1, Math.max(0, index));
      pendingFocus.current = true;
      setActiveIndex(next);
      virtualizer.scrollToIndex(Math.floor(next / GRID_COLUMNS), {
        align: "auto",
      });
      // The row may already be mounted; the effect above covers the other case.
      window.requestAnimationFrame(() => {
        const node = gridRef.current?.querySelector<HTMLButtonElement>(
          `[data-emoji-index="${next}"]`,
        );
        if (node) {
          pendingFocus.current = false;
          node.focus();
        }
      });
    },
    [items.length, virtualizer],
  );

  function choose(char: string) {
    picked.current = true;
    onSelect(char);
    setOpen(false);
    setQuery("");
  }

  function onGridKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (items.length === 0) {
      return;
    }
    const moves: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: GRID_COLUMNS,
      ArrowUp: -GRID_COLUMNS,
    };
    if (event.key in moves) {
      event.preventDefault();
      focusIndex(activeIndex + moves[event.key]!);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusIndex(items.length - 1);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          // A failed import is retried on the next open.
          setFailed(false);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("chat.emoji")}
          data-testid="chat-emoji"
        >
          <Smile className="size-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-80 p-2"
        data-testid="emoji-picker"
        onCloseAutoFocus={(event) => {
          // After a pick the composer takes focus; on Escape Radix returns it
          // to the trigger as usual.
          if (picked.current) {
            picked.current = false;
            event.preventDefault();
          }
        }}
      >
        <div className="flex items-center gap-1.5 border-b border-border pb-1.5">
          <Search className="size-3.5 shrink-0 text-faint" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focusIndex(0);
              }
            }}
            placeholder={t("chat.emojiSearch")}
            aria-label={t("chat.emojiSearch")}
            data-testid="emoji-search"
            className="h-7 min-w-0 flex-1 bg-transparent text-[12px] text-foreground placeholder:text-faint focus:outline-none"
          />
        </div>

        {failed ? (
          <p
            role="alert"
            className="px-1 py-3 text-center text-[11px] text-danger"
            data-testid="emoji-load-error"
          >
            {t("chat.emojiLoadFailed")}
          </p>
        ) : source === null ? (
          <p
            role="status"
            className="px-1 py-3 text-center text-[11px] text-faint"
            data-testid="emoji-loading"
          >
            {t("chat.emojiLoading")}
          </p>
        ) : (
          <>
            <div
              role="tablist"
              aria-label={t("chat.emojiCategories")}
              className="mt-1.5 flex gap-0.5 overflow-x-auto pb-1"
              data-testid="emoji-tabs"
            >
              {source.groups.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={queryText.length === 0 && item.id === activeGroupId}
                  data-testid={`emoji-tab-${item.id}`}
                  onClick={() => {
                    setQuery("");
                    setGroup(item.id);
                  }}
                  className={cn(
                    "shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] leading-4",
                    queryText.length === 0 && item.id === activeGroupId
                      ? "bg-hover text-foreground"
                      : "text-faint hover:bg-hover hover:text-foreground",
                  )}
                >
                  {t(`chat.emojiGroups.${item.id}`)}
                </button>
              ))}
            </div>

            {items.length === 0 ? (
              <p className="px-1 py-3 text-center text-[11px] text-faint">
                {t("chat.emojiNoResults")}
              </p>
            ) : (
              <div
                ref={scrollRef}
                role="group"
                aria-label={t("chat.emoji")}
                data-testid="emoji-grid"
                className="mt-1 h-48 overflow-y-auto"
                onKeyDown={onGridKeyDown}
              >
                <div
                  ref={gridRef}
                  className="relative w-full"
                  style={{ height: virtualizer.getTotalSize() }}
                >
                  {virtualizer.getVirtualItems().map((row) => {
                    const start = row.index * GRID_COLUMNS;
                    return (
                      <div
                        key={row.key}
                        className="absolute left-0 top-0 grid w-full grid-cols-8 gap-0.5"
                        style={{
                          height: ROW_HEIGHT,
                          transform: `translateY(${row.start}px)`,
                        }}
                      >
                        {items
                          .slice(start, start + GRID_COLUMNS)
                          .map((item, column) => {
                            const index = start + column;
                            return (
                              <button
                                key={item.char}
                                type="button"
                                data-emoji-button
                                data-emoji-index={index}
                                tabIndex={index === activeIndex ? 0 : -1}
                                aria-label={item.char}
                                data-testid={`emoji-${item.char}`}
                                onClick={() => choose(item.char)}
                                className={cn(
                                  "flex size-6 items-center justify-center rounded-sm text-[15px] leading-none",
                                  "hover:bg-hover focus-visible:bg-hover",
                                )}
                              >
                                {item.char}
                              </button>
                            );
                          })}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
