CREATE TABLE "inbound_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "ticket_source" NOT NULL,
	"code_hash" text NOT NULL,
	"screened_at" timestamp with time zone NOT NULL,
	"locale" "locale" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone,
	"ticket_id" uuid,
	CONSTRAINT "inbound_invites_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "inbound_invites_not_app" CHECK ("inbound_invites"."source" <> 'app'),
	CONSTRAINT "inbound_invites_claim_pair" CHECK (("inbound_invites"."claimed_by" IS NULL) = ("inbound_invites"."claimed_at" IS NULL)),
	CONSTRAINT "inbound_invites_ticket_needs_claim" CHECK ("inbound_invites"."ticket_id" IS NULL OR "inbound_invites"."claimed_by" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "inbound_nonces" (
	"source" "ticket_source" NOT NULL,
	"nonce" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inbound_nonces_source_nonce_pk" PRIMARY KEY("source","nonce")
);
--> statement-breakpoint
ALTER TABLE "inbound_invites" ADD CONSTRAINT "inbound_invites_claimed_by_persons_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_invites" ADD CONSTRAINT "inbound_invites_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_invites_claimed_by_idx" ON "inbound_invites" USING btree ("claimed_by");