CREATE TABLE "adverse_event_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"staff_user_id" uuid NOT NULL,
	CONSTRAINT "adverse_event_history_event_seq_unique" UNIQUE("event_id","seq"),
	CONSTRAINT "adverse_event_history_from" CHECK ("adverse_event_history"."from_status" IS NULL OR "adverse_event_history"."from_status" IN ('open', 'investigating')),
	CONSTRAINT "adverse_event_history_to" CHECK ("adverse_event_history"."to_status" IN ('open', 'investigating', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "adverse_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"ticket_ref" text,
	CONSTRAINT "adverse_events_type" CHECK ("adverse_events"."type" IN ('missed_crisis_follow_up', 'wrong_routing', 'data_incident')),
	CONSTRAINT "adverse_events_severity" CHECK ("adverse_events"."severity" IN ('low', 'moderate', 'high', 'critical')),
	CONSTRAINT "adverse_events_status" CHECK ("adverse_events"."status" IN ('open', 'investigating', 'closed')),
	CONSTRAINT "adverse_events_ticket_ref" CHECK ("adverse_events"."ticket_ref" IS NULL OR "adverse_events"."ticket_ref" ~ '^od_[0-9a-f]{12}$')
);
--> statement-breakpoint
ALTER TABLE "adverse_event_history" ADD CONSTRAINT "adverse_event_history_event_id_adverse_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."adverse_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adverse_event_history" ADD CONSTRAINT "adverse_event_history_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;