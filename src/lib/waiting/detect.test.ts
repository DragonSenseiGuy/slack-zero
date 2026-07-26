import { describe, expect, it } from 'vitest';

import {
  classifyAsk,
  describeWait,
  detectWaitingOn,
  NUDGE_THRESHOLD_MS,
  selectNudges,
  stalenessOf,
  type WaitingCandidate,
} from '@/lib/waiting/detect';

/**
 * plan.md, Phase 6 verification 3: "unit test 'waiting on' detection against
 * labeled sample conversations".
 *
 * The labeled set is `ASK_SAMPLES` below — each entry is a message the user
 * sent, hand-labeled with whether it is an ask. Deliberately rule-based rather
 * than model-based (see the note in `detect.ts`), so an exact pass rate is a
 * meaningful assertion rather than a number that drifts between runs the way
 * Phase 3's classification did.
 */

const ME = 'U0BK9FR4Y1M';
const THEM = 'U0BEHBXNGHK';
const NOW = new Date('2026-07-26T14:00:00.000Z');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

let counter = 0;

function message(
  overrides: Partial<WaitingCandidate> = {},
): WaitingCandidate {
  counter += 1;
  return {
    id: `m${counter}`,
    conversationId: 'D0BKMJLRRNH',
    userId: ME,
    text: 'can you take a look at the migration?',
    // Old enough to clear the minimum age by default.
    sentAt: at(-2 * HOUR),
    threadTs: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The labeled set
// ---------------------------------------------------------------------------

/**
 * Hand-labeled. `isAsk` is the human judgement about whether the user would
 * expect a reply. Conservative on purpose: a false positive nags the user to
 * chase something that was never a question, which is how a follow-up feature
 * gets switched off.
 */
const ASK_SAMPLES: ReadonlyArray<{ text: string; isAsk: boolean; note?: string }> =
  [
    // --- genuine asks ---
    { text: 'can you take a look at the migration?', isAsk: true },
    { text: 'could you send over the API key when you get a sec', isAsk: true },
    { text: 'Can you approve the staging access request?', isAsk: true },
    { text: 'need your sign-off on the release notes', isAsk: true },
    { text: 'are you free tomorrow to sync on this?', isAsk: true },
    { text: 'what time works for the retro?', isAsk: true },
    { text: 'please review the PR when you have a moment', isAsk: true },
    { text: 'let me know if the rollout order looks right', isAsk: true },
    { text: 'Would you mind double-checking the config?', isAsk: true },
    { text: 'any chance you could look at the failing test?', isAsk: true },
    { text: 'who owns the analytics pipeline these days?', isAsk: true },
    { text: 'did the nightly job finish or is it still stuck?', isAsk: true },

    // --- not asks ---
    { text: 'thanks!', isAsk: false },
    { text: 'shipped it 🚀', isAsk: false },
    { text: 'how are you?', isAsk: false, note: 'social, not an ask' },
    { text: 'you there?', isAsk: false, note: 'a ping, not a question' },
    { text: 'right?', isAsk: false, note: 'rhetorical' },
    { text: 'lol that deploy was cursed', isAsk: false },
    { text: 'heads up, deploy is going out at 4', isAsk: false },
    { text: 'I fixed the flaky test', isAsk: false },
    { text: 'ok', isAsk: false },
    {
      text: 'the regex is `^can you (.*)\\?$` by the way',
      isAsk: false,
      note: 'an ask-shaped phrase inside code must not count',
    },
  ];

describe('classifyAsk against the labeled set', () => {
  it.each(ASK_SAMPLES.map((s) => [s.text, s.isAsk, s.note ?? ''] as const))(
    'classifies %j as ask=%s %s',
    (text, isAsk) => {
      expect(classifyAsk(text) !== null).toBe(isAsk);
    },
  );

  it('is exactly right on the whole labeled set', () => {
    // Reported as one number so a regression is a single obvious failure.
    const wrong = ASK_SAMPLES.filter(
      (sample) => (classifyAsk(sample.text) !== null) !== sample.isAsk,
    ).map((sample) => `${sample.isAsk ? 'missed' : 'false positive'}: ${sample.text}`);

    expect(wrong).toEqual([]);
  });

  it('labels the kind of ask, for the UI to explain itself', () => {
    expect(classifyAsk('can you approve the staging request?')).toBe(
      'approval_request',
    );
    expect(classifyAsk('are you free tomorrow?')).toBe('scheduling');
    expect(classifyAsk('could you send the key over')).toBe('request');
    // Review and sign-off are the same family as approval: all three are "I
    // cannot proceed until you look at this".
    expect(classifyAsk('can you review the PR?')).toBe('approval_request');
    expect(classifyAsk('who owns the analytics pipeline?')).toBe(
      'direct_question',
    );
  });

  it('ignores a question mark inside a code span or block', () => {
    expect(classifyAsk('`can you do this?`')).toBeNull();
    expect(classifyAsk('```\ncan you do this?\n```')).toBeNull();
  });

  it('finds a real ask even when a social question is also present', () => {
    // Splitting per sentence rather than judging the whole message.
    expect(classifyAsk('hey! how are you? can you review the PR?')).not.toBeNull();
  });

  it('ignores empty and whitespace-only messages', () => {
    expect(classifyAsk('')).toBeNull();
    expect(classifyAsk('   \n  ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Detection over conversations
// ---------------------------------------------------------------------------

describe('detectWaitingOn', () => {
  const options = { authedUserId: ME, now: NOW };

  it('flags an unanswered ask the user sent', () => {
    const ask = message({ text: 'could you send over the deploy logs' });
    const results = detectWaitingOn([ask], options);

    expect(results).toHaveLength(1);
    expect(results[0].messageId).toBe(ask.id);
    expect(results[0].reason).toBe('request');
  });

  it('does not flag someone else’s question', () => {
    // Their question is *our* action item, which is Phase 3's job, not this one.
    expect(
      detectWaitingOn([message({ userId: THEM })], options),
    ).toEqual([]);
  });

  it('clears once the other person replies', () => {
    const ask = message({ text: 'can you review the PR?' });
    const reply = message({
      userId: THEM,
      text: 'looking now',
      sentAt: at(-HOUR),
    });

    expect(detectWaitingOn([ask, reply], options)).toEqual([]);
  });

  it('does NOT clear when the user only follows up themselves', () => {
    // Otherwise every bump would clear the very item it was chasing.
    const ask = message({ text: 'can you review the PR?', sentAt: at(-3 * HOUR) });
    const bump = message({ text: 'any update on this?', sentAt: at(-HOUR) });

    const results = detectWaitingOn([ask, bump], options);
    expect(results.map((r) => r.messageId)).toContain(ask.id);
  });

  it('ignores a reply that predates the ask', () => {
    const earlier = message({ userId: THEM, text: 'hey', sentAt: at(-5 * HOUR) });
    const ask = message({ text: 'can you review the PR?', sentAt: at(-2 * HOUR) });

    expect(detectWaitingOn([earlier, ask], options)).toHaveLength(1);
  });

  it('only counts thread replies as answers to a threaded ask', () => {
    const ask = message({
      text: 'can you review the PR?',
      threadTs: '1784994500.000100',
      sentAt: at(-3 * HOUR),
    });
    // A later message in the channel, but outside the thread.
    const elsewhere = message({
      userId: THEM,
      text: 'unrelated channel chatter',
      threadTs: null,
      sentAt: at(-HOUR),
    });

    expect(detectWaitingOn([ask, elsewhere], options)).toHaveLength(1);

    const inThread = message({
      userId: THEM,
      text: 'on it',
      threadTs: '1784994500.000100',
      sentAt: at(-HOUR),
    });
    expect(detectWaitingOn([ask, elsewhere, inThread], options)).toEqual([]);
  });

  it('does not let a reply in another conversation clear an ask', () => {
    const ask = message({ conversationId: 'D111', sentAt: at(-3 * HOUR) });
    const elsewhere = message({
      conversationId: 'D222',
      userId: THEM,
      sentAt: at(-HOUR),
    });

    expect(detectWaitingOn([ask, elsewhere], options)).toHaveLength(1);
  });

  it('treats a reaction as an answer', () => {
    // A 👍 on "can you approve this?" usually *is* the approval.
    expect(
      detectWaitingOn([message({ hasReactions: true })], options),
    ).toEqual([]);
  });

  it('ignores deleted messages on both sides', () => {
    expect(detectWaitingOn([message({ isDeleted: true })], options)).toEqual([]);

    const ask = message({ sentAt: at(-3 * HOUR) });
    const deletedReply = message({
      userId: THEM,
      sentAt: at(-HOUR),
      isDeleted: true,
    });
    expect(detectWaitingOn([ask, deletedReply], options)).toHaveLength(1);
  });

  it('ignores an ask that was only just sent', () => {
    // Nobody is "waiting" ten seconds in.
    expect(
      detectWaitingOn([message({ sentAt: at(-MINUTE) })], options),
    ).toEqual([]);
  });

  it('returns the stalest ask first', () => {
    const old = message({ text: 'can you review the PR?', sentAt: at(-5 * DAY) });
    const recent = message({ text: 'could you check the logs?', sentAt: at(-DAY) });

    expect(detectWaitingOn([recent, old], options).map((r) => r.messageId)).toEqual(
      [old.id, recent.id],
    );
  });

  it('ignores messages from an unknown author', () => {
    expect(detectWaitingOn([message({ userId: null })], options)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Staleness and nudges
// ---------------------------------------------------------------------------

describe('stalenessOf', () => {
  it('bands the wait rather than reporting an exact number', () => {
    expect(stalenessOf(at(-HOUR), NOW)).toBe('fresh');
    expect(stalenessOf(at(-DAY), NOW)).toBe('aging');
    expect(stalenessOf(at(-3 * DAY), NOW)).toBe('stale');
  });

  it('is inclusive at each boundary', () => {
    expect(stalenessOf(at(-NUDGE_THRESHOLD_MS), NOW)).toBe('stale');
    expect(stalenessOf(at(-DAY), NOW)).toBe('aging');
  });
});

describe('selectNudges', () => {
  const waiting = [
    { messageId: 'old', conversationId: 'D1', askedAt: at(-5 * DAY), reason: 'request' as const },
    { messageId: 'new', conversationId: 'D1', askedAt: at(-HOUR), reason: 'request' as const },
  ];

  it('surfaces only what has gone quiet past the threshold', () => {
    expect(selectNudges(waiting, NOW).map((w) => w.messageId)).toEqual(['old']);
  });

  it('accepts a custom threshold', () => {
    expect(selectNudges(waiting, NOW, MINUTE).map((w) => w.messageId)).toEqual([
      'old',
      'new',
    ]);
  });
});

describe('describeWait', () => {
  it('reads as a staleness indicator', () => {
    expect(describeWait(at(-3 * DAY), NOW)).toBe('asked 3 days ago');
    expect(describeWait(at(-DAY), NOW)).toBe('asked 1 day ago');
    expect(describeWait(at(-2 * HOUR), NOW)).toBe('asked 2 hours ago');
    expect(describeWait(at(-5 * MINUTE), NOW)).toBe('asked 5 minutes ago');
  });

  it('never goes negative for a clock skew', () => {
    expect(describeWait(at(HOUR), NOW)).toBe('asked 1 minute ago');
  });
});
