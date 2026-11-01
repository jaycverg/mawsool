import { z } from 'zod';
import { CareLanguageSchema, LocaleSchema, ModalitySchema, RegionSchema, StaffRoleSchema, TierSchema } from './enums';
import { CrisisEventSchema, ServiceSchema, TicketSchema } from './entities';

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
