import { WebClient, retryPolicies } from '@slack/web-api';

import {
  DEMO_OWNER_USER_ID,
  DEMO_TEAM_ID,
  DEMO_TEAM_NAME,
  isDemoMode,
} from '@/lib/demo/workspace';
import { noStoreFetch } from '@/lib/http/no-store';

import { decryptInstallation, getInstallation } from '@/lib/slack/installation';

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
  authedUserId: string;
  teamId: string;
  teamName: string;
};
export async function getSlackContext(): Promise<SlackContext> {
  const installation = await getInstallation();

  // Demo mode: there is no installation and no token. Every demo conversation
  // id is intercepted in src/lib/slack/live.ts before a request is built, so
  // this client is a placeholder that the hydration path never calls. A stray
  // call with no token fails closed — the queue renders without that content —
  // which is the behaviour we want from a mode that must never reach Slack.
  if (!installation && isDemoMode()) {
    return {
      client: new WebClient(undefined, { fetch: noStoreFetch }),
      authedUserId: DEMO_OWNER_USER_ID,
      teamId: DEMO_TEAM_ID,
      teamName: DEMO_TEAM_NAME,
    };
  }

  if (!installation) throw new SlackNotConnectedError();

  const decrypted = decryptInstallation(installation);
  const client = new WebClient(decrypted.userAccessToken, {
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
    rejectRateLimitedCalls: false,
    // Without this, Next writes every Slack response body to disk. See
    // src/lib/http/no-store.ts.
    fetch: noStoreFetch,
  });

  return {
    client,
    authedUserId: installation.authedUserId,
    teamId: installation.teamId,
    teamName: installation.teamId,
  };
}
