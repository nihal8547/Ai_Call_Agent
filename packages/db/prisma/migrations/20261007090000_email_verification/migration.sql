-- Email verification at sign-up. Accounts that already exist are treated as verified.
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMPTZ(3);
UPDATE "users" SET "email_verified_at" = "created_at";
