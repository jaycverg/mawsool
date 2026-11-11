import type { StorageAdapter, TabMarkAdapter } from '@mawsool/ui';
import { keepAnonymousSessions, wipeAnonymousData, type AnonymousStore } from './anonymous';
import { KEYS } from './keys';

/**
 * Everything the person put on this phone, as JSON they can copy: check-ins, preferences, health plan, choice, the
 * reminder settings (with the number they gave for text reminders, if any), the crisis record, the note handed to the crisis line
 * (its ids, never its contents: the number typed for it is not kept on the phone) and the next-day check with the person's answer. The device
 * credential, the cached directory and the unsent queue are left out: the first is a secret, the others are not the person's data.
 */
export async function exportDeviceData(storage: StorageAdapter, now: () => Date): Promise<string> {
  const [screenings, preferences, insurance, choice, crisis, tickets, sharing, reminders, crisisHandoff, followUp] = await Promise.all(
    [KEYS.screenings, KEYS.preferences, KEYS.insurance, KEYS.choice, KEYS.crisisBlock, KEYS.tickets, KEYS.sharing, KEYS.reminders, KEYS.crisisHandoff, KEYS.followUp].map((key) => storage.get<unknown>(key)),
  );
  return JSON.stringify(
    {
      exportedAt: now().toISOString(),
      screenings: screenings ?? [],
      preferences: preferences ?? {},
      insurance: insurance ?? null,
      choice: choice ?? null,
      crisis: crisis ?? null,
      tickets: tickets ?? [],
      sharing: sharing ?? null,
      reminders: reminders ?? null,
      crisisHandoff: crisisHandoff ?? null,
      followUp: followUp ?? null,
    },
    null,
    2,
  );
}

/**
 * What deleting the anonymous check-ins left behind:
 *  - `none`: nothing;
 *  - `next_start`: some databases could not be deleted just now; their ids are back on the list and the next start of the app deletes them;
 *  - `unknown`: some may be left and the list could not be written (or could not be made), so the next start may not find them: the person is asked to run Delete everything again.
 */
export type AnonymousLeft = 'none' | 'next_start' | 'unknown';

/** What wiping the phone left behind. */
export interface DeviceWipe {
  anonymousLeft: AnonymousLeft;
}

/**
 * Wipes everything on this phone: the encrypted store and its key, the anonymous sessions' encrypted stores and their keys, and the tab's crisis mark with them, so deleting
 * everything leaves nothing behind that could still hold a block. Nothing on the server is touched here; `eraseEverything`
 * (erase.ts) does that first.
 *
 * An anonymous database that cannot be deleted (the browser refuses, or something holds it open) never stops the rest, because the
 * server's copy is already gone by now and a retry that fails the same way would strand the person's data here:
 *
 *  1. the list of anonymous session ids is read (a browser that cannot list its databases is searched through that list alone);
 *  2. every database that can be deleted is;
 *  3. the device store is cleared regardless;
 *  4. the ids of the databases still there are written back to the list, so the next start of the app deletes them. If a throwing
 *     deletion leaves it unknown which are there, every id of the first step counts as there; if even that list could not be made, or
 *     the ids cannot be written back, the result is `unknown`.
 */
export async function deleteDeviceData(storage: StorageAdapter, tabMark?: TabMarkAdapter<unknown>, anonymous?: AnonymousStore | null): Promise<DeviceWipe> {
  const { left, unknown } = await wipeAnonymousData(anonymous);
  await storage.clear();
  tabMark?.set(null);
  // The ids are the only way a browser that cannot list its databases finds these again, so a list that cannot be written is said
  // plainly (`unknown`): the erase is still done, and the person is asked to run it again.
  const kept = await keepAnonymousSessions(left, anonymous);
  if (unknown || (left.length > 0 && !kept)) return { anonymousLeft: 'unknown' };
  return { anonymousLeft: left.length > 0 ? 'next_start' : 'none' };
}
