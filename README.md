# SlackZero

A keyboard-first slack client for your DM's and notifications!

**[Demo video](https://cdn.hackclub.com/019fbdb0-78f5-7d31-889f-e44dbe37ca99/Slack%20Zero%20Demo.mp4)**

![The inbox](docs/screenshots/inbox.png)

## Try it without a Slack app

Demo mode runs against a fake workspace, which are also used in tests.

**With Docker (nothing else gets installed):**

```bash
docker compose -f docker-compose.demo.yml up --build
```

Then open <http://localhost:7001> and click Enter the demo.

## Connecting your own Slack workspace

Requirements: Node 20+, Docker (for local Postgres), a Slack workspace you can
install an app into, and optionally a [Hack Club AI](https://ai.hackclub.com) key(for the urgency). If the app runs without one, it just
will not classify.

```bash
npm install
docker compose up -d
cp .env.example .env
npx prisma migrate dev
```

Create the Slack app and fill in `.env` by following
[`SLACK_APP_SETUP.md`](./SLACK_APP_SETUP.md).

Then connect the workspace:

```bash
npm run dev:https
```

Open <https://localhost:3000>, click through the certificate warning, and hit
**Connect Slack**.

### Refreshing your messages

The initial import runs during OAuth. These refresh or verify it later:

```bash
npm run backfill
npm run backfill:verify
npm run classify
```

## License
Licensed under the [MIT License](./LICENSE).

## AI disclosure

AI coding assistance was used during implementation, debugging and build verification. Product direction and final acceptance remained with me.
