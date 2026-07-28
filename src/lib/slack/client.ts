import { WebClient, retryPolicies } from '@slack/web-api';

import { getInstallation } from '@/lib/slack/installation';

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
  if (!installation) throw new SlackNotConnectedError();

  const client = new WebClient(installation.userAccessToken, {
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
    rejectRateLimitedCalls: false,
  });

  return {
    client,
    authedUserId: installation.authedUserId,
    teamId: installation.teamId,
    teamName: installation.teamName,
  };
}
