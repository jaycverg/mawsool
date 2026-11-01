import { completedSeries, isCompleteScreening } from '@mawsool/rules';
import { SHAREABLE_INSTRUMENTS, TierSchema, type BundleContent, type Preferences, type Screening, type ScoreEntry } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import { z } from 'zod';
import { KEYS } from './keys';
import { withStoreLock } from './lock';

/** What the person has typed for the clinic: kept here, on the phone, until they choose to share it. */
const SharingSchema = z.object({
  note: z.string().max(2000).default(''),
  /** One health condition per entry, as the person wrote it. */
  conditions: z.array(z.string().min(1).max(80)).max(20).default([]),
  /** The "Use AI to help write my note" tick. Off until the person ticks it. */
  useAi: z.boolean().default(false),
});
export type Sharing = z.infer<typeof SharingSchema>;

export const EMPTY_SHARING: Sharing = { note: '', conditions: [], useAi: false };

export async function loadSharing(storage: StorageAdapter): Promise<Sharing> {
  const parsed = SharingSchema.safeParse(await storage.get<unknown>(KEYS.sharing));
  return parsed.success ? parsed.data : EMPTY_SHARING;
}

export function saveSharing(storage: StorageAdapter, sharing: Sharing): Promise<void> {
  return storage.set(KEYS.sharing, sharing);
}

/** Splits what was typed into conditions: one per line or comma, trimmed, blanks and repeats dropped. */
export function parseConditions(text: string): string[] {
  return [...new Set(text.split(/[\n,،]/).map((entry) => entry.trim().slice(0, 80)).filter(Boolean))].slice(0, 20);
}

function entry(screening: Screening): ScoreEntry {
  return { instrument: screening.instrument as ScoreEntry['instrument'], total: screening.total, band: screening.band, takenAt: screening.takenAt };
}

/**
 * Everything the person could share, as bundle content: the latest finished score of each questionnaire, the whole
 * series, the typed note and conditions, and the matching preferences. The consent screen then keeps only the elements
 * ticked (`redact`). Item answers are never part of it, and neither is the C-SSRS.
 */
export function buildContent(screenings: readonly Screening[], preferences: Preferences, sharing: Sharing): BundleContent {
  const tracked = SHAREABLE_INSTRUMENTS.filter((instrument) => completedSeries([...screenings], instrument).length > 0);
  const scores = tracked.map((instrument) => entry(completedSeries([...screenings], instrument).at(-1)!));
  const trajectory = SHAREABLE_INSTRUMENTS.flatMap((instrument) => completedSeries([...screenings], instrument).map(entry)).sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const content: BundleContent = {};
  if (scores.length > 0) content.scores = scores;
  if (trajectory.length > 0) content.trajectory = trajectory.slice(-120);
  if (sharing.note.trim() !== '') content.free_text = sharing.note.trim();
  if (sharing.conditions.length > 0) content.conditions = sharing.conditions;
  if (Object.keys(preferences).length > 0) content.preferences = preferences;
  return content;
}

/** True when the device holds at least one finished check-in the person could share. */
export function hasScores(screenings: readonly Screening[]): boolean {
  return screenings.some((screening) => isCompleteScreening(screening) && (SHAREABLE_INSTRUMENTS as readonly string[]).includes(screening.instrument));
}

/** A ticket this phone issued: enough to find it on the server and to know what to revoke. */
const StoredTicketSchema = z.object({ id: z.uuid(), shortCode: z.string(), serviceId: z.string(), tier: TierSchema, issuedAt: z.iso.datetime({ offset: true }) });
export type StoredTicket = z.infer<typeof StoredTicketSchema>;

export async function loadTickets(storage: StorageAdapter): Promise<StoredTicket[]> {
  const stored = await storage.get<unknown>(KEYS.tickets);
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((item) => {
    const parsed = StoredTicketSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export function rememberTicket(storage: StorageAdapter, ticket: StoredTicket): Promise<void> {
  return withStoreLock(storage, async () => {
    const all = await loadTickets(storage);
    await storage.set(KEYS.tickets, [...all.filter((item) => item.id !== ticket.id), ticket]);
  });
}

/** Whether this phone has opted in to the equity group totals, and the four buckets given, so the choice can be shown and undone. */
const EquitySchema = z.object({
  optIn: z.boolean(),
  buckets: z.object({ ageBand: z.string().nullable(), gender: z.string().nullable(), language: z.string().nullable(), region: z.string().nullable() }).partial().default({}),
});
export type StoredEquity = z.infer<typeof EquitySchema>;

export async function loadEquity(storage: StorageAdapter): Promise<StoredEquity> {
  const parsed = EquitySchema.safeParse(await storage.get<unknown>(KEYS.equity));
  return parsed.success ? parsed.data : { optIn: false, buckets: {} };
}

export function saveEquity(storage: StorageAdapter, equity: StoredEquity): Promise<void> {
  return storage.set(KEYS.equity, equity);
}
