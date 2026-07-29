import { WebClient, retryPolicies } from '@slack/web-api';

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
  if (!installation) throw new SlackNotConnectedError();

  const decrypted = decryptInstallation(installation);
  const client = new WebClient(decrypted.userAccessToken, {
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
    rejectRateLimitedCalls: false,
  });

  return {
    client,
    authedUserId: installation.authedUserId,
    teamId: installation.teamId,
    teamName: installation.teamId,
  };
}
