'use client';

import { itemCount, needsUnverifiedLabel, wordingFor } from '@mawsool/instruments';
import { INSTRUMENTS, type Instrument } from '@mawsool/types';
import { isLocale, progressFillStyle } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { INSTRUMENT_TAG } from '../lib/bands';
import { deviceNow } from '../lib/clock';
import { recordAnswer } from '../lib/record-answer';
import { idFrom, sinceFrom } from '../lib/remeasure';
import { href } from '../lib/routes';
import { findDraft, loadScreenings } from '../lib/screening-store';
import { useDevice, type Device } from '../lib/use-device';
import { FlowHeader } from './FlowHeader';
import { UnverifiedLabel } from './UnverifiedLabel';

const SELF_ASSESSED: readonly Instrument[] = ['who5', 'phq9', 'gad7'];

/** The instrument named in `?i=`, else the WHO-5 opener. C-SSRS has no screen in this version. */
function instrumentFrom(param: string | null): Instrument {
  return (INSTRUMENTS as readonly string[]).includes(param ?? '') && SELF_ASSESSED.includes(param as Instrument) ? (param as Instrument) : 'who5';
}

/**
 * One question at a time, with the exact published wording for the person's language. Every answer is saved the
 * moment it is chosen, so closing the screen loses nothing. A PHQ-9 item 9 answer above zero is evaluated on the
 * spot by `packages/instruments`: the block is set, the answer is saved, and the person goes to the crisis screen
 * before they can press Next.
 *
 * The same flow carries the repeat check at six weeks: `?rm=<ticket id>` makes the PHQ-9 lead to the GAD-7 (`&p=` holds the
 * PHQ-9 just finished) and the GAD-7 lead to the repeat check screen. Every answer goes through the same `recordAnswer`, so item 9 fires the crisis path here exactly as it does in any check-in.
 */
export function CheckInFlow() {
  const params = useSearchParams();
  const instrument = instrumentFrom(params.get('i'));
  /** The ticket this check-in is the repeat check for, if it is one. */
  const repeatFor = idFrom(params.get('rm'));
  const phq9Done = idFrom(params.get('p'));
  /** For the repeat check, the moment it opened: nothing started before it is resumed or sent as the repeat check. Undefined for an ordinary check-in. */
  const sinceParam = params.get('since');
  const notBefore = repeatFor ? sinceFrom(sinceParam) : undefined;
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const t = useTranslations('checkIn');
  const ti = useTranslations('instrument');
  const tf = useTranslations('flow');
  const device = useDevice();
  const [answers, setAnswers] = useState<number[] | null>(null);
  const [index, setIndex] = useState(0);
  const [screeningId, setScreeningId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const heading = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (device === null || device === 'unavailable') return;
    loadScreenings(device.storage).then(
      (all) => {
        const draft = findDraft(all, instrument, notBefore);
        setAnswers(draft?.answers ?? []);
        setScreeningId(draft?.id ?? null);
        setIndex(draft?.answers.length ?? 0);
      },
      () => {
        setAnswers([]);
        setFailed(true);
      },
    );
  }, [device, instrument, notBefore]);

  const loaded = answers !== null;
  useEffect(() => {
    heading.current?.focus();
  }, [index, loaded]);

  const wording = wordingFor(instrument, lang);
  const total = itemCount(instrument);
  const item = wording.items[index];
  const back = index === 0 ? (repeatFor ? href(lang, 'ticket', { id: repeatFor }) : href(lang, '')) : undefined;
  const title = ti(`${instrument}Title`);

  if (device === 'unavailable') {
    return (
      <>
        <FlowHeader icon="close" leading={{ href: href(lang, ''), label: t('close') }} title={title} />
        <main className="mx-auto flex max-w-md flex-col gap-3 p-4">
          <p role="alert" className="t-body">{t('unavailable')}</p>
        </main>
      </>
    );
  }

  async function choose(value: number, device: Device) {
    setFailed(false);
    const outcome = await recordAnswer(
      { instrument, index, value, screeningId, notBefore },
      { storage: device.storage, crisis: device.crisis, now: deviceNow, newId: () => crypto.randomUUID(), locale: lang },
    );
    if (outcome.kind === 'failed') return setFailed(true);
    if (outcome.kind === 'crisis') {
      // A push, not a replace: Back from the crisis screen lands on this page, which the guard sends straight back.
      window.location.assign(href(lang, 'crisis'));
      return;
    }
    setAnswers(outcome.screening.answers);
    setScreeningId(outcome.screening.id);
  }

  const selected = answers?.[index];
  const last = index === total - 1;

  return (
    <>
      <FlowHeader icon="close" leading={{ href: href(lang, ''), label: t('close') }} title={title} />
      <main className="mx-auto flex min-h-[calc(100dvh-73px)] max-w-md flex-col gap-5 px-4 py-5">
        {answers === null || !item ? (
          <p className="t-body text-muted" aria-busy="true" />
        ) : (
          <>
            {repeatFor && (instrument === 'phq9' || instrument === 'gad7') && (
              <p className="t-small font-semibold text-accent-dark" data-repeat-step>
                {t('repeatStep', { current: instrument === 'phq9' ? 1 : 2, total: 2 })}
              </p>
            )}
            <div className="flex flex-col gap-2">
              <div className="flex justify-between text-[14px] text-muted">
                <span>{t('progress', { current: index + 1, total })}</span>
                <span dir="ltr">{INSTRUMENT_TAG[instrument]}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-[4px] bg-border" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={index + 1}>
                <div className="h-2 rounded-[4px] bg-accent" style={progressFillStyle((index + 1) / total)} />
              </div>
            </div>

            {needsUnverifiedLabel(instrument, lang, item) && <UnverifiedLabel />}

            <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
              {wording.stem && <legend className="mb-1 p-0 t-body text-muted">{wording.stem}</legend>}
              <p ref={heading} tabIndex={-1} className="mb-2 text-[26px] font-semibold leading-8 outline-none">
                {item.text}
              </p>
              {item.detail && <p className="t-small -mt-1 mb-2 text-muted">{item.detail}</p>}
              {wording.options.map((option) => {
                const checked = selected === option.value;
                return (
                  <label
                    key={`${index}-${option.value}`}
                    className={`flex min-h-[60px] cursor-pointer items-center gap-3.5 rounded-staff px-4 text-[17px] ${
                      checked ? 'border-2 border-accent bg-accent-tint font-semibold' : 'border border-border bg-surface'
                    }`}
                  >
                    <input
                      type="radio"
                      name={`q${index}`}
                      value={option.value}
                      checked={checked}
                      onChange={() => void choose(option.value, device as Device)}
                      className="size-[22px] accent-accent"
                    />
                    {option.label}
                  </label>
                );
              })}
            </fieldset>

            {failed && (
              <p role="alert" className="rounded-chip bg-warning px-3 py-2 text-small text-warning-ink">
                {t('saveFailed')}
              </p>
            )}
            <p className="t-small leading-[19px] text-muted">{t('note')}</p>

            <div className="mt-auto grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
              {back ? (
                <a href={back} className="flex min-h-cta items-center justify-center rounded-cta border-[1.5px] border-accent text-[16px] font-semibold text-accent">
                  {tf('back')}
                </a>
              ) : (
                <button type="button" onClick={() => setIndex(index - 1)} className="min-h-cta rounded-cta border-[1.5px] border-accent text-[16px] font-semibold text-accent">
                  {tf('back')}
                </button>
              )}
              <button
                type="button"
                disabled={selected === undefined}
                onClick={() => {
                  if (!last) setIndex(index + 1);
                  else if (repeatFor && instrument === 'phq9') window.location.assign(href(lang, 'check-in', { i: 'gad7', rm: repeatFor, p: screeningId ?? '', since: sinceParam ?? '' }));
                  else if (repeatFor && instrument === 'gad7') window.location.assign(href(lang, 'remeasure', { id: repeatFor, p: phq9Done ?? '', g: screeningId ?? '' }));
                  else window.location.assign(href(lang, 'result', { id: screeningId ?? '' }));
                }}
                className="btn-primary px-0"
              >
                {!last ? tf('next') : repeatFor ? (instrument === 'phq9' ? tf('next') : t('finishRepeat')) : t('finish')}
              </button>
            </div>
            <p className="flex items-center gap-2 t-small text-muted">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="6" y="11" width="12" height="9" rx="2" />
                <path d="M9 11V8a3 3 0 0 1 6 0v3" />
              </svg>
              {t('saved')}
            </p>
          </>
        )}
      </main>
    </>
  );
}
