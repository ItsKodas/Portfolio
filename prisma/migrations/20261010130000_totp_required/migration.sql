-- Whether a client's sign-in asks for an authenticator code. On for every existing client, so nothing about
-- how anyone signs in changes until the operator turns it off for someone.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "totpRequired" BOOLEAN NOT NULL DEFAULT true;
