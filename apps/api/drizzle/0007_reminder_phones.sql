CREATE TABLE "reminder_phones" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"interval_weeks" integer NOT NULL,
	"phone_ciphertext" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reminder_phones_interval" CHECK ("reminder_phones"."interval_weeks" IN (2, 4))
);
--> statement-breakpoint
ALTER TABLE "reminder_phones" ADD CONSTRAINT "reminder_phones_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;