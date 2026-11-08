DELETE FROM "revoked_handoffs";--> statement-breakpoint
ALTER TABLE "revoked_handoffs" DROP CONSTRAINT "revoked_handoffs_person_id_persons_id_fk";
--> statement-breakpoint
ALTER TABLE "revoked_handoffs" DROP CONSTRAINT "revoked_handoffs_person_id_handoff_id_pk";--> statement-breakpoint
ALTER TABLE "revoked_handoffs" ADD PRIMARY KEY ("handoff_id");--> statement-breakpoint
ALTER TABLE "revoked_handoffs" DROP COLUMN "person_id";