CREATE TABLE "clinic_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"ticket_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "clinic_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "portal_access" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_links" ADD CONSTRAINT "clinic_links_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_links" ADD CONSTRAINT "clinic_links_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinic_links_ticket_idx" ON "clinic_links" USING btree ("ticket_id");