# SlackZero

A fast, keyboard-first Slack client for triaging DMs and notifications.
Superhuman, but for Slack instead of email.

It pulls your DMs, mentions and threads into one prioritized queue, classifies
each message with a small language model (urgency, action-vs-FYI-vs-misc, and
whether it is an "any update on this?" bump), and lets you fly through the queue
with `j`/`k`/`e` without touching the mouse.

**[Demo video](https://cdn.hackclub.com/019fbdb0-78f5-7d31-889f-e44dbe37ca99/Slack%20Zero%20Demo.mp4)** — a walkthrough of the queue, the reading pane, and triage in action.

![The inbox: one prioritized queue of DMs, mentions and threads](docs/screenshots/inbox.png)

## Try it without a Slack app

Demo mode runs the whole app against a seeded fake workspace: no Slack app, no
tokens, no network calls to Slack. It is the fastest way to see what the triage
queue actually does.

**With Docker (nothing else installed):**

```bash
docker compose -f docker-compose.demo.yml up --build
```

Then open <http://localhost:7001> and click **Enter the demo**.

**With the repo checked out and Node 20+:**

```bash
npm install
npm run demo:setup
npm run demo           # http://localhost:3000
```

Demo mode is off unless `SLACKZERO_DEMO=1`, and it refuses to start on a
database that holds a real Slack installation, It signs a visitor in without
Slack, so it must never be reachable on a connected install. Replies are
inert in the demo: there is no token, so there is nothing to send with.

## Screenshots

| | |
| --- | --- |
| **Reading pane** — the message, its thread, what came before it, and why the model scored it that way.<br><br>![Reading pane](docs/screenshots/reading-pane.png) | **Waiting on Others** — asks *you* sent that nobody has answered, oldest first.<br><br>![Waiting on Others](docs/screenshots/waiting-on-others.png) |
| **Stats** — median response time, triaged-per-day, current streak.<br><br>![Stats](docs/screenshots/stats.png) | **Shortcuts** — press `?` anywhere in the inbox.<br><br>![Keyboard shortcuts](docs/screenshots/shortcuts.png) |

## Connecting your own Slack workspace

Requirements: Node 20+, Docker (for local Postgres), a Slack workspace you can
install an app into (**use a test workspace, not production**), and optionally a
[Hack Club AI](https://ai.hackclub.com) key. The app runs without one, it just
will not classify.

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
<https://localhost:3000/api/health>. Connecting automatically imports up to ten
unread messages per DM or group DM, plus mentions and relevant thread replies.

Slack OAuth *is* the login: completing it as the owner sets the session cookie.
Set `SLACK_OWNER_USER_ID` so only your Slack account can sign in.

### Refreshing your messages

The initial import runs during OAuth. These refresh or verify it later:

```bash
npm run backfill              # pull recent unread DMs/mpims and mentions
npm run backfill:verify       # re-count against Slack, independently
npm run classify              # classify anything not yet rated
```

Optional background jobs, each safe to run or skip:

```bash
npm run socket                # live ingestion over Socket Mode
npm run snooze:sweep          # reinject snoozed items while the app is open
npm run waiting:scan          # find asks nobody has answered
```

## License
Licensed under the [MIT License](./LICENSE).

## AI disclosure

AI coding assistance was used during implementation, debugging and build verification. Product direction and final acceptance remained with me.