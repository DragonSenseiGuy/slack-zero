BEGIN;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "isContent" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "mentionsAuthedUser" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "Message_isDeleted_isContent_mentionsAuthedUser_idx"
  ON "Message"("isDeleted", "isContent", "mentionsAuthedUser");
COMMIT;
