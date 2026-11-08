'use client';

import { completedSeries, isCompleteScreening, selectRow } from '@mawsool/rules';
import type { Instrument } from '@mawsool/types';
import { isLocale } from '@mawsool/ui';
import { useDemoOffsetMs } from '@mawsool/ui/components';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { deviceNow } from '../lib/clock';
import { addWeeks, formatDate, partOfDay, spanBetween, type Part } from '../lib/format';
import { href } from '../lib/routes';
import { followUpDue, loadFollowUp, type FollowUp } from '../lib/follow-up';
import { loadReminders, reminderDue, type ReminderSettings } from '../lib/reminders';
import { findDraft } from '../lib/screening-store';
import { useDevice } from '../lib/use-device';
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
  const trm = useTranslations('reminder');
  const tnd = useTranslations('nextDay');
  const ta = useTranslations('anonymous');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const screenings = useScreenings();
  const [part, setPart] = useState<Part | null>(null);
  const device = useDevice();
  const [reminders, setReminders] = useState<ReminderSettings | null>(null);
  const [followUp, setFollowUp] = useState<FollowUp | null>(null);
  // Re-render when the demo clock moves, so a reminder that the clock made due appears.
  useDemoOffsetMs();

  useEffect(() => setPart(partOfDay(deviceNow())), []);
  useEffect(() => {
    if (device === null || device === 'unavailable') return;
    void loadReminders(device.storage).then(setReminders, () => setReminders(null));
    void loadFollowUp(device.storage).then(setFollowUp, () => setFollowUp(null));
  }, [device]);

  const list = Array.isArray(screenings) ? screenings : [];
  const followUpIsDue = followUpDue(followUp, deviceNow());
  const reminderIsDue = reminders !== null && Array.isArray(screenings) && reminderDue(reminders, list, deviceNow());
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

        {followUpIsDue && (
          <section className="flex flex-col gap-2 rounded-card border-2 border-accent bg-accent-tint p-4" data-prompt="next-day">
            <h2 className="text-[16px] font-semibold">{tnd('cardTitle')}</h2>
            <p className="t-body">{tnd('cardBody')}</p>
            <a className="btn-primary" href={href(lang, 'next-day')}>{tnd('cardAction')}</a>
          </section>
        )}

        {reminderIsDue && (
          <section className="flex flex-col gap-2 rounded-card border-2 border-accent bg-accent-tint p-4" data-prompt="reminder">
            <h2 className="text-[16px] font-semibold">{trm('title')}</h2>
            <p className="t-body">{trm('body')}</p>
            <a className="btn-primary" href={href(lang, 'check-in')}>{trm('action')}</a>
          </section>
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
              compact
            />
            {nextCheckIn && <span className="text-[14px] text-muted">{t('nextCheckIn', { date: nextCheckIn })}</span>}
          </section>
        )}

        {device !== null && device !== 'unavailable' && !device.anonymous && (
          <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4" data-anonymous-offer>
            <h2 className="text-[16px] font-semibold">{ta('homeTitle')}</h2>
            <p className="t-body text-muted">{ta('homeBody')}</p>
            <a className="tap inline-flex items-center font-semibold text-accent" href={href(lang, 'anonymous')}>
              {ta('homeAction')}
            </a>
          </section>
        )}

        <p className="flex items-center gap-2 text-small text-muted rtl:leading-5">
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
