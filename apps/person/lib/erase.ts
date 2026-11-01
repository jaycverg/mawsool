import type { StorageAdapter, TabMarkAdapter } from '@mawsool/ui';
import { pendingEvents, type FlushResult } from './crisis-outbox';
import { deleteDeviceData } from './device-data';
import { callServer, hasServerFootprint, type ServerDeps } from './server';
import { within } from './within';

/** How long "Delete everything" waits for the unsent crisis record to reach the server before it carries on. */
const CRISIS_SEND_PATIENCE_MS = 8000;

export type EraseOutcome =
  | {
      status: 'erased';
      /** What became of a crisis record that had not been sent when the person asked: sent first, or deleted with the rest. */
      crisisRecord: 'none' | 'sent' | 'deleted';
      /** A crisis screen was open when everything was wiped. The block goes with the data; Help now remains. */
      crisisWasOpen: boolean;
    }
  /** The server holds data that only this phone's secret can ask to remove, and it could not be reached. Nothing was deleted. */
  | { status: 'blocked' }
  /** The phone's own storage would not delete. */
  | { status: 'failed' };

export interface EraseDeps {
  storage: StorageAdapter;
  tabMark: TabMarkAdapter<unknown>;
  server: ServerDeps;
  /** Sends the queued crisis events. */
  flushCrisis: () => Promise<FlushResult>;
  /** Whether a crisis screen is open right now. */
  crisisIsOpen: () => Promise<boolean>;
}

/**
 * "Delete everything": revokes what the server holds, then wipes the phone. The order matters, because the wipe
 * destroys the one secret that can ask the server to delete anything.
 *
 *  1. A crisis record that was never sent is sent first, within a time limit. It holds no person id and no answers,
 *     so sending it discloses nothing the person has not already given; if it cannot be sent, erasure wins and it goes
 *     with everything else, and the outcome says so.
 *  2. If this phone ever gave the server anything to keep (a ticket, a draft, the equity buckets), the server is asked
 *     to revoke every consent, delete the summaries and clear the buckets. If it cannot be reached, the run stops here
 *     with nothing deleted. A phone that never did so wipes without any network.
 *  3. The encrypted store, its key and the tab's crisis mark are removed.
 */
export async function eraseEverything(deps: EraseDeps): Promise<EraseOutcome> {
  let footprint: boolean;
  let unsent: number;
  try {
    footprint = await hasServerFootprint(deps.storage);
    unsent = (await pendingEvents(deps.storage)).length;
  } catch {
    return { status: 'failed' };
  }
  const crisisWasOpen = await deps.crisisIsOpen().catch(() => false);

  let crisisRecord: 'none' | 'sent' | 'deleted' = 'none';
  if (unsent > 0) {
    await within(deps.flushCrisis(), CRISIS_SEND_PATIENCE_MS, null);
    crisisRecord = (await pendingEvents(deps.storage).catch(() => [null])).length === 0 ? 'sent' : 'deleted';
  }

  if (footprint) {
    const revoked = await callServer(deps.server, 'DELETE', '/me/data');
    if (!revoked.ok) return { status: 'blocked' };
  }

  try {
    await deleteDeviceData(deps.storage, deps.tabMark);
  } catch {
    return { status: 'failed' };
  }
  return { status: 'erased', crisisRecord, crisisWasOpen };
}
