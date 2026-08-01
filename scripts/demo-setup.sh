#!/usr/bin/env bash
#
# One-command demo: `npm run demo:setup`
#
# Creates a *separate* Postgres database for the demo, migrates it, and seeds
# the fake workspace. Separate on purpose — demo mode signs a visitor in
# without Slack, so it must never share a database with a real installation
# (src/lib/demo/guard.ts refuses if it does).
#
# Then: `npm run demo`
set -euo pipefail

DEMO_DATABASE_URL="${DEMO_DATABASE_URL:-postgresql://slackzero:slackzero@localhost:5433/slackzero_demo}"
DEMO_DB_NAME="${DEMO_DATABASE_URL##*/}"
DEMO_DB_NAME="${DEMO_DB_NAME%%\?*}"

echo "==> Starting Postgres"
docker compose up -d

echo "==> Waiting for Postgres to accept connections"
for _ in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U slackzero >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "==> Creating database ${DEMO_DB_NAME} (if it does not exist)"
docker compose exec -T postgres psql -U slackzero -d slackzero -tc \
  "SELECT 1 FROM pg_database WHERE datname = '${DEMO_DB_NAME}'" \
  | grep -q 1 || docker compose exec -T postgres createdb -U slackzero "${DEMO_DB_NAME}"

echo "==> Applying migrations"
DATABASE_URL="${DEMO_DATABASE_URL}" npx prisma migrate deploy

echo "==> Seeding the demo workspace"
DATABASE_URL="${DEMO_DATABASE_URL}" npx tsx scripts/demo-seed.ts

echo
echo "Done. Start it with:  npm run demo"
echo "Then open http://localhost:3000 and click \"Enter the demo\"."
