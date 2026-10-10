-- Reading and editing env files, granted per client as the level above ENVIRONMENTS. Added to the enum and
-- nothing else: an env file holds the site's secrets, so no existing access gains it by itself. A client who
-- could see the Environments tab still only sees it until the operator ticks this for them.

-- AlterEnum
ALTER TYPE "SitePermission" ADD VALUE 'ENV_FILES';
