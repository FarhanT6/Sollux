-- A household person's own Sollux login on the account, so "Me" is whoever is signed in.
ALTER TABLE "household_members" ADD COLUMN IF NOT EXISTS "loginUserId" TEXT;
