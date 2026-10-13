-- The session that confirmed an authenticator enrolment is marked here, so finishing sign-in at the
-- "I have saved my recovery codes" step is bound to that one session rather than to the client being enrolled.
ALTER TABLE "ClientSession" ADD COLUMN "enrolledAt" TIMESTAMP(3);
