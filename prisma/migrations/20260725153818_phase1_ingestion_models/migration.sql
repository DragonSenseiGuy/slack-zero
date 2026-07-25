-- CreateEnum
CREATE TYPE "ConversationKind" AS ENUM ('IM', 'MPIM', 'PRIVATE_CHANNEL', 'PUBLIC_CHANNEL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "IngestSource" AS ENUM ('BACKFILL', 'EVENT');

-- CreateEnum
CREATE TYPE "MessageCategory" AS ENUM ('ACTION_NEEDED', 'MISC', 'FYI');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "teamId" TEXT,
    "username" TEXT,
    "realName" TEXT,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "timezone" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "teamId" TEXT,
    "kind" "ConversationKind" NOT NULL,
    "name" TEXT,
    "peerUserId" TEXT,
    "topic" TEXT,
    "purpose" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "isMember" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "ts" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "threadTs" TEXT,
    "isThreadReply" BOOLEAN NOT NULL DEFAULT false,
    "isThreadParent" BOOLEAN NOT NULL DEFAULT false,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "userId" TEXT,
    "botId" TEXT,
    "authorName" TEXT,
    "subtype" TEXT,
    "text" TEXT NOT NULL,
    "blocks" JSONB,
    "isEdited" BOOLEAN NOT NULL DEFAULT false,
    "editedAt" TIMESTAMP(3),
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "hasFiles" BOOLEAN NOT NULL DEFAULT false,
    "reactions" JSONB,
    "mentionedUserIds" TEXT[],
    "source" "IngestSource" NOT NULL DEFAULT 'BACKFILL',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Classification" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "urgencyScore" INTEGER NOT NULL,
    "category" "MessageCategory" NOT NULL,
    "isBump" BOOLEAN NOT NULL DEFAULT false,
    "bumpOfMessageId" TEXT,
    "reason" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Classification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageState" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "isDone" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "snoozedAt" TIMESTAMP(3),
    "isWaitingOn" BOOLEAN NOT NULL DEFAULT false,
    "waitingOnSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ViewDefinition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "layout" TEXT NOT NULL DEFAULT 'detailed',
    "filters" JSONB NOT NULL,
    "sort" TEXT NOT NULL DEFAULT 'newest',
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ViewDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Conversation_kind_idx" ON "Conversation"("kind");

-- CreateIndex
CREATE INDEX "Message_sentAt_idx" ON "Message"("sentAt");

-- CreateIndex
CREATE INDEX "Message_conversationId_threadTs_idx" ON "Message"("conversationId", "threadTs");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_ts_key" ON "Message"("conversationId", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "Classification_messageId_key" ON "Classification"("messageId");

-- CreateIndex
CREATE INDEX "Classification_category_urgencyScore_idx" ON "Classification"("category", "urgencyScore");

-- CreateIndex
CREATE UNIQUE INDEX "MessageState_messageId_key" ON "MessageState"("messageId");

-- CreateIndex
CREATE INDEX "MessageState_isDone_idx" ON "MessageState"("isDone");

-- CreateIndex
CREATE INDEX "MessageState_snoozedUntil_idx" ON "MessageState"("snoozedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "ViewDefinition_name_key" ON "ViewDefinition"("name");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Classification" ADD CONSTRAINT "Classification_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageState" ADD CONSTRAINT "MessageState_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
