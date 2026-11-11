import { z } from 'zod';
import type { StorageAdapter } from '@mawsool/ui';
import { KEYS } from './keys';
import { callServer, type ServerDeps } from './server';

/**
 * Whether this phone has the separate choice to count the totals it sent a clinic in anonymous group figures turned on, so the
 * choice can be shown and undone. The server holds the real value on the person; this is the phone's note of it, off unless set,
 * and it is removed with everything else by "Delete everything".
 */
const StoredSchema = z.object({ optIn: z.boolean() });

export async function loadOutcomeStatistics(storage: StorageAdapter): Promise<boolean> {
  const parsed = StoredSchema.safeParse(await storage.get<unknown>(KEYS.outcomeStatistics));
  return parsed.success ? parsed.data.optIn : false;
}

export function saveOutcomeStatistics(storage: StorageAdapter, optIn: boolean): Promise<void> {
  return storage.set(KEYS.outcomeStatistics, { optIn });
}

/**
 * - `done`: the server stopped counting this person's totals, and the phone noted it (a phone that could not keep the note is
 *   still `done`: the server is what counts, and turning it off again is harmless);
 * - `failed`: the server could not be reached or refused, so the choice is still on and nothing changed on the phone.
 */
export type TurnedOff = 'done' | 'failed';

/** Turns the choice off on the server, which takes the person's tickets out of the next read of the figures, and then on the phone. */
export async function turnOffOutcomeStatistics(server: ServerDeps): Promise<TurnedOff> {
  const done = await callServer<unknown>(server, 'PUT', '/me/outcome-statistics', { optIn: false });
  if (!done.ok) return 'failed';
  await saveOutcomeStatistics(server.storage, false).catch(() => undefined);
  return 'done';
}
