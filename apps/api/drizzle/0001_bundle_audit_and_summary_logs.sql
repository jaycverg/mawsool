CREATE TABLE "bundle_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "summary_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"ticket_id" uuid,
	"request_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "summary_logs_kind" CHECK ("summary_logs"."kind" IN ('draft', 'approved'))
);
--> statement-breakpoint
ALTER TABLE "bundle_reads" ADD CONSTRAINT "bundle_reads_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_reads" ADD CONSTRAINT "bundle_reads_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_reads" ADD CONSTRAINT "bundle_reads_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_logs" ADD CONSTRAINT "summary_logs_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_logs" ADD CONSTRAINT "summary_logs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bundle_reads_ticket_idx" ON "bundle_reads" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "summary_logs_person_idx" ON "summary_logs" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "summary_logs_ticket_idx" ON "summary_logs" USING btree ("ticket_id");--> statement-breakpoint
ALTER TABLE "shared_bundles" ADD CONSTRAINT "shared_bundles_ticket_unique" UNIQUE("ticket_id");