ALTER TYPE "public"."consent_element" ADD VALUE 'crisis_handoff';--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'crisis_line';--> statement-breakpoint
CREATE TABLE "crisis_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"crisis_event_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"content_ciphertext" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"contact_made_at" timestamp with time zone,
	CONSTRAINT "crisis_handoffs_event_unique" UNIQUE("crisis_event_id"),
	CONSTRAINT "crisis_handoffs_consent_unique" UNIQUE("consent_id")
);
--> statement-breakpoint
ALTER TABLE "crisis_handoffs" ADD CONSTRAINT "crisis_handoffs_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crisis_handoffs" ADD CONSTRAINT "crisis_handoffs_crisis_event_id_crisis_events_id_fk" FOREIGN KEY ("crisis_event_id") REFERENCES "public"."crisis_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crisis_handoffs" ADD CONSTRAINT "crisis_handoffs_consent_id_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."consents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crisis_handoffs_person_idx" ON "crisis_handoffs" USING btree ("person_id");