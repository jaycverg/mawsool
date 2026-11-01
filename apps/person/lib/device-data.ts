import type { StorageAdapter, TabFlagAdapter } from '@mawsool/ui';
import { KEYS } from './keys';

/**
 * Everything the person put on this phone, as JSON they can copy: check-ins, preferences, health plan, choice and
 * the crisis record. The device credential, the cached directory and the unsent queue are left out: the first is a
 * secret, the others are not the person's data.
 */
export async function exportDeviceData(storage: StorageAdapter, now: () => Date): Promise<string> {
  const [screenings, preferences, insurance, choice, crisis] = await Promise.all(
    [KEYS.screenings, KEYS.preferences, KEYS.insurance, KEYS.choice, KEYS.crisisBlock].map((key) => storage.get<unknown>(key)),
  );
  return JSON.stringify(
    { exportedAt: now().toISOString(), screenings: screenings ?? [], preferences: preferences ?? {}, insurance: insurance ?? null, choice: choice ?? null, crisis: crisis ?? null },
    null,
    2,
  );
}

/**
 * Wipes everything on this phone: the encrypted store and its key, and the tab's crisis flag with them, so deleting
 * everything leaves nothing behind that could still hold a block. Nothing on the server is touched here.
 */
export async function deleteDeviceData(storage: StorageAdapter, tabFlag?: TabFlagAdapter): Promise<void> {
  await storage.clear();
  tabFlag?.set(false);
}
