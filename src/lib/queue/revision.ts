import { prisma } from '@/lib/db';

export async function queueRevision(): Promise<string> {
  const [messages, states, classifications] = await Promise.all([
    prisma.message.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.messageState.aggregate({
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
    prisma.classification.aggregate({
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
  ]);

  const part = (count: number, at: Date | null) =>
    `${count}@${at ? at.getTime() : 0}`;

  return [
    part(messages._count._all, messages._max.updatedAt),
    part(states._count._all, states._max.updatedAt),
    part(classifications._count._all, classifications._max.updatedAt),
  ].join('|');
}
