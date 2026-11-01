'use client';

import { completedSeries, isCompleteScreening, selectRow } from '@mawsool/rules';
import type { Instrument } from '@mawsool/types';
import { isLocale } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { deviceNow } from '../lib/clock';
import { addWeeks, formatDate, partOfDay, spanBetween, type Part } from '../lib/format';
import { href } from '../lib/routes';
import { findDraft } from '../lib/screening-store';
import { useScreenings } from '../lib/use-screenings';
import { BottomNav } from './BottomNav';
import { HomeHeader } from './HomeHeader';
import { TrendChart } from './TrendChart';

const TRENDS: readonly Instrument[] = ['gad7', 'phq9'];

/** Home: the check-in card, a trend of the latest check-ins, and the privacy line. */
export function HomeScreen() {
  const t = useTranslations('home');
  const ti = useTranslations('instrument');
  const tr = useTranslations('result');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const screenings = useScreenings();
  const [part, setPart] = useState<Part | null>(null);

  useEffect(() => setPart(partOfDay(deviceNow())), []);

  const list = Array.isArray(screenings) ? screenings : [];
  const draft = findDraft(list, 'who5') ?? findDraft(list, 'gad7') ?? findDraft(list, 'phq9');
  const trendInstrument = TRENDS.find((instrument) => completedSeries(list, instrument).length > 0);
  const series = trendInstrument ? completedSeries(list, trendInstrument) : [];
  const latest = series.at(-1);
  const nextCheckIn = latest ? formatDate(addWeeks(latest.takenAt, selectRow(list.filter(isCompleteScreening)).row.recheckWeeks), lang, 'long') : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <HomeHeader />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-5">
        {part && <p className="text-[15px] text-muted">{t(part === 'morning' ? 'greetingMorning' : part === 'afternoon' ? 'greetingAfternoon' : 'greetingEvening')}</p>}

        {screenings === 'unavailable' && (
          <p role="alert" className="rounded-chip bg-warning px-3 py-2 text-small text-warning-ink">
            {t('storageUnavailable')}
          </p>
        )}

        <section className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5">
          <h1 className="t-h1">{t('heading')}</h1>
          <p className="t-body text-muted">
            {t('tagline')} {t('privacy')}
          </p>
          {screenings !== 'unavailable' && (
            <a className="btn-primary" href={draft ? href(lang, 'check-in', { i: draft.instrument }) : href(lang, 'check-in')}>
              {draft ? t('resume') : t('start')}
            </a>
          )}
          <div className="flex flex-wrap items-center gap-x-4 text-small text-muted">
            <span className="basis-full">{t('direct')}</span>
            <a className="tap inline-flex items-center font-semibold text-accent" href={href(lang, 'check-in', { i: 'phq9' })}>
              {t('directPhq9')}
            </a>
            <a className="tap inline-flex items-center font-semibold text-accent" href={href(lang, 'check-in', { i: 'gad7' })}>
              {t('directGad7')}
            </a>
          </div>
        </section>

        {trendInstrument && latest && (
          <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4" data-trend={trendInstrument}>
            <div className="flex items-baseline justify-between">
              <span className="text-[15px] font-semibold">{ti(`${trendInstrument}Full`)}</span>
              {series.length > 1 && (
                <span className="text-[13px] text-muted">{t('trendRange', { span: tr('span', spanBetween(series[0]!.takenAt, latest.takenAt)) })}</span>
              )}
            </div>
            <TrendChart
              series={series}
              rtl={lang === 'ar'}
              label={tr('chart', { instrument: ti(`${trendInstrument}Full`), summary: series.map((s) => tr('chartPoint', { date: formatDate(s.takenAt, lang), total: s.total })).join(', ') })}
              startLabel={formatDate(series[0]!.takenAt, lang)}
              endLabel={formatDate(latest.takenAt, lang)}
            />
            {nextCheckIn && <span className="text-[14px] text-muted">{t('nextCheckIn', { date: nextCheckIn })}</span>}
          </section>
        )}

        <p className="flex items-center gap-2 text-small text-muted">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="6" y="11" width="12" height="9" rx="2" />
            <path d="M9 11V8a3 3 0 0 1 6 0v3" />
          </svg>
          {t('stored')}
        </p>
      </main>
      <BottomNav />
    </div>
  );
}
