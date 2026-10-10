-- The public contact a site's holding page shows while it is down. Empty and unlisted for every existing
-- client, so no site shows anything until the operator lists one.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "publicContactListed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publicEmail" TEXT,
ADD COLUMN     "publicName" TEXT,
ADD COLUMN     "publicPhone" TEXT;
