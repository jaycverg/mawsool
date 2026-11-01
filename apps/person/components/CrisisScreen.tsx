'use client';

import { isCompleteScreening } from '@mawsool/rules';
import type { CrisisNumber } from '@mawsool/types';
import { createWebDialler, isLocale } from '@mawsool/ui';
import { BrandMark, LanguageToggle } from '@mawsool/ui/components';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CrisisRecord } from '../lib/crisis';
import { crisisTexts } from '../lib/crisis-copy';
import { crisisLines } from '../lib/crisis-numbers';
import { href } from '../lib/routes';
import { loadScreenings } from '../lib/screening-store';
import { useDevice } from '../lib/use-device';
import { syncNow } from '../lib/sync';
import { within } from '../lib/within';

type Reached = 'unasked' | 'asking' | 'yes' | 'later';

const LINES = crisisLines();
const SAKINA: CrisisNumber = LINES.hotline.number;

/**
 * The crisis screen: calm, full screen, no tab bar, no auto-dismiss. Works offline and with no AI.
 *
 * Every number is on screen as text and as a tap-to-call link that goes through the dialler adapter. A tap is
 * logged (which number) and the person stays here; the screen then asks "Did you reach someone?". Only "I'm with
 * someone safe" and "I'm safe right now — continue" release the block. Opened from "Help now" with no trigger, it
 * logs nothing.
 */
export function CrisisScreen() {
  const t = useTranslations('crisis');
  const common = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const device = useDevice();
  const [record, setRecord] = useState<CrisisRecord | null>(null);
  const [reached, setReached] = useState<Reached>('unasked');
  const [unsaved, setUnsaved] = useState(false);
  const promptRef = useRef<HTMLHeadingElement>(null);
  const dialler = useMemo(() => createWebDialler((url) => window.location.assign(url)), []);
  const lang = isLocale(locale) ? locale : 'en';
  const texts = crisisTexts(t, LINES);

  useEffect(() => {
    if (device === null || device === 'unavailable') return;
    void device.crisis.read().then((state) => {
      setRecord(state.record);
      // The prompt belongs to an open crisis. After a resolution, "Help now" is only a way to reach a number.
      if (state.record?.blocked && state.record.event?.humanContactConfirmed) setReached('yes');
      else if (state.record?.blocked && state.record.event?.callTapped) setReached('asking');
    });
  }, [device]);

  useEffect(() => {
    if (reached === 'asking') promptRef.current?.focus();
  }, [reached]);

  function call(number: CrisisNumber) {
    dialler.dial(number);
    if (record?.blocked && (reached === 'unasked' || reached === 'later')) setReached('asking');
    if (device && device !== 'unavailable') {
      void device.crisis.recordCall(number).then((next) => {
        if (next) setRecord(next);
        syncNow(lang);
      });
    }
  }

  async function reachedSomeone() {
    // The thanks appears once the answer is recorded, so what the screen says and what is saved never differ.
    if (device && device !== 'unavailable') {
      setRecord((await device.crisis.confirmContact()) ?? record);
      syncNow(lang);
    }
    setReached('yes');
  }

  async function release() {
    let destination = href(lang, '');
    let saved = true;
    if (device && device !== 'unavailable') {
      // Releasing never waits long on storage: the tab flag is cleared first thing, and a store that hangs must
      // not keep a person on this screen.
      const resumeId = (await within(device.crisis.read(), 500, null))?.record?.resumeScreeningId;
      const result = await within(device.crisis.resolve(), 1500, null);
      saved = result?.status === 'saved';
      syncNow(lang);
      if (resumeId) {
        const finished = (await within(loadScreenings(device.storage), 1000, [])).find((screening) => screening.id === resumeId && isCompleteScreening(screening));
        if (finished) destination = href(lang, 'result', { id: resumeId });
      }
    }
    if (saved) window.location.assign(destination);
    else {
      setUnsaved(true);
      router.push(destination);
    }
  }

  const tile = 'flex flex-col gap-0.5 rounded-card border-2 border-danger bg-surface px-4 py-3.5 text-danger';
  const choice = 'min-h-cta rounded-cta border-[1.5px] border-[#6B4A46] bg-surface px-4 text-[16px] font-semibold text-[#2A1414]';

  return (
    <div className="flex min-h-dvh flex-col bg-crisis-ground text-[#2A1414]" data-screen="crisis" data-last-call={record?.event?.callTapped ?? undefined}>
      <header className="flex items-center justify-between px-4 py-3.5">
        <div className="flex items-center gap-2 text-ink">
          <BrandMark />
          <span className="wordmark">{common('appName')}</span>
        </div>
        <LanguageToggle locale={lang} ariaLabel={common('language')} className="lang-toggle border-[#E3C9C5]!" />
      </header>

      <main className="flex flex-1 flex-col gap-3.5 px-5 pb-5 pt-2">
        <h1 className="text-[28px] font-semibold leading-[34px]">{t('heading')}</h1>
        <p className="text-[16px] leading-6 text-[#4D3330]">{t('body')}</p>

        <a
          href={`tel:${SAKINA}`}
          onClick={(event) => {
            event.preventDefault();
            call(SAKINA);
          }}
          className="flex items-center gap-3.5 rounded-ticket bg-danger p-4 text-white no-underline"
        >
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[#8A1515]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z" />
            </svg>
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="text-[20px] font-bold">{texts.hotline.title}</span>
            <span className="text-[14px] leading-[19px] text-[#FBE3E0]">{texts.hotline.detail}</span>
          </span>
        </a>

        <div className="grid grid-cols-2 gap-2.5">
          {texts.emergency.map((line) => (
            <a
              key={line.dial}
              href={`tel:${line.dial}`}
              onClick={(event) => {
                event.preventDefault();
                call(line.dial as CrisisNumber);
              }}
              className={`${tile} no-underline`}
            >
              <span className="text-[20px] font-bold">{line.title}</span>
              <span className="text-[14px] text-[#4D3330]">{line.detail}</span>
            </a>
          ))}
        </div>

        <div className="mt-1.5 flex items-center gap-2.5 text-[14px] text-[#4D3330]">
          <span className="h-px flex-1 bg-[#E3C9C5]" />
          {t('divider')}
          <span className="h-px flex-1 bg-[#E3C9C5]" />
        </div>

        <button type="button" className={choice} onClick={() => call(SAKINA)}>
          {t('callNow')}
        </button>

        {reached !== 'unasked' && (
          <section aria-labelledby="reached-title" className="flex flex-col gap-2.5 rounded-card border border-[#E3C9C5] bg-surface p-4" data-reached={reached}>
            <h2 id="reached-title" ref={promptRef} tabIndex={-1} className="text-[16px] font-semibold outline-none">
              {t('reachedTitle')}
            </h2>
            {reached === 'asking' && (
              <div className="flex gap-2.5">
                <button type="button" className="min-h-tap flex-1 rounded-pill border-[1.5px] border-[#6B4A46] px-3 font-semibold" onClick={() => void reachedSomeone()}>
                  {t('reachedYes')}
                </button>
                <button type="button" className="min-h-tap flex-1 rounded-pill border-[1.5px] border-[#6B4A46] px-3 font-semibold" onClick={() => setReached('later')}>
                  {t('reachedNo')}
                </button>
              </div>
            )}
            {reached === 'yes' && <p className="text-[15px] leading-[22px]">{t('reachedThanks')}</p>}
            {reached === 'later' && <p className="text-[15px] leading-[22px]">{t('reachedLater')}</p>}
          </section>
        )}

        <button type="button" className={choice} onClick={() => void release()}>
          {t('withSomeone')}
        </button>
        <button type="button" className={choice} onClick={() => void release()}>
          {t('safeNow')}
        </button>

        {unsaved && (
          <p role="status" className="rounded-chip bg-warning px-3 py-2 text-small text-warning-ink">
            {t('unsavedNote')}
          </p>
        )}
        <p className="mt-auto text-[13px] leading-[19px] text-[#4D3330]">{texts.offline}</p>
      </main>
    </div>
  );
}
