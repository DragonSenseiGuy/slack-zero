import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

import { decryptSlackToken, encryptSlackToken, isEncryptedToken } from '../src/lib/slack/token-crypto';

const db = new PrismaClient();
type TokenRow = { id: string; userAccessToken: string; botAccessToken: string | null };

async function main(): Promise<void> {
  // Values remain process-local and are never interpolated into SQL or output.
  const rows = await db.$queryRaw<TokenRow[]>`
    SELECT id, "userAccessToken", "botAccessToken" FROM "SlackInstallation"
  `;
  // Validate the key and every existing envelope before performing any write.
  // Decryption failures must leave both tokens and Slack-owned content intact.
  encryptSlackToken('validation-only');
  for (const row of rows) {
    if (isEncryptedToken(row.userAccessToken)) decryptSlackToken(row.userAccessToken);
    if (row.botAccessToken && isEncryptedToken(row.botAccessToken)) decryptSlackToken(row.botAccessToken);
  }
  for (const row of rows) {
    const user = isEncryptedToken(row.userAccessToken) ? row.userAccessToken : encryptSlackToken(row.userAccessToken);
    const bot = row.botAccessToken && !isEncryptedToken(row.botAccessToken)
      ? encryptSlackToken(row.botAccessToken)
      : row.botAccessToken;
    await db.$executeRaw`
      UPDATE "SlackInstallation" SET "userAccessToken" = ${user}, "botAccessToken" = ${bot} WHERE id = ${row.id}
    `;
  }
  // Scrub Slack-owned content in SQL, so it never enters this process.
  // Keep mentionedUserIds until the schema migration has derived the
  // content-free mentionsAuthedUser routing fact from it.
  await db.$executeRawUnsafe(`UPDATE "Message" SET text = '', blocks = NULL, reactions = NULL, "authorName" = NULL`);
  await db.$executeRawUnsafe(`UPDATE "User" SET username = NULL, "realName" = NULL, "displayName" = NULL, "avatarUrl" = NULL, timezone = NULL`);
  await db.$executeRawUnsafe(`UPDATE "Conversation" SET name = NULL, topic = NULL, purpose = NULL`);
  await db.$executeRawUnsafe(`UPDATE "Classification" SET reason = 'OTHER'`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.$disconnect();
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
