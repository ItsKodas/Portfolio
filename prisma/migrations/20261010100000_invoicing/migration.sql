-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('PAYPAL', 'PAYPAL_AUTOPAY', 'MANUAL');

-- AlterEnum
ALTER TYPE "AuditActor" ADD VALUE 'SYSTEM';

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "number" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "clientId" TEXT,
    "billToName" TEXT NOT NULL,
    "billToCompany" TEXT,
    "billToEmail" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AUD',
    "issuedOn" DATE,
    "dueOn" DATE NOT NULL,
    "notes" TEXT,
    "gst" BOOLEAN NOT NULL DEFAULT false,
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "gstCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "planId" TEXT,
    "periodStart" DATE,
    "periodEnd" DATE,
    "sentAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "overdueNotices" INTEGER NOT NULL DEFAULT 0,
    "lastOverdueNoticeAt" TIMESTAMP(3),

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitCents" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicePayment" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoiceId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paypalId" TEXT,
    "paypalMode" TEXT,
    "note" TEXT,
    "refundedAt" TIMESTAMP(3),

    CONSTRAINT "InvoicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceCounter" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "next" INTEGER NOT NULL,

    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPlan" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clientId" TEXT NOT NULL,
    "siteId" TEXT,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "interval" "BillingInterval" NOT NULL DEFAULT 'MONTHLY',
    "startsOn" DATE NOT NULL,
    "periodsBilled" INTEGER NOT NULL DEFAULT 0,
    "dueDays" INTEGER NOT NULL DEFAULT 14,
    "endedAt" TIMESTAMP(3),
    "paypalMode" TEXT,
    "paypalProductId" TEXT,
    "paypalPlanId" TEXT,
    "paypalPlanCents" INTEGER,
    "subscriptionId" TEXT,
    "subscriptionStatus" TEXT,

    CONSTRAINT "BillingPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE INDEX "Invoice_status_dueOn_idx" ON "Invoice"("status", "dueOn");

-- CreateIndex
CREATE INDEX "Invoice_clientId_createdAt_idx" ON "Invoice"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "Invoice_planId_idx" ON "Invoice"("planId");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_position_idx" ON "InvoiceLine"("invoiceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayment_paypalId_key" ON "InvoicePayment"("paypalId");

-- CreateIndex
CREATE INDEX "InvoicePayment_invoiceId_idx" ON "InvoicePayment"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPlan_subscriptionId_key" ON "BillingPlan"("subscriptionId");

-- CreateIndex
CREATE INDEX "BillingPlan_clientId_idx" ON "BillingPlan"("clientId");

-- CreateIndex
CREATE INDEX "BillingPlan_endedAt_idx" ON "BillingPlan"("endedAt");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "BillingPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPlan" ADD CONSTRAINT "BillingPlan_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPlan" ADD CONSTRAINT "BillingPlan_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

