/**
 * Command palette matching and ranking.
 *
 * Pure and deterministic: the same query against the same entries always
 * produces the same order, which is what makes `⌘K` → type three letters →
 * `Enter` a reflex rather than a gamble.
 *
 * Phase 2 scope is "jump to a channel/person" (plan.md). Saved views join the
 * entry list in Phase 4 — the `kind` field already has room for them.
 */

export type PaletteEntryKind = 'conversation' | 'person' | 'command';

export type PaletteEntry = {
  id: string;
  kind: PaletteEntryKind;
  /** What the user reads and types against, e.g. "#general" or "Ada". */
  label: string;
  /** Secondary line: "12 open", "Direct message", etc. */
  hint?: string;
  /** Extra matchable text that is not displayed (Slack id, username). */
  keywords?: string[];
  /** Sorts entries with equal relevance; higher first. */
  weight?: number;
};

export type ScoredEntry = {
  entry: PaletteEntry;
  score: number;
};

/**
 * Score one entry against a lowercased query.
 *
 * Three tiers, coarse on purpose — a subtle scoring function is impossible to
 * predict and therefore impossible to build muscle memory against:
 *   1000  exact label match
 *    500  label starts with the query
 *    250  label contains the query (minus how far in it starts)
 *    100  a keyword contains it
 *      0  no match (filtered out)
 *
 * Punctuation-insensitive on the leading sigil, so "gen" finds "#general".
 */
export function scoreEntry(entry: PaletteEntry, query: string): number {
  if (query === '') return 1;

  const label = entry.label.toLowerCase();
  const bare = label.replace(/^[#@]/, '');

  if (label === query || bare === query) return 1000;
  if (label.startsWith(query) || bare.startsWith(query)) return 500;

  const index = bare.indexOf(query);
  if (index !== -1) return Math.max(250 - index, 110);

  const keywords = entry.keywords ?? [];
  for (const keyword of keywords) {
    if (keyword.toLowerCase().includes(query)) return 100;
  }

  return 0;
}

/**
 * Filter and rank entries. Ties break on weight, then label, then id, so the
 * result is a total order — a palette whose rows swap places between renders
 * is worse than one that ranks imperfectly.
 */
export function filterPaletteEntries(
  entries: readonly PaletteEntry[],
  rawQuery: string,
  limit = 20,
): PaletteEntry[] {
  const query = rawQuery.trim().toLowerCase();

  const scored: ScoredEntry[] = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, query);
    if (score > 0) scored.push({ entry, score });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const weightA = a.entry.weight ?? 0;
    const weightB = b.entry.weight ?? 0;
    if (weightA !== weightB) return weightB - weightA;
    const labelCompare = a.entry.label.localeCompare(b.entry.label);
    if (labelCompare !== 0) return labelCompare;
    return a.entry.id.localeCompare(b.entry.id);
  });

  return scored.slice(0, limit).map((scoredEntry) => scoredEntry.entry);
}
