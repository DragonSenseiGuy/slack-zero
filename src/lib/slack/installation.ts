import type { SlackInstallation } from '@prisma/client';

import { prisma } from '@/lib/db';
import { decryptSlackToken, encryptSlackToken } from '@/lib/slack/token-crypto';

/**
 * Persistence for the single Slack OAuth installation.
 *
 * Tokens live here and here only. Nothing in this module may be returned to a
 * client component as-is — use `toPublicInstallation()` for anything that
 * crosses the server/client boundary.
 */

export type SaveInstallationInput = {
  teamId: string;
  teamName: string;
  authedUserId: string;
  userAccessToken: string;
  botAccessToken?: string | null;
  scopes: string;
};

/**
 * Upsert on (teamId, authedUserId) so re-running OAuth refreshes the stored
 * token instead of accumulating duplicate rows.
 */
export async function saveInstallation(
  input: SaveInstallationInput,
): Promise<SlackInstallation> {
  return prisma.slackInstallation.upsert({
    where: {
      teamId_authedUserId: {
        teamId: input.teamId,
        authedUserId: input.authedUserId,
      },
    },
    create: {
      teamId: input.teamId,
      authedUserId: input.authedUserId,
      encryptedUserAccessToken: encryptSlackToken(input.userAccessToken),
      encryptedBotAccessToken: input.botAccessToken ? encryptSlackToken(input.botAccessToken) : null,
      scopes: input.scopes,
    },
    update: {
      encryptedUserAccessToken: encryptSlackToken(input.userAccessToken),
      encryptedBotAccessToken: input.botAccessToken ? encryptSlackToken(input.botAccessToken) : null,
      scopes: input.scopes,
    },
  });
}

/**
 * The current installation, or null if the app has never been connected.
 *
 * SlackZero is single-user (see CLAUDE.md), so "the current installation" is
 * just the most recently updated row.
 */
export async function getInstallation(): Promise<SlackInstallation | null> {
  return prisma.slackInstallation.findFirst({
    orderBy: { updatedAt: 'desc' },
  });
}

/** Token-free view of an installation, safe to render. */
export type PublicInstallation = {
  teamId: string;
  teamName: string;
  authedUserId: string;
  scopes: string[];
  hasBotToken: boolean;
  installedAt: string;
  updatedAt: string;
};

export function toPublicInstallation(
  installation: SlackInstallation,
): PublicInstallation {
  return {
    teamId: installation.teamId,
    teamName: installation.teamId,
    authedUserId: installation.authedUserId,
    scopes: installation.scopes ? installation.scopes.split(',') : [],
    hasBotToken: Boolean(installation.encryptedBotAccessToken),
    installedAt: installation.installedAt.toISOString(),
    updatedAt: installation.updatedAt.toISOString(),
  };
}

export type DecryptedInstallation = SlackInstallation & {
  userAccessToken: string;
  botAccessToken: string | null;
};

/** Server-only token boundary. Never return this shape from a route. */
export function decryptInstallation(installation: SlackInstallation): DecryptedInstallation {
  return {
    ...installation,
    userAccessToken: decryptSlackToken(installation.encryptedUserAccessToken),
    botAccessToken: installation.encryptedBotAccessToken
      ? decryptSlackToken(installation.encryptedBotAccessToken)
      : null,
  };
}

/** Convenience for callers that only need the public shape. */
export async function getPublicInstallation(): Promise<PublicInstallation | null> {
  const installation = await getInstallation();
  return installation ? toPublicInstallation(installation) : null;
}
