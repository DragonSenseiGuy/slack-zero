# SlackZero

A fast, keyboard-first Slack client for triaging DMs and notifications.
Superhuman, but for Slack instead of email.

It pulls your DMs, mentions and threads into one prioritized queue, classifies
each message with a small language model (urgency, action-vs-FYI-vs-misc, and
whether it is an "any update on this?" bump), and lets you fly through the queue
with `j`/`k`/`e` without touching the mouse.

Single-user and local. There is no multi-tenant auth, no hosting story, and no
telemetry.

---

## Requirements

- Node 20+
- Docker (for the local Postgres)
- A Slack workspace you can install an app into — **use a test workspace, not
  production**
- A [Hack Club AI](https://ai.hackclub.com) key for classification and reply
  drafts (optional — the app runs without one, it just will not classify)

## Setup

```bash
npm install
docker compose up -d          # Postgres on host port 5433
cp .env.example .env          # then fill it in — see below
npx prisma migrate dev
```

**Create the Slack app and fill in `.env`** by following
[`SLACK_APP_SETUP.md`](./SLACK_APP_SETUP.md). It covers the scopes, Socket Mode,
the redirect URL, and the two traps that cost the most time here: a dev server
that silently falls back to plain HTTP, and ISP filters that block ngrok.

Then connect the workspace:

```bash
npm run dev:https             # https://localhost:3000
```

Open <https://localhost:3000>, click through the certificate warning, and hit
**Connect Slack**. Confirm all three checks are green at
<https://localhost:3000/api/health>.

## Loading your messages

```bash
npm run backfill              # pull recent DMs, mpims and mentions
npm run backfill:verify       # re-count against Slack, independently
npm run classify              # classify anything not yet rated
```

Then open <https://localhost:3000/inbox>.

Optional background jobs, each safe to run or skip:

```bash
npm run socket                # live ingestion over Socket Mode
npm run snooze:sweep          # reinject snoozed items while the app is open
npm run waiting:scan          # find asks nobody has answered
```

## Keyboard shortcuts

Press `?` in the inbox for the full list. The short version:

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous message |
| `Enter` | Open in the reading pane |
| `e` | Mark done (or undo) |
| `r` | Reply |
| `d` | Suggest replies |
| `h` | Snooze |
| `u` | Show or hide done items |
| `s` | Sort by urgency / recency |
| `g` / `G` | First / last message |
| `⌘K` | Jump to a channel or person |
| `Esc` | Back / clear the filter |
| `?` | This list |

Shortcuts stand down while you are typing, so a reply containing "read" will not
mark anything done.

## What it does

- **Unified queue** — DMs, mentions, and threads you are part of, in one list.
- **AI triage** — urgency 0-100, `action_needed` / `fyi` / `misc`, and a stored
  one-line reason for every score, so the ordering can be argued with rather
  than taken on faith.
- **Bump collapsing** — a three-message "any update?" chain shows as one row at
  the *original* ask's timestamp, so chasing surfaces staleness instead of
  faking new activity.
- **Saved views** — filter by category, source, VIP, bumped, urgency floor.
  Ships with Needs Reply, Waiting Room, Everything, and Waiting on Others.
- **Reply without leaving the queue** — inline compose, optional AI drafts,
  auto-mark-done.
- **Snooze** — later today / tomorrow / next week / custom, waking early if the
  thread sees new activity before then.
- **Waiting on others** — asks you sent that nobody has answered, with a
  staleness indicator.
- **Stats** — median response time, triaged-per-day, streak, at `/stats`.

## Development

```bash
npm run test                  # unit tests (no network, no database)
npm run test:e2e              # Playwright
npm run typecheck
npm run lint
```

The e2e suite seeds its own fixtures in an id namespace that cannot collide with
real Slack ids, and runs single-worker because every spec shares one local
Postgres. It builds into `.next-e2e` so it cannot clobber a running dev server.

Two evaluation harnesses make live LLM calls (never Slack calls):

```bash
npm run triage:eval           # classification accuracy vs the labeled set
npm run draft:eval            # what the reply drafts actually look like
```

**Re-run `draft:eval` after editing the drafting prompt.** A longer prompt makes
the model reason more, which eats the `max_tokens` budget and can truncate the
response to nothing — see the note on `DRAFT_MAX_TOKENS` in
`src/lib/reply/draft.ts`.

## Known limitations

See [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md). The short version: urgency scores are
not reproducible run-to-run, "answered" is detected structurally rather than
semantically, and a few ingestion paths have only fixture coverage.

## Architecture

- **Next.js 14** (App Router), TypeScript strict, Tailwind
- **Postgres via Prisma** — Slack is the source of truth for content; we store a
  metadata and state layer on top (classification, done, snooze, views)
- **Slack Web API** for reads and writes, **Socket Mode** for live events, so no
  public URL is needed
- **Hack Club AI** (`qwen/qwen3-32b`) behind a single module,
  `src/lib/llm/client.ts` — nothing else imports a provider SDK, so the model is
  swappable in one file

`plan.md` records what was built in each phase, what was verified, and the
judgment calls made along the way. `CLAUDE.md` holds the working conventions.
