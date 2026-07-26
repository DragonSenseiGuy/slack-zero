import { z } from 'zod';

import {
  compareByRecency,
  compareByUrgency,
  collapseBumpChains,
  matchesScope,
  type QueueItem,
  type QueueReason,
  type QueueScope,
} from '@/lib/queue/queue';
import { TRIAGE_CATEGORIES, type TriageCategory } from '@/lib/triage/types';

/**
 * Saved-view filters and sorts (plan.md, Phase 4).
 *
 * Pure: no Prisma, no React, no clock. A view is data — a name, a layout, a
 * filter set and a sort — so the thing worth testing is `matchesViewFilters`,
 * and it is testable directly against fixture items with no database
 * (plan.md, Phase 4 verification: "unit test the filter-matching logic
 * directly").
 *
 * `ViewDefinition.filters` is a Json column deliberately: the filter vocabulary
 * will keep growing (Phase 6 adds snoozed/waiting-on) and migrating a column per
 * checkbox would be absurd. The cost of that choice is that the JSON is
 * untrusted, so `viewFiltersSchema` validates at the edge — nothing constructs a
 * `ViewFilters` without going through it.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Why a message is in the queue at all. Mirrors Phase 1/2's `QueueReason`. */
export const VIEW_REASONS = ['dm', 'mention', 'thread'] as const;
export type ViewReason = (typeof VIEW_REASONS)[number];

export const REASON_LABEL: Record<ViewReason, string> = {
  dm: 'DMs',
  mention: 'Mentions',
  thread: 'Threads',
};

export const VIEW_LAYOUTS = ['detailed', 'dense'] as const;
export type ViewLayout = (typeof VIEW_LAYOUTS)[number];

export const LAYOUT_LABEL: Record<ViewLayout, string> = {
  detailed: 'Detailed',
  dense: 'Dense',
};

export const VIEW_SORTS = [
  'newest',
  'oldest',
  'urgency',
  'vip_unread_first',
] as const;
export type ViewSort = (typeof VIEW_SORTS)[number];

export const SORT_LABEL: Record<ViewSort, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  urgency: 'Urgency',
  vip_unread_first: 'VIP unreads on top',
};

/**
 * A filter set.
 *
 * Every field is optional and an omitted field means "do not narrow on this".
 * An *empty array* means the same thing as omitted, not "match nothing" — a
 * half-built view in the builder UI would otherwise show an empty queue and
 * read as broken.
 */
export type ViewFilters = {
  /** Triage categories to include. Empty/omitted = all categories. */
  categories?: TriageCategory[];
  /** Queue reasons to include. Empty/omitted = all reasons. */
  reasons?: ViewReason[];
  /** True = only collapsed bump chains. False/omitted = no constraint. */
  hasBump?: boolean;
  /** True = only messages from a VIP sender. */
  vipOnly?: boolean;
  /** True = only messages that have been classified. */
  classifiedOnly?: boolean;
  /** Inclusive urgency floor, 0-100. */
  minUrgency?: number;
  /** False (default) is inbox-zero behaviour: done items are hidden. */
  includeDone?: boolean;
  /** Restrict to one conversation or one person. */
  scope?: QueueScope | null;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const scopeSchema = z.union([
  z.object({
    kind: z.literal('conversation'),
    id: z.string().min(1),
    label: z.string(),
  }),
  z.object({
    kind: z.literal('user'),
    id: z.string().min(1),
    label: z.string(),
  }),
]);

export const viewFiltersSchema = z.object({
  categories: z.array(z.enum(TRIAGE_CATEGORIES)).optional(),
  reasons: z.array(z.enum(VIEW_REASONS)).optional(),
  hasBump: z.boolean().optional(),
  vipOnly: z.boolean().optional(),
  classifiedOnly: z.boolean().optional(),
  minUrgency: z.number().int().min(0).max(100).optional(),
  includeDone: z.boolean().optional(),
  scope: scopeSchema.nullish(),
});

export const viewLayoutSchema = z.enum(VIEW_LAYOUTS);
export const viewSortSchema = z.enum(VIEW_SORTS);

/**
 * Read a `filters` Json column into a `ViewFilters`.
 *
 * Returns `{}` — "no narrowing" — rather than throwing when the stored JSON is
 * unreadable. A view row corrupted by hand, or written by an older build with a
 * since-removed filter key, should degrade to showing everything. Showing too
 * much is recoverable by the user; a crashing inbox is not.
 */
export function parseViewFilters(value: unknown): ViewFilters {
  const parsed = viewFiltersSchema.safeParse(value ?? {});
  if (!parsed.success) return {};
  // `scope: null | undefined` both mean unscoped; normalize to undefined so the
  // shape is stable for equality checks in the builder.
  const { scope, ...rest } = parsed.data;
  return scope ? { ...rest, scope } : rest;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Empty and omitted both mean "no constraint" — see the note on ViewFilters. */
function unconstrained<T>(values: readonly T[] | undefined): boolean {
  return values === undefined || values.length === 0;
}

/**
 * Does one item belong in a view?
 *
 * Filters combine with AND across dimensions and OR within a dimension: two
 * categories means "either of these", but a category plus `vipOnly` means
 * "both". That is what plan.md's example view ("Needs Reply" = action_needed,
 * not done) needs, and it is the behaviour a checkbox UI implies.
 */
export function matchesViewFilters(
  item: QueueItem,
  filters: ViewFilters = {},
): boolean {
  if (!filters.includeDone && item.isDone) return false;

  if (!matchesScope(item, filters.scope)) return false;

  if (filters.vipOnly && !item.isVipSender) return false;

  if (filters.hasBump === true && item.bumps === null) return false;

  if (filters.classifiedOnly && item.triage === null) return false;

  if (!unconstrained(filters.reasons)) {
    // `QueueReason` and `ViewReason` are the same strings; the cast keeps the
    // two vocabularies nominally separate without a runtime map.
    if (!(filters.reasons as QueueReason[]).includes(item.reason)) return false;
  }

  if (!unconstrained(filters.categories)) {
    // An unclassified message has no category, so it cannot satisfy a
    // category filter. It is not silently dropped from *unfiltered* views —
    // only from ones that ask about a dimension it does not have yet.
    const category = item.triage?.category;
    if (!category || !filters.categories?.includes(category)) return false;
  }

  if (filters.minUrgency !== undefined) {
    const score = item.triage?.urgencyScore;
    if (score === undefined || score < filters.minUrgency) return false;
  }

  return true;
}

export function applyViewFilters(
  items: readonly QueueItem[],
  filters: ViewFilters = {},
): QueueItem[] {
  return items.filter((item) => matchesViewFilters(item, filters));
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * VIP unreads on top, then everything else by urgency.
 *
 * "Unread" here means not-done — our own triage state, not Slack's read/unread
 * (Phase 2 keeps those deliberately separate).
 */
function compareVipUnreadFirst(a: QueueItem, b: QueueItem): number {
  const priorityA = a.isVipSender && !a.isDone ? 0 : 1;
  const priorityB = b.isVipSender && !b.isDone ? 0 : 1;
  if (priorityA !== priorityB) return priorityA - priorityB;
  return compareByUrgency(a, b);
}

const COMPARATORS: Record<ViewSort, (a: QueueItem, b: QueueItem) => number> = {
  newest: compareByRecency,
  oldest: (a, b) => -compareByRecency(a, b),
  urgency: compareByUrgency,
  vip_unread_first: compareVipUnreadFirst,
};

export type SortForViewOptions = {
  /**
   * Bump collapsing stays on by default in every view, as in Phase 3: a chain
   * showing as three rows is the clutter the feature exists to remove,
   * regardless of which view you are looking at.
   */
  collapseBumps?: boolean;
};

export function sortForView(
  items: readonly QueueItem[],
  sort: ViewSort,
  options: SortForViewOptions = {},
): QueueItem[] {
  const rows =
    options.collapseBumps === false
      ? items.map((item) => ({ ...item }))
      : collapseBumpChains(items);

  return rows.sort(COMPARATORS[sort]);
}

/**
 * Filter, then collapse and sort — in that order.
 *
 * The order matters and is the same as Phase 2's: collapsing after filtering
 * lets a chain whose original ask is filtered out still appear under its oldest
 * surviving follow-up, instead of the whole chain vanishing.
 */
export function buildView(
  items: readonly QueueItem[],
  filters: ViewFilters,
  sort: ViewSort,
  options: SortForViewOptions = {},
): QueueItem[] {
  return sortForView(applyViewFilters(items, filters), sort, options);
}

// ---------------------------------------------------------------------------
// Built-in views
// ---------------------------------------------------------------------------

export type ViewSpec = {
  name: string;
  layout: ViewLayout;
  filters: ViewFilters;
  sort: ViewSort;
  position: number;
};

/**
 * A persisted view, in the shape a client component can hold.
 *
 * Serializable on purpose — this crosses the server → client boundary, so no
 * `Date`s and nothing Prisma-shaped.
 */
export type SavedView = ViewSpec & {
  id: string;
  /** Shipped out of the box; cannot be deleted (it would be re-seeded). */
  isBuiltIn: boolean;
};

/**
 * The three views plan.md ships out of the box.
 *
 * "Waiting Room" is the FYI/misc pile — things worth having seen but not worth
 * interrupting for. Note it deliberately does *not* set `classifiedOnly`: a
 * message still waiting on the async classifier belongs in "Everything", and
 * hiding it from every built-in view would make ingestion look broken while
 * classification catches up.
 */
export const BUILT_IN_VIEWS: readonly ViewSpec[] = [
  {
    name: 'Needs Reply',
    layout: 'detailed',
    filters: { categories: ['action_needed'] },
    sort: 'urgency',
    position: 0,
  },
  {
    name: 'Waiting Room',
    layout: 'dense',
    filters: { categories: ['fyi', 'misc'] },
    sort: 'newest',
    position: 1,
  },
  {
    name: 'Everything',
    layout: 'detailed',
    filters: {},
    sort: 'urgency',
    position: 2,
  },
] as const;

export const DEFAULT_VIEW_NAME = 'Everything';

/** Human summary of a filter set, for the sidebar and the builder. */
export function describeFilters(filters: ViewFilters): string {
  const parts: string[] = [];

  if (!unconstrained(filters.categories)) {
    parts.push(filters.categories!.join(' or '));
  }
  if (!unconstrained(filters.reasons)) {
    parts.push(filters.reasons!.map((r) => REASON_LABEL[r]).join(' or '));
  }
  if (filters.vipOnly) parts.push('VIP only');
  if (filters.hasBump) parts.push('bumped');
  if (filters.classifiedOnly) parts.push('classified');
  if (filters.minUrgency !== undefined) {
    parts.push(`urgency ≥ ${filters.minUrgency}`);
  }
  if (filters.scope) parts.push(filters.scope.label);
  if (filters.includeDone) parts.push('including done');

  return parts.length === 0 ? 'Everything' : parts.join(' · ');
}
