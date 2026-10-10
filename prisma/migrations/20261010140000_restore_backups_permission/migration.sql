-- Putting a backup back over the live site, granted per client as the level above BACKUPS. Added to the enum
-- and nothing else: a restore replaces everything the site has saved since the copy, so no existing access
-- gains it by itself. A client who could use the Backups tab still only makes and downloads copies there
-- until the operator ticks this for them.

-- AlterEnum
ALTER TYPE "SitePermission" ADD VALUE 'RESTORE_BACKUPS';
