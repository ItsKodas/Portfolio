-- CreateEnum
CREATE TYPE "TaxBalanceSide" AS ENUM ('ASSET', 'LIABILITY');

-- CreateTable
CREATE TABLE "TaxBalanceItem" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "year" INTEGER NOT NULL,
    "side" "TaxBalanceSide" NOT NULL,
    "name" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,

    CONSTRAINT "TaxBalanceItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxBalanceItem_year_idx" ON "TaxBalanceItem"("year");
