import { SummaryAvailabilitySchema, type SummaryAvailability } from '@mawsool/types';
import { API_URL } from './api';
import { deviceFetch } from './net';

/** Why the AI is not offered, as the consent screen's banner has it: the answers other than `available`. */
export type AiNotice = Exclude<SummaryAvailability['ai'], 'available'>;

/**
 * Asks the API whether an AI draft can be had right now (`GET /summary/availability`), for the public-demo build's banner. It is a
 * public read: the phone is not registered for it and nothing is recorded about the visit, so it does not mark a server footprint.
 * It goes through `deviceFetch`, which refuses it in an anonymous session, but callers do not ask at all in one. Returns the
 * reason to show, or null when the AI is available or the answer could not be read (a failed read shows nothing).
 */
export async function readAiNotice(): Promise<AiNotice | null> {
  try {
    const response = await deviceFetch()(`${API_URL}/summary/availability`, { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const parsed = SummaryAvailabilitySchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ai === 'available') return null;
    return parsed.data.ai;
  } catch {
    return null;
  }
}
