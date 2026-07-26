# Known issues

Written at the end of Phase 8, from the smoke test and from things found while
building. Ordered by how likely they are to bite you in daily use.

Nothing here is a crash — the app is usable. These are the places where it is
less capable than it looks, and where a future session should start.

---

## 1. Urgency scores are not reproducible

**What happens:** the same message classified twice can get urgency scores up to
20 points apart, at `temperature: 0`.

Measured over three full runs of the same 20 fixtures: every *category* and every
`is_bump` was identical each time, but `prod-outage` scored 70 / 85 / 90 and
`bump-gentle-ping` moved 50 / 70 / 70.

**Why it matters:** the display bands have hard edges (80 = "Now"), so a message
can change band between runs without its content changing. The urgency *sort*
is stable enough to be useful, but the exact number should not be treated as a
measurement.

**Status:** accepted, not fixed. CLAUDE.md anticipates it ("urgency score can
have some tolerance, category should not flip-flop"), and the category — the part
the queue actually branches on — is solid. The test suite gates category
strictly and urgency with a ±15 tolerance, and prints the exact-band rate so a
real regression is still visible.

## 2. "Answered" is detected structurally, not semantically

**What happens:** waiting-on detection (Phase 6) and reply-time stats (Phase 7)
both treat "someone else spoke later in this thread" as an answer. A reply of
"lol" clears an ask; a reply that changes the subject clears it too.

**Why it matters:** the "Waiting on Others" view will under-report. It will not
show you an ask that got a non-answer.

**Status:** deliberate. Judging whether each reply resolved each ask is a
per-message LLM call over your entire history, which is exactly the high-volume
spend CLAUDE.md rules out. The rules are conservative on purpose — a false
"you're waiting on this" is worse than a miss, because it trains you to ignore
the view.

## 3. Reply drafts invent specifics if you let them

**What happens:** the first version of the drafting prompt produced
`"Approved the staging access request."` — a flat claim that an action already
happened — and `"How about 10 AM tomorrow?"`, a time invented from nothing.

**Status:** mitigated, not eliminated. The prompt now forbids completed-action
phrasing and requires `[time]`/`[date]` blanks where a detail is missing, and
`hasPlaceholder()` flags any draft still containing one. Clicking a draft
**fills the compose box; it does not send**, which is a deliberate deviation from
plan.md's "one-key accept and send" — a small model that has demonstrably
invented facts should not have a one-key path into a colleague's DMs.

**If you edit the drafting prompt, re-run `npm run draft:eval`.** A longer prompt
makes the model reason more, and reasoning consumes the `max_tokens` budget
before any content is emitted. Tightening the prompt once truncated the response
to nothing until `DRAFT_MAX_TOKENS` was raised from 1600 to 3000.

## 4. Edits, reactions and deletions have only fixture coverage

**What happens:** nothing, as far as we know. But the Socket Mode paths for
`message_changed`, `message_deleted` and `reaction_added` have never been
exercised against a real Slack event — only against fixtures.

**Why:** during Phase 1's live test the messages sent were new messages only. No
edit or reaction ever arrived.

**How to close it:** with `npm run socket` running, edit a DM in Slack and add a
reaction to it, then check `isEdited` / `reactions` on that row.

## 5. Phase 5's live send has never been run

**What happens:** the reply path is covered by 60 unit tests, including the
failure path that matters most (a rejected send must not mark the item done).
But an actual reply has never been posted to Slack from the app.

**How to close it:** either send one by hand from `/inbox`, or run the gated
test:

```bash
SLACKZERO_E2E_LIVE_SEND=1 npm run test:e2e -- e2e/reply.spec.ts
```

It is opt-in because it posts a real message into the connected workspace. A
suite that messages a colleague on every `npm run test:e2e` is a hazard, not a
test.

## 6. The workspace has almost no data, so quality claims are thin

**What happens:** the connected workspace holds 8 messages — greetings, "yolo",
"testing" — all inbound, none threaded.

**Why it matters:** several claims are only fixture-verified in practice:

- classification quality on *real* `action_needed` content (there is none)
- bump collapsing against real bump chains (there are none)
- the "one click + read to triage" design goal for thread replies (no threads)
- waiting-on detection (no outgoing asks at all — `waiting:scan` correctly
  reports 0)

**How to close it:** use the app for a week on a workspace with real traffic,
then re-run `npm run triage:eval` and read the spot-check output from
`npm run classify`.

## 7. A thread *reply* shows without its parent

**What happens:** a thread parent shows its replies inline in the reading pane,
but a message that is itself a reply shows only itself. You have to open Slack
for the context.

**Status:** known gap from Phase 2, never closed because the workspace has no
threads to feel it with. Likely the first thing to fix once there is real data.

## 8. Operational sharp edges

- **`rm -rf .next` if the app renders unstyled.** That is the symptom of a
  build directory shared between `next dev` and `next build`. The e2e suite now
  builds into `.next-e2e` so it cannot cause this, but a stray `npm run build`
  while the dev server is up still can.
- **Use `npm run dev:https`, never bare `next dev --experimental-https`.** The
  bare flag shells out to `mkcert -install`, which needs an interactive sudo
  password, and Next **silently falls back to plain HTTP** when it cannot get
  one. The server looks healthy while Slack rejects every redirect URI.
- **Do not add a `loading.tsx` to `/inbox` or the app root.** A route-level
  Suspense boundary makes `revalidatePath('/inbox')` remount `InboxClient` and
  discard its state — sort mode, scroll position, selection, and in-flight save
  counters. Marking an item done visibly resets the inbox. `/stats` is safe
  because it holds no client state.
- **The e2e suite runs single-worker.** Every spec shares one local Postgres and
  a common fixture namespace; running them in parallel makes them delete each
  other's rows mid-test.
- **Classification is not automatic on ingest for a backfill.** Live messages are
  classified in the background as they arrive, but after `npm run backfill` you
  need `npm run classify`.
- **ngrok may be blocked on your network.** An ISP content filter
  (safebrowse.io, seen on Comcast) blocks `*.ngrok-free.dev` intermittently. Use
  `https://localhost:3000`; no tunnel is needed, because Slack events arrive over
  Socket Mode and the OAuth callback is only a browser redirect.

## 9. Two Slack accounts are connected

`SlackInstallation` holds rows for both `U0BEHBXNGHK` and `U0BK9FR4Y1M` in the
same workspace. This is not a bug — the upsert key is `(teamId, authedUserId)`,
so distinct users are distinct rows — but SlackZero is single-user and
`getInstallation()` returns the most recently updated, currently `U0BK9FR4Y1M`.
Everything is scoped to that account. Delete the other row if that is wrong.
