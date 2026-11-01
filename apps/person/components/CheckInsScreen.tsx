'use client';

import { completedSeries, isCompleteScreening } from '@mawsool/rules';
import type { Instrument } from '@mawsool/types';
import { isLocale } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { formatDate } from '../lib/format';
import { href } from '../lib/routes';
import { useScreenings } from '../lib/use-screenings';
import { BottomNav } from './BottomNav';
import { HomeHeader } from './HomeHeader';
import { TrendChart } from './TrendChart';

const KINDS: readonly Instrument[] = ['gad7', 'phq9', 'who5'];

/** Every finished check-in, newest first, with a line of totals per instrument. Check-ins in progress are not listed. */
export function CheckInsScreen() {
  const t = useTranslations('checkIns');
  const ti = useTranslations('instrument');
  const tr = useTranslations('result');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const screenings = useScreenings();
  const finished = (Array.isArray(screenings) ? screenings : []).filter(isCompleteScreening).sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt));

  return (
    <div className="flex min-h-dvh flex-col">
      <HomeHeader />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-5">
        <h1 className="t-h1">{t('title')}</h1>
        {screenings !== null && finished.length === 0 && (
          <>
            <p className="t-body text-muted">{t('empty')}</p>
            <a className="btn-primary" href={href(lang, 'check-in')}>
              {t('start')}
            </a>
          </>
        )}
        {KINDS.map((instrument) => {
          const series = completedSeries(finished, instrument);
          if (series.length === 0) return null;
          return (
            <section key={instrument} className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4" data-trend={instrument}>
              <span className="text-[15px] font-semibold">{ti(`${instrument}Full`)}</span>
              <TrendChart
                series={series}
                rtl={lang === 'ar'}
                label={tr('chart', { instrument: ti(`${instrument}Full`), summary: series.map((s) => tr('chartPoint', { date: formatDate(s.takenAt, lang), total: s.total })).join(', ') })}
                startLabel={formatDate(series[0]!.takenAt, lang)}
                endLabel={formatDate(series[series.length - 1]!.takenAt, lang)}
              />
            </section>
          );
        })}
        {finished.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {finished.map((screening) => (
              <li key={screening.id}>
                <a href={href(lang, 'result', { id: screening.id })} className="flex min-h-tap items-center justify-between gap-3 rounded-staff border border-border bg-surface px-4 py-3">
                  <span className="flex flex-col">
                    <span className="text-[15px] font-semibold">{ti(`${screening.instrument}Full`)}</span>
                    <span className="text-[13px] text-muted">{formatDate(screening.takenAt, lang, 'long')}</span>
                  </span>
                  <span className="flex items-baseline gap-2">
                    <span className="text-[20px] font-bold">{screening.total}</span>
                    <span className="text-[13px] font-semibold text-accent">{t('view')}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
      <BottomNav />
    </div>
  );
}
