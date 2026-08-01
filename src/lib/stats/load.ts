import { prisma } from '@/lib/db';
import { isDemoMode } from '@/lib/demo/workspace';
import { getInstallation } from '@/lib/slack/installation';
import {
  currentStreak,
  dailySeries,
  summarize,
  type DailyPoint,
  type StatsRow,
  type TriageSummary,
} from '@/lib/stats/compute';

/**
 * Reads the rows the stats dashboard needs (plan.md, Phase 7).
 *
 * All the arithmetic lives in `compute.ts`, which is pure and unit tested. This
 * file only fetches and shapes — keeping the split means the numbers can be
 * tested against known timestamps without a database.
 */

/** How far back the dashboard looks. Beyond this the data is not interesting. */
const HISTORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type StatsData = {
  isConnected: boolean;
  today: TriageSummary;
  week: TriageSummary;
  series: DailyPoint[];
  streak: number;
  /** Messages in the queue that have never been triaged, of any age. */
  openTotal: number;
  /** Outstanding asks the user is waiting on (Phase 6). */
  waitingOn: number;
  generatedAtIso: string;
};

export async function loadStats(): Promise<StatsData> {
  const now = new Date();
  const since = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);

  const installation = await getInstallation();

  const messages = await prisma.message.findMany({
    where: { sentAt: { gte: since }, isDeleted: false },
    select: {
      id: true,
      sentAt: true,
      userId: true,
      conversationId: true,
      state: {
        select: { isDone: true, doneAt: true, isWaitingOn: true },
      },
    },
    orderBy: { sentAt: 'asc' },
  });

  /**
   * The user's own messages, used to work out when they replied.
   *
   * Reply time is "how long did someone wait to hear back from me", so it is
   * measured to the first message *the user* sent in that conversation after the
   * incoming one. This is an approximation — it cannot tell whether that message
   * actually answered the incoming one — and it is the same structural
   * simplification Phase 6 makes for waiting-on detection, for the same reason:
   * asking a model per message is exactly the high-volume work CLAUDE.md rules
   * out.
   */
  const authedUserId = installation?.authedUserId ?? null;
  const outgoingByConversation = new Map<string, Date[]>();

  if (authedUserId) {
    for (const message of messages) {
      if (message.userId !== authedUserId) continue;
      const list = outgoingByConversation.get(message.conversationId) ?? [];
      list.push(message.sentAt);
      outgoingByConversation.set(message.conversationId, list);
    }
  }

  function firstReplyAfter(conversationId: string, sentAt: Date): Date | null {
    const outgoing = outgoingByConversation.get(conversationId);
    if (!outgoing) return null;
    // `messages` is ordered by sentAt, so each list is already sorted.
    for (const candidate of outgoing) {
      if (candidate.getTime() > sentAt.getTime()) return candidate;
    }
    return null;
  }

  const rows: StatsRow[] = messages
    // The user's own messages are not things they triage.
    .filter((message) => authedUserId === null || message.userId !== authedUserId)
    .map((message) => ({
      id: message.id,
      sentAt: message.sentAt,
      doneAt: message.state?.doneAt ?? null,
      isDone: message.state?.isDone ?? false,
      repliedAt: firstReplyAfter(message.conversationId, message.sentAt),
    }));

  const series = dailySeries(rows, 14, now);

  return {
    // Demo mode has no installation and never will — but it does have data,
    // so telling the visitor "nothing to measure yet" would be a lie about
    // the numbers directly below it.
    isConnected: installation !== null || isDemoMode(),
    today: summarize(rows, 'day', now),
    week: summarize(rows, 'week', now),
    series,
    streak: currentStreak(series),
    openTotal: rows.filter((row) => !row.isDone).length,
    waitingOn: messages.filter((message) => message.state?.isWaitingOn).length,
    generatedAtIso: now.toISOString(),
  };
}
