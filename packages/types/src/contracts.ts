import { z } from 'zod';
import {
  ActorSchema,
  CareLanguageSchema,
  ConsentElementSchema,
  LocaleSchema,
  ModalitySchema,
  RegionSchema,
  RerouteReasonSchema,
  SHAREABLE_INSTRUMENTS,
  StaffRoleSchema,
  TicketSourceSchema,
  TicketStateSchema,
  TierSchema,
} from './enums';
import { CrisisEventSchema, DemographicsSchema, PreferencesSchema, ServiceSchema, TicketSchema } from './entities';

/** Person bearer credential: `<personId>.<secret>`. The secret is 32 random bytes, base64url. */
export const PERSON_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const PersonSecretSchema = z.string().regex(PERSON_SECRET_PATTERN);

/** POST /persons. The device generates both values; no name, email, Emirates ID or phone is sent. */
export const RegisterPersonRequestSchema = z.object({
  id: z.uuid(),
  secret: PersonSecretSchema,
  locale: LocaleSchema,
});
export type RegisterPersonRequest = z.infer<typeof RegisterPersonRequestSchema>;

export const RegisterPersonResponseSchema = z.object({
  id: z.uuid(),
  created: z.boolean(),
});
export type RegisterPersonResponse = z.infer<typeof RegisterPersonResponseSchema>;

export const MagicLinkRequestSchema = z.object({ email: z.email() });
export type MagicLinkRequest = z.infer<typeof MagicLinkRequestSchema>;

export const VerifyMagicLinkRequestSchema = z.object({ token: z.string().min(20).max(200) });
export type VerifyMagicLinkRequest = z.infer<typeof VerifyMagicLinkRequestSchema>;

export const SessionSchema = z.object({
  sessionToken: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
  role: StaffRoleSchema,
  facilityId: z.uuid().nullable(),
});
export type Session = z.infer<typeof SessionSchema>;

export const StaffMeSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  role: StaffRoleSchema,
  facilityId: z.uuid().nullable(),
});
export type StaffMe = z.infer<typeof StaffMeSchema>;

/** Staff GET /tickets/:id. Ticket fields only; the consented bundle arrives with the clinician detail view. */
export const StaffTicketViewSchema = TicketSchema.pick({
  id: true,
  shortCode: true,
  tier: true,
  state: true,
  language: true,
  deadlineAt: true,
  source: true,
  serviceId: true,
  createdAt: true,
});
export type StaffTicketView = z.infer<typeof StaffTicketViewSchema>;

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const HealthResponseSchema = z.object({ status: z.literal('ok') });

/**
 * POST /crisis-events: one snapshot of a crisis event, keyed by the id the device generated. It carries no person
 * id, no item answers and no free text, and the schema is strict so a body that adds any of them is refused
 * instead of quietly dropped. `followUpAt` is the server's alone and is not accepted.
 */
export const CrisisEventSubmissionSchema = CrisisEventSchema.omit({ followUpAt: true })
  .strict()
  .refine((event) => event.humanContactConfirmed === (event.contactAt !== null), {
    message: 'contactAt is set exactly when human contact is confirmed',
  })
  .refine((event) => event.humanContactConfirmed === (event.contactSource !== null), {
    message: 'contactSource is set exactly when human contact is confirmed',
  });
export type CrisisEventSubmission = z.infer<typeof CrisisEventSubmissionSchema>;

export const CrisisEventReceiptSchema = z.object({ id: z.uuid(), created: z.boolean() });
export type CrisisEventReceipt = z.infer<typeof CrisisEventReceiptSchema>;

/** GET /services filters. The person app sends none: matching happens on the device. */
export const ServicesQuerySchema = z.object({
  tier: TierSchema.optional(),
  region: RegionSchema.optional(),
  modality: ModalitySchema.optional(),
  language: CareLanguageSchema.optional(),
});
export type ServicesQuery = z.infer<typeof ServicesQuerySchema>;

export const ServicesResponseSchema = z.array(ServiceSchema);

const Instant = z.iso.datetime({ offset: true });

/** One score the person may share: a total and band, never the item answers. */
export const ScoreEntrySchema = z
  .object({ instrument: z.enum(SHAREABLE_INSTRUMENTS), total: z.number().int().min(0).max(100), band: z.string().max(40).nullable(), takenAt: Instant })
  .strict();
export type ScoreEntry = z.infer<typeof ScoreEntrySchema>;

/**
 * What a bundle can hold, keyed by consent element. The required `ticket` element has no entry: it is the ticket's own
 * fields. Item answers have no place here, so no consent can send them.
 */
export const BundleContentSchema = z
  .object({
    scores: z.array(ScoreEntrySchema).max(3).optional(),
    trajectory: z.array(ScoreEntrySchema).max(120).optional(),
    free_text: z.string().max(2000).optional(),
    conditions: z.array(z.string().min(1).max(80)).max(20).optional(),
    preferences: PreferencesSchema.optional(),
  })
  .strict();
export type BundleContent = z.infer<typeof BundleContentSchema>;

/** The longest referral summary, in words, that is drafted or approved. */
export const SUMMARY_WORD_LIMIT = 120;

/** POST /tickets and the body of a reroute. The elements named in `consents` are the only ones kept from `content`. */
export const CreateTicketRequestSchema = z
  .object({
    clientRequestId: z.uuid(),
    serviceId: z.uuid(),
    windowDays: z.number().int().min(1).max(30),
    language: CareLanguageSchema,
    consents: z.array(ConsentElementSchema).min(1).max(6),
    content: BundleContentSchema,
    approvedSummary: z.string().max(1500).nullable().default(null),
    summaryRequestId: z.uuid().nullable().default(null),
  })
  .strict();
export type CreateTicketRequest = z.infer<typeof CreateTicketRequestSchema>;

export const RerouteRequestSchema = CreateTicketRequestSchema.extend({ reason: RerouteReasonSchema });
export type RerouteRequest = z.infer<typeof RerouteRequestSchema>;

export const ConsentRecordSchema = z.object({ id: z.uuid(), element: ConsentElementSchema, recipient: z.string(), grantedAt: Instant, revokedAt: Instant.nullable() });
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;

export const TicketEventViewSchema = z.object({
  seq: z.number().int().min(1),
  fromState: TicketStateSchema.nullable(),
  toState: TicketStateSchema,
  actor: ActorSchema,
  reason: z.string().nullable(),
  selfConfirmed: z.boolean(),
  at: Instant,
});
export type TicketEventView = z.infer<typeof TicketEventViewSchema>;

/** A person's own ticket, with its timeline, the clinic's contact and the consents that stand behind it. */
export const PersonTicketViewSchema = z.object({
  id: z.uuid(),
  shortCode: z.string(),
  qrPayload: z.string(),
  tier: TierSchema,
  state: TicketStateSchema,
  language: CareLanguageSchema,
  deadlineAt: Instant,
  source: TicketSourceSchema,
  serviceId: z.uuid(),
  serviceName: z.string(),
  clinicName: z.string(),
  clinicContact: z.string(),
  parentTicketId: z.uuid().nullable(),
  createdAt: Instant,
  events: z.array(TicketEventViewSchema),
  consents: z.array(ConsentRecordSchema),
});
export type PersonTicketView = z.infer<typeof PersonTicketViewSchema>;

export const CreatedTicketSchema = z.object({ created: z.boolean(), ticket: PersonTicketViewSchema });
export type CreatedTicket = z.infer<typeof CreatedTicketSchema>;

export const PersonTicketListSchema = z.array(PersonTicketViewSchema);

/** A state change asked for by a person or a clinic. A change to the state the ticket is already in is "unable to see". */
export const TicketEventRequestSchema = z
  .object({ to: TicketStateSchema, reason: z.string().trim().min(1).max(200).optional(), selfConfirmed: z.boolean().default(false) })
  .strict();
export type TicketEventRequest = z.infer<typeof TicketEventRequestSchema>;

export const TicketEventResultSchema = z.object({ state: TicketStateSchema, event: TicketEventViewSchema });
export type TicketEventResult = z.infer<typeof TicketEventResultSchema>;

/** POST /consents: adds one element to a live ticket after the fact. */
export const GrantConsentRequestSchema = z
  .object({ ticketId: z.uuid(), element: ConsentElementSchema, content: BundleContentSchema })
  .strict();
export type GrantConsentRequest = z.infer<typeof GrantConsentRequestSchema>;

export const RevokeConsentResultSchema = z.object({
  /** The elements removed from the bundle. Revoking the required `ticket` element removes all of them. */
  revoked: z.array(ConsentRecordSchema),
  ticketState: TicketStateSchema,
});
export type RevokeConsentResult = z.infer<typeof RevokeConsentResultSchema>;

/** What a clinician reads: only consented elements, and the list of optional ones the person did not share. */
export const StaffBundleViewSchema = z.object({
  ticketId: z.uuid(),
  shortCode: z.string(),
  content: BundleContentSchema,
  notShared: z.array(ConsentElementSchema),
  approvedSummary: z.string().nullable(),
});
export type StaffBundleView = z.infer<typeof StaffBundleViewSchema>;

/** The person's view of who read their bundle. Roles and the facility, never a staff member's name. */
export const BundleReadViewSchema = z.object({ at: Instant, role: StaffRoleSchema, facilityName: z.string() });
export type BundleReadView = z.infer<typeof BundleReadViewSchema>;

export const SummaryDraftRequestSchema = z
  .object({
    requestId: z.uuid(),
    locale: LocaleSchema,
    useAi: z.boolean(),
    consented: z.array(ConsentElementSchema).max(6),
    content: BundleContentSchema,
  })
  .strict();
export type SummaryDraftRequest = z.infer<typeof SummaryDraftRequestSchema>;

export const SummaryDraftSchema = z.object({ source: z.enum(['ai', 'template']), text: z.string() });
export type SummaryDraft = z.infer<typeof SummaryDraftSchema>;

/** PUT /persons/me/equity. Opting out clears the buckets on the server. */
export const EquityRequestSchema = z.object({ optIn: z.boolean(), buckets: DemographicsSchema.optional() }).strict();
export type EquityRequest = z.infer<typeof EquityRequestSchema>;

export const OpenApiDocumentSchema = z.object({ openapi: z.string(), paths: z.record(z.string(), z.unknown()) }).passthrough();
