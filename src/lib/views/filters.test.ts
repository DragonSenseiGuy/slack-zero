import { describe, expect, it } from 'vitest';

import type { QueueItem, QueueReason } from '@/lib/queue/queue';
import {
  applyViewFilters,
  buildView,
  BUILT_IN_VIEWS,
  describeFilters,
  matchesViewFilters,
  parseViewFilters,
  isChronologicalSort,
  nextViewSort,
  sortForView,
  VIEW_LAYOUTS,
  VIEW_SORTS,
  type ViewFilters,
  type ViewSort,
} from '@/lib/views/filters';
import type { MessageTriage, TriageCategory } from '@/lib/triage/types';

/**
 * Filter-matching, tested directly against fixture items
 * (plan.md, Phase 4 verification: "unit test the filter-matching logic directly
 * — given N messages + a filter set, correct subset returned").
 *
 * No database and no React: a view is just data, so this is all pure.
 */

const NOW = Date.parse('2026-07-26T12:00:00.000Z');

function triage(overrides: Partial<MessageTriage> = {}): MessageTriage {
  return {
    urgencyScore: 50,
    category: 'action_needed' as TriageCategory,
    isBump: false,
    bumpOfMessageId: null,
    reason: 'asks you to do a thing',
    model: 'qwen/qwen3-32b',
    classifiedAtIso: '2026-07-26T12:00:00.000Z',
    ...overrides,
  };
}

type ItemOverrides = Partial<QueueItem> & {
  triageOverrides?: Partial<MessageTriage> | null;
};

let counter = 0;

function item(overrides: ItemOverrides = {}): QueueItem {
  counter += 1;
  const { triageOverrides, ...rest } = overrides;
  const hoursAgo = counter;

  return {
    id: `m${counter}`,
    conversationId: 'D0BKMJLRRNH',
    ts: `178493859${counter}.000100`,
    sentAtIso: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
    // Distinct per item by default: these fixtures test filtering and sorting,
    // so each one has to stay its own row unless a test says otherwise.
    burstKey: `burst-${counter}`,
    reason: 'dm' as QueueReason,
    senderId: 'U0BEHBXNGHK',
    senderLabel: 'Dragon Sensei Guy',
    senderAvatarUrl: null,
    isBotSender: false,
    isVipSender: false,
    contextLabel: 'Direct message',
    contextKind: 'IM',
    preview: 'hello',
    body: 'hello',
    isDone: false,
    doneAtIso: null,
    snoozedUntilIso: null,
    snooze: null,
    isWaitingOn: false,
    waitingSinceIso: null,
    threadTs: null,
    isThreadReply: false,
    isThreadParent: false,
    replyCount: 0,
    hasFiles: false,
    isEdited: false,
    reactions: [],
    threadReplies: [],
    triage:
      triageOverrides === null
        ? null
        : triage(triageOverrides ?? {}),
    group: null,
    bumps: null,
    ...rest,
  };
}

function ids(items: readonly QueueItem[]): string[] {
  return items.map((each) => each.id);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('matchesViewFilters with no filters', () => {
  it('keeps an open message', () => {
    expect(matchesViewFilters(item(), {})).toBe(true);
  });

  it('hides a done message by default — inbox zero', () => {
    expect(matchesViewFilters(item({ isDone: true }), {})).toBe(false);
  });

  it('keeps a done message when the view asks for it', () => {
    expect(
      matchesViewFilters(item({ isDone: true }), { includeDone: true }),
    ).toBe(true);
  });

  it('keeps an unclassified message — classification is async', () => {
    // Ingestion never blocks on the classifier (CLAUDE.md), so an unrated
    // message is a normal state, not an error. It must not vanish from a view
    // that did not ask about categories.
    expect(matchesViewFilters(item({ triageOverrides: null }), {})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Individual dimensions
// ---------------------------------------------------------------------------

describe('category filter', () => {
  it('returns exactly the requested categories', () => {
    const action = item({ triageOverrides: { category: 'action_needed' } });
    const fyi = item({ triageOverrides: { category: 'fyi' } });
    const misc = item({ triageOverrides: { category: 'misc' } });

    expect(
      ids(applyViewFilters([action, fyi, misc], { categories: ['action_needed'] })),
    ).toEqual([action.id]);

    expect(
      ids(applyViewFilters([action, fyi, misc], { categories: ['fyi', 'misc'] })),
    ).toEqual([fyi.id, misc.id]);
  });

  it('excludes an unclassified message, since it has no category to match', () => {
    const pending = item({ triageOverrides: null });
    expect(
      applyViewFilters([pending], { categories: ['action_needed'] }),
    ).toEqual([]);
  });

  it('treats an empty array as "no constraint", not "match nothing"', () => {
    // A half-built view in the builder would otherwise render an empty queue
    // and read as broken.
    const items = [item(), item()];
    expect(applyViewFilters(items, { categories: [] })).toHaveLength(2);
  });
});

describe('reason filter', () => {
  it('separates DMs, mentions and threads', () => {
    const dm = item({ reason: 'dm' });
    const mention = item({ reason: 'mention' });
    const thread = item({ reason: 'thread' });
    const all = [dm, mention, thread];

    expect(ids(applyViewFilters(all, { reasons: ['mention'] }))).toEqual([
      mention.id,
    ]);
    expect(ids(applyViewFilters(all, { reasons: ['dm', 'thread'] }))).toEqual([
      dm.id,
      thread.id,
    ]);
  });
});

describe('vipOnly filter', () => {
  it('keeps only messages from a VIP sender', () => {
    const vip = item({ isVipSender: true });
    const ordinary = item({ isVipSender: false });

    expect(ids(applyViewFilters([vip, ordinary], { vipOnly: true }))).toEqual([
      vip.id,
    ]);
  });

  it('does not narrow when false', () => {
    expect(
      applyViewFilters([item({ isVipSender: false })], { vipOnly: false }),
    ).toHaveLength(1);
  });
});

describe('hasBump filter', () => {
  it('keeps only rows that absorbed follow-ups', () => {
    const bumped = item({
      bumps: {
        bumpCount: 2,
        firstAskedAtIso: '2026-07-20T12:00:00.000Z',
        lastBumpedAtIso: '2026-07-25T12:00:00.000Z',
        bumpMessageIds: ['b1', 'b2'],
        peakUrgencyScore: 70,
      },
    });
    const plain = item();

    expect(ids(applyViewFilters([bumped, plain], { hasBump: true }))).toEqual([
      bumped.id,
    ]);
  });
});

describe('classifiedOnly and minUrgency', () => {
  it('classifiedOnly drops rows the classifier has not reached', () => {
    const rated = item();
    const pending = item({ triageOverrides: null });
    expect(
      ids(applyViewFilters([rated, pending], { classifiedOnly: true })),
    ).toEqual([rated.id]);
  });

  it('minUrgency is an inclusive floor', () => {
    const low = item({ triageOverrides: { urgencyScore: 30 } });
    const exact = item({ triageOverrides: { urgencyScore: 60 } });
    const high = item({ triageOverrides: { urgencyScore: 90 } });

    expect(
      ids(applyViewFilters([low, exact, high], { minUrgency: 60 })),
    ).toEqual([exact.id, high.id]);
  });

  it('minUrgency excludes unclassified rows rather than assuming a score', () => {
    // Inventing a score would be indistinguishable from the model having
    // actually judged the message.
    expect(
      applyViewFilters([item({ triageOverrides: null })], { minUrgency: 1 }),
    ).toEqual([]);
  });
});

describe('scope filter', () => {
  it('narrows to one conversation', () => {
    const here = item({ conversationId: 'D111' });
    const elsewhere = item({ conversationId: 'D222' });

    expect(
      ids(
        applyViewFilters([here, elsewhere], {
          scope: { kind: 'conversation', id: 'D111', label: 'DM · Ada' },
        }),
      ),
    ).toEqual([here.id]);
  });

  it('narrows to one person', () => {
    const mine = item({ senderId: 'U111' });
    const theirs = item({ senderId: 'U222' });

    expect(
      ids(
        applyViewFilters([mine, theirs], {
          scope: { kind: 'user', id: 'U111', label: 'Ada' },
        }),
      ),
    ).toEqual([mine.id]);
  });
});

// ---------------------------------------------------------------------------
// Combination — the case plan.md's e2e exercises
// ---------------------------------------------------------------------------

describe('combining filters', () => {
  it('ANDs across dimensions and ORs within one', () => {
    const vipAction = item({
      isVipSender: true,
      triageOverrides: { category: 'action_needed' },
    });
    const vipFyi = item({
      isVipSender: true,
      triageOverrides: { category: 'fyi' },
    });
    const plainAction = item({
      isVipSender: false,
      triageOverrides: { category: 'action_needed' },
    });

    // Two filters at once: this is the shape the Phase 4 e2e test saves.
    const filters: ViewFilters = {
      categories: ['action_needed'],
      vipOnly: true,
    };

    expect(ids(applyViewFilters([vipAction, vipFyi, plainAction], filters))).toEqual(
      [vipAction.id],
    );
  });

  it('still hides done items when other filters match', () => {
    const doneAction = item({
      isDone: true,
      triageOverrides: { category: 'action_needed' },
    });
    expect(
      applyViewFilters([doneAction], { categories: ['action_needed'] }),
    ).toEqual([]);
  });

  it('returns nothing when the filters genuinely exclude everything', () => {
    const misc = item({ triageOverrides: { category: 'misc' } });
    expect(
      applyViewFilters([misc], { categories: ['action_needed'], vipOnly: true }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe('sortForView', () => {
  it('newest and oldest are exact reverses', () => {
    const older = item();
    const newer = item();
    // `item()` ages each fixture by one more hour, so `older` is newer.
    const newest = sortForView([newer, older], 'newest');
    const oldest = sortForView([newer, older], 'oldest');
    expect(ids(newest)).toEqual(ids(oldest).slice().reverse());
  });

  it('urgency puts the highest score first', () => {
    const low = item({ triageOverrides: { urgencyScore: 20 } });
    const high = item({ triageOverrides: { urgencyScore: 95 } });
    expect(ids(sortForView([low, high], 'urgency'))).toEqual([high.id, low.id]);
  });

  it('vip_unread_first lifts open VIP messages above everything', () => {
    const urgentStranger = item({
      isVipSender: false,
      triageOverrides: { urgencyScore: 99 },
    });
    const calmVip = item({
      isVipSender: true,
      triageOverrides: { urgencyScore: 10 },
    });

    expect(
      ids(sortForView([urgentStranger, calmVip], 'vip_unread_first')),
    ).toEqual([calmVip.id, urgentStranger.id]);
  });

  it('vip_unread_first does not lift a VIP message already marked done', () => {
    // "Unread" is our own done state, not Slack's read/unread.
    const doneVip = item({
      isVipSender: true,
      isDone: true,
      triageOverrides: { urgencyScore: 10 },
    });
    const openStranger = item({
      isVipSender: false,
      triageOverrides: { urgencyScore: 50 },
    });

    expect(
      ids(
        sortForView([doneVip, openStranger], 'vip_unread_first'),
      ),
    ).toEqual([openStranger.id, doneVip.id]);
  });

  it('collapses bump chains by default in every sort', () => {
    const original = item({ id: 'original' });
    const bump = item({
      id: 'bump',
      triageOverrides: { isBump: true, bumpOfMessageId: 'original' },
    });

    for (const sort of VIEW_SORTS) {
      expect(sortForView([bump, original], sort), sort).toHaveLength(1);
    }
  });

  it('can be asked not to collapse', () => {
    const original = item({ id: 'original' });
    const bump = item({
      id: 'bump',
      triageOverrides: { isBump: true, bumpOfMessageId: 'original' },
    });
    expect(
      sortForView([bump, original], 'newest', { collapseBumps: false }),
    ).toHaveLength(2);
  });
});

describe('nextViewSort', () => {
  it('reaches every order and returns to where it started', () => {
    // The header control is the only way to change the order now, so a sort it
    // cannot step to is a sort the user cannot choose.
    const seen: string[] = [];
    let sort: ViewSort = VIEW_SORTS[0];
    for (let step = 0; step < VIEW_SORTS.length; step += 1) {
      seen.push(sort);
      sort = nextViewSort(sort);
    }
    expect(new Set(seen)).toEqual(new Set(VIEW_SORTS));
    expect(sort).toBe(VIEW_SORTS[0]);
  });
});

describe('isChronologicalSort', () => {
  it('is true only for the time orders, where day headers make sense', () => {
    expect(isChronologicalSort('newest')).toBe(true);
    expect(isChronologicalSort('oldest')).toBe(true);
    // In urgency order these would read "Today / Older / Today".
    expect(isChronologicalSort('urgency')).toBe(false);
    expect(isChronologicalSort('vip_unread_first')).toBe(false);
  });
});

describe('buildView', () => {
  it('filters before collapsing, so a chain survives its original being filtered out', () => {
    // The original ask is done (so filtered out); the chase must still show
    // rather than the whole chain disappearing.
    const original = item({ id: 'original', isDone: true });
    const bump = item({
      id: 'bump',
      triageOverrides: { isBump: true, bumpOfMessageId: 'original' },
    });

    const rows = buildView([bump, original], {}, 'newest');
    expect(ids(rows)).toEqual(['bump']);
  });
});

// ---------------------------------------------------------------------------
// Persistence edge
// ---------------------------------------------------------------------------

describe('parseViewFilters', () => {
  it('reads a well-formed filter set', () => {
    expect(
      parseViewFilters({ categories: ['fyi'], vipOnly: true }),
    ).toEqual({ categories: ['fyi'], vipOnly: true });
  });

  it('treats null and undefined as no filters', () => {
    expect(parseViewFilters(null)).toEqual({});
    expect(parseViewFilters(undefined)).toEqual({});
  });

  it('degrades to "everything" rather than throwing on corrupt JSON', () => {
    // A row hand-edited in psql, or written by an older build with a filter key
    // since removed, must not crash the inbox. Showing too much is recoverable.
    expect(parseViewFilters({ categories: ['not_a_category'] })).toEqual({});
    expect(parseViewFilters('nonsense')).toEqual({});
    expect(parseViewFilters({ minUrgency: 500 })).toEqual({});
  });

  it('normalizes a null scope away', () => {
    expect(parseViewFilters({ scope: null, vipOnly: true })).toEqual({
      vipOnly: true,
    });
  });

  it('round-trips through JSON, which is how it is actually stored', () => {
    const filters: ViewFilters = {
      categories: ['action_needed'],
      reasons: ['mention'],
      minUrgency: 60,
      scope: { kind: 'conversation', id: 'C1', label: '#general' },
    };
    expect(parseViewFilters(JSON.parse(JSON.stringify(filters)))).toEqual(filters);
  });
});

// ---------------------------------------------------------------------------
// Built-in views
// ---------------------------------------------------------------------------

describe('BUILT_IN_VIEWS', () => {
  it('ships the three views plan.md names, plus Phase 6’s waiting view', () => {
    expect(BUILT_IN_VIEWS.map((view) => view.name)).toEqual([
      'Needs Reply',
      'Waiting Room',
      'Everything',
      // plan.md Phase 6: "separate view" for outstanding asks.
      'Waiting on Others',
    ]);
  });

  it('"Waiting on Others" keeps done items — an ask is still outstanding', () => {
    const waiting = BUILT_IN_VIEWS.find((v) => v.name === 'Waiting on Others');
    const doneButWaiting = item({ isDone: true, isWaitingOn: true });
    const notWaiting = item({ isWaitingOn: false });

    expect(
      ids(applyViewFilters([doneButWaiting, notWaiting], waiting!.filters)),
    ).toEqual([doneButWaiting.id]);
  });

  it('uses only valid layouts, sorts and filters', () => {
    for (const view of BUILT_IN_VIEWS) {
      expect(VIEW_LAYOUTS).toContain(view.layout);
      expect(VIEW_SORTS).toContain(view.sort);
      // Round-trips through the same validator the DB column goes through.
      expect(parseViewFilters(view.filters)).toEqual(view.filters);
    }
  });

  it('"Needs Reply" selects action_needed and nothing else', () => {
    const needsReply = BUILT_IN_VIEWS.find((v) => v.name === 'Needs Reply');
    const action = item({ triageOverrides: { category: 'action_needed' } });
    const fyi = item({ triageOverrides: { category: 'fyi' } });

    expect(
      ids(applyViewFilters([action, fyi], needsReply!.filters)),
    ).toEqual([action.id]);
  });

  it('"Waiting Room" is the fyi/misc pile', () => {
    const waiting = BUILT_IN_VIEWS.find((v) => v.name === 'Waiting Room');
    const action = item({ triageOverrides: { category: 'action_needed' } });
    const fyi = item({ triageOverrides: { category: 'fyi' } });
    const misc = item({ triageOverrides: { category: 'misc' } });

    expect(ids(applyViewFilters([action, fyi, misc], waiting!.filters))).toEqual([
      fyi.id,
      misc.id,
    ]);
  });

  it('"Everything" hides nothing except done items', () => {
    const everything = BUILT_IN_VIEWS.find((v) => v.name === 'Everything');
    const pending = item({ triageOverrides: null });
    const misc = item({ triageOverrides: { category: 'misc' } });
    const done = item({ isDone: true });

    expect(
      applyViewFilters([pending, misc, done], everything!.filters),
    ).toHaveLength(2);
  });
});

describe('describeFilters', () => {
  it('says "Everything" for an empty set', () => {
    expect(describeFilters({})).toBe('Everything');
  });

  it('summarizes a combination', () => {
    expect(
      describeFilters({ categories: ['action_needed'], vipOnly: true }),
    ).toBe('action_needed · VIP only');
  });

  it('mentions a scope by its label', () => {
    expect(
      describeFilters({ scope: { kind: 'user', id: 'U1', label: 'Ada' } }),
    ).toBe('Ada');
  });
});
