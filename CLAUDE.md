# CLAUDE.md

Project context and conventions for any agent working in this repo. Read this
in full before starting any phase in `plan.md`.

## What this project is
SlackZero: a fast, keyboard-first Slack client for triaging DMs and
notifications. Think "Superhuman, but for Slack instead of email." Core value
is speed and correct prioritization (AI urgency + action/misc classification),
not feature breadth.

## Working agreement
- `plan.md` is the source of truth for what to build and in what order. Work
  phase by phase, in order, and do not start a phase until the previous one's
  verification steps pass.
- Update the `Status` field at the top of the current phase in `plan.md` as
  you go (`In progress` → `Done`, or `Blocked: <reason>` if stuck).
- Every phase has a "Verification" section. Treat these as required, not
  optional — write the tests, run them, and only proceed if they pass.
- If a task turns out to be ambiguous or the assumed architecture doesn't
  fit, stop and note it in `plan.md` under the relevant phase rather than
  guessing silently and moving on.
- Don't jump ahead to implement later-phase features early "while you're in
  there" — it breaks the incremental testability this plan is built around.
- **Commit each phase to git** when its verification passes: one commit per
  phase, message starting `Phase N: <short summary>`, and say so in the
  message if anything is still unverified. Run `git status` before staging and
  confirm `.env` (and anything else holding a secret) is not included. Local
  commits only — don't push and don't add a remote unless asked.

## Tech stack
- Next.js 14 (App Router), TypeScript, Tailwind CSS
- Prisma + Postgres
- Slack Web API + Events API (Socket Mode for local dev, no public URL
  needed)
- LLM: **Hack Club AI** (`https://ai.hackclub.com/proxy/v1`), an
  OpenAI-compatible proxy, for classification, summarization, reply drafts.
  Default model is `qwen/qwen3-32b` (`LLM_MODEL`).
  *User decisions, 2026-07-24: (1) this replaces calling the Anthropic API
  directly; (2) **do not use Opus 5 or other frontier models for small,
  high-volume tasks** — classification, bump detection, and similar per-message
  work must use a small open-weight model. It's a waste of money otherwise.
  Only reach for a larger model if a task demonstrably fails on the small one,
  and flag it when you do.*
- Vitest for unit tests, Playwright for e2e

## Repo conventions
- Package manager: npm
- Run dev server: `npm run dev`
- Run unit tests: `npm run test`
- Run e2e tests: `npm run test:e2e`
- Prisma migrations: `npx prisma migrate dev`
- Keep API keys and secrets in `.env` (never commit); `.env.example` should
  always reflect every env var actually in use — update it whenever a new
  one is added
- Server-side Slack/LLM API calls only — never expose Slack tokens or the
  Hack Club AI key to the client
- Prefer server actions / API routes over client-side data fetching for
  anything touching Slack or the LLM

## Code style
- TypeScript strict mode on
- Functional React components, hooks over classes
- Colocate tests next to the code they test (`foo.ts` + `foo.test.ts`)
- No `any` unless truly unavoidable — if used, comment why
- Keep Slack API response shapes and our internal data model clearly
  separated (normalize at the ingestion boundary, per Phase 1); don't let
  raw Slack payload shapes leak into UI components

## AI classification notes
- All LLM access goes through the single module `src/lib/llm/client.ts`,
  which wraps the `openai` package pointed at Hack Club AI. Do not import
  `openai` (or any other provider SDK) anywhere else — keeping the provider
  swappable in one file is the whole point. Server-side only.
- All LLM calls for classification should log their reasoning
  (`reason` field) alongside the score/category — this is required for
  debugging and building trust in the sorting, not optional metadata
- Budget for Hack Club AI's rate limit: 450 chat/embedding requests per 30
  minutes, HTTP 429 beyond that. Batch and back off accordingly.
- Classification should never block message ingestion — ingest first, then
  classify async
- When writing prompts for classification, keep them deterministic and
  testable: same input should reliably produce the same category (urgency
  score can have some tolerance, category should not flip-flop)

## Testing philosophy
- Unit test pure logic (classification parsing, filter matching, sort
  logic, scheduling) with fixture data — these should not depend on live
  Slack or Anthropic API calls
- e2e (Playwright) tests cover the actual user flows described in each
  phase's Verification section
- For anything involving real Slack API calls, use a dedicated test/sandbox
  Slack workspace, never a production one
- AI classification quality (is this message actually "action needed"?)
  can't be fully unit tested — use a small hand-labeled fixture set to catch
  regressions, and call out remaining judgment calls for human review in the
  PR description rather than claiming full automated coverage

## Things to explicitly avoid
- Don't build multi-tenant auth/user management — this is a single-user
  local tool for now
- Don't add features not listed in `plan.md` without flagging them first —
  scope creep here defeats the "phase by phase, test before advancing"
  approach
- Don't silently swap out the assumed stack (Next.js/Prisma/Postgres/Slack
  Socket Mode/Hack Club AI) — if something about it doesn't work, stop and
  surface it rather than routing around it