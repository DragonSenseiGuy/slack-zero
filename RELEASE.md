# Releasing SlackZero

SlackZero is a local, single-user tool: there is no hosted instance to point
anyone at, and there never will be — it acts with *your* Slack user token. What
ships instead is a downloadable build that runs on the reviewer's own machine,
in demo mode, against a seeded fake workspace.

## What a reviewer does

1. Download `slackzero-v<version>.zip` from the GitHub release.
2. Unzip it and, from inside the folder:

   ```bash
   docker compose -f docker-compose.demo.yml up --build
   ```

3. Open <http://localhost:7001> and click **Enter the demo**.

Requirements: Docker Desktop (or Docker Engine + Compose v2). Nothing else —
no Node, no Postgres, no Slack app, no API keys. First build takes a few
minutes; subsequent starts are seconds.

To use it with a real Slack workspace instead, see the README section
"Connecting your own Slack workspace".

## Cutting a release

```bash
npm run test && npm run test:e2e && npm run typecheck && npm run lint
npm run package:release
```

`package:release` builds `dist/slackzero-v<version>.zip` from `git archive` at
HEAD — committed files only, so `.env`, `node_modules` and build output cannot
leak into the artifact. Commit before running it.

Then publish:

```bash
gh release create v<version> dist/slackzero-v<version>.zip \
  --title "SlackZero v<version>" \
  --notes-file RELEASE.md
```

## Release checklist

- [ ] `npm run test`, `npm run test:e2e`, `npm run typecheck`, `npm run lint`
      all pass
- [ ] Version bumped in `package.json`
- [ ] Screenshots regenerated if the UI changed (`npm run demo` then
      `npm run screenshots`)
- [ ] The demo stack verified from a clean state:

      ```bash
      docker compose -f docker-compose.demo.yml down -v
      docker compose -f docker-compose.demo.yml up --build
      ```

- [ ] `.env` is not in the archive: `unzip -l dist/slackzero-v<version>.zip | grep -c '\.env$'` → `0`
      (`.env.example` is expected and fine)
- [ ] The zip is attached to the GitHub release, not linked from a file host

## What is in the archive

The repository at HEAD: source, Prisma migrations, the Dockerfile, both compose
files, and the docs. It is a source distribution that builds itself — which is
the honest shape for a web app whose whole job is to hold your Slack session.
There is no standalone binary because there is nothing to run one against: the
app needs Postgres and a browser either way, and Docker Compose supplies both
in one command.
