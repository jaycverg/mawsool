import { z } from 'zod';

/**
 * What kind of adverse event was recorded. A fixed list, never free text: the log holds no person's name, number, score or
 * answer, and no sentence about one.
 */
export const ADVERSE_EVENT_TYPES = ['missed_crisis_follow_up', 'wrong_routing', 'data_incident'] as const;
export const AdverseEventTypeSchema = z.enum(ADVERSE_EVENT_TYPES);
export type AdverseEventType = z.infer<typeof AdverseEventTypeSchema>;

/** How serious it was, least to most. */
export const ADVERSE_EVENT_SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;
export const AdverseEventSeveritySchema = z.enum(ADVERSE_EVENT_SEVERITIES);
export type AdverseEventSeverity = z.infer<typeof AdverseEventSeveritySchema>;

/** Where it stands. It only moves forward: open to investigating to closed, or open straight to closed. */
export const ADVERSE_EVENT_STATUSES = ['open', 'investigating', 'closed'] as const;
export const AdverseEventStatusSchema = z.enum(ADVERSE_EVENT_STATUSES);
export type AdverseEventStatus = z.infer<typeof AdverseEventStatusSchema>;

/** The shape of the keyed pseudonymous ticket id the overdue list shows (`od_` and twelve hex digits). It names no ticket, person or code. */
export const TICKET_REF_PATTERN = /^od_[0-9a-f]{12}$/;
export const TicketRefSchema = z.string().regex(TICKET_REF_PATTERN);

const Instant = z.iso.datetime({ offset: true });

/** `POST /adverse-events`: what happened, how serious, when, and optionally which ticket (by its pseudonymous id). */
export const RecordAdverseEventRequestSchema = z
  .object({
    type: AdverseEventTypeSchema,
    severity: AdverseEventSeveritySchema,
    /** When it happened, on the care clock; the care clock's now when left out. Never later than the care clock's now. */
    occurredAt: Instant.optional(),
    ticketRef: TicketRefSchema.optional(),
  })
  .strict();
export type RecordAdverseEventRequest = z.infer<typeof RecordAdverseEventRequestSchema>;

/** `POST /adverse-events/:id/status`. */
export const MoveAdverseEventRequestSchema = z.object({ to: AdverseEventStatusSchema }).strict();
export type MoveAdverseEventRequest = z.infer<typeof MoveAdverseEventRequestSchema>;

/** One recorded move of an event's status: the first is the recording itself (`from` is null). `at` is the wall clock. */
export const AdverseEventMoveSchema = z.object({
  from: AdverseEventStatusSchema.nullable(),
  to: AdverseEventStatusSchema,
  at: Instant,
  /** The role of the staff member who made the move. */
  by: z.enum(['ops', 'admin']),
});
export type AdverseEventMove = z.infer<typeof AdverseEventMoveSchema>;

export const AdverseEventSchema = z.object({
  id: z.uuid(),
  type: AdverseEventTypeSchema,
  severity: AdverseEventSeveritySchema,
  status: AdverseEventStatusSchema,
  /** When it happened (care clock). */
  occurredAt: Instant,
  /** When it was recorded (wall clock). */
  recordedAt: Instant,
  ticketRef: TicketRefSchema.nullable(),
  history: z.array(AdverseEventMoveSchema),
});
export type AdverseEvent = z.infer<typeof AdverseEventSchema>;

/** `GET /adverse-events` filters: a status and a severity, each optional. */
export const AdverseEventsQuerySchema = z.object({ status: AdverseEventStatusSchema.optional(), severity: AdverseEventSeveritySchema.optional() });
export type AdverseEventsQuery = z.infer<typeof AdverseEventsQuerySchema>;

/**
 * The log: the events (newest occurrence first) and how many there are in each status and each severity, over the whole log
 * whatever the filter. It is a record of incidents, not a published aggregate of people: it names no person, and holds no
 * count of anyone, so nothing here is suppressed.
 */
export const AdverseEventsResponseSchema = z.object({
  items: z.array(AdverseEventSchema),
  counts: z.object({
    byStatus: z.object({ open: z.number().int().min(0), investigating: z.number().int().min(0), closed: z.number().int().min(0) }),
    bySeverity: z.object({ low: z.number().int().min(0), moderate: z.number().int().min(0), high: z.number().int().min(0), critical: z.number().int().min(0) }),
  }),
});
export type AdverseEventsResponse = z.infer<typeof AdverseEventsResponseSchema>;
