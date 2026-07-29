# Privacy-first storage deployment

1. Stop the web and Socket Mode processes so no plaintext writes race the scrub.
2. Take a database backup only if required. The backup contains old Slack content
   and plaintext OAuth tokens; encrypt it, tightly restrict it, set a deletion
   deadline, and never restore it into a less protected environment.
3. Set `SLACK_TOKEN_ENCRYPTION_KEY` to exactly 32 random base64-encoded bytes and
   preserve it in the deployment secret manager (`openssl rand -base64 32`).
4. Against the **old schema**, run `npm run db:privacy-prepare`. It is idempotent,
   does not print token/content values, encrypts tokens in place, and scrubs
   forbidden content using SQL.
5. Run `npm run db:migrate:deploy`. The migration aborts if a non-null token does
   not have the `enc:v1:` envelope, then renames token columns and drops all
   plaintext-era content columns.
6. Deploy/restart the web and separate Socket Mode processes with the same key.

Cold starts intentionally hydrate from Slack and may be slower or encounter
Slack rate limiting; SDK Retry-After handling applies. Caches are process-local,
bounded, last-used evicted, expire after 60 seconds, and are never serialized.

Rollback to pre-migration application code would require restoring the old,
privacy-sensitive backup and reintroduces private content/plaintext-token risk.
Prefer a forward fix. Dropped Slack-owned content cannot and should not be
reconstructed from the database; Slack remains the source of truth.
