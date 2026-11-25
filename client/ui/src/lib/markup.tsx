import type { ReactNode } from "react";

/**
 * Safe renderer of the simplified message markup (stage 4.1).
 *
 * Supported: **bold**, *italic*, `inline code`, fenced ``` code ``` blocks and
 * http(s) links. Everything else — including HTML tags and scripts — is plain
 * text. This module never builds HTML strings and never uses
 * `dangerouslySetInnerHTML`, which the security test asserts.
 */

const TOKEN =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(https?:\/\/[^\s<>"']+)/g;

const FENCE = /```(?:\w*\n)?([\s\S]*?)```/g;

export function Markup({ text }: { text: string }) {
  return <>{renderText(text)}</>;
}

function renderText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  FENCE.lastIndex = 0;
  while ((match = FENCE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(...renderInline(text.slice(lastIndex, match.index), `i${key++}`));
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
    nodes.push(...renderInline(text.slice(lastIndex), `i${key}`));
  }
  return nodes;
}

function renderInline(text: string, prefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
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
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
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
