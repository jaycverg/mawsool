CREATE TABLE "demo_clock" (
	"id" integer PRIMARY KEY NOT NULL,
	"offset_ms" bigint NOT NULL,
	CONSTRAINT "demo_clock_single_row" CHECK ("demo_clock"."id" = 1),
	CONSTRAINT "demo_clock_forward" CHECK ("demo_clock"."offset_ms" >= 0)
);
