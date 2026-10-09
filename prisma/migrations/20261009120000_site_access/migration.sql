-- Sites stop belonging to one client. Each existing link becomes a SiteAccess row carrying every permission,
-- which is exactly what that client could do before, so nobody loses anything on the way across.

-- CreateEnum
CREATE TYPE "SitePermission" AS ENUM ('LOGS', 'LIFECYCLE', 'ENVIRONMENTS', 'DEPLOYS');

-- CreateTable
CREATE TABLE "SiteAccess" (
    "siteId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "permissions" "SitePermission"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteAccess_pkey" PRIMARY KEY ("siteId","clientId")
);

-- CreateIndex
CREATE INDEX "SiteAccess_clientId_idx" ON "SiteAccess"("clientId");

-- AddForeignKey
ALTER TABLE "SiteAccess" ADD CONSTRAINT "SiteAccess_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteAccess" ADD CONSTRAINT "SiteAccess_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry every existing client to site link across, with the access it already had
INSERT INTO "SiteAccess" ("siteId", "clientId", "permissions", "createdAt")
SELECT "id", "clientId", ARRAY['LOGS', 'LIFECYCLE', 'ENVIRONMENTS', 'DEPLOYS']::"SitePermission"[], "createdAt"
FROM "Site";

-- DropForeignKey
ALTER TABLE "Site" DROP CONSTRAINT "Site_clientId_fkey";

-- DropIndex
DROP INDEX "Site_clientId_idx";

-- AlterTable
ALTER TABLE "Site" DROP COLUMN "clientId";
