-- The admin Logs page: who did what, and every email the site sent. Both start empty; nothing that happened
-- before this migration is reconstructed.

-- CreateEnum
CREATE TYPE "AuditActor" AS ENUM ('ADMIN', 'CLIENT', 'VISITOR');

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "actorType" "AuditActor" NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "site" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "targetName" TEXT,
    "summary" TEXT NOT NULL,
    "detail" JSONB,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SentEmail" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "replyTo" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "error" TEXT,

    CONSTRAINT "SentEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_kind_createdAt_idx" ON "AuditEvent"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_createdAt_idx" ON "AuditEvent"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_site_createdAt_idx" ON "AuditEvent"("site", "createdAt");

-- CreateIndex
CREATE INDEX "SentEmail_createdAt_idx" ON "SentEmail"("createdAt");

-- CreateIndex
CREATE INDEX "SentEmail_to_createdAt_idx" ON "SentEmail"("to", "createdAt");

