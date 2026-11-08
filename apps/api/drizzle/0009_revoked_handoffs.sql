CREATE TABLE "revoked_handoffs" (
	"person_id" uuid NOT NULL,
	"handoff_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "revoked_handoffs_person_id_handoff_id_pk" PRIMARY KEY("person_id","handoff_id")
);
--> statement-breakpoint
ALTER TABLE "revoked_handoffs" ADD CONSTRAINT "revoked_handoffs_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;