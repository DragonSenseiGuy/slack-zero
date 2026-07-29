import { PrismaClient } from '@prisma/client';
import { chromium } from '@playwright/test';

import 'dotenv/config';

import { createSession, SESSION_COOKIE_NAME } from '../../src/lib/auth/session';

/**
 * Playwright global setup: sign the suite in as the owner.
 *
 * Every page except `/` now requires a session, and the only way to get one in
 * production is to complete Slack OAuth — which an e2e run cannot do (it needs
 * a browser at slack.com and a human). So mint the cookie directly with the
 * same secret and the same helper the callback uses. The token is a real one:
 * if `createSession`/`verifySession` ever disagree, the whole suite fails,
 * which is the behaviour we want from a fixture that stands in for auth.
 *
 * Nothing here writes to `SlackInstallation`; it only reads which user owns it.
 */

const STORAGE_STATE = 'e2e/.auth/owner.json';

export { STORAGE_STATE };

export default async function globalSetup(): Promise<void> {
  const secret = process.env.SLACK_STATE_SECRET;
  if (!secret) {
    throw new Error(
      'e2e: SLACK_STATE_SECRET must be set — it signs the owner session cookie.',
    );
  }

  const owner = await resolveOwner();

  const token = await createSession(
    { teamId: owner.teamId, userId: owner.authedUserId },
    secret,
  );

  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: token,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      // The suite runs over plain http (see playwright.config.ts); a Secure
      // cookie would simply never be sent.
      secure: false,
      sameSite: 'Lax',
    },
  ]);
  await context.storageState({ path: STORAGE_STATE });
  await browser.close();
}

/** Mirrors `getOwnerIdentity()` without pulling the Next-only module graph in. */
async function resolveOwner(): Promise<{ teamId: string; authedUserId: string }> {
  const configured = process.env.SLACK_OWNER_USER_ID?.trim();
  const prisma = new PrismaClient();

  try {
    const row = await prisma.slackInstallation.findFirst({
      where: configured ? { authedUserId: configured } : undefined,
      orderBy: { installedAt: 'asc' },
    });

    if (row) return { teamId: row.teamId, authedUserId: row.authedUserId };
    if (configured) return { teamId: '', authedUserId: configured };

    throw new Error(
      'e2e: no Slack installation in the database, so there is no owner to ' +
        'sign in as. Connect Slack once, or set SLACK_OWNER_USER_ID.',
    );
  } finally {
    await prisma.$disconnect();
  }
}
