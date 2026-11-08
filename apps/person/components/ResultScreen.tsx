'use client';

import { needsUnverifiedLabel, offersFollowUp, wordingFor } from '@mawsool/instruments';
import { completedSeries, isCompleteScreening, isTracked, reliableChange, type Change } from '@mawsool/rules';
import type { Instrument, Screening } from '@mawsool/types';
import { isLocale } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { MAX_TOTAL } from '../lib/bands';
import { formatDate, spanBetween } from '../lib/format';
import { href } from '../lib/routes';
import { loadScreenings } from '../lib/screening-store';
import { useDevice } from '../lib/use-device';
import { BandBar } from './BandBar';
import { FlowHeader } from './FlowHeader';
import { TrendChart } from './TrendChart';
import { UnverifiedLabel } from './UnverifiedLabel';

interface Loaded {
  screening: Screening;
  series: Screening[];
}

/**
 * The result of one finished check-in: score, severity band, the change since the previous check-in of the same
 * kind, and plain-language "what this means / what it does not mean". Copy per band lives in the message files
 * under `clinicalCopy`. It never uses a diagnostic label, and a reliable deterioration points to support options,
 * where matching runs again on the latest scores.
 */
export function ResultScreen() {
  const id = useSearchParams().get('id');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const t = useTranslations('result');
  const tc = useTranslations('clinicalCopy');
  const ti = useTranslations('instrument');
  const ta = useTranslations('anonymous');
  const device = useDevice();
  const anonymous = device !== null && device !== 'unavailable' && device.anonymous;
  const [state, setState] = useState<'loading' | 'missing' | Loaded>('loading');
  const [others, setOthers] = useState<Instrument[]>([]);

  useEffect(() => {
    if (device === null) return;
    if (device === 'unavailable') {
      setState('missing');
      return;
    }
    loadScreenings(device.storage).then(
      (all) => {
        const screening = all.find((candidate) => candidate.id === id && isCompleteScreening(candidate));
        if (!screening) return setState('missing');
        setState({ screening, series: completedSeries(all, screening.instrument).filter((s) => Date.parse(s.takenAt) <= Date.parse(screening.takenAt)) });
        const taken = new Set(all.filter(isCompleteScreening).map((s) => s.instrument));
        setOthers((['gad7', 'phq9'] as const).filter((instrument) => !taken.has(instrument)));
      },
      () => setState('missing'),
    );
  }, [device, id]);

  const leading = { href: href(lang, ''), label: t('back') };
  if (state === 'loading') return <FlowHeader leading={leading} title={t('title')} />;
  if (state === 'missing') {
    return (
      <>
        <FlowHeader leading={leading} title={t('title')} />
        <main className="mx-auto flex max-w-md flex-col gap-3 p-4">
          <p className="t-body">{t('notFound')}</p>
        </main>
      </>
    );
  }

  const { screening, series } = state;
  const instrument = screening.instrument;
  const previous = series.length > 1 ? series[series.length - 2]! : null;
  const change: Change | null = previous && isTracked(instrument) ? reliableChange(instrument, previous.total, screening.total) : null;
  const wording = wordingFor(instrument, lang);
  const unverified = wording.items.some((item) => needsUnverifiedLabel(instrument, lang, item));
  const bandNames: Record<string, string> = {
    minimal: t('bands.minimal'),
    mild: t('bands.mild'),
    moderate: t('bands.moderate'),
    moderately_severe: t('bands.moderately_severe'),
    severe: t('bands.severe'),
  };
  const meaning =
    instrument === 'who5' ? tc(offersFollowUp(screening.total) ? 'who5.low' : 'who5.typical') : tc(`${instrument as 'phq9' | 'gad7'}.${screening.band as string}`);

  const summary = series.map((s) => t('chartPoint', { date: formatDate(s.takenAt, lang), total: s.total })).join(', ');
  const span = previous ? spanBetween(previous.takenAt, screening.takenAt) : null;

  return (
    <>
      <FlowHeader leading={leading} title={t('title')} />
      <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-5">
        <section className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5" data-result={instrument}>
          <span className="text-[13px] font-semibold uppercase tracking-[0.6px] text-muted rtl:normal-case rtl:tracking-normal">
            {ti(`${instrument}Full`)} · {formatDate(screening.takenAt, lang, 'long')}
          </span>
          <div className="flex flex-wrap items-baseline gap-x-2.5">
            <span className="text-[48px] font-bold leading-[52px]" data-score>
              {screening.total}
            </span>
            {screening.band && <span className="text-[20px] font-semibold">{bandNames[screening.band]}</span>}
            <span className="text-[15px] text-muted">{t('outOf', { max: MAX_TOTAL[instrument] })}</span>
          </div>
          <BandBar instrument={instrument} total={screening.total} names={bandNames} current={screening.band} />
          {unverified && <UnverifiedLabel compact />}
        </section>

        <section className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-5">
          <h2 className="text-[16px] font-semibold">{t('how')}</h2>
          <TrendChart
            series={series}
            rtl={lang === 'ar'}
            label={t('chart', { instrument: ti(`${instrument}Full`), summary })}
            startLabel={formatDate(series[0]!.takenAt, lang)}
            endLabel={formatDate(series[series.length - 1]!.takenAt, lang)}
          />
          {isTracked(instrument) && (
            <p
              data-change={change?.kind ?? 'first'}
              className={`flex gap-2.5 rounded-[12px] p-3 text-[14px] leading-5 ${change?.kind === 'reliable_deterioration' ? 'bg-warning text-warning-ink' : 'bg-accent-tint text-accent-dark'}`}
            >
              {change && span
                ? t(change.kind === 'reliable_deterioration' ? 'deterioration' : change.kind === 'reliable_improvement' ? 'improvement' : 'steady', {
                    points: t('points', { count: Math.abs(change.delta) }),
                    span: t('span', span),
                  })
                : t('first')}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-3 px-1 pt-1">
          <div>
            <h2 className="mb-1 text-[16px] font-bold">{t('means')}</h2>
            <p className="t-body text-[#34484A]">{meaning}</p>
          </div>
          <div>
            <h2 className="mb-1 text-[16px] font-bold">{t('doesNotMean')}</h2>
            <p className="t-body text-[#34484A]">{tc('doesNotMean')}</p>
          </div>
        </section>

        {instrument === 'who5' ? (
          <div className="mt-auto flex flex-col gap-2.5">
            {offersFollowUp(screening.total) ? (
              <>
                <p className="t-body font-semibold">{t('whoFollowUp')}</p>
                <a className="btn-primary" href={href(lang, 'check-in', { i: 'gad7' })}>
                  {t('whoFollowUpGad7')}
                </a>
                <a className="btn-primary" href={href(lang, 'check-in', { i: 'phq9' })}>
                  {t('whoFollowUpPhq9')}
                </a>
                <a className="tap flex items-center justify-center text-[15px] font-semibold text-accent" href={href(lang, '')}>
                  {t('whoHome')}
                </a>
              </>
            ) : (
              <>
                <a className="btn-primary" href={href(lang, '')}>
                  {t('whoHome')}
                </a>
                <a className="tap flex items-center justify-center text-[15px] font-semibold text-accent" href={href(lang, 'check-in', { i: 'gad7' })}>
                  {t('whoFollowUpGad7')}
                </a>
                <a className="tap flex items-center justify-center text-[15px] font-semibold text-accent" href={href(lang, 'check-in', { i: 'phq9' })}>
                  {t('whoFollowUpPhq9')}
                </a>
              </>
            )}
          </div>
        ) : (
          <div className="mt-auto flex flex-col gap-2.5">
            {anonymous ? (
              <p className="rounded-[12px] bg-mock p-3 text-[14px] leading-5 text-mock-ink" data-anonymous-result-note>
                {ta('resultNote')}{' '}
                <a className="font-semibold underline" href={href(lang, 'anonymous')}>
                  {ta('bannerLink')}
                </a>
              </p>
            ) : (
              <a className="btn-primary" href={href(lang, 'options')}>
                {t('options')}
              </a>
            )}
            {others.map((other) => (
              <a key={other} className="tap flex items-center justify-center text-[15px] font-semibold text-accent" href={href(lang, 'check-in', { i: other })}>
                {t(other === 'gad7' ? 'alsoGad7' : 'alsoPhq9')}
              </a>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
