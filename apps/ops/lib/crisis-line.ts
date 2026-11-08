import { CrisisHandoffListSchema, CrisisHandoffViewSchema, type CrisisHandoffView, type Session } from '@mawsool/types';
import { staffCall } from '@mawsool/ui';
import { API_URL } from './metrics';

export type HandoffsLoad = { status: 'ok'; items: CrisisHandoffView[] } | { status: 'unauthorized' } | { status: 'failed' };

/** The hand-offs the person consented to and has not withdrawn: all the API will ever list for this role. */
export async function loadHandoffs(session: Session, fetcher: typeof fetch = window.fetch.bind(window)): Promise<HandoffsLoad> {
  const result = await staffCall<unknown>({ fetch: fetcher, apiUrl: API_URL, session, path: '/crisis-handoffs' });
  if (result.status === 'unauthorized') return { status: 'unauthorized' };
  const parsed = result.status === 'ok' ? CrisisHandoffListSchema.safeParse(result.body) : null;
  return parsed?.success ? { status: 'ok', items: parsed.data.items } : { status: 'failed' };
}

/**
 * `gone` is a 404: the person stopped sharing it (or it never existed), so there is nothing to mark and the list should be read again.
 */
export type ContactResult = { status: 'marked'; handoff: CrisisHandoffView } | { status: 'gone' } | { status: 'unauthorized' } | { status: 'failed' };

export async function markContactMade(session: Session, handoffId: string, fetcher: typeof fetch = window.fetch.bind(window)): Promise<ContactResult> {
  const result = await staffCall<unknown>({ fetch: fetcher, apiUrl: API_URL, session, method: 'POST', path: `/crisis-handoffs/${handoffId}/contact` });
  if (result.status === 'unauthorized') return { status: 'unauthorized' };
  if (result.status === 'refused' && result.httpStatus === 404) return { status: 'gone' };
  const parsed = result.status === 'ok' ? CrisisHandoffViewSchema.safeParse(result.body) : null;
  return parsed?.success ? { status: 'marked', handoff: parsed.data } : { status: 'failed' };
}
