import { describe, expect, it } from 'vitest';

import {
  applyQueueFilters,
  attachThreadReplies,
  buildQueue,
  clampIndex,
  collapseBumpChains,
  compareByRecency,
  compareByUrgency,
  contextLabelFor,
  effectiveUrgency,
  matchesScope,
  moveSelection,
  nextSelectionAfterRemoval,
  queueCounts,
  queueReasonFor,
  resolveBumpRoot,
  senderLabelFor,
  sortQueue,
  threadKey,
  toQueueItem,
  unclassifiedCount,
  userLabel,
  type QueueConversation,
  type QueueItem,
  type QueueMessageRow,
  type QueueUser,
} from '@/lib/queue/queue';
import { bumpStalenessLabel } from '@/lib/queue/time';
import type { MessageTriage, TriageCategory } from '@/lib/triage/types';

/**
 * Fixture-driven, no database and no live Slack. Ids follow the shapes Phase 1
 * actually stores (`U...`, `D...`, `C...`) so the tests read like real data.
 */

const ME = 'U0BK9FR4Y1M';
const PEER = 'U0BEHBXNGHK';
const OTHER = 'U0BZZOTHER1';

const IM: QueueConversation = {
  id: 'D0BKMJLRRNH',
  kind: 'IM',
  name: null,
  peerUserId: PEER,
};

const MPIM: QueueConversation = {
  id: 'G0BMPIM0001',
  kind: 'MPIM',
  name: 'mpdm-a--b--c-1',
  peerUserId: null,
};

const CHANNEL: QueueConversation = {
  id: 'C0BHAPPEN01',
  kind: 'PUBLIC_CHANNEL',
  name: 'happenings',
  peerUserId: null,
};

const USERS = new Map<string, QueueUser>([
  [
    ME,
    {
      id: ME,
      username: 'aditya',
      realName: 'Aditya N',
      displayName: 'adi',
      avatarUrl: 'https://example.com/adi.png',
      isBot: false,
      isVip: false,
    },
  ],
  [
    PEER,
    {
      id: PEER,
      username: 'dsg',
      realName: 'Dragon Sensei Guy',
      displayName: '',
      avatarUrl: null,
      isBot: false,
      isVip: false,
    },
  ],
  [
    OTHER,
    {
      id: OTHER,
      username: 'bot',
      realName: 'Deploy Bot',
      displayName: null,
      avatarUrl: null,
      isBot: true,
      isVip: false,
    },
  ],
]);

const CONVERSATIONS = new Map<string, QueueConversation>([
  [IM.id, IM],
  [MPIM.id, MPIM],
  [CHANNEL.id, CHANNEL],
]);

let rowCounter = 0;

function row(overrides: Partial<QueueMessageRow> = {}): QueueMessageRow {
  rowCounter += 1;
  const conversation = overrides.conversation ?? IM;
  return {
    id: `m${String(rowCounter).padStart(3, '0')}`,
    conversationId: conversation.id,
    ts: `178493859${rowCounter}.000100`,
    sentAt: new Date(Date.UTC(2026, 6, 25, 12, rowCounter)),
    threadTs: null,
    isThreadReply: false,
    isThreadParent: false,
    replyCount: 0,
    userId: PEER,
    authorName: null,
    botId: null,
    subtype: null,
    text: 'hello',
    isEdited: false,
    isDeleted: false,
    hasFiles: false,
    reactions: null,
    mentionedUserIds: [],
    conversation,
    isDone: false,
    doneAt: null,
    triage: null,
    ...overrides,
  };
}

const context = { authedUserId: ME };

// ---------------------------------------------------------------------------

describe('queueReasonFor', () => {
  it('includes a DM from someone else', () => {
    expect(queueReasonFor(row(), context)).toBe('dm');
  });

  it('includes a group DM', () => {
    expect(queueReasonFor(row({ conversation: MPIM }), context)).toBe('dm');
  });

  it('excludes the user’s own messages — you do not triage yourself', () => {
    expect(queueReasonFor(row({ userId: ME }), context)).toBeNull();
  });

  it('excludes soft-deleted messages', () => {
    expect(queueReasonFor(row({ isDeleted: true }), context)).toBeNull();
  });

  it('excludes membership noise even in a DM-shaped conversation', () => {
    expect(
      queueReasonFor(
        row({ conversation: CHANNEL, subtype: 'channel_join' }),
        context,
      ),
    ).toBeNull();
  });

  it('excludes an ordinary channel message that does not mention the user', () => {
    expect(queueReasonFor(row({ conversation: CHANNEL }), context)).toBeNull();
  });

  it('includes a channel message that mentions the user', () => {
    expect(
      queueReasonFor(
        row({ conversation: CHANNEL, mentionedUserIds: [ME] }),
        context,
      ),
    ).toBe('mention');
  });

  it('ignores mentions of other people', () => {
    expect(
      queueReasonFor(
        row({ conversation: CHANNEL, mentionedUserIds: [OTHER] }),
        context,
      ),
    ).toBeNull();
  });

  it('includes a reply in a thread the user participates in', () => {
    const reply = row({
      conversation: CHANNEL,
      threadTs: '1784938500.000100',
      isThreadReply: true,
    });
    expect(
      queueReasonFor(reply, {
        authedUserId: ME,
        participatingThreadKeys: new Set([
          threadKey(CHANNEL.id, '1784938500.000100'),
        ]),
      }),
    ).toBe('thread');
  });

  it('excludes a thread reply in a thread the user is not part of', () => {
    const reply = row({
      conversation: CHANNEL,
      threadTs: '1784938500.000100',
      isThreadReply: true,
    });
    expect(
      queueReasonFor(reply, {
        authedUserId: ME,
        participatingThreadKeys: new Set(),
      }),
    ).toBeNull();
  });

  it('reports a DM thread reply as a thread, not a plain DM', () => {
    const reply = row({
      threadTs: '1784938500.000100',
      isThreadReply: true,
    });
    expect(queueReasonFor(reply, context)).toBe('thread');
  });

  it('reports a thread parent someone else started in my thread as a thread', () => {
    const parent = row({
      conversation: CHANNEL,
      threadTs: '1784938500.000100',
      isThreadParent: true,
      replyCount: 2,
    });
    expect(
      queueReasonFor(parent, {
        authedUserId: ME,
        participatingThreadKeys: new Set([
          threadKey(CHANNEL.id, '1784938500.000100'),
        ]),
      }),
    ).toBe('thread');
  });

  it('still shows DMs when Slack is not connected (no authed user yet)', () => {
    // Before OAuth there is no "me", so nothing can be excluded as self-authored.
    expect(queueReasonFor(row({ userId: ME }), { authedUserId: null })).toBe(
      'dm',
    );
  });
});

describe('labels', () => {
  it('prefers displayName, then realName, then username, then id', () => {
    expect(userLabel(USERS.get(ME))).toBe('adi');
    // PEER has displayName '' — an empty string is not a name.
    expect(userLabel(USERS.get(PEER))).toBe('Dragon Sensei Guy');
    expect(
      userLabel({
        id: 'U1',
        username: 'handle',
        realName: null,
        displayName: null,
        avatarUrl: null,
        isBot: false,
        isVip: false,
      }),
    ).toBe('handle');
    expect(
      userLabel({
        id: 'U1',
        username: null,
        realName: null,
        displayName: null,
        avatarUrl: null,
        isBot: false,
        isVip: false,
      }),
    ).toBe('U1');
    expect(userLabel(null)).toBeNull();
  });

  it('falls back to authorName for a bot message with no User row', () => {
    expect(
      senderLabelFor(
        row({ userId: null, botId: 'B123', authorName: 'GitHub' }),
        USERS,
      ),
    ).toBe('GitHub');
  });

  it('falls back to the bot id when nothing else is known', () => {
    expect(
      senderLabelFor(row({ userId: null, botId: 'B123', authorName: null }), USERS),
    ).toBe('Bot B123');
  });

  it('falls back to the user id when the directory has no row', () => {
    expect(senderLabelFor(row({ userId: 'UGHOST0001' }), USERS)).toBe(
      'UGHOST0001',
    );
  });

  it('names the peer in a DM context label', () => {
    expect(contextLabelFor(IM, USERS)).toBe('DM · Dragon Sensei Guy');
  });

  it('labels an IM generically when the peer is unknown', () => {
    expect(contextLabelFor({ ...IM, peerUserId: null }, USERS)).toBe(
      'Direct message',
    );
  });

  it('does not expose Slack’s machine-generated mpim name', () => {
    expect(contextLabelFor(MPIM, USERS)).toBe('Group DM');
  });

  it('uses #name for channels', () => {
    expect(contextLabelFor(CHANNEL, USERS)).toBe('#happenings');
  });
});

describe('toQueueItem', () => {
  it('renders mentions in the preview and body rather than raw tokens', () => {
    const item = toQueueItem(
      row({ text: `hey <@${ME}> can you look?` }),
      'dm',
      USERS,
      CONVERSATIONS,
    );
    expect(item.preview).toBe('hey @adi can you look?');
    expect(item.body).toBe('hey @adi can you look?');
  });

  it('serializes dates as ISO strings so the item can cross to the client', () => {
    const item = toQueueItem(row(), 'dm', USERS, CONVERSATIONS);
    expect(typeof item.sentAtIso).toBe('string');
    expect(item.sentAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(item.doneAtIso).toBeNull();
  });

  it('substitutes a placeholder for a file-only message', () => {
    const item = toQueueItem(
      row({ text: '', hasFiles: true }),
      'dm',
      USERS,
      CONVERSATIONS,
    );
    expect(item.preview).toBe('(file attachment)');
    expect(item.body).toBe('(file attachment)');
  });

  it('substitutes a placeholder for an empty message with no files', () => {
    const item = toQueueItem(row({ text: '   ' }), 'dm', USERS, CONVERSATIONS);
    expect(item.preview).toBe('(no text)');
  });

  it('carries reactions and the done state through', () => {
    const doneAt = new Date('2026-07-25T12:00:00.000Z');
    const item = toQueueItem(
      row({
        reactions: [{ name: 'eyes', count: 2 }],
        isDone: true,
        doneAt,
      }),
      'dm',
      USERS,
      CONVERSATIONS,
    );
    expect(item.reactions).toEqual([{ name: 'eyes', count: 2 }]);
    expect(item.isDone).toBe(true);
    expect(item.doneAtIso).toBe(doneAt.toISOString());
  });

  it('marks a message from a bot user as a bot sender', () => {
    const item = toQueueItem(row({ userId: OTHER }), 'dm', USERS, CONVERSATIONS);
    expect(item.isBotSender).toBe(true);
  });
});

describe('buildQueue', () => {
  it('drops excluded rows and keeps the rest', () => {
    const rows = [
      row({ text: 'a DM' }),
      row({ userId: ME, text: 'mine' }),
      row({ conversation: CHANNEL, text: 'unrelated channel chatter' }),
      row({
        conversation: CHANNEL,
        mentionedUserIds: [ME],
        text: 'a mention',
      }),
    ];

    const items = buildQueue(rows, {
      ...context,
      users: USERS,
      conversations: CONVERSATIONS,
    });

    expect(items.map((item) => item.preview)).toEqual([
      'a mention',
      'a DM',
    ]);
  });

  it('sorts newest first', () => {
    const older = row({
      sentAt: new Date('2026-07-25T10:00:00.000Z'),
      text: 'older',
    });
    const newer = row({
      sentAt: new Date('2026-07-25T11:00:00.000Z'),
      text: 'newer',
    });

    const items = buildQueue([older, newer], {
      ...context,
      users: USERS,
      conversations: CONVERSATIONS,
    });
    expect(items.map((item) => item.preview)).toEqual(['newer', 'older']);
  });

  it('breaks a same-instant tie on ts, then id — the order is total', () => {
    const sentAt = new Date('2026-07-25T10:00:00.000Z');
    const a = row({ sentAt, ts: '1784938590.000100', id: 'zzz', text: 'a' });
    const b = row({ sentAt, ts: '1784938590.000200', id: 'aaa', text: 'b' });

    const forwards = buildQueue([a, b], { ...context, users: USERS });
    const backwards = buildQueue([b, a], { ...context, users: USERS });

    expect(forwards.map((item) => item.id)).toEqual(['aaa', 'zzz']);
    expect(backwards.map((item) => item.id)).toEqual(forwards.map((i) => i.id));
  });

  it('includes done items — hiding them is a display decision', () => {
    const items = buildQueue(
      [row({ isDone: true, doneAt: new Date() }), row()],
      { ...context, users: USERS },
    );
    expect(items).toHaveLength(2);
    expect(items.some((item) => item.isDone)).toBe(true);
  });

  it('returns an empty queue for an empty input', () => {
    expect(buildQueue([], context)).toEqual([]);
  });
});

describe('compareByRecency', () => {
  it('is a valid comparator: reflexive on equal items', () => {
    const [item] = buildQueue([row()], { ...context, users: USERS });
    expect(compareByRecency(item, item)).toBe(0);
  });
});

describe('attachThreadReplies', () => {
  const parentTs = '1784938500.000100';

  function threadFixture() {
    const parent = row({
      conversation: CHANNEL,
      ts: parentTs,
      threadTs: parentTs,
      isThreadParent: true,
      replyCount: 2,
      mentionedUserIds: [ME],
      text: 'kicking off',
    });
    const replyOne = row({
      conversation: CHANNEL,
      ts: '1784938600.000100',
      threadTs: parentTs,
      isThreadReply: true,
      text: 'second',
    });
    const replyTwo = row({
      conversation: CHANNEL,
      ts: '1784938550.000100',
      threadTs: parentTs,
      isThreadReply: true,
      text: 'first',
    });
    return { parent, replyOne, replyTwo };
  }

  it('hangs replies off the parent, oldest first', () => {
    const { parent, replyOne, replyTwo } = threadFixture();
    const items = buildQueue([parent], { ...context, users: USERS });

    const withThread = attachThreadReplies(
      items,
      [replyOne, replyTwo],
      USERS,
      CONVERSATIONS,
    );

    expect(withThread[0].threadReplies.map((reply) => reply.body)).toEqual([
      'first',
      'second',
    ]);
  });

  it('never includes the parent in its own reply list', () => {
    const { parent } = threadFixture();
    const items = buildQueue([parent], { ...context, users: USERS });
    const withThread = attachThreadReplies(items, [parent], USERS);
    expect(withThread[0].threadReplies).toEqual([]);
  });

  it('skips deleted replies', () => {
    const { parent, replyOne } = threadFixture();
    const items = buildQueue([parent], { ...context, users: USERS });
    const withThread = attachThreadReplies(
      items,
      [{ ...replyOne, isDeleted: true }],
      USERS,
    );
    expect(withThread[0].threadReplies).toEqual([]);
  });

  it('leaves a reply item’s own threadReplies empty, so siblings do not duplicate', () => {
    const { replyOne, replyTwo } = threadFixture();
    const items = buildQueue([replyOne], {
      authedUserId: ME,
      participatingThreadKeys: new Set([threadKey(CHANNEL.id, parentTs)]),
      users: USERS,
    });
    expect(items[0].reason).toBe('thread');

    const withThread = attachThreadReplies(items, [replyTwo], USERS);
    expect(withThread[0].threadReplies).toEqual([]);
  });

  it('is a no-op when there are no replies', () => {
    const items = buildQueue([row()], { ...context, users: USERS });
    expect(attachThreadReplies(items, [], USERS)).toEqual(items);
  });
});

// ---------------------------------------------------------------------------

function itemFixture(overrides: Partial<QueueItem>): QueueItem {
  const [base] = buildQueue([row()], { ...context, users: USERS });
  return { ...base, ...overrides };
}

describe('applyQueueFilters', () => {
  const open = itemFixture({ id: 'open', isDone: false });
  const done = itemFixture({ id: 'done', isDone: true });

  it('hides done items by default — inbox zero is the default behaviour', () => {
    expect(applyQueueFilters([open, done]).map((item) => item.id)).toEqual([
      'open',
    ]);
  });

  it('reveals done items when asked', () => {
    expect(
      applyQueueFilters([open, done], { includeDone: true }).map((i) => i.id),
    ).toEqual(['open', 'done']);
  });

  it('narrows to a conversation scope', () => {
    const elsewhere = itemFixture({
      id: 'elsewhere',
      conversationId: CHANNEL.id,
    });
    expect(
      applyQueueFilters([open, elsewhere], {
        scope: { kind: 'conversation', id: CHANNEL.id, label: '#happenings' },
      }).map((item) => item.id),
    ).toEqual(['elsewhere']);
  });

  it('narrows to a person scope by sender', () => {
    const fromOther = itemFixture({ id: 'other', senderId: OTHER });
    expect(
      applyQueueFilters([open, fromOther], {
        scope: { kind: 'user', id: OTHER, label: 'Deploy Bot' },
      }).map((item) => item.id),
    ).toEqual(['other']);
  });

  it('combines scope and done filtering', () => {
    const doneHere = itemFixture({
      id: 'doneHere',
      isDone: true,
      conversationId: CHANNEL.id,
    });
    const openHere = itemFixture({ id: 'openHere', conversationId: CHANNEL.id });
    const scope = {
      kind: 'conversation' as const,
      id: CHANNEL.id,
      label: '#happenings',
    };

    expect(
      applyQueueFilters([open, doneHere, openHere], { scope }).map((i) => i.id),
    ).toEqual(['openHere']);
    expect(
      applyQueueFilters([open, doneHere, openHere], {
        scope,
        includeDone: true,
      }).map((item) => item.id),
    ).toEqual(['doneHere', 'openHere']);
  });

  it('matches everything when there is no scope', () => {
    expect(matchesScope(open, null)).toBe(true);
    expect(matchesScope(open, undefined)).toBe(true);
  });
});

describe('queueCounts', () => {
  it('counts open and done within the active scope', () => {
    const items = [
      itemFixture({ id: '1', isDone: false }),
      itemFixture({ id: '2', isDone: true }),
      itemFixture({ id: '3', isDone: false, conversationId: CHANNEL.id }),
    ];

    expect(queueCounts(items)).toEqual({ open: 2, done: 1, total: 3 });
    expect(
      queueCounts(items, {
        kind: 'conversation',
        id: CHANNEL.id,
        label: '#happenings',
      }),
    ).toEqual({ open: 1, done: 0, total: 1 });
  });

  it('handles an empty queue', () => {
    expect(queueCounts([])).toEqual({ open: 0, done: 0, total: 0 });
  });
});

describe('selection arithmetic', () => {
  it('clamps into range and tolerates an empty list', () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(1, 3)).toBe(1);
    expect(clampIndex(4, 0)).toBe(0);
  });

  it('stops at the ends rather than wrapping', () => {
    // Wrapping in a triage queue means "j at the bottom starts you over",
    // which is disorienting; stopping means "you are done".
    expect(moveSelection(0, -1, 5)).toBe(0);
    expect(moveSelection(4, 1, 5)).toBe(4);
    expect(moveSelection(2, 1, 5)).toBe(3);
    expect(moveSelection(2, -1, 5)).toBe(1);
    expect(moveSelection(0, 1, 0)).toBe(0);
  });

  it('keeps the cursor in place when an item is removed under it', () => {
    // 5 items, cursor on index 2, mark it done -> 4 remain, cursor stays on 2,
    // which is now the item that was below it. `e e e` triages a run.
    expect(nextSelectionAfterRemoval(2, 4)).toBe(2);
  });

  it('steps back when the last item is removed', () => {
    expect(nextSelectionAfterRemoval(4, 4)).toBe(3);
  });

  it('collapses to zero when the list empties', () => {
    expect(nextSelectionAfterRemoval(0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: bump collapsing and urgency sort
// ---------------------------------------------------------------------------

/**
 * plan.md, Phase 3 verification: "a 3-message bump chain should appear as 1
 * item showing 'first asked X days ago'". These are the tests for that claim.
 */

const NOW_ISO = '2026-07-25T12:00:00.000Z';

function triage(overrides: Partial<MessageTriage> = {}): MessageTriage {
  return {
    urgencyScore: 50,
    category: 'action_needed' as TriageCategory,
    isBump: false,
    bumpOfMessageId: null,
    reason: 'asks you to do a thing',
    model: 'qwen/qwen3-32b',
    classifiedAtIso: NOW_ISO,
    ...overrides,
  };
}

/** A queue item at an explicit age, so staleness assertions are exact. */
function item(
  id: string,
  daysAgo: number,
  triageOverrides: Partial<MessageTriage> | null,
  text = 'text',
): QueueItem {
  const sentAt = new Date(
    Date.parse(NOW_ISO) - daysAgo * 24 * 60 * 60 * 1000,
  );
  return {
    ...toQueueItem(
      row({
        id,
        text,
        sentAt,
        ts: `${Math.floor(sentAt.getTime() / 1000)}.000100`,
        triage: triageOverrides === null ? null : triage(triageOverrides),
      }),
      'dm',
      USERS,
      CONVERSATIONS,
    ),
    id,
  };
}

describe('resolveBumpRoot', () => {
  it('walks a chase-of-a-chase back to the original ask', () => {
    const links = new Map([
      ['bump2', 'bump1'],
      ['bump1', 'original'],
    ]);
    expect(resolveBumpRoot('bump2', links)).toBe('original');
    expect(resolveBumpRoot('original', links)).toBe('original');
  });

  it('does not hang on a cycle the model could invent', () => {
    // A model is perfectly capable of claiming A bumps B and B bumps A.
    const links = new Map([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(['a', 'b']).toContain(resolveBumpRoot('a', links));
  });

  it('stops at a link we do not hold rather than throwing', () => {
    expect(resolveBumpRoot('x', new Map([['x', 'gone']]))).toBe('gone');
  });
});

describe('collapseBumpChains', () => {
  it('folds a 3-message bump chain into 1 item kept at the original ask', () => {
    const original = item('original', 5, {}, 'can you review the migration?');
    const bump1 = item('bump1', 2, { isBump: true, bumpOfMessageId: 'original' }, 'any update on this?');
    const bump2 = item('bump2', 1, { isBump: true, bumpOfMessageId: 'bump1' }, 'gentle ping');

    const collapsed = collapseBumpChains([bump2, bump1, original]);

    expect(collapsed).toHaveLength(1);

    const [only] = collapsed;
    // The survivor is the original ask, not the latest chase — that is what
    // makes the recency sort show staleness instead of treating a bump as new.
    expect(only.id).toBe('original');
    expect(only.body).toBe('can you review the migration?');
    expect(only.bumps).not.toBeNull();
    expect(only.bumps?.bumpCount).toBe(2);
    expect(only.bumps?.bumpMessageIds).toEqual(['bump1', 'bump2']);
    expect(only.bumps?.firstAskedAtIso).toBe(only.sentAtIso);
  });

  it('labels the collapsed row with how long the original has been waiting', () => {
    const original = item('original', 5, {});
    const bump1 = item('bump1', 2, { isBump: true, bumpOfMessageId: 'original' });
    const bump2 = item('bump2', 1, { isBump: true, bumpOfMessageId: 'bump1' });

    const [only] = collapseBumpChains([bump2, bump1, original]);
    const summary = only.bumps;
    if (!summary) throw new Error('expected a bump summary');

    // The literal string plan.md asks for.
    expect(bumpStalenessLabel(summary.firstAskedAtIso, NOW_ISO)).toBe(
      'first asked 5 days ago',
    );
    // And the chase itself is recorded, so "bumped twice, last yesterday" is
    // renderable without going back to the database.
    expect(summary.lastBumpedAtIso).toBe(bump2.sentAtIso);
  });

  it('leaves an unrelated message alone', () => {
    const original = item('original', 5, {});
    const bump = item('bump', 2, { isBump: true, bumpOfMessageId: 'original' });
    const unrelated = item('unrelated', 3, {});

    const collapsed = collapseBumpChains([bump, unrelated, original]);

    expect(collapsed).toHaveLength(2);
    expect(collapsed.map((each) => each.id).sort()).toEqual([
      'original',
      'unrelated',
    ]);
    expect(
      collapsed.find((each) => each.id === 'unrelated')?.bumps,
    ).toBeNull();
  });

  it('carries the peak urgency of the chain, not just the original score', () => {
    // The chase is where the urgency escalated ("this is blocking the release").
    // Collapsing must not hide that behind the original's calmer score.
    const original = item('original', 5, { urgencyScore: 30 });
    const bump = item('bump', 1, {
      isBump: true,
      bumpOfMessageId: 'original',
      urgencyScore: 85,
    });

    const [only] = collapseBumpChains([bump, original]);
    expect(only.bumps?.peakUrgencyScore).toBe(85);
    expect(effectiveUrgency(only)).toBe(85);
  });

  it('stands in the oldest survivor when the original is gone', () => {
    // The original was marked done, or a scope filtered it out. The chain must
    // not vanish with it.
    const bump1 = item('bump1', 2, { isBump: true, bumpOfMessageId: 'missing' });
    const bump2 = item('bump2', 1, { isBump: true, bumpOfMessageId: 'bump1' });

    const collapsed = collapseBumpChains([bump2, bump1]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].id).toBe('bump1');
  });

  it('is a no-op when nothing is a bump', () => {
    const items = [item('a', 1, {}), item('b', 2, null)];
    const collapsed = collapseBumpChains(items);
    expect(collapsed).toHaveLength(2);
    expect(collapsed.every((each) => each.bumps === null)).toBe(true);
  });

  it('does not treat a bump with no target as folding into anything', () => {
    // `is_bump: true` with `bump_of: null` — the model saw a chase but could not
    // name the original. One row must stay one row.
    const lone = item('lone', 1, { isBump: true, bumpOfMessageId: null });
    expect(collapseBumpChains([lone])).toHaveLength(1);
  });
});

describe('sortQueue', () => {
  it('orders by urgency, then by category, then by recency', () => {
    const low = item('low', 1, { urgencyScore: 10 });
    const high = item('high', 3, { urgencyScore: 90 });
    const mid = item('mid', 2, { urgencyScore: 50 });

    const sorted = sortQueue([low, high, mid], { mode: 'urgency' });
    expect(sorted.map((each) => each.id)).toEqual(['high', 'mid', 'low']);
  });

  it('breaks an urgency tie with action_needed ahead of fyi and misc', () => {
    const misc = item('misc', 1, { urgencyScore: 40, category: 'misc' });
    const action = item('action', 1, {
      urgencyScore: 40,
      category: 'action_needed',
    });
    const fyi = item('fyi', 1, { urgencyScore: 40, category: 'fyi' });

    const sorted = sortQueue([misc, fyi, action], { mode: 'urgency' });
    expect(sorted.map((each) => each.id)).toEqual(['action', 'fyi', 'misc']);
  });

  it('collapses chains in recency mode so a chase does not resurface the item', () => {
    const original = item('original', 5, {});
    const bump = item('bump', 0, { isBump: true, bumpOfMessageId: 'original' });
    const other = item('other', 2, {});

    const sorted = sortQueue([bump, other, original], { mode: 'recency' });

    // Without collapsing, `bump` (today) would sit at the top. With it, the
    // chain is represented by the 5-day-old original, which sorts *below* the
    // 2-day-old message — staleness surfaced rather than newness faked.
    expect(sorted.map((each) => each.id)).toEqual(['other', 'original']);
  });

  it('can be asked not to collapse', () => {
    const original = item('original', 5, {});
    const bump = item('bump', 1, { isBump: true, bumpOfMessageId: 'original' });

    const sorted = sortQueue([bump, original], {
      mode: 'recency',
      collapseBumps: false,
    });
    expect(sorted).toHaveLength(2);
  });

  it('sorts unclassified messages after classified ones without dropping them', () => {
    // Classification is async (CLAUDE.md), so the queue is always rendered with
    // some rows not yet classified. They must still be reachable.
    const classified = item('classified', 2, { urgencyScore: 70 });
    const pending = item('pending', 1, null);

    const sorted = sortQueue([pending, classified], { mode: 'urgency' });
    expect(sorted.map((each) => each.id)).toEqual(['classified', 'pending']);
    expect(unclassifiedCount(sorted)).toBe(1);
  });
});

describe('compareByUrgency', () => {
  it('is a total order, so the queue does not jitter between renders', () => {
    const a = item('a', 1, { urgencyScore: 50 });
    const b = item('b', 1, { urgencyScore: 50 });
    expect(compareByUrgency(a, b)).toBe(-compareByUrgency(b, a));
    expect(compareByUrgency(a, a)).toBe(0);
  });
});
