-- The Backups tab, granted per client like the other four. Added to the enum and nothing else: a copy holds a
-- site's whole database, so no existing access gains it by itself. The operator ticks it for each client who
-- should have it.

-- AlterEnum
ALTER TYPE "SitePermission" ADD VALUE 'BACKUPS';
