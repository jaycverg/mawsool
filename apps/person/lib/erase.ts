import type { StorageAdapter, TabMarkAdapter } from '@mawsool/ui';
import type { AnonymousStore } from './anonymous';
import { loadHandoffs } from './crisis-handoff';
import { pendingEvents, type FlushResult } from './crisis-outbox';
import { deleteDeviceData, type AnonymousLeft, type DeviceWipe } from './device-data';
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
      /** Whether an anonymous check-in database is left: none, to be deleted at the next start of the app, or unknown (the person is asked to run Delete everything again). */
      anonymousLeft: AnonymousLeft;
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
  /** The anonymous session's encrypted database, deleted with the rest. The browser's own when not given. */
  anonymousStore?: AnonymousStore | null;
}

/**
 * "Delete everything": revokes what the server holds, then wipes the phone. The order matters, because the wipe
 * destroys the one secret that can ask the server to delete anything.
 *
 *  1. A crisis record that was never sent is sent first, within a time limit. It holds no person id and no answers,
 *     so sending it discloses nothing the person has not already given; if it cannot be sent, erasure wins and it goes
 *     with everything else, and the outcome says so.
 *  2. If this phone ever gave the server anything to keep (a ticket, a draft, the equity buckets, a note for the crisis line), the
 *     server is asked to revoke every consent, delete the summaries and notes and clear the buckets, with the ids of the notes
 *     this phone made so that one still on its way is refused. If it cannot be reached, the run stops here
 *     with nothing deleted. A phone that never did so wipes without any network.
 *  3. The encrypted store, its key, the anonymous sessions' encrypted stores and their keys, and the tab's crisis mark are removed.
 *     An anonymous store that cannot be deleted right now does not stop the rest: the erase still reports as done, and says that
 *     those check-ins are deleted at the next start of the app.
 */
export async function eraseEverything(deps: EraseDeps): Promise<EraseOutcome> {
  let footprint: boolean;
  let unsent: number;
  let handoffIds: string[];
  try {
    footprint = await hasServerFootprint(deps.storage);
    unsent = (await pendingEvents(deps.storage)).length;
    // The ids of every note this phone ever tried to hand to the crisis line, including one whose send never got an answer.
    handoffIds = (await loadHandoffs(deps.storage)).map((record) => record.handoffId).slice(-100);
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
    // Any failure on the way to the server stops the run with nothing deleted: `callServer` reports a phone that cannot
    // read its own device secret the same way as a network that is down.
    // The ids go with the request, so the server can also refuse a send it has not seen yet and that is still on its way.
    const revoked = await callServer(deps.server, 'DELETE', '/me/data', handoffIds.length > 0 ? { handoffIds } : undefined);
    if (!revoked.ok) return { status: 'blocked' };
  }

  let wiped: DeviceWipe;
  try {
    wiped = await deleteDeviceData(deps.storage, deps.tabMark, deps.anonymousStore);
  } catch {
    return { status: 'failed' };
  }
  return { status: 'erased', crisisRecord, crisisWasOpen, anonymousLeft: wiped.anonymousLeft };
}
