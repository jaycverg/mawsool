import { z } from 'zod';
import {
  ActorSchema,
  CareLanguageSchema,
  ConsentElementSchema,
  CrisisTriggerSchema,
  InboundSourceSchema,
  LocaleSchema,
  ModalitySchema,
  RegionSchema,
  RerouteReasonSchema,
  SHAREABLE_INSTRUMENTS,
  StaffRoleSchema,
  TICKET_STATES,
  TicketSourceSchema,
  TicketStateSchema,
  TierSchema,
  UnableReasonSchema,
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

/** One row of the clinic's queue, and the ticket fields of the detail view: the ticket's own fields and nothing the person chose to share. */
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

/**
 * Staff GET /tickets/:id. The ticket fields, and the clinic's own latest "unable to see" report while it still stands:
 * the newest event is that same-state report, so the person has not moved on and the clinic has not acted since.
 */
export const StaffTicketDetailSchema = StaffTicketViewSchema.extend({
  unable: z.object({ reason: UnableReasonSchema, at: z.iso.datetime({ offset: true }) }).nullable(),
});
export type StaffTicketDetail = z.infer<typeof StaffTicketDetailSchema>;

/** States the clinic's queue can be filtered to; `open` is the three states a ticket waits in before it is seen. */
export const QUEUE_STATE_FILTERS = ['open', ...TICKET_STATES] as const;
export const QueueStateFilterSchema = z.enum(QUEUE_STATE_FILTERS);
export type QueueStateFilter = z.infer<typeof QueueStateFilterSchema>;

/** Largest page of the queue. The queue says how many more there are. */
export const QUEUE_MAX_PAGE = 200;

/** GET /tickets: filters for the clinic's queue. */
export const StaffQueueQuerySchema = z.object({
  state: QueueStateFilterSchema.default('open'),
  tier: TierSchema.optional(),
  limit: z.coerce.number().int().min(1).max(QUEUE_MAX_PAGE).default(100),
});
export type StaffQueueQuery = z.infer<typeof StaffQueueQuerySchema>;

/**
 * The clinic's queue: tickets addressed to the staff member's facility, earliest deadline first. A ticket whose share
 * the person ended is not in it, and not in the counts. `total` is how many match the filter, whatever the page holds.
 */
export const StaffQueueSchema = z.object({
  facility: z.object({ id: z.uuid(), name: z.string() }),
  total: z.number().int().min(0),
  counts: z.partialRecord(TicketStateSchema, z.number().int().min(0)),
  items: z.array(StaffTicketViewSchema),
});
export type StaffQueue = z.infer<typeof StaffQueueSchema>;

/** Largest gap between a signed request's timestamp and the API's clock, in seconds, in either direction. */
export const INBOUND_WINDOW_SECONDS = 300;

/**
 * POST /inbound/screens: a front door hands over that someone screened positive. It names no one and carries no scores:
 * the invite it creates holds only the source, when the screen was taken and the language the front door used.
 */
export const InboundScreenRequestSchema = z.object({ result: z.literal('positive'), screenedAt: z.iso.datetime({ offset: true }), locale: LocaleSchema }).strict();
export type InboundScreenRequest = z.infer<typeof InboundScreenRequestSchema>;

/** The answer to a signed inbound screen: the code the person claims the invite with, shown once, and where to claim it. */
export const InboundScreenReceiptSchema = z.object({
  inviteId: z.uuid(),
  /** Grouped for reading aloud, `ABCD-EFGH`. Only its hash is stored. */
  code: z.string(),
  claimUrl: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type InboundScreenReceipt = z.infer<typeof InboundScreenReceiptSchema>;

/** The characters of an invite code (the ticket code's alphabet), and how many. */
export const INVITE_CODE_LENGTH = 8;

/** The code as typed or linked: any case, with or without the dash and spaces. */
export const InviteCodeSchema = z
  .string()
  .max(24)
  .transform((value) => value.replace(/[\s-]/g, '').toUpperCase())
  .pipe(z.string().regex(new RegExp(`^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{${INVITE_CODE_LENGTH}}$`)));

/** POST /me/invites/claim. */
export const ClaimInviteRequestSchema = z.object({ code: InviteCodeSchema }).strict();
export type ClaimInviteRequest = z.infer<typeof ClaimInviteRequestSchema>;

/** A claimed invite, as the person's phone keeps it until the ticket is sent. */
export const ClaimedInviteSchema = z.object({ inviteId: z.uuid(), source: InboundSourceSchema, screenedAt: z.iso.datetime({ offset: true }) });
export type ClaimedInvite = z.infer<typeof ClaimedInviteSchema>;

/** A FHIR R4 Bundle as it crosses the API. The shape is checked against the R4 schema in tests, not here. */
export const FhirBundleSchema = z.looseObject({ resourceType: z.literal('Bundle') });
export type FhirBundle = z.infer<typeof FhirBundleSchema>;

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

/**
 * The language the text of a read is written in: the page's language on the phone, and nothing else about the person.
 * Left out, a person route uses the language the device registered with and the public directory uses English.
 */
export const LocaleQuerySchema = z.object({ locale: LocaleSchema.optional() });
export type LocaleQuery = z.infer<typeof LocaleQuerySchema>;

/** GET /services filters. The person app sends none of them: matching happens on the device. It sends only the page's `locale`. */
export const ServicesQuerySchema = LocaleQuerySchema.extend({
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

/** The most totals a referral, a consent or a summary draft can carry in. */
export const REFERRAL_SCORES_MAX = 3;
/** The most totals a stored bundle can hold: the referral's own plus the two of a repeat check. */
export const STORED_SCORES_MAX = REFERRAL_SCORES_MAX + 2;

/**
 * What a bundle can hold, keyed by consent element. The required `ticket` element has no entry: it is the ticket's own
 * fields. Item answers have no place here, so no consent can send them. This is what is stored and read back: `scores` holds up to
 * three totals from the referral and, if the person chooses to send them, the two totals of a repeat check (each entry carries
 * its own `takenAt`). What a person may send in (a referral, a consent, a summary draft) is `ReferralContentSchema`.
 */
export const BundleContentSchema = z
  .object({
    scores: z.array(ScoreEntrySchema).max(STORED_SCORES_MAX).optional(),
    trajectory: z.array(ScoreEntrySchema).max(120).optional(),
    free_text: z.string().max(2000).optional(),
    conditions: z.array(z.string().min(1).max(80)).max(20).optional(),
    preferences: PreferencesSchema.optional(),
  })
  .strict();
export type BundleContent = z.infer<typeof BundleContentSchema>;

/** Bundle content as a person sends it in: the same, with the referral's cap on `scores`. The repeat check's totals join the stored bundle only through their own route. */
export const ReferralContentSchema = BundleContentSchema.extend({ scores: z.array(ScoreEntrySchema).max(REFERRAL_SCORES_MAX).optional() });

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
    content: ReferralContentSchema,
    approvedSummary: z.string().max(1500).nullable().default(null),
    summaryRequestId: z.uuid().nullable().default(null),
    /** The consent elements the approved summary was written from. Stopping one of them removes the summary; stopping any other leaves it. Empty for a summary the person wrote by hand. */
    summaryBuiltFrom: z.array(ConsentElementSchema).max(6).default([]),
    /** The front-door invite this person claimed, so the ticket carries its source. Ignored when it is not theirs or was already used, and on a reroute. */
    inviteId: z.uuid().nullable().default(null),
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
  /** A code from a fixed list (reroute, unable to see, consent revoked), never free text. */
  reason: z.string().nullable(),
  selfConfirmed: z.boolean(),
  at: Instant,
});
export type TicketEventView = z.infer<typeof TicketEventViewSchema>;

/** The totals a repeat check can send: the PHQ-9 and the GAD-7, never the WHO-5 and never item answers. */
export const RemeasureScoreSchema = ScoreEntrySchema.extend({ instrument: z.enum(['phq9', 'gad7']) });

/**
 * POST /me/tickets/:id/remeasure: the person finished a repeat PHQ-9 and GAD-7. `scores` is empty unless they ticked "send
 * these totals to the clinic" on that screen, and then holds at most one total per instrument. Without it nothing leaves the phone.
 */
export const RemeasureRequestSchema = z
  .object({ scores: z.array(RemeasureScoreSchema).max(2).default([]) })
  .strict()
  .refine((request) => new Set(request.scores.map((score) => score.instrument)).size === request.scores.length, { message: 'One total per instrument' });
export type RemeasureRequest = z.infer<typeof RemeasureRequestSchema>;

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

/** The ticket after a repeat check: it is `closed`, its two new events are listed, and `scoresShared` says whether the totals were sent. */
export const RemeasureResultSchema = z.object({ state: TicketStateSchema, scoresShared: z.boolean(), events: z.array(TicketEventViewSchema) });
export type RemeasureResult = z.infer<typeof RemeasureResultSchema>;

export const CreatedTicketSchema = z.object({ created: z.boolean(), ticket: PersonTicketViewSchema });
export type CreatedTicket = z.infer<typeof CreatedTicketSchema>;

export const PersonTicketListSchema = z.array(PersonTicketViewSchema);

/**
 * A state change asked for by a person or a clinic: a move to another state, or an explicit "unable to see" with one of
 * a fixed list of reasons. A move to the state the ticket is already in is not an "unable to see": it is refused.
 */
export const TicketEventRequestSchema = z.union([
  z.object({ to: TicketStateSchema, selfConfirmed: z.boolean().default(false) }).strict(),
  z.object({ unable: z.literal(true), reason: UnableReasonSchema }).strict(),
]);
export type TicketEventRequest = z.infer<typeof TicketEventRequestSchema>;

export const TicketEventResultSchema = z.object({ state: TicketStateSchema, event: TicketEventViewSchema });
export type TicketEventResult = z.infer<typeof TicketEventResultSchema>;

/** POST /consents: adds one element to a live ticket after the fact. */
export const GrantConsentRequestSchema = z
  .object({ ticketId: z.uuid(), element: ConsentElementSchema, content: ReferralContentSchema })
  .strict();
export type GrantConsentRequest = z.infer<typeof GrantConsentRequestSchema>;

export const RevokeConsentResultSchema = z.object({
  /** The elements removed from the bundle. Revoking the required `ticket` element removes all of them. */
  revoked: z.array(ConsentRecordSchema),
  ticketState: TicketStateSchema,
  /** True when the revoke also removed the approved summary and the logged drafts, because they were built from what was shared. */
  summaryRemoved: z.boolean(),
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
    content: ReferralContentSchema,
  })
  .strict();
export type SummaryDraftRequest = z.infer<typeof SummaryDraftRequestSchema>;

export const SummaryDraftSchema = z.object({ source: z.enum(['ai', 'template']), text: z.string() });
export type SummaryDraft = z.infer<typeof SummaryDraftSchema>;

/** PUT /persons/me/equity. Opting out clears the buckets on the server. */
export const EquityRequestSchema = z.object({ optIn: z.boolean(), buckets: DemographicsSchema.optional() }).strict();
export type EquityRequest = z.infer<typeof EquityRequestSchema>;

export const OpenApiDocumentSchema = z.object({ openapi: z.string(), paths: z.record(z.string(), z.unknown()) }).passthrough();

/** How often a reminder to re-check comes, in weeks. Reminders are off until the person turns them on. */
export const REMINDER_INTERVAL_WEEKS = [2, 4] as const;
export const ReminderIntervalSchema = z.union([z.literal(2), z.literal(4)]);
export type ReminderInterval = z.infer<typeof ReminderIntervalSchema>;

/**
 * A mobile number for text reminders, in international form (`+` and 8 to 15 digits). The phone strips spaces and dashes
 * before it checks. It exists only when the person opts into reminders and chooses to give one, and it never joins a screening record.
 */
export const PhoneNumberSchema = z.string().regex(/^\+[1-9]\d{7,14}$/);
export type PhoneNumber = z.infer<typeof PhoneNumberSchema>;

/** PUT /me/reminder-phone: the optional number for text reminders and the interval it is used at. */
export const ReminderPhoneRequestSchema = z.object({ phone: PhoneNumberSchema, intervalWeeks: ReminderIntervalSchema }).strict();
export type ReminderPhoneRequest = z.infer<typeof ReminderPhoneRequestSchema>;

/** What the server answers about the number it holds: that it holds one, never the number. */
export const ReminderPhoneResultSchema = z.object({ stored: z.boolean(), intervalWeeks: ReminderIntervalSchema.nullable() });
export type ReminderPhoneResult = z.infer<typeof ReminderPhoneResultSchema>;

/**
 * The short template a person may hand to the crisis line: the language they use, the totals of their latest finished
 * check-ins (never item answers), which trigger fired (the console reads "item 9 positive" from `phq9_item9`) and, only if
 * they chose to give one, a number to call back on. Strict, so nothing else can ride along.
 */
export const CrisisHandoffContentSchema = z
  .object({
    language: LocaleSchema,
    trigger: CrisisTriggerSchema,
    scores: z.array(ScoreEntrySchema).max(REFERRAL_SCORES_MAX),
    callbackNumber: PhoneNumberSchema.nullable(),
  })
  .strict();
export type CrisisHandoffContent = z.infer<typeof CrisisHandoffContentSchema>;

/**
 * POST /me/crisis-handoffs. `consented` must be literally `true`: a request without it is refused and writes nothing.
 * `crisisEventId` is the id of the crisis event the phone already sent, the one the console's "contact made" completes.
 * `handoffId` is made by the phone, like a ticket's client request id, so it can stop the hand-off even when the reply to
 * the send was lost, and a repeated send is the same hand-off.
 */
export const CreateCrisisHandoffRequestSchema = CrisisHandoffContentSchema.extend({ handoffId: z.uuid(), crisisEventId: z.uuid(), consented: z.literal(true) }).strict();
export type CreateCrisisHandoffRequest = z.infer<typeof CreateCrisisHandoffRequestSchema>;

/** What the phone keeps to be able to stop the hand-off: the row's id and the ledger row that consent lives in. */
export const CrisisHandoffReceiptSchema = z.object({ handoffId: z.uuid(), consentId: z.uuid(), grantedAt: Instant, created: z.boolean() });
export type CrisisHandoffReceipt = z.infer<typeof CrisisHandoffReceiptSchema>;

/** DELETE /me/crisis-handoffs/:id: the consent is revoked and the hand-off row is gone. */
export const CrisisHandoffRevokedSchema = z.object({ revokedAt: Instant });
export type CrisisHandoffRevoked = z.infer<typeof CrisisHandoffRevokedSchema>;

/** One hand-off as the crisis-line console reads it. It names no person and no crisis event. */
export const CrisisHandoffViewSchema = CrisisHandoffContentSchema.extend({ id: z.uuid(), receivedAt: Instant, contactMadeAt: Instant.nullable() });
export type CrisisHandoffView = z.infer<typeof CrisisHandoffViewSchema>;

export const CrisisHandoffListSchema = z.object({ items: z.array(CrisisHandoffViewSchema) });
export type CrisisHandoffList = z.infer<typeof CrisisHandoffListSchema>;

/**
 * DELETE /me/data may carry the ids of hand-offs the phone made, including ones whose send it never heard back from, so the
 * server can refuse any of them that is still on its way. The body is optional: a phone that never handed anything over sends none.
 */
export const EraseRequestSchema = z.object({ handoffIds: z.array(z.uuid()).max(100) }).strict();
export type EraseRequest = z.infer<typeof EraseRequestSchema>;
