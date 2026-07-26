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
**Status:** Done — all three verification bullets pass, including the live
Socket Mode round-trip (completed 2026-07-25). Live coverage is *new message*
ingestion only; the edit, delete, and reaction paths are fixture-tested but
have not been observed against live Slack.

**Objective:** Pull real DM, mention, and thread data from Slack into our DB.

**What was built (2026-07-25):**
- `src/lib/slack/raw.ts` — narrow structural types for the Slack payload fields
  we actually read. Nothing downstream imports `@slack/web-api` response types.
- `src/lib/slack/normalize.ts` — the ingestion boundary. Pure functions
  (no DB, no network, no clock), which is what makes verification #2 possible
  without a live workspace.
- `src/lib/slack/ingest.ts` — persistence. Every write upserts on a
  Slack-owned identity, so re-ingestion converges instead of duplicating.
- `src/lib/slack/backfill.ts` + `npm run backfill` — the backfill job.
- `src/lib/slack/socket.ts` + `npm run socket` — the Socket Mode listener.
- `scripts/verify-backfill.ts` + `npm run backfill:verify` — recounts Slack
  independently of the ingestion code and diffs it against Postgres.

**Backfill scope decision:** plan.md says "recent DMs, mpims, and channel
mentions", so backfill reads history for IMs/mpims only and reaches channels
solely through `search.messages` mention hits. It does *not* pull full history
for every channel in the workspace. `conversations.list` and `users.list` are
still enumerated in full, because a `Conversation`/`User` row is needed to
render any message that references them.

**Deliberately NOT done here** (later phases own these): no LLM/classification
call anywhere in the ingest path (Phase 3 — and CLAUDE.md requires ingestion
never block on it), no queue UI (Phase 2), no snooze/done state written
(Phases 2/6). The `Classification`, `MessageState`, and `ViewDefinition`
tables are created by the migration but nothing reads or writes them yet.

**Verified 2026-07-25:**
- **#1 Backfill row counts.** Ran against the real BOOM workspace as
  `U0BK9FR4Y1M`. First run: 11 users, 13 conversations (10 public channels +
  3 IMs), 2 messages, 1 mention, 0 threads. Cross-checked with
  `npm run backfill:verify`, which re-reads Slack directly rather than reusing
  the ingestion code, so a shared bug cannot hide the mismatch — all five
  counts matched. Re-running backfill reported `0 created` with unchanged
  totals, confirming idempotency.
  - Only 2 messages because the workspace genuinely has almost no DM traffic:
    the self-DM is empty, and the one real DM contains a single "hello".
  - `D0BKMJ9KLPP` (the Slackbot DM) is returned by `conversations.list` but
    answers `channel_not_found` to `conversations.history`. Recorded as a
    skipped conversation rather than crashing the run; the row exists with
    `lastSyncedAt` null.
- **#2 Normalization unit tests.** 52 tests in `normalize.test.ts` covering all
  three edge cases plan.md names (threaded reply, edited message, message with
  reactions) plus bot messages with no user id, `message_changed` /
  `message_deleted` / tombstone events, `channel_join` noise, and ts parsing.
  Fixture-driven; no live Slack. Plus 8 in `ingest.test.ts` (reaction merge
  idempotency) and 14 in `socket.test.ts` (event routing, DB mocked).
  Suite total: **126 tests, 8 files**, up from 55/5.
- **#3 Live Socket Mode test — PASSED.** With `npm run socket` connected, six
  real DMs were sent from `U0BEHBXNGHK` to `U0BK9FR4Y1M` in `D0BKMJLRRNH`
  ("yolo", "testing", "hello", "you there?", "hola", "como estas"). All six
  landed in Postgres with `source = EVENT`, **0.38s–1.85s** between Slack's
  `ts` and our `firstSeenAt` — comfortably inside plan.md's "within a few
  seconds". Each was ingested exactly once despite two installations existing
  for this workspace, confirming the `(conversationId, ts)` dedup. Afterwards
  `npm run backfill:verify` still reported all counts matching (Slack 7 DM
  messages / DB 7), so the event path and the backfill path agree.
  - The six rows were spot-checked in Postgres: each joins to conversation
    `D0BKMJLRRNH` (`kind IM`, correct `peerUserId`), resolves its author to the
    real `User` row for `dsg` rather than a stub, and carries no Slack-only
    fields — `client_msg_id`, `user_profile`, `source_team` and friends are all
    dropped at the boundary. `blocks` holds Block Kit verbatim, which is the
    one documented deliberate exception.
  - Re-running backfill afterwards, so it re-read all six live rows, reported
    `0 created / 8 updated` with 8 distinct `(conversationId, ts)` pairs across
    8 rows. That is a stronger idempotency check than the earlier one, because
    the collisions were real rows written by the *other* ingestion path.
  - **Caveat, stated plainly:** the live run exercised *new message* ingestion
    only. The edit, delete, and reaction paths were not triggered against live
    Slack — they are covered by fixture tests in `normalize.test.ts` and
    `socket.test.ts`, but have not been observed end to end. Worth a real
    edit/reaction spot-check during Phase 2.

**Three bugs found and fixed while verifying:**
- `upsertMessage` overwrote `source` on every update, so a backfill re-reading
  a message that had arrived live flipped it `EVENT` -> `BACKFILL`. Since
  `source` is meant to record how a message was *first* seen, this erased the
  only evidence in the data that the Socket Mode path had worked. Found while
  setting up the post-live dedup check. `source` is now written on insert only.
- The mention pass overwrote conversation metadata. `search.messages` returns a
  much thinner `channel` object than `conversations.list` — no `is_member`, no
  `is_archived`, no topic — so routing it through the normal upsert silently
  downgraded `#happenings` from `isMember: true` to `false`. Caught by diffing
  the DB against the recon dump. Fixed with a separate
  `ensureConversationFromReference()` that creates a row if missing and never
  touches an existing one; `conversations.list` stays the authority for
  metadata.
- `e2e/smoke.spec.ts` asserted `Not connected yet.` unconditionally, which only
  holds against an empty database. It has been failing since Phase 0's OAuth
  round-trip stored an installation (Phase 0's "e2e 3/3" was recorded before
  that). Rewritten to assert the invariant that actually holds — the page
  renders exactly one of the two connection states with the matching action
  link.

**Note on Slack ts parsing:** `parseSlackTs` splits the string rather than
computing `Number(ts) * 1000`. The float form sits at the edge of double
precision and can round the millisecond the wrong way; there is a regression
test for this.

**Note on the two installation rows** (carried over from Phase 0): backfill
ingested `U0BK9FR4Y1M`, as `getInstallation()` selects. This did not block
anything. Socket Mode does not filter on authorization — when two users in one
workspace have installed the app, Slack delivers the same message once per
authorization, and the `(conversationId, ts)` upsert collapses the duplicate.
Filtering instead would risk dropping a message whose envelope names the other
account.

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
**Status:** Done — all three verification items addressed (2026-07-25). The
Playwright round-trip and the keyboard checklist pass; the "one click+read to
triage" design check is a judgment call and is answered honestly below.

**Objective:** A working queue UI — not smart yet, just fast.

**What was built (2026-07-25):**
- `src/lib/queue/queue.ts` — the queue model. Pure: inclusion rules
  (`queueReasonFor`), labelling, recency sort, display filters, selection
  arithmetic. Takes plain rows and lookup maps, never Prisma or the network,
  which is what makes the rules fixture-testable.
- `src/lib/queue/text.ts` — Slack `mrkdwn` → plain text. The one place that
  knows `<@U…>` / `<#C…|name>` / `<https://x|label>` / `&amp;`. Without it the
  UI would render raw Slack tokens, which is precisely the leak CLAUDE.md
  forbids.
- `src/lib/queue/time.ts` — relative timestamps, with `now` passed in rather
  than read, so SSR and hydration agree.
- `src/lib/queue/load.ts` — the IO half: reads Postgres, calls the pure
  functions, returns a serializable `InboxData`. Server-side only.
- `src/lib/queue/actions.ts` — `setMessageDone` server action, writing
  `MessageState` (the table Phase 1 created for this).
- `src/lib/keyboard/shortcuts.ts` — key event + mode → action, as a pure
  function. `src/lib/palette/search.ts` — palette matching/ranking, also pure.
- `src/app/inbox/*` — the split view: `page.tsx` (server), `InboxClient.tsx`,
  `QueueList.tsx`, `ReadingPane.tsx`, `CommandPalette.tsx`.

**Route decision:** the queue lives at **`/inbox`**, not `/`. `/` stays the
setup/status page and gains an "Open inbox →" link. Moving the setup screen
would have meant editing the OAuth callback's redirect target and the Phase 0
unit tests that assert it, for no functional gain. Phase 8's polish pass is the
natural place to revisit what `/` should be.

**Queue inclusion rules** (all unit tested): DMs and group DMs; channel
messages that @-mention the authed user; replies in threads the authed user
participates in. Excluded: soft-deleted messages, membership/administrative
subtypes, and the user's own messages — you do not triage yourself, and Phase 6
owns the "waiting on others" view where sent messages resurface.

**Done semantics:** done items leave the queue by default (inbox zero), with
`u` / a header toggle to reveal them. The write is optimistic, and rolls back
with an error banner if the server action fails.

**Verified 2026-07-25:**
- **#1 Playwright e2e — PASSED.** `e2e/inbox.spec.ts`, 7 tests, all green in a
  full-suite run (`npm run test:e2e` → **10/10** including the 3 Phase 0/1
  smoke tests). The required round-trip is one test: load the queue, `j` to the
  second item, `e`, confirm it leaves the list, wait for the server to confirm
  the write, **full page reload**, re-scope, confirm it is still absent, then
  `u` and confirm it is present and flagged done. Undo is covered too.
  - The spec seeds its own fixtures (`e2e/fixtures/seed.ts`) in an `E2E` id
    namespace that cannot collide with real Slack ids, and narrows the queue to
    the fixture channel through the palette, so no assertion depends on what
    the live workspace happens to contain. Fixtures are re-seeded before each
    test and deleted afterwards; the real ingested rows were re-counted after
    the run and are unchanged (8 messages / 13 conversations / 11 users, 6 of
    the messages still `source=EVENT`).
  - It skips with a clear message if no `SlackInstallation` exists, since a
    channel mention cannot be attributed without an authed user.
- **#2 Keyboard checklist.** `j`/`k`/`Enter`/`e`/`Esc`/`⌘K` plus `u` and `g`/`G`
  all verified by driving a real browser; the first six are also asserted in the
  committed e2e suite. See the handoff notes for the item-by-item table.
- **#3 Design check** — see "Honest assessment" below.
- `npm run test` → **13 files / 258 tests** (up from 8/126). `npx tsc --noEmit`,
  `npm run lint`, `npm run build` all clean.

**One real bug found while verifying:** the done write is optimistic, so every
post-`e` assertion passed from client state while the server action was still
in flight — and `page.reload()` **aborted the request**, losing the write. The
first e2e run caught it (`expected 6, received 7` after reload). The fix is not
a test-only wait: the UI now tracks in-flight and server-confirmed saves,
renders a "Saving…" indicator, and exposes both counts as data attributes so
the test has a real sync point. A user navigating away mid-save had the same
silent-loss problem.

**Deliberately NOT done here** (later phases own these): no classification,
urgency sort or bump collapsing (Phase 3); no view builder or saved views
(Phase 4) — the palette scopes the queue to a channel/person, which is what
plan.md asks of it, and `PaletteEntry.kind` already has a slot for views; no
reply box (Phase 5); no snooze (Phase 6). `r` and `h` are deliberately left
unbound so those phases can claim them without changing an existing meaning.

**Honest assessment of the "one click+read to triage" design check:** it holds
for the common case and I believe the claim, with one caveat.
- The reading pane always shows the *full* body of the selected message, so
  selecting is reading — there is no click between "see it in the list" and
  "know what it says". `e` then triages it and the next item slides under the
  cursor. Steady-state triage is `e e e` with `j` only to skip. Zero clicks.
- `Enter` is not needed to read; it only moves DOM focus into the pane so
  space/PgDn scroll a long message. That is the honest reason it exists.
- **The caveat:** a thread parent shows its replies inline, but a message that
  is *itself* a reply shows only itself — you cannot see the rest of that
  thread without going to Slack. With zero threads in the connected workspace
  this is untested against real data (the coverage is seeded fixtures). It is
  the most likely place the claim breaks in practice, and it is worth fixing in
  Phase 3 or 5 when thread context matters more.
- Also unquantified: nothing here is smart yet, so "one read to triage" assumes
  the queue is short. The claim is about interaction cost per message, not
  about the queue being the right length. That is Phase 3's job.

**Phase 1 follow-up not attempted:** Phase 1 suggested spot-checking the edit /
delete / reaction paths against live Slack during this phase. That was not
done — it needs a live Socket Mode session and manual Slack interaction, and it
audits Phase 1's ingestion rather than Phase 2's UI. The UI renders `isEdited`,
`reactions` and filters `isDeleted`, all fixture-tested; the live gap Phase 1
recorded is still open.

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
**Status:** Done — all three verification items pass. See "Findings" below; the
headline one is that **urgency scores are not reproducible at `temperature: 0`**
(±20 points run to run), while category and `is_bump` are.

**Objective:** Urgency scoring and action/misc classification via the
Hack Club AI proxy.

**Tasks:**
- Classification pipeline: for each ingested message, call **Hack Club AI**
  (`qwen/qwen3-32b` via `src/lib/llm/client.ts`) to
  produce: `urgency_score` (0-100), `category` (action_needed | misc |
  fyi), `is_bump` (bool, references original message if detected), `reason`
  (short explanation, for debugging/trust)
  *(This bullet previously said "call Anthropic API" — stale wording from before
  the 2026-07-24 decision to use Hack Club AI with a small open-weight model for
  per-message work. CLAUDE.md and the Architecture section above are the
  authority; corrected here in Phase 3.)*
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

**Verified 2026-07-26** (`qwen/qwen3-32b` via Hack Club AI):
- `npm run test` → **348 tests / 16 files** (was 274/13). `npx tsc --noEmit`,
  `npm run lint`, `npm run build` clean; `npm run test:e2e` **10/10**.
- **Bump collapsing (verification #2):** a 3-message chain collapses to exactly
  1 row, the survivor is the *original ask* keeping its own timestamp, and
  `bumpStalenessLabel` renders the literal `"first asked 5 days ago"` that
  plan.md asks for. Also covered: chase-of-a-chase, model-invented cycles,
  peak-urgency propagation, and the case where the original is gone (oldest
  survivor stands in rather than the chain vanishing).
- **Labeled-set accuracy (verification #1):** 20 hand-labeled fixtures, 18
  unambiguous. Category **17/18 (94%)**, `is_bump` **18/18 (100%)**.
  `npm run triage:eval` runs them against the live model; `fixtures.test.ts`
  scores committed recordings so `npm run test` stays offline.
- **Real-data spot-check (verification #3):** all 8 ingested messages
  classified, 0 failed, 8 requests used of the 450/30min budget. Every row
  stored a non-empty `reason`. Judgements were defensible: greetings/"yolo"/
  "testing" → `misc` 0-10; `"you there?"` → `action_needed` 35; a bare
  `@`-mention → `action_needed` 20.
  **Caveat:** the workspace contains only greetings and test messages, so this
  confirms the pipeline runs end to end without producing nonsense — it does
  **not** validate `action_needed` detection on substantive content. The fixture
  set carries that weight until there is real traffic.

**Findings:**
1. **Urgency is not reproducible; category and `is_bump` are.** Across three
   full live runs of the same 20 fixtures at `temperature: 0`, every category
   and every `is_bump` was identical, but urgency moved by up to 20 points
   (`prod-outage` 70/85/90, `bump-gentle-ping` 50/70/70). This matters beyond
   test flakiness: the display bands in `types.ts` have hard edges (80 = "Now"),
   so a message can change band between runs without its content changing.
   CLAUDE.md anticipates this ("urgency score can have some tolerance, category
   should not flip-flop"), so the suite gates category strictly and urgency with
   a ±15 tolerance plus ordering invariants, while still *tracking* and printing
   the exact-band rate.
2. **The first set of committed recordings was not reproducible.** They scored
   100%/100% offline, but re-running the same fixtures live scored 94%/61%, and
   `urgent-word-but-social` had been recorded as `misc @ 5` while the live model
   now says `fyi @ 30-50` consistently (5/5 on a repeat run). Recordings have
   been refreshed from a real run so the offline number reflects real behaviour.
   Anyone regenerating them should re-run `npm run triage:eval` rather than
   trusting a stale capture.
3. **The one genuine category miss is worth keeping:** `urgent-word-but-social`
   ("URGENT: someone left a whole cake in the kitchen 🎂") is labeled `misc` but
   the model calls it `fyi`. The label was not softened to make the suite pass —
   the model is reading a joke as an announcement.

---

## Phase 4: Custom Views & Filters
**Status:** Done — both verification items pass.

**Verified 2026-07-26:**
- `npm run test` → **387 tests / 17 files** (was 348/16); `npx tsc --noEmit`,
  `npm run lint`, `npm run build` clean.
- `npm run test:e2e` → **18/18** (8 new in `e2e/views.spec.ts`).
- **Filter-matching unit tests (verification #2):** 39 tests over every
  dimension (category, reason, VIP, has-bump, classified-only, min-urgency,
  scope, include-done), their combinations, all four sorts, and the
  `parseViewFilters` persistence edge.
- **e2e (verification #1):** a custom view with **two** filters
  (`action_needed` + VIP-only) is created, saved, the page is fully reloaded,
  the view is still there and still filters correctly. The test then revokes the
  sender's VIP status and re-checks that the view empties — proving the two
  filters are ANDed rather than one of them doing all the work.
- Built-ins seed themselves on first load (verified in the DB: "Needs Reply",
  "Waiting Room", "Everything"), and view switching is asserted not to reload
  the page.
- Real Slack data re-counted afterwards and unchanged: 6 `EVENT` + 2 `BACKFILL`
  messages, 13 conversations, 11 users, 8 real classifications, and **0**
  leftover `E2E ` views.

**Design notes:**
- `ViewDefinition.filters` stays a Json column: the filter vocabulary will keep
  growing (Phase 6 adds snoozed/waiting-on) and a column per checkbox would be
  absurd. The cost is that the JSON is untrusted, so `viewFiltersSchema`
  validates writes and `parseViewFilters` tolerates unreadable reads by
  degrading to "no filters" rather than crashing the inbox.
- An **empty filter array means "no constraint"**, not "match nothing" — a
  half-built view in the builder would otherwise show an empty queue and read as
  broken.
- A category filter **excludes unclassified rows**, since they have no category
  to match. They are not hidden from unfiltered views: classification is async
  and an unrated message is a normal state. There is an e2e test for exactly
  this asymmetry.
- `u` (show done) and the palette scope override a view rather than mutating it;
  they are transient UI state, not part of the saved definition.
- **VIP needed a new field.** plan.md lists VIP as both a filter and a sort, but
  nothing in Slack's API carries it — it is our own judgement about a person, so
  `User.isVip` was added (migration `20260726145839_phase4_view_filters_and_vip`).
- Deleting a built-in view is **refused**, not ignored: it would be re-seeded on
  the next empty-table check, so "deleting" one would appear to work and then
  undo itself.

**Two test-infrastructure bugs this phase exposed (both pre-existing):**
1. **The e2e suite could not run in parallel.** `fullyParallel: true` plus a
   single local Postgres and a shared fixture id namespace meant two spec files
   deleted each other's rows mid-test. It was latent while only one spec seeded
   data (`mode: 'serial'` covered it within a file); adding Phase 4's suite
   exposed it immediately. Now `workers: 1`, with the reasoning recorded in
   `playwright.config.ts`. Per-file namespaces would restore parallelism, but the
   whole suite runs in ~25s.
2. **Phase 2's "newest first" assertions were passing for the wrong reason.**
   They relied on the fixtures having *no* classifications: with every row
   unrated the urgency sort falls through to recency, so the two orders
   coincided. Seeding real categories broke them — correctly. The Phase 2 helper
   now pins the sort to recency explicitly, so those tests assert the mode they
   actually mean.

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
**Status:** Done — all three verification items pass, including the live send
(completed 2026-07-26).

**Verified 2026-07-26:**
- `npm run test` → **448 tests / 20 files** (was 387/17); `npx tsc --noEmit`,
  `npm run lint`, `npm run build` clean; `npm run test:e2e` → **24 passed,
  1 skipped** (the skip is the live send, see below).
- **Draft prompt/response parsing (verification #2):** 30 unit tests. The parser
  skips individual malformed drafts and throws only when nothing usable
  survives — offering two of three beats offering none.
- **Failure path (verification #3):** 15 unit tests in
  `src/lib/reply/actions.test.ts`. The central one asserts that when Slack
  rejects the send, the error surfaces and `MessageState` is **never** written.
  Covered alongside it: rate limiting, an empty reply, a deleted message, a DB
  failure, and the mirror case — once the reply is really in Slack, a failed
  done-write must still report success, because telling the user the send failed
  makes them send it twice.
- 14 more tests over `send.ts` (thread routing, `ok:false`, missing `ts`).

**Live send — PASSED 2026-07-26 (verification #1):**
A reply was sent by hand from `/inbox` and confirmed from three directions:
- **It reached Slack.** `conversations.history` on `D0BKMJLRRNH` shows
  `"yes i am there, hello"` from the authed user `U0BK9FR4Y1M`, ts
  `1785085914.137779`.
- **The item was auto-marked done.** `"you there?"` has `isDone: true`,
  `doneAt 17:11:54.141` — **4ms after** the message's own Slack timestamp of
  `17:11:54.137`. That gap is the proof the designed order held: send first,
  then mark done. Had it been the other way round, a failed send would have
  silently removed the item from the queue.
- **The round trip closed.** The reply was ingested back over Socket Mode
  (outgoing message count went 0 → 1), so the write path and the read path agree.

The automated version of this check lives in `e2e/reply.spec.ts` ("sending for
real") and remains **opt-in** behind `SLACKZERO_E2E_LIVE_SEND=1`, because it
posts a real message into the connected workspace. A suite that messages a
colleague every time someone types `npm run test:e2e` is a hazard, not a test.

**Deliberate deviation from the task list:**
plan.md asks for AI drafts with "one-key accept and send". Clicking a draft
**fills the compose box; it does not send.** Live testing (`npm run draft:eval`)
showed the model inventing specifics that would be one keystroke from a
colleague — it produced `"Approved the staging access request."` (a flat claim
that an action already happened) and `"How about 10 AM tomorrow?"` (a time
invented from nothing). Tightening the system prompt fixed both — it now
requires approval be phrased as an intention and a missing detail be left as a
`[time]`/`[date]` blank — and `hasPlaceholder()` flags any remaining blank so the
UI can mark that draft as needing an edit. But a small model that has
demonstrably invented facts once should not have a one-key path to sending, so
the accept step stops at the box. Revisit if a future model earns it.

**Findings:**
- **Tightening the prompt caused truncation.** More rules to weigh means more
  hidden reasoning, and `DRAFT_MAX_TOKENS: 1600` started returning
  `finish_reason: 'length'` with zero content. Raised to **3000** and confirmed
  clean over two full `draft:eval` runs. This is the Phase 0 trap again: anyone
  editing the drafting prompt must re-run `npm run draft:eval` and expect to move
  that number with it.
- **The e2e suite was silently breaking the dev server.** Playwright's
  `webServer` ran `next build && next start` into the same `.next` a running
  `npm run dev` serves from, so after any e2e run the dev server 404'd its own
  stylesheet and rendered completely unstyled — which reads as a broken app, not
  a clobbered build directory. The e2e build now goes to `.next-e2e` via
  `NEXT_DIST_DIR` (`next.config.mjs`, `playwright.config.ts`, gitignored), and
  the fix was verified by running the full suite and re-checking that the dev
  server's CSS survived it. This had been true since the first e2e run of the
  session.
- `r` and `d` were left unbound in Phase 2 with a test asserting it, so a key
  could not mean two things across phases. Phase 5 claims them, so that guard was
  moved rather than deleted — `h` is still reserved for Phase 6.

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
**Status:** Done — all three verification items pass.

**Verified 2026-07-26:**
- `npm run test` → **524 tests / 22 files** (was 448/20); `npx tsc --noEmit`,
  `npm run lint`, `npm run build` clean; `npm run test:e2e` → **29 passed,
  1 skipped** (the skip is Phase 5's opt-in live send).
- **Snooze reinjection scheduling (verification #1):** 29 unit tests. The
  boundary is pinned explicitly — at exactly `snoozedUntil` the item is back,
  because plan.md says "at/after"; late by a millisecond is fine, early is a bug.
- **Early unsnooze on new activity (verification #2):** covered in the same
  file, including the case that makes it correct rather than merely present —
  activity is compared against `snoozedAt`, not `snoozedUntil`, so the message
  that *prompted* the snooze does not immediately wake it.
- **Waiting-on detection (verification #3):** 45 unit tests over a 22-entry
  hand-labeled set, asserted exactly (no threshold). Plus behaviour tests: a
  bump does not clear the ask it is chasing, a reaction counts as an answer, and
  only same-thread replies answer a threaded ask.
- 5 e2e tests for the round trip a unit test cannot cover: snooze removes the row
  and it is still gone after a full reload, a past custom time is refused, and a
  snoozed item is not resurrected by "show done".
- Both jobs run clean against real data: `npm run waiting:scan` scanned 8
  messages and reported 0 waiting-on, which is **correct** — every real message
  is inbound, so the user has no outstanding asks. `npm run snooze:sweep --once`
  found nothing due.

**Design notes:**
- **Waiting-on detection is rule-based, not model-based.** It runs over every
  message the user has ever sent — exactly the high-volume per-message work
  CLAUDE.md says not to spend a model on — and plan.md asks for it to be tested
  "against labeled sample conversations", which a rule can satisfy exactly.
  Phase 3 showed model output drifting between identical runs; a detector whose
  pass rate moved on its own would be worthless as a regression guard.
  The rules are deliberately conservative: a missed item is invisible, a false
  one nags the user to chase something that was never a question, which is how a
  follow-up feature gets switched off.
- **"Answered" is defined structurally** — anyone other than the user speaking
  later in the same thread (or conversation, if unthreaded). It cannot tell
  whether the reply actually addressed the ask. Judging that is precisely the
  per-message LLM work this module exists to avoid, so the limitation is
  accepted and documented rather than papered over.
- **Snooze is a sweep, not a timer per message.** A timer does not survive the
  process closing, and this tool is closed overnight — which is exactly when a
  "tomorrow morning" snooze elapses. The sweep is idempotent, so a missed run
  costs latency and never correctness. It runs on inbox load *and* from
  `npm run snooze:sweep`; the former covers "opened in the morning", the latter
  "already open when the time arrives".
- Snooze clears `isDone`: snoozing means "not now", which implies not handled.
- "Waiting on Others" sets `includeDone` — an ask you triaged out of the inbox
  is still an ask someone owes you an answer to.

**Two bugs found while verifying:**
1. **`NOT_AN_ASK` never matched anything.** The rhetorical-question patterns were
   anchored with `$`, but the candidate sentences arrive with their terminating
   `?` still attached, so "how are you?" was being reported as an outstanding
   ask. Caught by the labeled set on its first run — exactly what the labeled set
   is for. Fixed by stripping surrounding punctuation before matching.
2. **`listViews()` only seeded built-ins when the table was empty.** That looks
   equivalent to seeding what is missing and is not: "Waiting on Others" was
   invisible on every database that already had views, which is every existing
   install. Now seeds by absent name.

**Also fixed:** the snooze picker had its own `window` key listener, which raced
the inbox's global one — Escape both closed the menu and cleared the queue scope,
non-deterministically. `InboxClient` owns the keyboard for the whole inbox now;
one dispatcher, one outcome. `h` was reserved and asserted-unbound since Phase 2,
so that guard moved rather than disappearing.

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
**Status:** Done — both verification items pass.

**Verified 2026-07-26:**
- `npm run test` → **561 tests / 23 files** (was 524/22); `npx tsc --noEmit`,
  `npm run lint`, `npm run build` clean; `npm run test:e2e` → **34 passed,
  1 skipped** (the skip is Phase 5's opt-in live send).
- **Response-time calculation (verification #1):** 37 unit tests against fixture
  data with fixed timestamps. Every expected duration is written out rather than
  recomputed — a test that derives the value it checks proves nothing.
- **Dashboard renders with real data (verification #2):** 5 e2e tests at
  `/stats`, asserting HTTP 200, no `console.error`, and no uncaught page
  exception. Includes the round trip that makes it a measurement rather than a
  layout: mark an item done in the inbox, reload the dashboard, confirm the
  triaged count went up by exactly one.
- Rendered against the live database: 8 open, 0 waiting on, median response `—`
  (nothing triaged yet), 14-day series present.

**Design notes:**
- **Median is the headline, not mean.** Response times are heavily skewed — a
  handful of messages cleared after a holiday drags a mean far above anything the
  user recognises as their turnaround. Mean and p90 are shown alongside, because
  the gap between them is itself informative.
- **Nulls render as `—`, never as `0`.** A zero response time claims an instant
  turnaround; on a fresh install that is a lie. There is a dedicated e2e test
  asserting the empty state never shows `0s` or `NaN`.
- **`triaged` counts by when an item was *done*; `received` counts by arrival.**
  Those answer different questions ("how much did I get through today" vs "how
  much came in"), so both are reported rather than one standing in for the other.
  A message from last week cleared this morning is part of today's work.
- **Negative durations are clamped to zero.** Slack's `ts` is the sender's clock
  and `doneAt` is this machine's; they disagree by a second or two routinely, and
  one negative value would drag an average below zero.
- Quiet days appear in the series as zero-height bars rather than being omitted —
  a gap reads as missing data, a zero reads as a quiet day, and only one is true.
- The chart is CSS divs, not a charting library: plan.md asks for a "simple stats
  dashboard page", and a dependency plus a client bundle is not that.
- **Reply time is approximated structurally** — the first message the user sent
  in that conversation after the incoming one. It cannot tell whether that
  message actually answered it. This is the same simplification Phase 6 makes for
  waiting-on, for the same reason: judging it per message is exactly the
  high-volume LLM work CLAUDE.md rules out.

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
**Status:** Done — both verification items pass.

**Verified 2026-07-26:**
- `npm run test` → **577 tests / 24 files** (was 561/23); `npx tsc --noEmit`,
  `npm run lint`, `npm run build` clean.
- **Full Playwright suite green in one run (verification #1):** 42 tests across
  6 spec files, 41 passed + 1 skipped (Phase 5's opt-in live send).
- **Manual smoke test (verification #2):** every route exercised against the
  real workspace — `/` `/inbox` `/stats` `/health` `/api/health` all 200,
  `/no-such-page` 404, health reports `db: ok · slack: ok · llm: ok`, 0
  unclassified messages, no raw `<@U…>` tokens leaking into the HTML, and no
  errors or warnings in the dev server log. Findings written up in
  `KNOWN_ISSUES.md`.

**Built:**
- Root error boundary (`app/error.tsx`) showing the actual message — this is a
  single-user local tool and the "user" is the person who can fix it.
- `not-found.tsx`, and a loading state for `/stats`.
- `?` cheat-sheet overlay, rendered from `SHORTCUT_HELP` — the same list the
  footer uses and the same module that resolves keys, so it cannot drift into
  documenting a binding that no longer works. There is a test asserting the
  overlay row count equals `SHORTCUT_HELP.length` rather than a literal.
- `src/lib/slack/errors.ts`: translates Slack's terse codes into something
  actionable, and classifies each as retryable or not. 13 unit tests. Wired into
  the reply path, so a rate-limited send now says "wait ~20s" instead of
  `ratelimited`, and a permission failure says plainly that retrying will not
  help.
- `README.md` rewritten from the `create-next-app` boilerplate it still was.
- `KNOWN_ISSUES.md`, ordered by how likely each issue is to bite in daily use.

**On rate limiting:** `WebClient` was already configured with
`retryPolicies.fiveRetriesInFiveMinutes` and `rejectRateLimitedCalls: false`
since Phase 1, so backoff and retry were in place. What was missing was
*legibility* — a queued call is invisible, and an interactive send that silently
waits minutes on "Sending…" reads as a hang. That is what this phase added.

**The bug this phase introduced and then caught:**
A `loading.tsx` was added to `/inbox` and to the app root. Both were removed the
same day. A route-level Suspense boundary makes `revalidatePath('/inbox')` —
which **every** server action in the inbox calls — tear down and remount
`InboxClient`, discarding all of its state: sort mode, palette scope, selected
row, and the in-flight/confirmed save counters. In the UI, marking an item done
would visibly reset the inbox under the user.

Four e2e tests caught it (`inbox`, `snooze`, `stats`, `views` — every test that
writes and then reloads), and the giveaway was in the DOM attributes: `sort-mode`
had reverted from `recency` to `urgency` and `confirmed-saves` to `0`. Worth
recording because the fix is counter-intuitive — the "polish" change was the
regression. A note in `src/app/inbox/page.tsx` and in `KNOWN_ISSUES.md` warns
against re-adding it. `/stats` keeps its loading state safely, holding no client
state to lose.

---

## Remaining work

**Phase 5's live send is still unverified.** Everything else in all 8 phases is
green. The reply path has 60 unit tests including the failure path, but a reply
has never actually been posted to Slack from the app. Close it with either a
manual send from `/inbox`, or:

```bash
SLACKZERO_E2E_LIVE_SEND=1 npm run test:e2e -- e2e/reply.spec.ts
```

See `KNOWN_ISSUES.md` for the full list of what is thin, most of which comes
down to the connected workspace holding 8 trivial messages.

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