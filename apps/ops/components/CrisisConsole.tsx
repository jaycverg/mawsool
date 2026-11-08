'use client';

import type { CrisisHandoffView, Session } from '@mawsool/types';
import { isLocale } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { loadHandoffs, markContactMade } from '../lib/crisis-line';

type Load = { k: 'loading' } | { k: 'failed' } | { k: 'ready'; items: CrisisHandoffView[] };

const INSTRUMENT_NAMES = { who5: 'WHO-5', phq9: 'PHQ-9', gad7: 'GAD-7' } as const;

function dateTime(iso: string, lang: 'ar' | 'en'): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai' }).format(new Date(iso));
}

/**
 * The mock crisis-line console: the short notes people chose to hand over, and a button to mark that contact was made.
 * It lists only what the API returns for the crisis-line role, which is a hand-off whose consent is live; a note the person
 * stops sharing disappears on the next read, and pressing "contact made" on one that went answers that it was withdrawn. The
 * page says everywhere that it is a stand-in: no real line receives anything.
 */
export function CrisisConsole({ session, signOut }: { session: Session; signOut: () => void }) {
  const t = useTranslations('crisisLine');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const [load, setLoad] = useState<Load>({ k: 'loading' });
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const read = useCallback(async () => {
    const result = await loadHandoffs(session);
    if (result.status === 'unauthorized') return signOut();
    setLoad(result.status === 'ok' ? { k: 'ready', items: result.items } : { k: 'failed' });
  }, [session, signOut]);

  useEffect(() => void read(), [read]);

  async function markContact(id: string) {
    setBusyId(id);
    setMessage(null);
    const result = await markContactMade(session, id);
    setBusyId(null);
    if (result.status === 'unauthorized') return signOut();
    if (result.status === 'gone') {
      setMessage(t('gone'));
      return void read();
    }
    if (result.status === 'failed') return setMessage(t('markFailed'));
    setLoad((current) => (current.k === 'ready' ? { k: 'ready', items: current.items.map((item) => (item.id === id ? result.handoff : item)) } : current));
    setMessage(t('marked'));
  }

  return (
    <main className="mx-auto flex max-w-[760px] flex-col gap-4 px-6 py-7" data-screen="crisis-console">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="t-h1 flex-1 basis-60">{t('heading')}</h1>
        <span className="t-label rounded-chip bg-mock px-2.5 py-1 font-semibold text-mock-ink" data-mock-label>{t('mock')}</span>
        <button type="button" className="tap rounded-pill border border-border px-4 text-[14px] font-semibold" onClick={signOut}>{t('signOut')}</button>
      </div>
      <p className="t-body text-muted">{t('intro')}</p>
      <div>
        <button type="button" className="tap rounded-pill border border-border px-4 text-[14px] font-semibold" onClick={() => void read()} data-refresh>{t('refresh')}</button>
      </div>
      {message && <p role="status" aria-live="polite" className="t-body" data-console-message>{message}</p>}
      {load.k === 'loading' && <p role="status" className="t-body text-muted">{t('loading')}</p>}
      {load.k === 'failed' && <p role="alert" className="t-body text-danger">{t('failed')}</p>}
      {load.k === 'ready' && load.items.length === 0 && <p className="t-body" data-empty>{t('empty')}</p>}
      {load.k === 'ready' && load.items.length > 0 && (
        <ul className="flex flex-col gap-3" data-handoffs>
          {load.items.map((item) => (
            <li key={item.id} className="flex flex-col gap-2 rounded-staff border border-border bg-surface p-[18px]" data-handoff={item.id} data-contact={item.contactMadeAt ? 'made' : 'waiting'}>
              <p className="t-body"><b>{t('received')}</b>{': '}{dateTime(item.receivedAt, lang)}</p>
              <p className="t-body"><b>{t('language')}</b>{': '}{t(`languages.${item.language}`)}</p>
              <p className="t-body" data-reason>{t(`reason.${item.trigger}`)}</p>
              <p className="t-body">
                <b>{t('scores')}</b>
                {': '}
                {item.scores.length === 0 ? t('noScores') : item.scores.map((score) => `${INSTRUMENT_NAMES[score.instrument]} ${score.total}`).join(' · ')}
              </p>
              <p className="t-body">
                <b>{t('callback')}</b>
                {': '}
                {item.callbackNumber ? <span dir="ltr" data-callback>{item.callbackNumber}</span> : t('noCallback')}
              </p>
              {item.contactMadeAt ? (
                <p className="t-body font-semibold" data-contact-state>{t('contactMade', { at: dateTime(item.contactMadeAt, lang) })}</p>
              ) : (
                <button type="button" className="btn-primary self-start" disabled={busyId === item.id} onClick={() => void markContact(item.id)} data-mark-contact>
                  {t('markContact')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
