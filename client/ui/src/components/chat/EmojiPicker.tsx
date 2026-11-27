import { Search, Smile } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { filterEmoji } from "@/lib/emoji";
import { cn } from "@/lib/utils";

const GRID_COLUMNS = 8;

export interface EmojiPickerProps {
  /** Inserts the chosen glyph at the caret of the composer. */
  onSelect: (char: string) => void;
}

/**
 * Compact built-in emoji picker for the message composer (P31).
 *
 * No dependency and no network: the list lives in `lib/emoji`. Radix Popover
 * owns Escape, outside-click and collision handling. Focus returns to the
 * trigger on Escape and to the composer after a pick; the composer decides
 * where the caret goes.
 */
export function EmojiPicker({ onSelect }: EmojiPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const picked = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => filterEmoji(query), [query]);

  function choose(char: string) {
    picked.current = true;
    onSelect(char);
    setOpen(false);
    setQuery("");
  }

  function moveFocus(offset: number) {
    const buttons = Array.from(
      gridRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-emoji-button]",
      ) ?? [],
    );
    if (buttons.length === 0) {
      return;
    }
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const next = Math.min(
      buttons.length - 1,
      Math.max(0, (current === -1 ? 0 : current) + offset),
    );
    buttons[next]?.focus();
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
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
        className="w-64 p-2"
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
                moveFocus(1);
              }
            }}
            placeholder={t("chat.emojiSearch")}
            aria-label={t("chat.emojiSearch")}
            data-testid="emoji-search"
            className="h-7 min-w-0 flex-1 bg-transparent text-[12px] text-foreground placeholder:text-faint focus:outline-none"
          />
        </div>
        {results.length === 0 ? (
          <p className="px-1 py-3 text-center text-[11px] text-faint">
            {t("chat.emojiNoResults")}
          </p>
        ) : (
          <div
            ref={gridRef}
            role="group"
            aria-label={t("chat.emoji")}
            data-testid="emoji-grid"
            className="mt-1.5 grid max-h-44 grid-cols-8 gap-0.5 overflow-y-auto"
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault();
                moveFocus(1);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                moveFocus(-1);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                moveFocus(GRID_COLUMNS);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveFocus(-GRID_COLUMNS);
              } else if (event.key === "Home") {
                event.preventDefault();
                moveFocus(-results.length);
              } else if (event.key === "End") {
                event.preventDefault();
                moveFocus(results.length);
              }
            }}
          >
            {results.map((entry) => (
              <button
                key={entry.char}
                type="button"
                data-emoji-button
                aria-label={entry.char}
                data-testid={`emoji-${entry.char}`}
                onClick={() => choose(entry.char)}
                className={cn(
                  "flex size-6 items-center justify-center rounded-sm text-[15px] leading-none",
                  "hover:bg-hover focus-visible:bg-hover",
                )}
              >
                {entry.char}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
