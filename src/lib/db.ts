import { PrismaClient } from '@prisma/client';

/**
 * Prisma client singleton.
 *
 * Next's dev server hot-reloads modules, which would otherwise open a new pool
 * on every edit until Postgres refuses connections. Stash the instance on
 * globalThis in development so reloads reuse it.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
