import type { SlackInstallation } from '@prisma/client';

import { prisma } from '@/lib/db';
import { getOwnerUserId } from '@/lib/env';
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

/** Raised when someone other than the owner completes the OAuth flow. */
export class NotTheOwnerError extends Error {
  constructor(readonly attemptedUserId: string) {
    super(
      `Slack user ${attemptedUserId} is not the owner of this SlackZero install.`,
    );
    this.name = 'NotTheOwnerError';
  }
}

/**
 * Upsert on (teamId, authedUserId) so re-running OAuth refreshes the stored
 * token instead of accumulating duplicate rows.
 *
 * Refuses to store an installation for anyone but the owner. Without this,
 * "connect Slack" doubles as a takeover: any visitor could authorize, become
 * the most recent row, and be handed the app.
 *
 * @throws {NotTheOwnerError}
 */
export async function saveInstallation(
  input: SaveInstallationInput,
): Promise<SlackInstallation> {
  const owner = await getOwnerIdentity();
  if (owner && owner.authedUserId !== input.authedUserId) {
    throw new NotTheOwnerError(input.authedUserId);
  }

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
 * The owner's Slack identity, or null if the app has never been connected.
 *
 * Two ways to be the owner, in priority order:
 *
 * 1. `SLACK_OWNER_USER_ID` names one explicitly. Prefer this in any deployment
 *    that is reachable by more than you — it is immune to whatever rows the
 *    database happens to hold.
 * 2. Otherwise, trust on first use: the earliest installation wins.
 *
 * Note (2) is genuinely ambiguous on this database. Phase 0 left *two*
 * installation rows behind, because two people in the workspace authorized the
 * app while it was being set up (see `plan.md`). Set `SLACK_OWNER_USER_ID`.
 */
export async function getOwnerIdentity(): Promise<{
  teamId: string;
  authedUserId: string;
} | null> {
  const configured = getOwnerUserId();

  const row = configured
    ? await prisma.slackInstallation.findFirst({
        where: { authedUserId: configured },
        orderBy: { installedAt: 'asc' },
      })
    : await prisma.slackInstallation.findFirst({
        orderBy: { installedAt: 'asc' },
      });

  if (!row) {
    // A configured owner who has not connected yet still *is* the owner; say
    // so, or first-use OAuth would be rejected as "not the owner".
    return configured ? { teamId: '', authedUserId: configured } : null;
  }

  return { teamId: row.teamId, authedUserId: row.authedUserId };
}

/**
 * The owner's installation, or null if the app has never been connected.
 *
 * SlackZero is single-user (see CLAUDE.md), but "single-user" was previously
 * implemented as "whichever row was updated last", which is not an identity at
 * all — it let the newest connector inherit the app. Resolve the owner
 * explicitly instead.
 */
export async function getInstallation(): Promise<SlackInstallation | null> {
  const owner = await getOwnerIdentity();
  if (!owner) return null;

  return prisma.slackInstallation.findFirst({
    where: { authedUserId: owner.authedUserId },
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
