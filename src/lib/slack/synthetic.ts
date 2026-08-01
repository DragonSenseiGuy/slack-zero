import { prisma } from '@/lib/db';
import { DEMO_WORKSPACE, isDemoMode } from '@/lib/demo/workspace';

/**
 * Message content that does not come from Slack.
 *
 * Two callers need this, for the same reason: the app never persists message
 * text (see PRIVACY_MIGRATION.md), so a row in Postgres is an identity and a
 * pile of triage state with nothing to render. Live, `src/lib/slack/live.ts`
 * fetches the text from Slack. Without a workspace — the e2e suite, and demo
 * mode — something has to stand in.
 *
 * Both are strictly opt-in via an environment flag, and both are scoped to
 * conversation and user ids in namespaces that real Slack ids cannot collide
 * with. When no flag is set this module returns null for everything and the
 * live path is the only path.
 */

export type SyntheticUser = { name: string; displayName: string };

export type SyntheticWorkspace = {
  /** For diagnostics and tests: which stand-in is active. */
  readonly kind: 'e2e' | 'demo';
  readonly conversationIds: ReadonlySet<string>;
  /** Conversations that may be thread-hydrated (channels, not DMs). */
  readonly threadedConversationIds: ReadonlySet<string>;
  readonly channelNames: Readonly<Record<string, string>>;
  readonly users: Readonly<Record<string, SyntheticUser>>;
  /** Message id → text, before any mention prefix. */
  readonly messageText: Readonly<Record<string, string>>;
  /** True when this message should render as addressed to the owner. */
  mentionsOwner(conversationId: string, messageId: string): boolean;
  /** Slack `reply_count` to report for a thread parent. */
  replyCount(messageId: string): number | undefined;
  /** The Slack id the `<@...>` mention prefix should name, if any. */
  ownerUserId(): Promise<string | null>;
};

// ---------------------------------------------------------------------------
// e2e fixtures
// ---------------------------------------------------------------------------

const E2E_CHANNEL = 'CE2ESEED001';
const E2E_DM = 'DE2ESEED001';
const E2E_SENDER = 'UE2ESEED001';
const E2E_BYSTANDER = 'UE2EGAP0001';

const E2E_MESSAGES: Record<string, string> = {
  ...Object.fromEntries(
    [
      'alpha — first fixture message',
      'bravo — second fixture message',
      'charlie — third fixture message',
      'delta — fourth fixture message',
      'echo — fifth fixture message',
      'foxtrot — sixth fixture message',
    ].map((text, index) => [`me2e-msg-${index}`, `E2E ${text}`]),
  ),
  ...Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => [
      `me2e-gap-${index}`,
      `E2E bystander chatter ${index + 1}`,
    ]),
  ),
  'me2e-thread-parent': 'E2E golf — thread parent',
  'me2e-thread-reply-0': 'E2E thread reply one',
  'me2e-thread-reply-1': 'E2E thread reply two',
  'me2e-burst-gap': 'E2E bystander chatter burst gap',
  'me2e-burst-0': 'E2E burst one — hey, are you around?',
  'me2e-burst-1': 'E2E burst two — following up on the migration',
  'me2e-burst-2': 'E2E burst three — need this before the release',
  'me2e-late': 'E2E hotel — arrived after the page loaded',
  ...Object.fromEntries(
    [
      'one — did the migration land?',
      'two — not yet, reviewing it now',
      'three — any blockers?',
      'four — just the index rebuild',
      'five — how long does that take?',
      'six — twenty minutes or so',
      'seven — fine, ship it after',
      'eight — will do',
      'nine — thanks',
      'ten — no problem',
      'eleven — one more thing',
      'twelve — go on',
      'thirteen — sounds good, go ahead',
    ].map((text, index) => [`me2e-dm-${index}`, `E2E dm ${text}`]),
  ),
};

const E2E_MENTION_IDS =
  /^me2e-msg-\d+$|^me2e-burst-\d+$|^me2e-thread-parent$|^me2e-late$/;

const e2eWorkspace: SyntheticWorkspace = {
  kind: 'e2e',
  conversationIds: new Set([E2E_CHANNEL, E2E_DM]),
  threadedConversationIds: new Set([E2E_CHANNEL]),
  channelNames: { [E2E_CHANNEL]: 'e2e-seed' },
  users: {
    [E2E_SENDER]: { name: 'e2e-fixture-sender', displayName: 'E2E Fixture Sender' },
    [E2E_BYSTANDER]: { name: 'e2e-bystander', displayName: 'E2E Bystander' },
  },
  messageText: E2E_MESSAGES,
  mentionsOwner(conversationId, messageId) {
    return conversationId === E2E_CHANNEL && E2E_MENTION_IDS.test(messageId);
  },
  replyCount(messageId) {
    return messageId === 'me2e-thread-parent' ? 2 : undefined;
  },
  /**
   * The e2e suite runs against a database that has a real installation in it,
   * and the fixtures must mention *that* user or nothing lands in the queue.
   */
  async ownerUserId() {
    const installation = await prisma.slackInstallation.findFirst({
      orderBy: { updatedAt: 'desc' },
      select: { authedUserId: true },
    });
    return installation?.authedUserId ?? null;
  },
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function e2eEnabled(): boolean {
  return process.env.SLACKZERO_E2E === '1';
}

/**
 * The active stand-in workspace, or null when the app is talking to real
 * Slack. e2e wins if both flags are somehow set: a test run must never be
 * silently reading demo content it does not assert on.
 */
export function activeSyntheticWorkspace(): SyntheticWorkspace | null {
  if (e2eEnabled()) return e2eWorkspace;
  if (isDemoMode()) return DEMO_WORKSPACE;
  return null;
}

/** The stand-in that owns this conversation, or null. */
export function syntheticWorkspaceFor(
  conversationId: string,
): SyntheticWorkspace | null {
  const workspace = activeSyntheticWorkspace();
  return workspace?.conversationIds.has(conversationId) ? workspace : null;
}

/** The stand-in that owns this user id, or null. */
export function syntheticWorkspaceForUser(
  userId: string,
): SyntheticWorkspace | null {
  const workspace = activeSyntheticWorkspace();
  return workspace && userId in workspace.users ? workspace : null;
}
