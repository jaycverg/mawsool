import { z } from 'zod';
import { AgeBandSchema, CareLanguageSchema, GenderSchema, RegionSchema, TicketSourceSchema, TierSchema } from './enums';

/**
 * What an aggregate carries in place of a number when too few people stand behind it, or when showing it would let a
 * hidden number be worked out from the ones beside it. It holds nothing else: no flag, no gap, no hint of size.
 */
export const SuppressedSchema = z.object({ suppressed: z.literal(true) }).strict();
export type SuppressedValue = z.infer<typeof SuppressedSchema>;

/** A published value or `{ suppressed: true }`. */
export const orSuppressed = <T extends z.ZodType>(schema: T) => z.union([schema, SuppressedSchema]);

/** The periods the dashboard can show, counted back from the API clock's day: all time, the last 90 days, the last 30 days. */
export const METRIC_PERIODS = ['all', '90d', '30d'] as const;
export const MetricPeriodSchema = z.enum(METRIC_PERIODS);
export type MetricPeriod = z.infer<typeof MetricPeriodSchema>;

/** The tiers a ticket can carry. Self-help never makes a ticket. */
export const TICKET_TIERS = ['community', 'tele', 'gp', 'specialist'] as const;
export const TicketTierSchema = z.enum(TICKET_TIERS);
export type TicketTier = z.infer<typeof TicketTierSchema>;

export const PeriodQuerySchema = z.object({ period: MetricPeriodSchema.default('all') });

/**
 * The one period the equity view and the symptom-change figures are served for. Two periods of the same group subtract (all
 * time less the last 90 days is the group's tickets from before the window, which can be a handful of named people), and the
 * small-number guardrail forbids publishing that. So each has a single period, a request for any other is refused, and the
 * dashboard's period filter does not reach them.
 */
export const EQUITY_PERIOD = '90d' as const;
export const EquityQuerySchema = z.object({ period: z.literal(EQUITY_PERIOD).default(EQUITY_PERIOD) });
/** The symptom-change figures are served for the equity view's one period, and the same request shape refuses every other. */
export const OutcomesQuerySchema = EquityQuerySchema;

/** The funnel's filters. A filter that is not sent means every value. */
export const FunnelQuerySchema = PeriodQuerySchema.extend({ source: TicketSourceSchema.optional(), tier: TicketTierSchema.optional() });
export type FunnelQuery = z.infer<typeof FunnelQuerySchema>;

/** A count that has not been suppressed. */
const Count = z.number().int().min(0);
/** A percentage with one decimal, 0 to 100. */
const Percent = z.number().min(0).max(100);

export const FUNNEL_STAGES = ['positive_screen', 'ticket_issued', 'acknowledged', 'seen', 'remeasured'] as const;
export const FunnelStageSchema = z.enum(FUNNEL_STAGES);
export type FunnelStage = z.infer<typeof FunnelStageSchema>;

/**
 * The referral funnel, counted in journeys: a parentless ticket and every reroute that followed it are one journey, which
 * reaches a stage when any of its tickets reached that stage or a later one. The first stage counts server-known positive
 * screens only (unclaimed unexpired invites, journeys, crisis events); screens that stayed on a phone are not counted.
 */
export const FunnelResponseSchema = z.object({
  period: MetricPeriodSchema,
  source: TicketSourceSchema.nullable(),
  tier: TicketTierSchema.nullable(),
  stages: z.array(
    z.object({
      stage: FunnelStageSchema,
      count: orSuppressed(Count),
      /** Of those who reached this stage, the percentage who reached the next one. Null on the last stage. */
      carriedOn: orSuppressed(Percent).nullable(),
    }),
  ),
  /** What the first stage cannot count, so the tile can say so: screens that never left a phone, and crisis events that cannot be matched to a ticket. */
  notCounted: z.object({ appOnlyScreens: z.literal(true), crisisEventsUnmatched: z.literal(true) }),
});
export type FunnelResponse = z.infer<typeof FunnelResponseSchema>;

/** One rate: how many of how many, as a share. Published only when both sides of it clear the threshold. */
export const RateSchema = z.object({ count: Count, of: Count, percent: Percent });
export type Rate = z.infer<typeof RateSchema>;

export const TimelinessCellSchema = z.object({
  /** Tickets whose promise has been settled: they reached `seen` or went overdue. */
  tickets: Count,
  withinTarget: orSuppressed(RateSchema),
  medianDaysToSeen: orSuppressed(z.number().min(0)),
  p90DaysToSeen: orSuppressed(z.number().min(0)),
});
export type TimelinessCell = z.infer<typeof TimelinessCellSchema>;

export const TimelinessResponseSchema = z.object({
  period: MetricPeriodSchema,
  overall: orSuppressed(TimelinessCellSchema),
  tiers: z.array(z.object({ tier: TicketTierSchema, cell: orSuppressed(TimelinessCellSchema) })),
  /** Tickets that are overdue now. The list is shown only when enough tickets stand behind it, and holds pseudonymous ids. */
  overdue: orSuppressed(
    z.object({
      count: Count,
      shown: Count,
      tickets: z.array(z.object({ id: z.string(), daysOverdue: Count })),
    }),
  ),
  /** The directory's own listed waits (mock services), not a measurement of anyone. */
  indicativeWait: z.array(z.object({ service: z.string(), tier: TierSchema, days: Count, sample: z.literal(true) })),
});
export type TimelinessResponse = z.infer<typeof TimelinessResponseSchema>;

export const CrisisResponseSchema = z.object({
  period: MetricPeriodSchema,
  shown: orSuppressed(Count),
  calledALine: orSuppressed(RateSchema),
  contactConfirmed: orSuppressed(RateSchema),
  medianMinutesToContact: orSuppressed(z.number().min(0)),
});
export type CrisisResponse = z.infer<typeof CrisisResponseSchema>;

/** The instruments a symptom change is measured on: the two that have a reliable-change threshold. */
export const OUTCOME_INSTRUMENTS = ['phq9', 'gad7'] as const;
export const OutcomeInstrumentSchema = z.enum(OUTCOME_INSTRUMENTS);
export type OutcomeInstrument = z.infer<typeof OutcomeInstrumentSchema>;

/**
 * Symptom change among re-measured tickets, per instrument, for the last 90 days only. Only totals the person shared are used
 * (a live `scores` consent, a referral total and a repeat-check total of the same instrument) and only when the person also
 * opted in to anonymous statistics; a re-measured ticket without all of that is `excluded`. `meanChange` is the repeat total
 * minus the referral total, in points (negative is fewer symptoms), and the two shares are of the included tickets: reliable
 * improvement is a fall of at least the instrument's threshold, deterioration a rise of at least it. Every figure is `{ suppressed: true }` when too few people stand behind it, or when showing it would let
 * a hidden number be worked out from the ones beside it (see `hiddenCells`).
 */
export const OutcomesResponseSchema = z.object({
  period: z.literal(EQUITY_PERIOD),
  /** The points of change that count as reliable, per instrument (`RELIABLE_CHANGE`). */
  reliableChangePoints: z.object({ phq9: z.number().int().positive(), gad7: z.number().int().positive() }),
  /** Tickets that reached re-measured in the last 90 days: the same people as the funnel's last stage for that period. */
  remeasured: orSuppressed(Count),
  instruments: z.array(
    z.object({
      instrument: OutcomeInstrumentSchema,
      included: orSuppressed(Count),
      excluded: orSuppressed(Count),
      meanChange: orSuppressed(z.number()),
      reliableImprovement: orSuppressed(RateSchema),
      reliableDeterioration: orSuppressed(RateSchema),
    }),
  ),
});
export type OutcomesResponse = z.infer<typeof OutcomesResponseSchema>;

export const EQUITY_DIMENSIONS = ['age_band', 'gender', 'language', 'region'] as const;
export const EquityDimensionSchema = z.enum(EQUITY_DIMENSIONS);
export type EquityDimension = z.infer<typeof EquityDimensionSchema>;

/** A gap of this many points or more from the overall rate is flagged. */
export const EQUITY_FLAG_POINTS = 10;

/** The value of the "no bucket given" group in a dimension a person may leave empty. */
export const NOT_GIVEN = 'not_given';

export const EquityCellSchema = z.object({
  tickets: Count,
  loopClosed: Count,
  ratePercent: Percent,
  medianDaysToSeen: z.number().min(0),
  /** The cell's rate minus the overall rate, in points. */
  gapPoints: z.number(),
  flagged: z.boolean(),
});
export type EquityCell = z.infer<typeof EquityCellSchema>;

export const EquityValueSchema = z.union([AgeBandSchema, GenderSchema, CareLanguageSchema, RegionSchema, z.literal(NOT_GIVEN)]);

export const EquityResponseSchema = z.object({
  period: MetricPeriodSchema,
  flagPoints: z.literal(EQUITY_FLAG_POINTS),
  overall: orSuppressed(z.object({ tickets: Count, loopClosed: Count, ratePercent: Percent })),
  dimensions: z.array(
    z.object({
      dimension: EquityDimensionSchema,
      rows: z.array(z.object({ value: EquityValueSchema, cell: orSuppressed(EquityCellSchema) })),
    }),
  ),
});
export type EquityResponse = z.infer<typeof EquityResponseSchema>;

/** `GET /clock`: open to anyone, holds no person data. `offsetMs` is how far the demo clock is ahead of the wall (always 0 with the demo off). */
export const ClockStateSchema = z.object({ demoMode: z.boolean(), offsetMs: z.number().int().min(0) });
export type ClockState = z.infer<typeof ClockStateSchema>;

/** The steps the demo clock can take: +7 days (the day-7 check), +3 weeks (the re-check), +6 weeks (re-measure). */
export const DEMO_ADVANCE_STEPS = ['7d', '3w', '6w'] as const;
export const DemoAdvanceStepSchema = z.enum(DEMO_ADVANCE_STEPS);
export type DemoAdvanceStep = z.infer<typeof DemoAdvanceStepSchema>;

export const AdvanceClockRequestSchema = z.object({ by: DemoAdvanceStepSchema }).strict();
export type AdvanceClockRequest = z.infer<typeof AdvanceClockRequestSchema>;

export const AdvanceClockResultSchema = ClockStateSchema.extend({
  now: z.iso.datetime({ offset: true }),
  /** Tickets the sweep moved to overdue straight after the step. */
  markedOverdue: Count,
});
export type AdvanceClockResult = z.infer<typeof AdvanceClockResultSchema>;

/** Noura's invite: the code and the mock TAMM page that opens with it, in each language. Made by a reset and by `POST /demo/noura-invite`. */
export const NouraInviteResultSchema = z.object({
  code: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
  tammUrl: z.object({ ar: z.string(), en: z.string() }),
});
export type NouraInviteResult = z.infer<typeof NouraInviteResultSchema>;

/** What a reset hands the presenter: Noura's invite code and the mock TAMM page that opens with it, in each language. */
export const DemoResetResultSchema = z.object({
  offsetMs: z.literal(0),
  seededAt: z.iso.datetime({ offset: true }),
  noura: NouraInviteResultSchema,
});
export type DemoResetResult = z.infer<typeof DemoResetResultSchema>;

export type EquityValue = z.infer<typeof EquityValueSchema>;
