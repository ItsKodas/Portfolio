-- CreateEnum
CREATE TYPE "TaxEntryKind" AS ENUM ('INCOME', 'EXPENSE');

-- CreateTable
CREATE TABLE "TaxEntry" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "TaxEntryKind" NOT NULL,
    "occurredOn" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "businessPercent" INTEGER NOT NULL DEFAULT 100,

    CONSTRAINT "TaxEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxYear" (
    "year" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "otherIncomeCents" INTEGER NOT NULL DEFAULT 0,
    "withheldCents" INTEGER NOT NULL DEFAULT 0,
    "lodgedOn" DATE,

    CONSTRAINT "TaxYear_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "TaxReminder" (
    "key" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxReminder_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "TaxEntry_occurredOn_idx" ON "TaxEntry"("occurredOn");
