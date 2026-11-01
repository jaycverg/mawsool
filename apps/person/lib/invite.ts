import { ClaimedInviteSchema, InviteCodeSchema, type ClaimedInvite } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import { KEYS } from './keys';
import { callServer, markServerFootprint, type ServerDeps } from './server';

/** The front-door invite this phone claimed and has not yet sent a ticket for, if any. */
export async function loadInvite(storage: StorageAdapter): Promise<ClaimedInvite | null> {
  const parsed = ClaimedInviteSchema.safeParse(await storage.get<unknown>(KEYS.invite));
  return parsed.success ? parsed.data : null;
}

export function saveInvite(storage: StorageAdapter, invite: ClaimedInvite): Promise<void> {
  return storage.set(KEYS.invite, invite);
}

/** Forgets the invite once a ticket has used it. */
export function clearInvite(storage: StorageAdapter): Promise<void> {
  return storage.remove(KEYS.invite);
}

export type ClaimOutcome =
  /** The server bound the invite to this phone and the phone kept it. */
  | { status: 'claimed'; invite: ClaimedInvite }
  /** What was typed is not an invite code. Nothing was sent. */
  | { status: 'bad_code' }
  /** The code is unknown, expired, or somebody else holds it. The server does not say which. */
  | { status: 'not_found' }
  /** The phone is offline or the server is down. Claiming again is safe. */
  | { status: 'offline' }
  /** The phone would not note the claim before anything was sent, so nothing was. */
  | { status: 'not_saved' }
  /** The server holds the claim but this phone could not keep it, so the ticket would not carry the source. Claiming again with the same code retries the keep. */
  | { status: 'claimed_not_kept' };

/**
 * Claims an invite by its code: the server binds it to this device, and the phone keeps the invite until the ticket
 * is sent. The same code claimed again by the same phone answers with the same invite, so a retry after a lost reply
 * or a failed keep is safe. The device registers with the server here if it has not yet, as at any first server write.
 */
export async function claimInvite(deps: ServerDeps, typed: string, now: () => Date): Promise<ClaimOutcome> {
  const code = InviteCodeSchema.safeParse(typed);
  if (!code.success) return { status: 'bad_code' };
  try {
    await markServerFootprint(deps.storage, now);
  } catch {
    return { status: 'not_saved' };
  }
  const result = await callServer<unknown>(deps, 'POST', '/me/invites/claim', { code: code.data });
  if (!result.ok) {
    if (result.reason === 'rejected') return { status: result.status === 404 ? 'not_found' : 'bad_code' };
    return { status: 'offline' };
  }
  const invite = ClaimedInviteSchema.safeParse(result.body);
  if (!invite.success) return { status: 'offline' };
  return (await saveInvite(deps.storage, invite.data).then(() => true, () => false)) ? { status: 'claimed', invite: invite.data } : { status: 'claimed_not_kept' };
}
