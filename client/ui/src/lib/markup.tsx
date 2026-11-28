import type { ReactNode } from "react";

/**
 * Safe renderer of the simplified message markup (stage 4.1).
 *
 * Supported: **bold**, *italic*, `inline code`, fenced ``` code ``` blocks,
 * http(s) links and confirmed `@mentions`. Everything else — including HTML
 * tags and scripts — is plain text. This module never builds HTML strings and
 * never uses `dangerouslySetInnerHTML`, which the security test asserts.
 */

const TOKEN =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(https?:\/\/[^\s<>"']+)/g;

const FENCE = /```(?:\w*\n)?([\s\S]*?)```/g;

/** Same boundaries as the server's mention resolver. */
const MENTION_BOUNDARY_BEFORE = /[\s([{<,;:.!?]/;
const MENTION_WORD_AFTER = /[\p{L}\p{N}_-]/u;

type MentionClick = (userId: number, clientX: number, clientY: number) => void;

interface MentionEntry {
  /** Lowercase nickname. */
  name: string;
  id: number;
}

export interface MarkupProps {
  text: string;
  /**
   * Lowercase nickname to a confirmed user id. Only ids the server actually
   * recorded for this message belong here; unknown `@name` stays plain text.
   */
  mentions?: ReadonlyMap<string, number>;
  /** Opens the user menu for a confirmed mention. */
  onMentionClick?: MentionClick;
}

export function Markup({ text, mentions, onMentionClick }: MarkupProps) {
  const entries = mentionEntries(mentions, onMentionClick);
  return <>{renderText(text, entries, onMentionClick)}</>;
}

/** Longest nickname first, so "@Anna Maria" wins over "@Anna". */
function mentionEntries(
  mentions: ReadonlyMap<string, number> | undefined,
  onMentionClick: MentionClick | undefined,
): MentionEntry[] {
  if (!mentions || !onMentionClick) {
    return [];
  }
  const entries: MentionEntry[] = [];
  for (const [nickname, id] of mentions) {
    const name = nickname.trim().toLowerCase();
    if (name) {
      entries.push({ name, id });
    }
  }
  return entries.sort((a, b) => b.name.length - a.name.length);
}

function renderText(
  text: string,
  entries: MentionEntry[],
  onMentionClick: MentionClick | undefined,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  FENCE.lastIndex = 0;
  while ((match = FENCE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(
        ...renderInline(
          text.slice(lastIndex, match.index),
          `i${key++}`,
          entries,
          onMentionClick,
        ),
      );
    }
    nodes.push(
      <pre
        key={`pre${key++}`}
        className="my-1 overflow-x-auto rounded-sm border border-border bg-background px-2 py-1.5 text-[12px] leading-relaxed"
      >
        <code>{(match[1] ?? "").replace(/\n$/, "")}</code>
      </pre>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(
      ...renderInline(
        text.slice(lastIndex),
        `i${key}`,
        entries,
        onMentionClick,
      ),
    );
  }
  return nodes;
}

function renderInline(
  text: string,
  prefix: string,
  entries: MentionEntry[],
  onMentionClick: MentionClick | undefined,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let plain = 0;
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(
        ...renderPlain(
          text.slice(lastIndex, match.index),
          `${prefix}-p${plain++}`,
          entries,
          onMentionClick,
        ),
      );
    }
    const token = match[0];
    const id = `${prefix}-${key++}`;
    if (match[1]) {
      nodes.push(
        <code
          key={id}
          className="rounded-sm border border-border bg-raised px-1 py-px font-mono text-[12px]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      nodes.push(<strong key={id}>{token.slice(2, -2)}</strong>);
    } else if (match[3]) {
      nodes.push(<em key={id}>{token.slice(1, -1)}</em>);
    } else if (match[4]) {
      nodes.push(<em key={id}>{token.slice(1, -1)}</em>);
    } else {
      const { url, trailing } = splitTrailingPunctuation(token);
      // Only http(s) reaches this branch; any other scheme is plain text.
      nodes.push(
        <a
          key={id}
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          {url}
        </a>,
      );
      if (trailing) {
        nodes.push(trailing);
      }
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    nodes.push(
      ...renderPlain(
        text.slice(lastIndex),
        `${prefix}-p${plain}`,
        entries,
        onMentionClick,
      ),
    );
  }
  return nodes;
}

/**
 * Splits one plain segment into text and confirmed mention buttons.
 *
 * Mentions are matched against the known nicknames, not against a guessed
 * character class: nicknames may contain spaces, so the map is the truth. A
 * mention needs the same boundary before `@` and after the name as the server,
 * which keeps `mail@host` and `@Ann` (for "Anna") plain.
 */
function renderPlain(
  text: string,
  prefix: string,
  entries: MentionEntry[],
  onMentionClick: MentionClick | undefined,
): ReactNode[] {
  if (entries.length === 0 || !onMentionClick || !text.includes("@")) {
    return [text];
  }
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  let at = text.indexOf("@");
  while (at !== -1) {
    if (at >= cursor) {
      const before = at > 0 ? text[at - 1] : "";
      if (
        before === undefined ||
        before === "" ||
        MENTION_BOUNDARY_BEFORE.test(before)
      ) {
        const mention = matchMention(text, at, entries);
        if (mention) {
          if (at > cursor) {
            nodes.push(text.slice(cursor, at));
          }
          const label = text.slice(at, at + 1 + mention.length);
          nodes.push(
            <button
              key={`${prefix}-m${key++}`}
              type="button"
              data-mention-id={mention.id}
              onClick={(event) =>
                onMentionClick(mention.id, event.clientX, event.clientY)
              }
              className="rounded-sm font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              {label}
            </button>,
          );
          cursor = at + 1 + mention.length;
          at = text.indexOf("@", cursor);
          continue;
        }
      }
    }
    at = text.indexOf("@", at + 1);
  }
  if (cursor === 0) {
    return [text];
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

/** The longest known nickname that starts here, if it ends at a boundary. */
function matchMention(
  text: string,
  at: number,
  entries: MentionEntry[],
): { id: number; length: number } | null {
  for (const entry of entries) {
    const end = at + 1 + entry.name.length;
    if (end > text.length) {
      continue;
    }
    if (text.slice(at + 1, end).toLowerCase() !== entry.name) {
      continue;
    }
    const after = end < text.length ? text[end] : "";
    if (after && MENTION_WORD_AFTER.test(after)) {
      continue;
    }
    return { id: entry.id, length: entry.name.length };
  }
  return null;
}

const TRAILING = /[.,;:!?)\]}]+$/;

function splitTrailingPunctuation(url: string): { url: string; trailing: string } {
  const match = TRAILING.exec(url);
  if (!match) {
    return { url, trailing: "" };
  }
  return {
    url: url.slice(0, match.index),
    trailing: match[0],
  };
}
