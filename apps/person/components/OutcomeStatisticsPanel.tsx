'use client';

import { useTranslations } from 'next-intl';

export type StatisticsState = 'idle' | 'working' | 'removed' | 'failed';

/**
 * Settings' note on the separate choice to count the totals sent to a clinic in anonymous group figures. It is shown only while
 * the choice is on (it is off by default, so a person who never chose it sees nothing), or to say that it was just turned off or
 * that turning it off failed. The one control turns it off; turning it on happens only on the repeat check screen, next to the totals.
 */
export function OutcomeStatisticsPanel({ on, state, onTurnOff }: { on: boolean; state: StatisticsState; onTurnOff: () => void }) {
  const t = useTranslations('settings');
  if (!on && state !== 'removed' && state !== 'failed') return null;
  return (
    <section className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-5" data-panel="statistics">
      <h2 className="text-[16px] font-semibold">{t('statisticsTitle')}</h2>
      {on && <p className="t-body text-muted">{t('statisticsOnBody')}</p>}
      {on && (
        <button type="button" className="tap rounded-pill border-[1.5px] border-accent px-4 font-semibold text-accent" disabled={state === 'working'} onClick={onTurnOff} data-control="turn-off-statistics">
          {t('statisticsOptOut')}
        </button>
      )}
      {state === 'removed' && <p role="status" className="text-[15px] font-semibold text-accent-dark">{t('statisticsRemoved')}</p>}
      {state === 'failed' && <p role="alert" className="text-[15px] font-semibold text-danger">{t('statisticsFailed')}</p>}
    </section>
  );
}
