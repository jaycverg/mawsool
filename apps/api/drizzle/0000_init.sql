CREATE TYPE "public"."actor" AS ENUM('person', 'clinic', 'system');--> statement-breakpoint
CREATE TYPE "public"."age_band" AS ENUM('under_18', '18_24', '25_34', '35_44', '45_54', '55_plus');--> statement-breakpoint
CREATE TYPE "public"."care_language" AS ENUM('ar', 'en', 'ur', 'hi', 'tl', 'other');--> statement-breakpoint
CREATE TYPE "public"."consent_element" AS ENUM('ticket', 'scores', 'trajectory', 'free_text', 'conditions', 'preferences');--> statement-breakpoint
CREATE TYPE "public"."crisis_number" AS ENUM('800725462', '999', '998');--> statement-breakpoint
CREATE TYPE "public"."crisis_trigger" AS ENUM('phq9_item9', 'cssrs');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('female', 'male', 'another');--> statement-breakpoint
CREATE TYPE "public"."insurance_class" AS ENUM('thiqa', 'daman_basic', 'daman_enhanced', 'other_private', 'not_sure');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('ar', 'en');--> statement-breakpoint
CREATE TYPE "public"."modality" AS ENUM('in_person', 'tele');--> statement-breakpoint
CREATE TYPE "public"."region" AS ENUM('abu_dhabi_city', 'al_ain', 'al_dhafra');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('clinician', 'ops', 'admin');--> statement-breakpoint
CREATE TYPE "public"."ticket_source" AS ENUM('app', 'phc', 'tamm', 'school');--> statement-breakpoint
CREATE TYPE "public"."ticket_state" AS ENUM('issued', 'acknowledged', 'seen', 'overdue', 'rerouted', 'remeasured', 'closed', 'declined', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."tier" AS ENUM('self_help', 'community', 'tele', 'gp', 'specialist');--> statement-breakpoint
CREATE TABLE "adverse_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid,
	"crisis_event_id" uuid,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"reported_by" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"ticket_id" uuid,
	"recipient" text NOT NULL,
	"element" "consent_element" NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "crisis_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trigger" "crisis_trigger" NOT NULL,
	"shown_at" timestamp with time zone NOT NULL,
	"call_tapped" "crisis_number",
	"context_shared" boolean DEFAULT false NOT NULL,
	"human_contact_confirmed" boolean DEFAULT false NOT NULL,
	"contact_source" text,
	"contact_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"follow_up_at" timestamp with time zone,
	"locale" "locale" NOT NULL,
	CONSTRAINT "crisis_events_contact_pair" CHECK ("crisis_events"."human_contact_confirmed" = ("crisis_events"."contact_at" IS NOT NULL)),
	CONSTRAINT "crisis_events_contact_source" CHECK ("crisis_events"."contact_source" IS NULL OR "crisis_events"."contact_source" IN ('self_report', 'mock_line'))
);
--> statement-breakpoint
CREATE TABLE "facilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"region" "region" NOT NULL,
	"contact_text" text NOT NULL,
	"sample" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"secret_hash" text NOT NULL,
	"locale" "locale" NOT NULL,
	"equity_opt_in" boolean DEFAULT false NOT NULL,
	"age_band" "age_band",
	"gender" "gender",
	"language" "care_language",
	"region" "region",
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "persons_buckets_only_when_opted_in" CHECK ("persons"."equity_opt_in" OR ("persons"."age_band" IS NULL AND "persons"."gender" IS NULL AND "persons"."language" IS NULL AND "persons"."region" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"tier" "tier" NOT NULL,
	"modality" "modality" NOT NULL,
	"languages" "care_language"[] NOT NULL,
	"clinician_genders" "gender"[] NOT NULL,
	"insurance_classes" "insurance_class"[] NOT NULL,
	"region" "region" NOT NULL,
	"indicative_wait_days" integer NOT NULL,
	"facility_id" uuid,
	"sample" boolean DEFAULT true NOT NULL,
	CONSTRAINT "services_facility_unless_self_help" CHECK (("services"."tier" = 'self_help') = ("services"."facility_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "shared_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"recipient" text NOT NULL,
	"content_ciphertext" text,
	"approved_summary_ciphertext" text,
	"created_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "staff_magic_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "staff_magic_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "staff_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"facility_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "staff_users_email_unique" UNIQUE("email"),
	CONSTRAINT "staff_users_clinician_has_facility" CHECK (("staff_users"."role" = 'clinician') = ("staff_users"."facility_id" IS NOT NULL)),
	CONSTRAINT "staff_users_email_lowercase" CHECK ("staff_users"."email" = lower("staff_users"."email"))
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"from_state" "ticket_state",
	"to_state" "ticket_state" NOT NULL,
	"actor" "actor" NOT NULL,
	"channel" text NOT NULL,
	"reason" text,
	"self_confirmed" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "ticket_events_ticket_seq_unique" UNIQUE("ticket_id","seq"),
	CONSTRAINT "ticket_events_seq_positive" CHECK ("ticket_events"."seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_code" text NOT NULL,
	"person_id" uuid NOT NULL,
	"tier" "tier" NOT NULL,
	"service_id" uuid NOT NULL,
	"state" "ticket_state" NOT NULL,
	"language" "care_language" NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"source" "ticket_source" NOT NULL,
	"parent_ticket_id" uuid,
	"client_request_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tickets_short_code_unique" UNIQUE("short_code"),
	CONSTRAINT "tickets_client_request_id_unique" UNIQUE("client_request_id"),
	CONSTRAINT "tickets_not_self_help" CHECK ("tickets"."tier" <> 'self_help')
);
--> statement-breakpoint
ALTER TABLE "adverse_events" ADD CONSTRAINT "adverse_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adverse_events" ADD CONSTRAINT "adverse_events_crisis_event_id_crisis_events_id_fk" FOREIGN KEY ("crisis_event_id") REFERENCES "public"."crisis_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_bundles" ADD CONSTRAINT "shared_bundles_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_magic_links" ADD CONSTRAINT "staff_magic_links_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_parent_ticket_id_tickets_id_fk" FOREIGN KEY ("parent_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consents_person_idx" ON "consents" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "consents_ticket_idx" ON "consents" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "services_facility_idx" ON "services" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "tickets_service_idx" ON "tickets" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "tickets_person_idx" ON "tickets" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "tickets_state_deadline_idx" ON "tickets" USING btree ("state","deadline_at");