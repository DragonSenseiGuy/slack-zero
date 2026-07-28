-- AlterTable
ALTER TABLE "MessageState" ADD COLUMN     "lastSnoozedUntil" TIMESTAMP(3),
ADD COLUMN     "unsnoozeReason" TEXT,
ADD COLUMN     "unsnoozedAt" TIMESTAMP(3);
