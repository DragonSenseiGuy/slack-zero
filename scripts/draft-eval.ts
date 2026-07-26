/**
 * Reply-draft smoke check: `npm run draft:eval`
 *
 * Runs a handful of representative messages through the live drafting path and
 * prints what the model suggests. This is the reply-side counterpart to
 * `npm run triage:eval`: `src/lib/reply/draft.test.ts` covers parsing offline,
 * and this is how you see whether the prompt actually produces sendable text.
 *
 * Sends nothing to Slack — it only calls the LLM.
 */
import 'dotenv/config';

import { isLlmConfigured } from '../src/lib/env';
import { generateDrafts } from '../src/lib/reply/generate';
import { hasPlaceholder } from '../src/lib/reply/draft';

const CASES = [
  { label: 'approval request', text: 'Can you approve the staging access request for the new contractor?' },
  { label: 'scheduling', text: 'Are you free to sync on the migration sometime tomorrow?' },
  { label: 'direct question', text: 'Did the nightly job finish, or is it still stuck?' },
  { label: 'blocked colleague', text: "I'm blocked on the API key — can you send it over when you get a sec?" },
  { label: 'banter', text: 'lol that deploy was cursed' },
];

async function main(): Promise<void> {
  if (!isLlmConfigured()) {
    console.error('No LLM key configured. Set HACKCLUB_AI_API_KEY in .env.');
    process.exitCode = 1;
    return;
  }

  for (const testCase of CASES) {
    try {
      const result = await generateDrafts({
        text: testCase.text,
        senderLabel: 'Dragon Sensei Guy',
        selfLabel: 'me',
        contextLabel: 'DM · Dragon Sensei Guy',
        isDirectMessage: true,
        isThread: false,
        sentAtIso: new Date(Date.now() - 30 * 60_000).toISOString(),
        nowIso: new Date().toISOString(),
      });

      console.log(`\n== ${testCase.label} ==`);
      console.log(`   "${testCase.text}"`);
      for (const draft of result.drafts) {
        const flag = hasPlaceholder(draft.text) ? ' [needs editing]' : '';
        console.log(`   [${draft.kind}]${flag} ${draft.text}`);
      }
    } catch (error) {
      console.log(
        `\n== ${testCase.label} == FAILED: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
