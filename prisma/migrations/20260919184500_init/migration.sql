-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('NEW', 'REPLIED', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "ProjectType" AS ENUM ('NEW_SITE', 'REDESIGN', 'WEB_APP', 'ONLINE_STORE', 'OTHER');

-- CreateEnum
CREATE TYPE "Budget" AS ENUM ('UNDER_2K', 'FROM_2K_TO_5K', 'FROM_5K_TO_10K', 'OVER_10K', 'NOT_SURE');

-- CreateEnum
CREATE TYPE "Timeline" AS ENUM ('ASAP', 'ONE_TO_THREE_MONTHS', 'OVER_THREE_MONTHS', 'FLEXIBLE');

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT,
    "website" TEXT,
    "projectType" "ProjectType",
    "budget" "Budget",
    "timeline" "Timeline",
    "message" TEXT NOT NULL,
    "referenceSites" TEXT[],
    "status" "QuoteStatus" NOT NULL DEFAULT 'NEW',
    "archivedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "ipHash" TEXT NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "body" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Quote_ipHash_createdAt_idx" ON "Quote"("ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "Quote_archivedAt_createdAt_idx" ON "Quote"("archivedAt", "createdAt");

-- CreateIndex
CREATE INDEX "Note_quoteId_idx" ON "Note"("quoteId");

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
