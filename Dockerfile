FROM node:20-bookworm-slim AS base

WORKDIR /app

# Prisma needs OpenSSL at generation time and when loading its query engine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*


FROM base AS dependencies

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci


FROM base AS builder

ENV NEXT_TELEMETRY_DISABLED=1
# The application validates that DATABASE_URL exists. All pages that use the
# database are dynamically rendered, so the build does not connect to this URL.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build
# Bundle the one-time privacy preparation command so the production image can
# run it without retaining tsx or the rest of the development dependencies.
RUN ./node_modules/.bin/esbuild scripts/privacy-pre-migration.ts \
  --bundle \
  --platform=node \
  --format=cjs \
  --external:@prisma/client \
  --outfile=/app/privacy-pre-migration.cjs
RUN ./node_modules/.bin/esbuild scripts/backfill.ts \
  --bundle \
  --platform=node \
  --format=cjs \
  --external:@prisma/client \
  --external:@slack/web-api \
  --outfile=/app/backfill.cjs
RUN ./node_modules/.bin/esbuild scripts/socket.ts \
  --bundle \
  --platform=node \
  --format=cjs \
  --external:@prisma/client \
  --external:@slack/socket-mode \
  --external:@slack/web-api \
  --outfile=/app/socket.cjs


FROM dependencies AS production-dependencies

RUN npm prune --omit=dev --ignore-scripts \
  && npm pkg set \
    'scripts.db:privacy-prepare=node privacy-pre-migration.cjs' \
    'scripts.backfill=node backfill.cjs' \
    'scripts.socket=node socket.cjs'


FROM base AS runner

ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  HOSTNAME=0.0.0.0 \
  PORT=7001

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/privacy-pre-migration.cjs ./privacy-pre-migration.cjs
COPY --from=builder /app/backfill.cjs ./backfill.cjs
COPY --from=builder /app/socket.cjs ./socket.cjs
COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs

# `.next` is copied in as root, so the runtime user cannot create
# `.next/cache/...` — which flooded the logs with EACCES on every outbound call.
# Nothing sensitive is expected here: all Slack and LLM traffic goes through
# `noStoreFetch` (src/lib/http/no-store.ts), so Next writes no fetch-cache
# entries at all, and every page is dynamic so there is no ISR output either.
RUN mkdir -p .next/cache && chown -R node:node .next/cache

USER node

EXPOSE 7001

CMD ["npm", "run", "start"]
