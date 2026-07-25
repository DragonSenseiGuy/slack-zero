/**
 * Slack `mrkdwn` → plain text, plus preview/truncation helpers.
 *
 * Why this exists: Slack stores `@ada` as `<@U012ABC>`, `#general` as
 * `<#C012ABC|general>`, and links as `<https://x|label>`. Rendering the stored
 * `text` column straight into the UI would show those raw tokens. This module
 * is the one place that knows the encoding.
 *
 * Deliberately pure — no DB, no React, no clock — so it is unit-testable
 * against fixtures (CLAUDE.md, "Unit test pure logic ... with fixture data").
 * It takes plain lookup maps rather than Prisma rows so nothing Slack- or
 * database-shaped leaks in.
 */

/** Minimal label source for mention resolution. */
export type LabelLookup = {
  /** Slack user id → human label, e.g. "U012ABC" → "Ada Lovelace". */
  users?: ReadonlyMap<string, string>;
  /** Slack conversation id → channel name without the "#". */
  channels?: ReadonlyMap<string, string>;
};

/**
 * Slack escapes exactly three characters in message text, and only these
 * three: `&`, `<`, `>`. Decoding happens *after* token parsing, so a literal
 * "&lt;@U1&gt;" in someone's message is never mistaken for a real mention.
 */
function decodeSlackEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Slack wraps every special token in angle brackets and never nests them, so a
 * non-greedy `<...>` scan with no `<`/`>` inside is a complete parse.
 */
const TOKEN_PATTERN = /<([^<>]*)>/g;

function renderToken(inner: string, lookup: LabelLookup): string {
  // `<@U012ABC>` or `<@U012ABC|display name>`
  if (inner.startsWith('@')) {
    const [idPart, label] = splitOnFirstPipe(inner.slice(1));
    if (label) return `@${label}`;
    const resolved = lookup.users?.get(idPart);
    return `@${resolved ?? idPart}`;
  }

  // `<#C012ABC>` or `<#C012ABC|general>`
  if (inner.startsWith('#')) {
    const [idPart, label] = splitOnFirstPipe(inner.slice(1));
    if (label) return `#${label}`;
    const resolved = lookup.channels?.get(idPart);
    return `#${resolved ?? idPart}`;
  }

  // Specials: `<!here>`, `<!channel>`, `<!everyone>`, `<!subteam^S1|@team>`,
  // and the date token `<!date^1234^{date}|fallback>`.
  if (inner.startsWith('!')) {
    const [command, label] = splitOnFirstPipe(inner.slice(1));
    // The label already carries its own sigil when there is one
    // (`<!subteam^S1|@design>` → "@design"), so it is used verbatim.
    if (label) return label;
    const bare = command.split('^')[0];
    return `@${bare}`;
  }

  // Everything else is a link: `<https://x>` or `<https://x|label>`.
  const [target, label] = splitOnFirstPipe(inner);
  if (label) return label;
  return target.startsWith('mailto:') ? target.slice('mailto:'.length) : target;
}

function splitOnFirstPipe(value: string): [string, string | null] {
  const index = value.indexOf('|');
  if (index === -1) return [value, null];
  return [value.slice(0, index), value.slice(index + 1)];
}

/**
 * Render Slack message text as plain, human-readable text.
 *
 * Formatting markers (`*bold*`, `_italic_`, `` `code` ``) are left as typed —
 * stripping them loses information the author put there, and Phase 2's job is
 * to be fast and legible, not to reimplement Slack's renderer.
 */
export function renderSlackText(
  text: string | null | undefined,
  lookup: LabelLookup = {},
): string {
  if (!text) return '';

  const withTokensResolved = text.replace(TOKEN_PATTERN, (_match, inner) =>
    renderToken(String(inner), lookup),
  );

  return decodeSlackEntities(withTokensResolved);
}

/** Collapse every run of whitespace (including newlines) to a single space. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Truncate to `maxLength`, preferring a word boundary, and append an ellipsis
 * only when something was actually removed.
 */
export function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (text.length <= maxLength) return text;

  const hardCut = text.slice(0, maxLength);
  const lastSpace = hardCut.lastIndexOf(' ');
  // Only honour the word boundary if it isn't throwing away most of the line.
  const cut = lastSpace > maxLength * 0.6 ? hardCut.slice(0, lastSpace) : hardCut;

  return `${cut.trimEnd()}…`;
}

export const DEFAULT_PREVIEW_LENGTH = 140;

/**
 * One-line preview for a list row: rendered, whitespace-collapsed, truncated.
 *
 * `fallback` covers messages whose entire content is a file or an attachment —
 * an empty row in the queue is worse than a placeholder, because the user
 * cannot tell it apart from a rendering bug.
 */
export function buildPreview(
  text: string | null | undefined,
  options: {
    lookup?: LabelLookup;
    maxLength?: number;
    fallback?: string;
  } = {},
): string {
  const {
    lookup = {},
    maxLength = DEFAULT_PREVIEW_LENGTH,
    fallback = '',
  } = options;

  const plain = collapseWhitespace(renderSlackText(text, lookup));
  if (!plain) return fallback;

  return truncate(plain, maxLength);
}
