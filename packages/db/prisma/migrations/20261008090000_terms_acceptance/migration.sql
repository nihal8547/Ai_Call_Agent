-- Terms of service and privacy policy accepted at sign-up (or when joining by invitation).
-- Accounts from before stay NULL: they never saw the checkbox.
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" TIMESTAMPTZ(3),
                    ADD COLUMN "terms_version" VARCHAR(40);
