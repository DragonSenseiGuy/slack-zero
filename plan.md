# Plan: SlackZero — "Superhuman for Slack"

## Project Summary
A fast, keyboard-first Slack client focused on triaging DMs and notifications
quickly. Core loop: pull in DMs/mentions/threads → classify urgency and
action-vs-misc with AI → present as a single prioritized queue → let the user
fly through it with keyboard shortcuts (reply, done, snooze, defer).

## Architecture Decisions (assumed — flag if you want to change)
- **Frontend**: Next.js 14 (App Router) + TypeScript + Tailwind
- **Backend**: Next.js API routes / server actions (same app, no separate service for now)
- **Slack integration**: Slack OAuth (user token, not bot-only) + Web API for
  reads/writes + Events API via Socket Mode for local dev (no public URL needed)
- **Database**: Postgres via Prisma (stores cached messages, classification
  results, view definitions, snooze/done state — Slack is source of truth for
  content, we store our own metadata/state layer on top)
- **AI**: **Hack Club AI** (`https://ai.hackclub.com/proxy/v1`), an
  OpenAI-compatible proxy, for urgency scoring, action/misc classification,
  bump-message detection, thread summarization, reply drafts. Default model is
  `qwen/qwen3-32b` — a small open-weight model, chosen because classification
  is per-message and high-volume. Rate limit is 450 requests / 30 min. All
  access is funnelled through `src/lib/llm/client.ts` so the provider and
  model are swappable in one file.
  *User decisions, 2026-07-24: (1) replaces calling the Anthropic API
  directly; (2) do not use Opus 5 / frontier models for small tasks.*
- **Auth**: Slack OAuth only for v1 (single user, local use). No multi-tenant
  auth system needed yet.
- **Testing**: Vitest for unit tests, Playwright for critical-path e2e
  (queue loads, keyboard nav, reply send, done/snooze actions)

If any phase reveals this stack is wrong for a requirement, stop and flag it
rather than silently working around it.

## How to work through this plan
- One phase at a time, in order. Do not start phase N+1 until phase N's tests
  pass.
- Spin up a fresh subagent per phase. Each subagent should:
  1. Read this file's section for its phase, plus CLAUDE.md in full.
  2. Implement the tasks.
  3. Write/run the tests listed under "Verification" for that phase.
  4. Only mark the phase done and hand off if verification passes.
  5. **Commit the phase's work to git** once verification passes — one commit
     per phase, message starting `Phase N: <short summary>`. Never commit
     `.env` or any secret; check `git status` before staging. Commit locally
     only — do not push, and do not create a remote.
- If a phase ends up committed before its verification is complete (as Phase 0
  was), say so plainly in the commit message rather than implying it's green.
- If a phase's verification fails after reasonable effort, stop and surface
  the blocker instead of proceeding to the next phase.
- Update the `Status` line at the top of each phase (`Not started` /
  `In progress` / `Blocked: <reason>` / `Done`) as you go, so progress is
  visible from the file itself.

---

## Phase 0: Project Scaffolding & Slack App Setup
**Status:** Done — all four verification bullets pass, including the live OAuth
round-trip (completed 2026-07-25).

**Verified 2026-07-24/25** (Next.js 14.2.35, Postgres 16 on host port **5433**):
- `npm run test` → 5 files, **55 tests passed** (OAuth callback with mocked
  Slack: success + bad/missing state + `ok:false` + missing code; state HMAC
  sign/verify; env loader; LLM client wrapper with the provider SDK mocked)
- `npx tsc --noEmit` clean · `npm run lint` clean · `npm run build` succeeds
  (6 routes)
- **`npm run test:e2e` → 3/3 passed** (chromium). Playwright browsers had to be
  installed first (`npx playwright install`). The existing `webServer` config
  (build + `next start` on port 3100) worked as written — no changes needed.
- `npm run dev` boots clean; `GET /api/health` → HTTP 200 with **`db: ok`** and
  **`llm: ok`** ("Hack Club AI reachable; default model qwen/qwen3-32b (690
  models available)"). `slack` is still `not_configured` — correct, since no
  installation is stored yet.
- **One real LLM call** through `src/lib/llm/client.ts` against
  `qwen/qwen3-32b` on the live Hack Club AI proxy: returned a real completion,
  and a JSON-mode classification call returned parseable
  `{urgency_score, category, reason}`. Phase 3's wiring is proven.
- `/api/slack/oauth/start` returns 307 to `slack.com/oauth/v2/authorize` with a
  populated `client_id`, all 13 user scopes from `src/lib/slack/scopes.ts`, the
  `.env` `redirect_uri`, and a signed `state` also set as an httpOnly/Secure
  cookie (600s TTL). The route itself is correct.
- App manifest independently re-checked against Slack's current schema:
  `settings.event_subscriptions.user_events` is valid for user-token events,
  and `features.bot_user` is optional under Socket Mode

**Two bugs found and fixed while verifying:**
- `LLM_MODEL`'s fallback default in `src/lib/env.ts` was
  `anthropic/claude-opus-5`, contradicting `.env.example`,
  `SLACK_APP_SETUP.md`, and the user's explicit "no frontier models for small,
  high-volume tasks" decision. If `LLM_MODEL` were ever unset, every
  per-message classification would have silently gone to a frontier model.
  Default is now `qwen/qwen3-32b`.
- `chat()` in `src/lib/llm/client.ts` silently returned `text: ''` when the
  provider truncated the response. This matters specifically because the
  default model is a *reasoning* model: the proxy returns its hidden reasoning
  in a separate `message.reasoning` field (so `content` is clean — no `<think>`
  blocks leak, confirmed against the live API), but that reasoning still spends
  the `max_tokens` budget. A too-small budget yields `content: null` +
  `finish_reason: 'length'`. `chat()` now surfaces `finishReason` and throws a
  descriptive `LlmError` instead of handing callers an empty string to parse.
  **Phase 3 must budget `maxTokens` generously** — reasoning alone used ~94
  tokens on a trivial prompt.

**Live OAuth round-trip — PASSED 2026-07-25:**
- Real `xoxp-` user tokens (82 chars) + bot tokens stored in
  `SlackInstallation` for workspace **BOOM** (`T0BEJLG8H1U`). No token was
  pasted in by hand — the full browser approval flow was exercised
  (`/api/slack/oauth/start` → Slack → `/api/slack/oauth/callback` →
  `/?slack_connected=1`).
- `GET /api/health` now reports **`slack: ok`** — "authenticated as
  `U0BK9FR4Y1M` in BOOM" via a real `auth.test` — alongside `db: ok` and
  `llm: ok`.

**Local HTTPS instead of a tunnel (setup change made during this phase):**
The ngrok tunnel originally in `.env` is unusable on this network: an ISP
content filter (safebrowse.io, Comcast resolvers) blocks `*.ngrok-free.dev` on
both IPv4 and IPv6 — TLS handshake failure on 443, `302` to a warning page on
80 — while `ngrok.com` itself resolves fine and the ngrok agent reports the
tunnel healthy. The filter also proved to be *intermittent*: it briefly lifted,
then re-engaged mid-session.

No tunnel is actually required: Slack events arrive over Socket Mode, and the
OAuth callback is only a browser redirect. So `.env` now uses
`https://localhost:3000` (the value `.env.example` and `SLACK_APP_SETUP.md`
already documented as the default; the ngrok values are kept commented out).

`npm run dev:https` had a real footgun that this exposed: bare
`next dev --experimental-https` shells out to `mkcert -install`, which needs an
interactive sudo password to add a CA to the system trust store, and when that
prompt can't be answered **Next silently falls back to plain HTTP** — the
server looks healthy while Slack rejects every redirect URI. The script now
generates a cert with openssl via `npm run certs` (idempotent) and passes it
explicitly with `--experimental-https-key/--experimental-https-cert`. Verified
serving `https://localhost:3000`. `*.pem` and `/certificates/` were already
gitignored.

**Open question for the user (not blocking):** two installation rows exist for
workspace BOOM — the flow was run twice under two different Slack accounts
(`U0BEHBXNGHK`, then `U0BK9FR4Y1M`). This is not a dedup bug;
`saveInstallation` correctly upserts on `(teamId, authedUserId)`, so distinct
users are distinct rows. But SlackZero is single-user, and
`getInstallation()` returns the most recently updated row — currently
`U0BK9FR4Y1M`. **Phase 1's backfill will therefore ingest `U0BK9FR4Y1M`'s
DMs.** If that's the wrong account, delete the stray row before backfilling.

**Objective:** Empty-but-running app, with a real Slack app configured and
OAuth working end to end.

**Tasks:**
- Scaffold Next.js + TypeScript + Tailwind project
- Set up Prisma + Postgres (local, e.g. docker-compose for dev DB)
- Create `.env.example` documenting all required env vars (Slack client
  id/secret, signing secret, app token for socket mode, Hack Club AI key,
  DB url)
- Write a `SLACK_APP_SETUP.md` with step-by-step instructions for creating
  the Slack app in the Slack API dashboard (scopes needed: at minimum
  `im:history`, `im:read`, `im:write`, `channels:history`, `groups:history`,
  `mpim:history`, `users:read`, `chat:write`, `reactions:read`)
- Implement Slack OAuth flow (connect button → OAuth → store token)
- Health check page confirming: DB connected, Slack token valid (test API
  call like `auth.test`)

**Verification:**
- `npm run dev` boots with no errors
- OAuth flow completes and a valid Slack token is stored
- `/api/health` returns DB + Slack connection status as OK
- Basic test: OAuth callback route unit tested with mocked Slack response

---

## Phase 1: Slack Data Ingestion
**Status:** Not started

**Objective:** Pull real DM, mention, and thread data from Slack into our DB.

**Tasks:**
- Data models (Prisma schema): `Message`, `Conversation`, `User`,
  `Classification`, `ViewDefinition`, `MessageState` (done/snoozed/waiting-on)
- Initial backfill job: fetch recent DMs, mpims, and channel mentions for the
  authed user via Slack Web API
- Socket Mode listener for live events (new messages, reactions, thread
  replies) to keep data fresh without polling
- Normalize Slack's message format into our internal `Message` model
  (handle threads, edits, deletes)
- Basic dedup/idempotency so re-ingesting doesn't create duplicates

**Verification:**
- Backfill script run against a real (or sandboxed) Slack workspace produces
  correct row counts matching what's visible in Slack
- Unit tests for the Slack→internal message normalization function,
  including edge cases (threaded reply, edited message, message with
  reactions)
- Live test: send a DM in the test workspace, confirm it appears in DB
  within a few seconds via Socket Mode

---

## Phase 2: Unified Inbox UI Core
**Status:** Not started

**Objective:** A working queue UI — not smart yet, just fast.

**Tasks:**
- Single unified queue view merging DMs + mentions + threads, sorted by
  recency
- List item component: sender, preview, channel/DM context, timestamp
- Reading pane / split view (select item → view full content without losing
  queue position)
- Keyboard nav: `j`/`k` move, `Enter` open, `e` mark done, `Esc` back to list
- "Done" state persisted (separate from Slack's read/unread)
- Command palette (`⌘K`) for jumping to a channel/person/view

**Verification:**
- Playwright e2e: load queue, navigate with `j`/`k`, mark an item done,
  refresh page, confirm done state persisted
- Manual checklist in PR description confirming keyboard shortcuts all work
- No message requires more than one click+read to triage (design check, not
  automated)

---

## Phase 3: AI Triage Engine
**Status:** Not started

**Objective:** Urgency scoring and action/misc classification via Claude.

**Tasks:**
- Classification pipeline: for each ingested message, call Anthropic API to
  produce: `urgency_score` (0-100), `category` (action_needed | misc |
  fyi), `is_bump` (bool, references original message if detected), `reason`
  (short explanation, for debugging/trust)
- Batch classification on ingestion (don't block the ingestion pipeline —
  queue it async)
- Bump detection logic: identify "any update on this?" style follow-ups,
  link them to the original ask, and collapse them in the recency sort
  (surface staleness instead of re-bumping the item to "new")
- Sort-by-urgency mode in the UI, sort-by-recency-with-bumps-collapsed mode
- Store classification reasoning so scores are debuggable, not a black box

**Verification:**
- Unit tests with a fixed set of sample messages (hand-labeled expected
  category/urgency) — track classification accuracy against this labeled set
- Test bump collapsing specifically: a 3-message bump chain should appear as
  1 item showing "first asked X days ago"
- Manual spot-check: run classification against real inbox data, confirm
  action_needed messages are actually action-needed (no automated way to
  fully verify AI judgment, so this is a human review step — log results in
  the PR)

---

## Phase 4: Custom Views & Filters
**Status:** Not started

**Objective:** Saved views like the Slack screenshot, but with our AI
dimensions available as filters.

**Tasks:**
- View builder UI: name, layout (detailed/dense), filters (action_needed,
  misc, mentions, threads, VIP, has_bump, channel/DM scope), sort
  (newest/oldest/urgency/VIP-unreads-on-top)
- Persist views (`ViewDefinition` table), list saved views in sidebar
- Default views shipped out of the box: "Needs Reply", "Waiting Room"
  (FYI/misc), "Everything"
- View switching without full page reload

**Verification:**
- Playwright e2e: create a custom view with 2 filters, save, reload app,
  confirm view persists and filters correctly
- Unit test the filter-matching logic directly (given N messages + a filter
  set, correct subset returned)

---

## Phase 5: Reply & Compose
**Status:** Not started

**Objective:** Respond to Slack messages without leaving the queue.

**Tasks:**
- Inline reply box in the reading pane, sends via Slack `chat.postMessage`
  (or thread reply API as appropriate)
- AI-drafted reply suggestions for common patterns (ack, scheduling,
  approval) — one-key accept and send, or edit first
- Optimistic UI update + rollback on send failure
- After reply sent, auto-mark item done (configurable)

**Verification:**
- Playwright e2e: reply to a test DM from the queue, confirm message appears
  in actual Slack workspace, confirm item auto-marked done
- Unit test the reply-draft prompt/response parsing
- Failure-path test: simulate Slack API error on send, confirm UI shows
  error and does not falsely mark done

---

## Phase 6: Snooze, Waiting-On, Follow-Ups
**Status:** Not started

**Objective:** Time-shifting and tracking outstanding asks.

**Tasks:**
- Snooze action with time picker (later today / tomorrow / next week /
  custom), removes item from queue until snooze time, then reinjects
- Background job to reinject snoozed items at the right time
- Auto-unsnooze early if new activity happens on that thread before the
  snooze time
- "Waiting on others" detection: messages the user sent that ask a
  question/request and haven't gotten a reply — separate view, with
  staleness indicator
- Follow-up nudge: surface "waiting on" items that have gone quiet past a
  threshold

**Verification:**
- Unit test snooze reinjection scheduling logic (given a snooze time, item
  reappears at/after that time, not before)
- Test early-unsnooze-on-new-activity path
- Unit test "waiting on" detection against labeled sample conversations

---

## Phase 7: Analytics & Stats
**Status:** Not started

**Objective:** Superhuman-style stats to build the habit and show impact.

**Tasks:**
- Response time tracking (time from message received → done/replied)
- Daily/weekly summary: items triaged, avg response time, items still open
- Simple stats dashboard page

**Verification:**
- Unit test response-time calculation against fixture data with known
  timestamps
- Playwright check that dashboard renders with real data without errors

---

## Phase 8: Polish, Error Handling, Docs
**Status:** Not started

**Objective:** Make it robust enough for daily personal use.

**Tasks:**
- Rate-limit handling for Slack API (backoff/retry)
- Error boundaries and toast notifications for failures throughout the app
- Loading/empty states for every view
- README with setup instructions (link to SLACK_APP_SETUP.md)
- Full keyboard shortcut cheat sheet (in-app `?` overlay)

**Verification:**
- Full Playwright suite (all previous e2e tests) green in one run
- Manual smoke test: use the app for real triage of the connected
  workspace's actual DMs for one session, log any friction/bugs found in a
  final `KNOWN_ISSUES.md`

---

## Done Criteria for the Overall Project
All 8 phases marked `Done`, full test suite green, and a working app that can
OAuth into a real Slack workspace, ingest DMs/mentions, classify and sort
them, and let a user triage through the queue with keyboard shortcuts,
sending real replies back to Slack.