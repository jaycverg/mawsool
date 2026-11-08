import type { StorageAdapter, TabMarkAdapter } from '@mawsool/ui';
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
 * Wipes everything on this phone: the encrypted store and its key, and the tab's crisis mark with them, so deleting
 * everything leaves nothing behind that could still hold a block. Nothing on the server is touched here; `eraseEverything`
 * (erase.ts) does that first.
 */
export async function deleteDeviceData(storage: StorageAdapter, tabMark?: TabMarkAdapter<unknown>): Promise<void> {
  await storage.clear();
  tabMark?.set(null);
}
