BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "SlackInstallation" WHERE ("userAccessToken" NOT LIKE 'enc:v1:%') OR ("botAccessToken" IS NOT NULL AND "botAccessToken" NOT LIKE 'enc:v1:%')) THEN
    RAISE EXCEPTION 'Run npm run db:privacy-prepare with SLACK_TOKEN_ENCRYPTION_KEY before this migration';
  END IF;
END $$;

DELETE FROM "Classification" WHERE "messageId" IN (SELECT id FROM "Message" WHERE "isDeleted" = true);
UPDATE "MessageState" SET "isWaitingOn" = false, "waitingOnSince" = NULL
WHERE "messageId" IN (SELECT id FROM "Message" WHERE "isDeleted" = true);

ALTER TABLE "SlackInstallation" RENAME COLUMN "userAccessToken" TO "encryptedUserAccessToken";
ALTER TABLE "SlackInstallation" RENAME COLUMN "botAccessToken" TO "encryptedBotAccessToken";
ALTER TABLE "SlackInstallation" DROP COLUMN "teamName";

ALTER TABLE "User" DROP COLUMN "teamId", DROP COLUMN username, DROP COLUMN "realName", DROP COLUMN "displayName", DROP COLUMN "avatarUrl", DROP COLUMN timezone, DROP COLUMN "isBot", DROP COLUMN "isDeleted";
ALTER TABLE "Conversation" DROP COLUMN "teamId", DROP COLUMN name, DROP COLUMN topic, DROP COLUMN purpose, DROP COLUMN "isArchived", DROP COLUMN "isMember";
ALTER TABLE "Message" ADD COLUMN "isContent" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "mentionsAuthedUser" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Message" SET "isContent" = false WHERE subtype IN ('channel_join','channel_leave','group_join','group_leave','channel_topic','channel_purpose','channel_name','channel_archive','channel_unarchive','bot_add','bot_remove','pinned_item','unpinned_item');
UPDATE "Message" m SET "mentionsAuthedUser" = true
WHERE EXISTS (
  SELECT 1 FROM "SlackInstallation" i
  WHERE i."authedUserId" = ANY(m."mentionedUserIds")
);
ALTER TABLE "Message" DROP COLUMN "isThreadReply", DROP COLUMN "isThreadParent", DROP COLUMN "replyCount", DROP COLUMN "botId", DROP COLUMN "authorName", DROP COLUMN subtype, DROP COLUMN text, DROP COLUMN blocks, DROP COLUMN "isEdited", DROP COLUMN "editedAt", DROP COLUMN "hasFiles", DROP COLUMN reactions, DROP COLUMN "mentionedUserIds";
CREATE INDEX "Message_isDeleted_isContent_mentionsAuthedUser_idx" ON "Message"("isDeleted", "isContent", "mentionsAuthedUser");

CREATE TYPE "ClassificationReasonCode" AS ENUM ('DIRECT_REQUEST','QUESTION','APPROVAL_NEEDED','BLOCKED','DEADLINE','INCIDENT','FOLLOW_UP','INFORMATIONAL','AUTOMATED_NOTICE','SOCIAL','OTHER');
ALTER TABLE "Classification" ADD COLUMN "reasonCode" "ClassificationReasonCode" NOT NULL DEFAULT 'OTHER';
ALTER TABLE "Classification" DROP COLUMN reason;
ALTER TABLE "Classification" ALTER COLUMN "reasonCode" DROP DEFAULT;

COMMIT;
