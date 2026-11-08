'use client';

import type { ClinicLinkMove, ClinicLinkTicket } from '@mawsool/types';
import { formatDate, isLocale } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { actOnLink, credentialFromFragment, openLink, type LinkCredential } from '../lib/clinic-link';
import { API_URL, displayCode } from '../lib/queue';

type Screen =
  | { k: 'loading' }
  | { k: 'missing' }
  | { k: 'refused'; why: 'invalid' | 'not_found' | 'withdrawn' | 'failed' }
  | { k: 'ready'; credential: LinkCredential; ticket: ClinicLinkTicket; busy: boolean; note: 'conflict' | 'failed' | null }
  | { k: 'done'; move: ClinicLinkMove; freshLink: boolean };

/**
 * The page a clinic's no-login link opens (a mock channel: the link is logged by the API, not sent). It reads the ticket id and the
 * one-time token from the address's fragment, shows only what is needed to act on that one ticket (its code, tier, state and
 * deadline) and offers the moves the clinic may make. It never shows a score, a note, a summary or anything the person shared.
 * Nothing here is kept: the credential lives in this page's memory, and a move spends the link.
 */
export function ClinicLinkScreen() {
  const t = useTranslations('clinicLink');
  const root = useTranslations();
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const [screen, setScreen] = useState<Screen>({ k: 'loading' });

  useEffect(() => {
    const credential = credentialFromFragment(window.location.hash);
    if (!credential) return setScreen({ k: 'missing' });
    let active = true;
    void openLink(window.fetch.bind(window), API_URL, credential).then((result) => {
      if (!active) return;
      if (result.status === 'ok') setScreen({ k: 'ready', credential, ticket: result.body, busy: false, note: null });
      else if (result.status === 'conflict') setScreen({ k: 'refused', why: 'failed' });
      else setScreen({ k: 'refused', why: result.status });
    });
    return () => {
      active = false;
    };
  }, []);

  async function act(move: ClinicLinkMove) {
    if (screen.k !== 'ready' || screen.busy) return;
    const { credential, ticket } = screen;
    setScreen({ ...screen, busy: true, note: null });
    const result = await actOnLink(window.fetch.bind(window), API_URL, credential, move);
    if (result.status === 'ok') return setScreen({ k: 'done', move, freshLink: result.body.freshLink });
    if (result.status === 'invalid' || result.status === 'not_found' || result.status === 'withdrawn') return setScreen({ k: 'refused', why: result.status });
    setScreen({ k: 'ready', credential, ticket, busy: false, note: result.status === 'conflict' ? 'conflict' : 'failed' });
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-6" data-screen="clinic-link">
      <p role="note" className="rounded-input bg-mock px-3 py-2.5 text-[13px] font-semibold leading-[18px] text-mock-ink" data-mock-label>
        {t('mock')}
      </p>
      <h1 className="t-h1">{t('heading')}</h1>
      {screen.k === 'loading' && <p role="status" className="t-body text-muted">{t('loading')}</p>}
      {screen.k === 'missing' && <p role="alert" className="t-body" data-link-state="missing">{t('missing')}</p>}
      {screen.k === 'refused' && (
        <p role="alert" className="t-body" data-link-state={screen.why}>
          {t(`refused.${screen.why}`)}
        </p>
      )}
      {screen.k === 'ready' && (
        <section className="flex flex-col gap-3 rounded-staff border border-border bg-surface p-[18px]" data-link-state="ready">
          <span className="t-code text-[22px]" dir="ltr" data-code>{displayCode(screen.ticket.shortCode)}</span>
          <p className="t-body">
            {t('summary', { tier: root(`tier.${screen.ticket.tier}`), state: root(`state.${screen.ticket.state}`), deadline: formatDate(screen.ticket.deadlineAt, lang, 'long') })}
          </p>
          {screen.ticket.moves.length === 0 && <p className="t-body text-muted" data-no-moves>{t('noMoves')}</p>}
          <div className="flex flex-wrap gap-2.5">
            {screen.ticket.moves.includes('acknowledged') && (
              <button type="button" className="tap rounded-pill border-[1.5px] border-accent bg-surface px-[18px] text-[15px] font-semibold text-accent disabled:opacity-60" disabled={screen.busy} onClick={() => void act('acknowledged')} data-move="acknowledged">
                {t('acknowledge')}
              </button>
            )}
            {screen.ticket.moves.includes('seen') && (
              <button type="button" className="tap rounded-pill bg-accent px-[18px] text-[15px] font-semibold text-surface disabled:opacity-60" disabled={screen.busy} onClick={() => void act('seen')} data-move="seen">
                {t('markSeen')}
              </button>
            )}
          </div>
          {screen.note && (
            <p role="alert" className="t-body text-danger" data-link-note={screen.note}>
              {t(`note.${screen.note}`)}
            </p>
          )}
          <p className="t-small text-muted">{t('onlyThis')}</p>
        </section>
      )}
      {screen.k === 'done' && (
        <section role="status" className="flex flex-col gap-2 rounded-staff border border-border bg-surface p-[18px]" data-link-state="done" data-move-made={screen.move}>
          <p className="text-[17px] font-semibold">{t(screen.move === 'acknowledged' ? 'doneAcknowledged' : 'doneSeen')}</p>
          <p className="t-body text-muted" data-fresh-link={screen.freshLink ? 'yes' : 'no'}>
            {t(screen.freshLink ? 'freshLink' : 'noFreshLink')}
          </p>
        </section>
      )}
    </main>
  );
}
