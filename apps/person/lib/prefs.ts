import { FALLBACK_HANDOFF_WINDOW_DAYS } from '@mawsool/rules';
import { InsuranceClassSchema, PreferencesSchema, RerouteReasonSchema, TierSchema, type InsuranceClass, type Preferences, type Tier } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import { z } from 'zod';
import { KEYS } from './keys';

/** The person's matching preferences. All optional; an unreadable value reads as none. */
export async function loadPreferences(storage: StorageAdapter): Promise<Preferences> {
  const parsed = PreferencesSchema.safeParse(await storage.get<unknown>(KEYS.preferences));
  return parsed.success ? parsed.data : {};
}

export function savePreferences(storage: StorageAdapter, preferences: Preferences): Promise<void> {
  return storage.set(KEYS.preferences, preferences);
}

/** The health plan the person picked, or "not sure" until they pick one. It never leaves the device during matching. */
export async function loadInsurance(storage: StorageAdapter): Promise<InsuranceClass> {
  const parsed = InsuranceClassSchema.safeParse(await storage.get<unknown>(KEYS.insurance));
  return parsed.success ? parsed.data : 'not_sure';
}

export function saveInsurance(storage: StorageAdapter, insurance: InsuranceClass): Promise<void> {
  return storage.set(KEYS.insurance, insurance);
}

const ChoiceSchema = z.object({
  tier: TierSchema,
  serviceId: z.string(),
  chosenAt: z.iso.datetime({ offset: true }),
  /** True once the choice is in effect: guided self-help at once, any other tier once its ticket is issued. */
  confirmed: z.boolean(),
});
export type Choice = z.infer<typeof ChoiceSchema>;

export async function loadChoice(storage: StorageAdapter): Promise<Choice | null> {
  const parsed = ChoiceSchema.safeParse(await storage.get<unknown>(KEYS.choice));
  return parsed.success ? parsed.data : null;
}

export function saveChoice(storage: StorageAdapter, choice: Choice): Promise<void> {
  return storage.set(KEYS.choice, choice);
}

/** The tier the person is on now, if any. A choice still waiting on consent is not yet the current tier. */
export function currentTier(choice: Choice | null): Tier | null {
  return choice?.confirmed ? choice.tier : null;
}

/**
 * A pick that is waiting on the consent screen. It lives apart from the current choice so that choosing, then walking
 * away from consent, never costs the person the support they are already on. `requestId` is made once per pick and
 * reused on every retry, so a retried send is the same request to the server. A reroute carries the ticket it replaces.
 */
const PendingChoiceSchema = z.object({
  tier: TierSchema,
  serviceId: z.string(),
  chosenAt: z.iso.datetime({ offset: true }),
  /** Days from issue the option promised, taken from the card the person chose. */
  windowDays: z.number().int().min(1).max(30),
  requestId: z.uuid(),
  reroute: z.object({ ticketId: z.uuid(), reason: RerouteReasonSchema }).nullable(),
});
export type PendingChoice = z.infer<typeof PendingChoiceSchema>;

export async function loadPendingChoice(storage: StorageAdapter): Promise<PendingChoice | null> {
  const parsed = PendingChoiceSchema.safeParse(await storage.get<unknown>(KEYS.pendingChoice));
  return parsed.success ? parsed.data : null;
}

export function savePendingChoice(storage: StorageAdapter, pending: PendingChoice): Promise<void> {
  return storage.set(KEYS.pendingChoice, pending);
}

export function clearPendingChoice(storage: StorageAdapter): Promise<void> {
  return storage.remove(KEYS.pendingChoice);
}

/** A pending choice for an option card: the window comes from the card, or the fallback when the card has none. */
export function pendingFrom(
  option: { tier: Tier; serviceId: string; handoffWindowDays: number | null },
  deps: { now: () => Date; newId: () => string },
  reroute: PendingChoice['reroute'],
): PendingChoice {
  return { tier: option.tier, serviceId: option.serviceId, chosenAt: deps.now().toISOString(), windowDays: option.handoffWindowDays ?? FALLBACK_HANDOFF_WINDOW_DAYS, requestId: deps.newId(), reroute };
}
