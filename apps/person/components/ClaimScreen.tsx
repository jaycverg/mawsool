'use client';

import { InviteCodeSchema, type ClaimedInvite } from '@mawsool/types';
import { isLocale } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { API_URL } from '../lib/api';
import { deviceNow } from '../lib/clock';
import { claimInvite } from '../lib/invite';
import { href } from '../lib/routes';
import { useDevice } from '../lib/use-device';
import { FlowHeader } from './FlowHeader';

type Phase = { k: 'idle' } | { k: 'claiming' } | { k: 'claimed'; invite: ClaimedInvite } | { k: 'problem'; problem: 'bad_code' | 'not_found' | 'offline' | 'not_saved' | 'claimed_not_kept' };

/**
 * Claims the invite a front door (TAMM, a primary health centre, a school programme) handed over. The code arrives in
 * the link and is shown in the box, but nothing is claimed until the person presses the button. Claiming links the
 * invite to this phone so the ticket they send later says where the screen came from; it shares nothing, and the
 * person still chooses what the clinic sees on the next screens.
 */
export function ClaimScreen() {
  const t = useTranslations('claim');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const fromLink = useSearchParams().get('code') ?? '';
  const device = useDevice();
  const [typed, setTyped] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const code = typed ?? fromLink;
  const valid = InviteCodeSchema.safeParse(code).success;

  async function claim(event: FormEvent) {
    event.preventDefault();
    if (device === null || device === 'unavailable') return setPhase({ k: 'problem', problem: 'not_saved' });
    setPhase({ k: 'claiming' });
    const outcome = await claimInvite({ storage: device.storage, fetch: window.fetch.bind(window), apiUrl: API_URL, locale: lang, random: window.crypto }, code, deviceNow);
    setPhase(outcome.status === 'claimed' ? { k: 'claimed', invite: outcome.invite } : { k: 'problem', problem: outcome.status });
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <FlowHeader leading={{ href: href(lang, ''), label: t('back') }} title={t('title')} />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3.5 px-4 py-5" data-screen="claim">
        <h1 className="t-h1">{t('heading')}</h1>
        {phase.k === 'claimed' ? (
          <section className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4" role="status" data-claimed={phase.invite.source}>
            <p className="t-body font-semibold">{t('claimedTitle', { source: t(`source.${phase.invite.source}`) })}</p>
            <p className="t-body text-muted">{t('claimedBody')}</p>
            <a className="btn-primary" href={href(lang, 'check-in', { i: 'who5' })}>{t('startCheckIn')}</a>
            <a className="tap flex items-center justify-center rounded-pill border-[1.5px] border-accent px-4 font-semibold text-accent" href={href(lang, '')}>{t('home')}</a>
          </section>
        ) : (
          <form onSubmit={claim} className="flex flex-col gap-3">
            <p className="t-body text-muted">{t('intro')}</p>
            <label htmlFor="invite-code" className="t-body font-semibold">{t('codeLabel')}</label>
            <input
              id="invite-code"
              name="code"
              dir="ltr"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={24}
              value={code}
              onChange={(event) => setTyped(event.target.value)}
              className="t-code h-12 w-full rounded-input border border-[#9AAAA7] bg-surface px-3 text-[18px] tracking-[2px]"
            />
            <button type="submit" className="btn-primary" disabled={!valid || phase.k === 'claiming' || device === null}>{t('claim')}</button>
            <p className="t-small text-muted">{t('claimNote')}</p>
          </form>
        )}
        {phase.k === 'problem' && <p role="alert" className="t-body text-danger" data-problem={phase.problem}>{t(`problem.${phase.problem}`)}</p>}
      </main>
    </div>
  );
}
