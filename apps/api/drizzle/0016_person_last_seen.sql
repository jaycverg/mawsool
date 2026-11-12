ALTER TABLE "persons" ADD COLUMN "last_seen_on" date;--> statement-breakpoint
-- A person who registered before this column existed counts as seen on the day the migration runs (a one-time backfill, not a default).
UPDATE "persons" SET "last_seen_on" = CURRENT_DATE;