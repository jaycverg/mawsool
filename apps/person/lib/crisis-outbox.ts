import { CrisisEventSubmissionSchema, type CrisisEventSubmission, type Locale } from '@mawsool/types';
import { loadOrCreateIdentity, personAuthorization, registerDevice, type RandomSource, type StorageAdapter } from '@mawsool/ui';
import { KEYS } from './keys';
import { withStoreLock } from './lock';

/** The most recent snapshot of each crisis event that the server has not yet acknowledged. */
export async function pendingEvents(storage: StorageAdapter): Promise<CrisisEventSubmission[]> {
  const stored = await storage.get<unknown>(KEYS.crisisOutbox);
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((entry) => {
    const parsed = CrisisEventSubmissionSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Queues a snapshot without taking the store lock, for a caller that already holds it (the lock is not reentrant).
 * A newer snapshot of the same event replaces the older one that was waiting.
 */
export async function enqueueEventLocked(storage: StorageAdapter, snapshot: CrisisEventSubmission): Promise<void> {
  const waiting = await pendingEvents(storage);
  await storage.set(KEYS.crisisOutbox, [...waiting.filter((entry) => entry.id !== snapshot.id), snapshot]);
}

/** Queues a snapshot. */
export function enqueueEvent(storage: StorageAdapter, snapshot: CrisisEventSubmission): Promise<void> {
  return withStoreLock(storage, () => enqueueEventLocked(storage, snapshot));
}

/** Removes a snapshot once the server has it, unless a newer snapshot of the event queued up while it was in flight. */
function acknowledge(storage: StorageAdapter, sent: CrisisEventSubmission): Promise<void> {
  return withStoreLock(storage, async () => {
    const waiting = await pendingEvents(storage);
    const next = waiting.filter((entry) => entry.id !== sent.id || JSON.stringify(entry) !== JSON.stringify(sent));
    if (next.length !== waiting.length) await storage.set(KEYS.crisisOutbox, next);
  });
}

export type FlushOutcome =
  /** Nothing was waiting. */
  | 'empty'
  /** Everything waiting was acknowledged or refused for good. */
  | 'sent'
  /** The network or the server was unavailable; the queue is kept for the next try. */
  | 'offline'
  /** The server holds this id with a different secret, so the queue cannot be sent from this device. */
  | 'conflict';

export interface FlushResult {
  outcome: FlushOutcome;
  /** Snapshots the server accepted. */
  sent: number;
  /** Snapshots the server refused as malformed. They can never succeed, so they are dropped. */
  rejected: number;
}

export interface FlushDeps {
  storage: StorageAdapter;
  fetch: typeof fetch;
  apiUrl: string;
  locale: Locale;
  random: RandomSource;
}

let inFlight: Promise<FlushResult> | null = null;

/** The most passes one flush makes: a pass per snapshot that was queued while the one before it was in flight. */
const MAX_PASSES = 6;

/**
 * Sends the queued crisis events. The device registers first if it has not yet (it registers at its first server
 * write, and a crisis event is one), then each snapshot is posted with the device credential. A snapshot leaves the
 * queue only once the server acknowledges it, so going offline mid-send loses nothing, and sending the same
 * snapshot twice is harmless because the server keys on the event id. One send runs at a time.
 */
export function flushOutbox(deps: FlushDeps): Promise<FlushResult> {
  inFlight ??= flushUntilQuiet(deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Runs passes until the queue is empty or a pass fails. A snapshot queued while a pass was in flight (a tap on the
 * crisis screen during a send) is still waiting when that pass ends, and without another pass it would sit until
 * the next page load.
 */
async function flushUntilQuiet(deps: FlushDeps): Promise<FlushResult> {
  let total = await flush(deps);
  for (let pass = 1; pass < MAX_PASSES && total.outcome === 'sent' && (await pendingEvents(deps.storage)).length > 0; pass += 1) {
    const next = await flush(deps);
    total = { outcome: next.outcome === 'empty' ? total.outcome : next.outcome, sent: total.sent + next.sent, rejected: total.rejected + next.rejected };
  }
  return total;
}

async function flush({ storage, fetch: fetchFn, apiUrl, locale, random }: FlushDeps): Promise<FlushResult> {
  const waiting = await pendingEvents(storage);
  if (waiting.length === 0) return { outcome: 'empty', sent: 0, rejected: 0 };

  const identity = await loadOrCreateIdentity(storage, random);
  const registration = await registerDevice({ fetch: fetchFn, apiUrl, identity, locale });
  if (registration === 'conflict') return { outcome: 'conflict', sent: 0, rejected: 0 };
  if (registration === 'failed') return { outcome: 'offline', sent: 0, rejected: 0 };

  let sent = 0;
  let rejected = 0;
  for (const snapshot of waiting) {
    let status: number;
    try {
      const response = await fetchFn(`${apiUrl}/crisis-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: personAuthorization(identity) },
        body: JSON.stringify(snapshot),
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
    } catch {
      return { outcome: 'offline', sent, rejected };
    }
    if (status === 200 || status === 201) {
      sent += 1;
      await acknowledge(storage, snapshot);
    } else if (status === 400) {
      rejected += 1;
      await acknowledge(storage, snapshot);
    } else {
      return { outcome: 'offline', sent, rejected };
    }
  }
  return { outcome: 'sent', sent, rejected };
}
