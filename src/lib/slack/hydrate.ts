import type { WebClient } from '@slack/web-api';

import { prisma } from '@/lib/db';
import { getSlackContext } from '@/lib/slack/client';
import { upsertUser } from '@/lib/slack/ingest';
import { normalizeUser } from '@/lib/slack/normalize';
import type { RawSlackUser } from '@/lib/slack/raw';

const STUB_WHERE = {
  username: null,
  realName: null,
  displayName: null,
} as const;

const attempted = new Set<string>();

export function resetHydrationAttempts(): void {
  attempted.clear();
}

export type HydrateDeps = {
  client?: WebClient;
  onLog?: (message: string) => void;
};

export async function findStubUserIds(
  candidateIds: readonly string[],
): Promise<string[]> {
  const ids = [...new Set(candidateIds)].filter(Boolean);
  if (ids.length === 0) return [];

  const rows = await prisma.user.findMany({
    where: { id: { in: ids }, ...STUB_WHERE },
    select: { id: true },
  });

  return rows.map((row) => row.id);
}

export async function hydrateStubUsers(
  candidateIds: readonly string[],
  deps: HydrateDeps = {},
): Promise<number> {
  const log = deps.onLog ?? (() => {});

  let pending: string[];
  try {
    pending = (await findStubUserIds(candidateIds)).filter(
      (id) => !attempted.has(id),
    );
  } catch (error) {
    log(`user hydration lookup failed: ${describe(error)}`);
    return 0;
  }

  if (pending.length === 0) return 0;

  let client: WebClient;
  try {
    client = deps.client ?? (await getSlackContext()).client;
  } catch (error) {
    log(`user hydration skipped: ${describe(error)}`);
    return 0;
  }

  let filled = 0;

  for (const id of pending) {
    attempted.add(id);

    try {
      const result = await client.users.info({ user: id });
      const member = result.user as RawSlackUser | undefined;

      if (!result.ok || !member) {
        log(`users.info returned no profile for ${id}`);
        continue;
      }

      await upsertUser(normalizeUser(member));
      filled += 1;
      log(`hydrated ${id}`);
    } catch (error) {
      log(`could not hydrate ${id}: ${describe(error)}`);
    }
  }

  return filled;
}

export async function hydrateAllStubUsers(
  deps: HydrateDeps = {},
): Promise<number> {
  const stubs = await prisma.user.findMany({
    where: STUB_WHERE,
    select: { id: true },
  });

  return hydrateStubUsers(
    stubs.map((row) => row.id),
    deps,
  );
}

function describe(error: unknown): string {
  const data =
    typeof error === 'object' && error !== null
      ? (error as { data?: { error?: unknown } }).data
      : undefined;

  if (data && typeof data.error === 'string') return data.error;
  return error instanceof Error ? error.message : String(error);
}
