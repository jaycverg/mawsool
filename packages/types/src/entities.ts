import { z } from 'zod';
import {
  ActorSchema,
  AgeBandSchema,
  CareLanguageSchema,
  ConsentElementSchema,
  CrisisNumberSchema,
  CrisisTriggerSchema,
  GenderSchema,
  InstrumentSchema,
  InsuranceClassSchema,
  LocaleSchema,
  ModalitySchema,
  RegionSchema,
  StaffRoleSchema,
  TicketSourceSchema,
  TimeOfDaySchema,
  TicketStateSchema,
  TierSchema,
} from './enums';

/** ISO 8601 instant with offset, as it crosses the JSON boundary. */
const Instant = z.iso.datetime({ offset: true });
const Id = z.uuid();

/** Short ticket code: `MW` plus four characters, six in all. Shown as `MW-4K7Q`. */
export const SHORT_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ShortCodeSchema = z.string().regex(/^MW[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);

/** Formats a stored short code for display: `MW4K7Q` becomes `MW-4K7Q`. */
export function formatShortCode(code: string): string {
  return `${code.slice(0, 2)}-${code.slice(2)}`;
}

/** Equity buckets. Present only when the person opted in. */
export const DemographicsSchema = z.object({
  ageBand: AgeBandSchema.nullable(),
  gender: GenderSchema.nullable(),
  language: CareLanguageSchema.nullable(),
  region: RegionSchema.nullable(),
});
export type Demographics = z.infer<typeof DemographicsSchema>;

/** Server-side person record. The device keeps the secret; the server keeps only its hash, never returned. */
export const PersonSchema = z.object({
  id: Id,
  locale: LocaleSchema,
  equityOptIn: z.boolean(),
  demographics: DemographicsSchema.nullable(),
  createdAt: Instant,
});
export type Person = z.infer<typeof PersonSchema>;

/**
 * A completed or in-progress instrument on the device. The server never stores this row; a copy reaches the
 * server only inside a consented `SharedBundle`. C-SSRS answers are 0 (no) or 1 (yes).
 */
export const ScreeningSchema = z.object({
  id: Id,
  instrument: InstrumentSchema,
  answers: z.array(z.number().int().min(0).max(5)),
  total: z.number().int().min(0).max(100),
  band: z.string().nullable(),
  item9Flag: z.boolean(),
  takenAt: Instant,
});
export type Screening = z.infer<typeof ScreeningSchema>;

/** Matching preferences. All optional; they stay on the device unless the person consents to share them. */
export const PreferencesSchema = z.object({
  language: CareLanguageSchema.optional(),
  clinicianGender: GenderSchema.optional(),
  modality: ModalitySchema.optional(),
  region: RegionSchema.optional(),
  timeOfDay: TimeOfDaySchema.optional(),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

export const FacilitySchema = z.object({
  id: Id,
  name: z.string().min(1),
  region: RegionSchema,
  /** Shown on the ticket as the clinic contact. Sample text until real contact details exist. */
  contactText: z.string().min(1),
  sample: z.boolean(),
});
export type Facility = z.infer<typeof FacilitySchema>;

/** Mock directory entry. `facilityId` is null for self-help resources and set for every other tier. */
export const ServiceSchema = z.object({
  id: Id,
  name: z.string().min(1),
  tier: TierSchema,
  modality: ModalitySchema,
  languages: z.array(CareLanguageSchema).min(1),
  clinicianGenders: z.array(GenderSchema),
  insuranceClasses: z.array(InsuranceClassSchema),
  region: RegionSchema,
  indicativeWaitDays: z.number().int().min(0),
  facilityId: Id.nullable(),
  sample: z.boolean(),
});
export type Service = z.infer<typeof ServiceSchema>;

export const TicketSchema = z.object({
  id: Id,
  shortCode: ShortCodeSchema,
  personId: Id,
  tier: TierSchema,
  serviceId: Id,
  state: TicketStateSchema,
  language: CareLanguageSchema,
  deadlineAt: Instant,
  source: TicketSourceSchema,
  parentTicketId: Id.nullable(),
  clientRequestId: Id.nullable(),
  createdAt: Instant,
});
export type Ticket = z.infer<typeof TicketSchema>;

/** Append-only. `seq` starts at 1 per ticket; (ticketId, seq) is unique. */
export const TicketEventSchema = z.object({
  id: Id,
  ticketId: Id,
  seq: z.number().int().min(1),
  fromState: TicketStateSchema.nullable(),
  toState: TicketStateSchema,
  actor: ActorSchema,
  channel: z.string().min(1),
  reason: z.string().nullable(),
  selfConfirmed: z.boolean(),
  at: Instant,
});
export type TicketEvent = z.infer<typeof TicketEventSchema>;

/** Append-only consent ledger row. A revoke sets `revokedAt` and never removes the row. */
export const ConsentSchema = z.object({
  id: Id,
  personId: Id,
  ticketId: Id.nullable(),
  recipient: z.string().min(1),
  element: ConsentElementSchema,
  grantedAt: Instant,
  revokedAt: Instant.nullable(),
});
export type Consent = z.infer<typeof ConsentSchema>;

/** Contract-level view of a shared bundle. At rest the content is AES-256-GCM ciphertext. */
export const SharedBundleSchema = z.object({
  id: Id,
  ticketId: Id,
  recipient: z.string().min(1),
  elements: z.array(ConsentElementSchema),
  approvedSummary: z.string().nullable(),
  deletedAt: Instant.nullable(),
});
export type SharedBundle = z.infer<typeof SharedBundleSchema>;

/** Carries no person id and no item answers by design. */
export const CrisisEventSchema = z.object({
  id: Id,
  trigger: CrisisTriggerSchema,
  shownAt: Instant,
  callTapped: CrisisNumberSchema.nullable(),
  contextShared: z.boolean(),
  humanContactConfirmed: z.boolean(),
  contactSource: z.enum(['self_report', 'mock_line']).nullable(),
  contactAt: Instant.nullable(),
  resolvedAt: Instant.nullable(),
  followUpAt: Instant.nullable(),
  locale: LocaleSchema,
});
export type CrisisEvent = z.infer<typeof CrisisEventSchema>;

export const AdverseEventSchema = z.object({
  id: Id,
  ticketId: Id.nullable(),
  crisisEventId: Id.nullable(),
  type: z.enum(['missed_crisis_follow_up', 'wrong_routing', 'data_incident', 'other']),
  severity: z.enum(['low', 'medium', 'high']),
  status: z.enum(['open', 'reviewed', 'closed']),
  reportedBy: z.string().min(1),
  at: Instant,
});
export type AdverseEvent = z.infer<typeof AdverseEventSchema>;

export const StaffUserSchema = z.object({
  id: Id,
  email: z.email(),
  name: z.string().min(1),
  role: StaffRoleSchema,
  facilityId: Id.nullable(),
});
export type StaffUser = z.infer<typeof StaffUserSchema>;
