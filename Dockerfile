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


FROM dependencies AS production-dependencies

RUN npm prune --omit=dev --ignore-scripts


FROM base AS runner

ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  HOSTNAME=0.0.0.0 \
  PORT=3000

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs

USER node

EXPOSE 3000

CMD ["npm", "run", "start"]
