import type { ClassificationContext } from '@/lib/triage/prompt';
import type { TriageCategory } from '@/lib/triage/types';

/**
 * A hand-labeled sample set for measuring classification quality
 * (plan.md, Phase 3 verification: "unit tests with a fixed set of sample
 * messages (hand-labeled expected category/urgency) — track classification
 * accuracy against this labeled set").
 *
 * How this is used, and why it is shaped this way:
 *
 *  - `expected` is a human judgement written *before* seeing what the model
 *    said. It is the ground truth.
 *  - `recorded` is the model's actual raw reply, captured from a live run of
 *    `npm run triage:eval` against `qwen/qwen3-32b`. It is committed so that
 *    `classify.test.ts` can score real model output with **no network access**
 *    (CLAUDE.md: unit tests must not hit live APIs).
 *  - Re-running `npm run triage:eval` refreshes the recordings. If accuracy
 *    moves, that is a real signal about the model or the prompt, and the diff
 *    shows exactly which messages changed their mind.
 *
 * Urgency is checked as a *range*, not a number: CLAUDE.md allows tolerance on
 * the score but not on the category, so the category assertions are strict and
 * the urgency assertions are band-width.
 *
 * `ambiguous: true` marks cases where reasonable humans disagree. They are
 * reported separately and excluded from the pass/fail threshold — counting a
 * genuine coin-flip as a model failure would make the accuracy number a lie in
 * the other direction.
 */

export const FIXTURE_NOW_ISO = '2026-07-25T17:00:00.000Z';

const ME = 'adi';

type FixtureInput = {
  text: string;
  senderLabel?: string;
  contextLabel?: string;
  isDirectMessage?: boolean;
  mentionsMe?: boolean;
  isThreadReply?: boolean;
  /** Minutes before `FIXTURE_NOW_ISO`. */
  ageMinutes?: number;
  previous?: Array<{ id: string; text: string; ageMinutes: number }>;
};

export type LabeledMessage = {
  id: string;
  /** Short human name, used in the accuracy report. */
  label: string;
  context: ClassificationContext;
  expected: {
    category: TriageCategory;
    /** Inclusive [min, max] the score must land in. */
    urgency: [number, number];
    isBump: boolean;
  };
  ambiguous?: boolean;
  note?: string;
  /** Raw model reply, captured live. Regenerate with `npm run triage:eval`. */
  recorded?: string;
};

function at(ageMinutes: number): string {
  return new Date(
    Date.parse(FIXTURE_NOW_ISO) - ageMinutes * 60_000,
  ).toISOString();
}

function context(input: FixtureInput): ClassificationContext {
  return {
    text: input.text,
    senderLabel: input.senderLabel ?? 'Dragon Sensei Guy',
    contextLabel: input.contextLabel ?? 'DM · Dragon Sensei Guy',
    isDirectMessage: input.isDirectMessage ?? true,
    mentionsMe: input.mentionsMe ?? false,
    isThreadReply: input.isThreadReply ?? false,
    sentAtIso: at(input.ageMinutes ?? 30),
    nowIso: FIXTURE_NOW_ISO,
    previous: (input.previous ?? []).map((previous) => ({
      id: previous.id,
      text: previous.text,
      sentAtIso: at(previous.ageMinutes),
    })),
  };
}

export const LABELED_MESSAGES: LabeledMessage[] = [
  {
    id: 'direct-question',
    label: 'DM asking a direct question',
    context: context({
      text: 'Hey, can you send me the staging DB credentials when you get a sec?',
    }),
    expected: { category: 'action_needed', urgency: [30, 65], isBump: false },
    recorded:
      '{"category": "action_needed", "urgency_score": 25, "is_bump": false, "bump_of": null, "reason": "Asks for staging DB credentials"}',
  },
  {
    id: 'prod-outage',
    label: 'production outage, reader is on the hook',
    context: context({
      text: `@${ME} checkout is returning 500s in prod right now and we think it's your payments change. Can you roll it back?`,
      contextLabel: '#incidents',
      isDirectMessage: false,
      mentionsMe: true,
      ageMinutes: 4,
    }),
    expected: { category: 'action_needed', urgency: [80, 100], isBump: false },
    recorded:
      '{"category": "action_needed", "urgency_score": 70, "is_bump": false, "bump_of": null, "reason": "Asks you to roll back a payments change causing 500 errors in production"}',
  },
  {
    id: 'thanks',
    label: 'a thank-you with no ask',
    context: context({ text: 'thanks, that worked 🙏' }),
    expected: { category: 'misc', urgency: [0, 19], isBump: false },
    recorded:
      '{"category": "misc", "urgency_score": 10, "is_bump": false, "bump_of": null, "reason": "Expresses gratitude without requiring action"}',
  },
  {
    id: 'banter',
    label: 'pure banter',
    context: context({ text: 'lol same' }),
    expected: { category: 'misc', urgency: [0, 19], isBump: false },
    recorded:
      '{"category": "misc", "urgency_score": 10, "is_bump": false, "bump_of": null, "reason": "Casual reaction with no actionable content"}',
  },
  {
    id: 'greeting',
    label: 'bare greeting',
    context: context({ text: 'hey!' }),
    expected: { category: 'misc', urgency: [0, 25], isBump: false },
    recorded:
      '{"category": "misc", "urgency_score": 10, "is_bump": false, "bump_of": null, "reason": "casual greeting with no ask or information"}',
  },
  {
    id: 'deploy-bot',
    label: 'deploy bot notice',
    context: context({
      text: 'Deploy of web@4.18.2 to production succeeded in 3m41s.',
      senderLabel: 'Deploy Bot',
      contextLabel: '#deploys',
      isDirectMessage: false,
    }),
    expected: { category: 'fyi', urgency: [0, 25], isBump: false },
    recorded:
      '{"category": "fyi", "urgency_score": 30, "is_bump": false, "bump_of": null, "reason": "Conveys a successful deployment status update"}',
  },
  {
    id: 'announcement',
    label: 'team announcement',
    context: context({
      text: 'Heads up everyone — the new design system docs are live at docs.example.com/ds.',
      contextLabel: '#general',
      isDirectMessage: false,
      ageMinutes: 240,
    }),
    expected: { category: 'fyi', urgency: [0, 30], isBump: false },
    recorded:
      '{"category": "fyi", "urgency_score": 25, "is_bump": false, "bump_of": null, "reason": "Announces new design system docs are live at docs.example.com/ds."}',
  },
  {
    id: 'ooo',
    label: 'out-of-office notice',
    context: context({
      text: "I'm out tomorrow for a doctor's appointment, back Thursday.",
    }),
    expected: { category: 'fyi', urgency: [0, 35], isBump: false },
    recorded:
      '{"category": "fyi", "urgency_score": 30, "is_bump": false, "bump_of": null, "reason": "informs you of their absence schedule for tomorrow and Thursday."}',
  },
  {
    id: 'review-with-deadline',
    label: 'PR review request with a Friday deadline',
    context: context({
      text: `@${ME} could you review PR #412 before Friday? It blocks the billing release.`,
      contextLabel: '#eng',
      isDirectMessage: false,
      mentionsMe: true,
      ageMinutes: 90,
    }),
    expected: { category: 'action_needed', urgency: [50, 85], isBump: false },
    recorded:
      '{"category": "action_needed", "urgency_score": 70, "is_bump": false, "bump_of": null, "reason": "Asks to review PR #412 before Friday as it blocks the billing release"}',
  },
  {
    id: 'approval',
    label: 'approval request',
    context: context({
      text: 'Need your sign-off on the vendor invoice so finance can pay it this week.',
    }),
    expected: { category: 'action_needed', urgency: [40, 75], isBump: false },
    recorded:
      '{"category": "action_needed", "urgency_score": 45, "is_bump": false, "bump_of": null, "reason": "Asks for sign-off on a vendor invoice to enable payment this week."}',
  },
  {
    id: 'scheduling',
    label: 'scheduling ask',
    context: context({
      text: 'Are you free for 30 minutes tomorrow afternoon to go over the migration plan?',
    }),
    expected: { category: 'action_needed', urgency: [35, 70], isBump: false },
    recorded:
      '{"category": "action_needed", "urgency_score": 30, "is_bump": false, "bump_of": null, "reason": "Asks you to go over the migration plan tomorrow afternoon."}',
  },
  {
    id: 'bump-any-update',
    label: '"any update on this?" chasing an earlier ask',
    context: context({
      text: 'any update on this?',
      ageMinutes: 30,
      previous: [
        {
          id: 'msg-original-ask',
          text: 'Can you take a look at the auth migration doc and let me know if the rollout order makes sense?',
          ageMinutes: 60 * 24 * 3,
        },
      ],
    }),
    expected: { category: 'action_needed', urgency: [40, 80], isBump: true },
    recorded:
      '{"category": "action_needed", "urgency_score": 45, "is_bump": true, "bump_of": 1, "reason": "Follow-up asking for update on the auth migration doc review request from message 1"}',
  },
  {
    id: 'bump-gentle-ping',
    label: '"gentle ping" chasing, two levels deep',
    context: context({
      text: 'gentle ping on this 🙏',
      ageMinutes: 20,
      previous: [
        {
          id: 'msg-original-ask',
          text: 'Could you approve the staging access request for the new contractor?',
          ageMinutes: 60 * 24 * 5,
        },
        {
          id: 'msg-first-bump',
          text: 'bump',
          ageMinutes: 60 * 24 * 2,
        },
      ],
    }),
    expected: { category: 'action_needed', urgency: [40, 80], isBump: true },
    recorded:
      '{"category": "action_needed", "urgency_score": 30, "is_bump": true, "bump_of": 1, "reason": "Following up on the staging access request approval from 5 days ago"}',
  },
  {
    id: 'not-a-bump-new-question',
    label: 'new question that merely follows earlier messages',
    context: context({
      text: 'Separately — do you know who owns the analytics pipeline now?',
      ageMinutes: 15,
      previous: [
        {
          id: 'msg-earlier',
          text: 'morning!',
          ageMinutes: 120,
        },
      ],
    }),
    expected: { category: 'action_needed', urgency: [20, 55], isBump: false },
    recorded:
      '{"category": "action_needed", "urgency_score": 30, "is_bump": false, "bump_of": null, "reason": "Asks if the reader knows who owns the analytics pipeline now."}',
  },
  {
    id: 'blocked-colleague',
    label: 'colleague blocked, waiting on the reader',
    context: context({
      text: "I'm blocked on the schema change until you merge the migration — can you get to it this morning?",
      ageMinutes: 25,
    }),
    expected: { category: 'action_needed', urgency: [60, 90], isBump: false },
    recorded:
      '{"category": "action_needed", "urgency_score": 70, "is_bump": false, "bump_of": null, "reason": "The sender is blocked on a schema change and requests the reader to merge the migration by morning."}',
  },
  {
    id: 'status-update',
    label: 'someone reporting what they did',
    context: context({
      text: 'Finished the search indexing work, it is deployed and I am moving on to the caching ticket.',
      contextLabel: '#eng',
      isDirectMessage: false,
      ageMinutes: 300,
    }),
    expected: { category: 'fyi', urgency: [0, 30], isBump: false },
    recorded:
      '{"category": "fyi", "urgency_score": 15, "is_bump": false, "bump_of": null, "reason": "Informs the reader that the search indexing work is completed and deployed, and they are moving on to the caching ticket."}',
  },
  {
    id: 'thread-reply-question',
    label: 'question inside a thread the reader is in',
    context: context({
      text: 'Which environment did you see that on, staging or prod?',
      contextLabel: '#support',
      isDirectMessage: false,
      isThreadReply: true,
      ageMinutes: 12,
    }),
    expected: { category: 'action_needed', urgency: [30, 70], isBump: false },
    recorded:
      '{"category": "action_needed", "urgency_score": 25, "is_bump": false, "bump_of": null, "reason": "Asks for information about the environment where an issue was observed."}',
  },
  {
    id: 'alert-not-directed',
    label: 'monitoring alert, not addressed to anyone',
    context: context({
      text: '[ALERT] p95 latency on api-gateway is 1.8s (threshold 1.0s) for 10 minutes.',
      senderLabel: 'Grafana',
      contextLabel: '#alerts',
      isDirectMessage: false,
      ageMinutes: 8,
    }),
    expected: { category: 'fyi', urgency: [30, 75], isBump: false },
    ambiguous: true,
    note: 'Genuinely contested: an alert nobody has been assigned is information, but a human on call would read it as action. Excluded from the pass threshold.',
    recorded:
      '{"category": "fyi", "urgency_score": 50, "is_bump": false, "bump_of": null, "reason": "Alert about p95 latency exceeding threshold on api-gateway"}',
  },
  {
    id: 'open-question-to-channel',
    label: 'open question to a channel the reader could answer',
    context: context({
      text: 'Does anyone know why the nightly job started taking 40 minutes?',
      contextLabel: '#eng',
      isDirectMessage: false,
      ageMinutes: 45,
    }),
    expected: { category: 'fyi', urgency: [10, 45], isBump: false },
    ambiguous: true,
    note: 'Contested: not addressed to the reader, but they may be the only person who can answer. The prompt asks for action_needed only when the reader is the one who can answer, which is unknowable from the text alone.',
    recorded:
      '{"category": "action_needed", "urgency_score": 45, "is_bump": false, "bump_of": null, "reason": "Asks about a problem with the nightly job\'s runtime that requires investigation"}',
  },
  {
    id: 'urgent-word-but-social',
    label: 'urgency word attached to nothing urgent',
    context: context({
      text: 'URGENT: someone left a whole cake in the kitchen 🎂',
      contextLabel: '#random',
      isDirectMessage: false,
      ageMinutes: 20,
    }),
    expected: { category: 'misc', urgency: [0, 25], isBump: false },
    note: 'Checks that the model scores content rather than pattern-matching the word "urgent".',
    recorded:
      '{"category": "fyi", "urgency_score": 30, "is_bump": false, "bump_of": null, "reason": "Informs that someone left a cake in the kitchen, marked as urgent but no direct action required."}',
  },
];

export const STRICT_FIXTURES = LABELED_MESSAGES.filter(
  (fixture) => fixture.ambiguous !== true,
);
