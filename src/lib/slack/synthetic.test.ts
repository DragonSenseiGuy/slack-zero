import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEMO_MESSAGES } from '@/lib/demo/workspace';
import {
  activeSyntheticWorkspace,
  syntheticWorkspaceFor,
  syntheticWorkspaceForUser,
} from '@/lib/slack/synthetic';

vi.mock('@/lib/db', () => ({
  prisma: { slackInstallation: { findFirst: vi.fn() } },
}));

afterEach(() => {
  delete process.env.SLACKZERO_E2E;
  delete process.env.SLACKZERO_DEMO;
});

describe('synthetic workspace selection', () => {
  it('is inert with no flag set — the live Slack path is the only path', () => {
    expect(activeSyntheticWorkspace()).toBeNull();
    expect(syntheticWorkspaceFor('CE2ESEED001')).toBeNull();
    expect(syntheticWorkspaceFor('DDEMOPRIYA0')).toBeNull();
    expect(syntheticWorkspaceForUser('UDEMOPRIYA0')).toBeNull();
  });

  it('never claims a conversation id it does not own', () => {
    process.env.SLACKZERO_DEMO = '1';

    expect(syntheticWorkspaceFor('DDEMOPRIYA0')?.kind).toBe('demo');
    // A real Slack conversation must always fall through to the live path,
    // even with demo mode on.
    expect(syntheticWorkspaceFor('C0BFRLH0SDU')).toBeNull();
    expect(syntheticWorkspaceForUser('U0BK9FR4Y1M')).toBeNull();
  });

  it('prefers the e2e fixtures when both flags are set', () => {
    // A test run must never silently read demo content it does not assert on.
    process.env.SLACKZERO_E2E = '1';
    process.env.SLACKZERO_DEMO = '1';

    expect(activeSyntheticWorkspace()?.kind).toBe('e2e');
    expect(syntheticWorkspaceFor('DDEMOPRIYA0')).toBeNull();
  });

  it('exposes demo text and channel names for hydration', () => {
    process.env.SLACKZERO_DEMO = '1';
    const workspace = activeSyntheticWorkspace();

    expect(workspace?.channelNames.CDEMORELEASE).toBe('eng-releases');
    expect(workspace?.messageText['mdemo-priya-1']).toBe(
      DEMO_MESSAGES.find((message) => message.id === 'mdemo-priya-1')?.text,
    );
    // DMs are not thread-hydratable; channels are.
    expect(workspace?.threadedConversationIds.has('CDEMORELEASE')).toBe(true);
    expect(workspace?.threadedConversationIds.has('DDEMOPRIYA0')).toBe(false);
  });
});
