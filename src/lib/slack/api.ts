import { getSlackContext } from '@/lib/slack/client';

export type SlackAuthCheck =
  | {
      status: 'ok';
      teamId: string;
      teamName: string;
      userId: string;
      url?: string;
    }
  | { status: 'not_configured' }
  | { status: 'error'; error: string };

export async function checkSlackAuth(): Promise<SlackAuthCheck> {
  let context;
  try {
    context = await getSlackContext();
  } catch {
    return { status: 'not_configured' };
  }

  try {
    const result = await context.client.auth.test();

    if (!result.ok) {
      return { status: 'error', error: String(result.error ?? 'auth_failed') };
    }

    return {
      status: 'ok',
      teamId: String(result.team_id ?? context.teamId),
      teamName: String(result.team ?? context.teamName),
      userId: String(result.user_id ?? context.authedUserId),
      url: typeof result.url === 'string' ? result.url : undefined,
    };
  } catch (error) {
    const data =
      typeof error === 'object' && error !== null
        ? (error as { data?: { error?: unknown } }).data
        : undefined;
    const code =
      data && typeof data.error === 'string'
        ? data.error
        : error instanceof Error
          ? error.message
          : 'auth_test_failed';
    return { status: 'error', error: code };
  }
}
