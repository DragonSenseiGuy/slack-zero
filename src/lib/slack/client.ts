import { WebClient, retryPolicies } from '@slack/web-api';

import { getInstallation } from '@/lib/slack/installation';

/**
 * Server-side Slack Web API client construction.
 *
 * The token is read from the DB in here and never leaves: callers get a
 * configured `WebClient` plus the authed user's identity, not credentials.
 */

export class SlackNotConnectedError extends Error {
  constructor() {
    super(
      'No Slack installation stored. Visit /api/slack/oauth/start to connect a workspace.',
    );
    this.name = 'SlackNotConnectedError';
  }
}

export type SlackContext = {
  client: WebClient;
  /** Slack id of the user whose token we are acting with. */
  authedUserId: string;
  teamId: string;
  teamName: string;
};

/**
 * A client for the current installation.
 *
 * Rate limiting: `WebClient` already queues on HTTP 429 and honours
 * `Retry-After` by default, and `retryPolicies.fiveRetriesInFiveMinutes` adds
 * exponential backoff for transient network/5xx failures. That is enough for
 * ingestion at this volume — plan.md puts real backoff/retry polish in Phase 8,
 * so nothing more elaborate belongs here yet.
 */
export async function getSlackContext(): Promise<SlackContext> {
  const installation = await getInstallation();
  if (!installation) throw new SlackNotConnectedError();

  const client = new WebClient(installation.userAccessToken, {
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
    // Queue rather than throw when Slack rate limits us.
    rejectRateLimitedCalls: false,
  });

  return {
    client,
    authedUserId: installation.authedUserId,
    teamId: installation.teamId,
    teamName: installation.teamName,
  };
}
