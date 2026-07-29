import type { WebClient } from '@slack/web-api';

import { getSlackContext } from '@/lib/slack/client';
import { slackUserCache } from '@/lib/slack/cache';
import type { RawSlackUser } from '@/lib/slack/raw';

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
  return [...new Set(candidateIds)].filter(
    (id) => Boolean(id) && !slackUserCache.get(id),
  );
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

      slackUserCache.set(id, member);
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
  deps.onLog?.('Profiles are cached on demand; no persistent stubs need hydration.');
  return 0;
}

function describe(error: unknown): string {
  const data =
    typeof error === 'object' && error !== null
      ? (error as { data?: { error?: unknown } }).data
      : undefined;

  if (data && typeof data.error === 'string') return data.error;
  return error instanceof Error ? error.message : String(error);
}
