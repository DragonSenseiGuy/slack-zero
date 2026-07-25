# Slack app setup

One-time setup to connect SlackZero to a Slack workspace. Takes about ten
minutes.

> Use a **test / sandbox workspace**, not your production one (see CLAUDE.md).
> You can create a free one at <https://slack.com/create>.

---

## 1. Create the app from a manifest

1. Go to <https://api.slack.com/apps> and click **Create New App**.
2. Choose **From an app manifest**.
3. Pick your workspace, click **Next**.
4. Switch the editor to **YAML** and paste the manifest below, replacing
   everything already in the box.
5. Click **Next**, review the summary, then **Create**.

```yaml
display_information:
  name: SlackZero
  description: Keyboard-first triage client for DMs, mentions, and threads
  background_color: "#1a1d21"
features:
  bot_user:
    display_name: SlackZero
    always_online: false
oauth_config:
  redirect_urls:
    - https://localhost:3000/api/slack/oauth/callback
  scopes:
    user:
      - im:history
      - im:read
      - im:write
      - mpim:history
      - mpim:read
      - groups:history
      - groups:read
      - channels:history
      - channels:read
      - users:read
      - chat:write
      - reactions:read
      - search:read
    bot:
      - users:read
settings:
  event_subscriptions:
    user_events:
      - message.im
      - message.mpim
      - message.groups
      - message.channels
      - reaction_added
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

### Manifest verification notes

This manifest was checked against Slack's current app-manifest schema
(<https://docs.slack.dev/reference/app-manifest>) on 2026-07-24. **No changes
were needed** — it is valid as written. Specifically:

- **`settings.event_subscriptions.user_events` is the correct key** for
  subscribing to events on behalf of the authorizing *user* (as opposed to
  `bot_events`, which is for bot-token events). Both keys are valid siblings,
  and each accepts up to 100 event types. Since SlackZero acts as the user, all
  of our subscriptions live under `user_events`.
- **A `bot_user` is *not* required** to enable event subscriptions or Socket
  Mode — the schema marks `features.bot_user`, `settings.event_subscriptions`
  and `settings.socket_mode_enabled` all as independently optional. The
  `bot_user` block is kept anyway because the manifest requests one bot scope
  (`users:read`), which gives the app a stable identity in the workspace. If
  you ever delete `oauth_config.scopes.bot`, delete `features.bot_user` too so
  the two stay consistent.
- **No `request_url`** is set under `event_subscriptions`, which is correct:
  with `socket_mode_enabled: true` Slack pushes events over a WebSocket, so no
  public HTTPS endpoint is needed for local dev. (Phase 1 wires up the Socket
  Mode listener; Phase 0 does not consume events yet.)
- Constraints all satisfied: `name` ≤ 35 chars, `description` ≤ 140 chars,
  `background_color` is a 6-digit hex including the `#`.
- `token_rotation_enabled: false` means the issued user token (`xoxp-…`) does
  not expire, which matches the Phase 0 database schema — there is no refresh
  token column.

### Scopes: additions beyond plan.md

`plan.md` lists a minimum scope set. This manifest adds four more (user
decision, 2026-07-24), because Phase 1 needs them:

| Scope | Why |
| --- | --- |
| `channels:read` | `conversations.list` needs it to enumerate public channels |
| `groups:read` | same, for private channels |
| `mpim:read` | same, for group DMs |
| `search:read` | mention lookup (`search.messages`) — user-token only |

Everything else matches plan.md's stated minimum. The same list lives in code
at `src/lib/slack/scopes.ts`; if you change one, change the other, or Slack
will reject the authorize request.

---

## 2. Enable Socket Mode and generate the app-level token

The manifest already sets `socket_mode_enabled: true`, but the app-level token
has to be created by hand — manifests can't mint tokens.

1. In your app, go to **Settings → Socket Mode** and confirm the toggle is on.
2. Go to **Settings → Basic Information → App-Level Tokens**.
3. Click **Generate Token and Scopes**.
   - Token name: `socket-mode` (anything works)
   - Add scope: **`connections:write`**
   - Click **Generate**
4. Copy the token — it starts with `xapp-`. This is the only time it's shown.
5. Put it in `.env` as `SLACK_APP_TOKEN`.

---

## 3. Copy the app credentials

Still under **Settings → Basic Information → App Credentials**:

| Slack field | `.env` variable |
| --- | --- |
| Client ID | `SLACK_CLIENT_ID` |
| Client Secret (click *Show*) | `SLACK_CLIENT_SECRET` |
| Signing Secret (click *Show*) | `SLACK_SIGNING_SECRET` |

Then generate the one secret Slack does *not* give you — the key used to
HMAC-sign the OAuth `state` parameter:

```bash
openssl rand -hex 32
```

Put the result in `.env` as `SLACK_STATE_SECRET`.

---

## 4. HTTPS for local development

**Slack requires OAuth redirect URLs to use `https`.** Plain
`http://localhost:3000` will be rejected, so you cannot complete OAuth with the
ordinary `npm run dev`.

**Recommended — Next.js's built-in self-signed HTTPS:**

```bash
npm run dev:https      # → next dev --experimental-https
```

This serves the app on `https://localhost:3000` with a locally generated
self-signed certificate. Your browser will warn once about the certificate;
accept it and continue. This matches the default `SLACK_REDIRECT_URI` and
`APP_BASE_URL` in `.env`, so nothing else needs changing.

**Fallback — ngrok**, if the self-signed certificate causes trouble (some
corporate machines and some browsers refuse it):

```bash
npm run dev                    # terminal 1, http://localhost:3000
ngrok http 3000                # terminal 2
```

ngrok prints a public `https://<something>.ngrok-free.app` URL. If you use it,
update **all three** places to match, or OAuth will fail with
`bad_redirect_uri`:

1. Slack app → **OAuth & Permissions → Redirect URLs** — add
   `https://<something>.ngrok-free.app/api/slack/oauth/callback` and **Save**.
2. `.env` → `SLACK_REDIRECT_URI` — the same full URL.
3. `.env` → `APP_BASE_URL` — `https://<something>.ngrok-free.app`.

> Note: if port 3000 is already in use on your machine, pass `--port` (e.g.
> `npm run dev:https -- --port 3210`) and adjust the URLs above to match.

---

## 5. Hack Club AI key

SlackZero uses **Hack Club AI** as its LLM provider rather than calling the
Anthropic API directly (user decision, 2026-07-24). It's an OpenAI-compatible
proxy that still gives access to Claude models.

1. Go to <https://ai.hackclub.com> and sign in.
2. Open the dashboard and create an API key with a descriptive name.
3. Put it in `.env` as `HACKCLUB_AI_API_KEY`.

Things to know:

- **This service is only for users 18 and under.** That is Hack Club's rule,
  not ours. If you're over 18, you'll need a different provider — swap the
  implementation in `src/lib/llm/client.ts`, which is the single place the app
  talks to an LLM.
- Rate limit: **450 chat/embedding requests per 30 minutes**; over that you get
  HTTP 429.
- Never commit the key. `.env` is gitignored.
- List available models (no auth required):
  ```bash
  curl https://ai.hackclub.com/proxy/v1/models
  ```
  `LLM_MODEL` defaults to `qwen/qwen3-32b`, a small open-weight model. This is
  deliberate: classification runs on every message, so a frontier model there
  burns money for no benefit. Don't raise it without a measured reason.

---

## 6. Connect

```bash
cp .env.example .env     # if you haven't already, then fill it in
docker compose up -d     # Postgres on host port 5433
npx prisma migrate dev   # apply migrations
npm run dev:https
```

1. Open <https://localhost:3000> and accept the certificate warning.
2. Click **Connect Slack**.
3. Approve the requested permissions in Slack.
4. You'll land back on the home page showing the workspace, authed user, and
   granted scopes.
5. Check <https://localhost:3000/health> — `db` and `slack` should both read
   `ok`, and `llm` should read `ok` once you've added the Hack Club key.

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| `slack_error=slack_not_configured` | `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_STATE_SECRET` missing from `.env` |
| `bad_redirect_uri` from Slack | `SLACK_REDIRECT_URI` doesn't exactly match a Redirect URL in the Slack app |
| `slack_error=invalid_state_missing` | The state cookie didn't come back. Usually means you're on `http`, not `https` — the cookie is `Secure`. |
| `slack_error=invalid_state_expired` | You took longer than 10 minutes to approve. Just click Connect again. |
| `slack_error=missing_user_token` | The app was installed without `user_scope`. Re-check `oauth_config.scopes.user` in the manifest. |
| Health page shows `db: error` | Postgres isn't running — `docker compose up -d` |
