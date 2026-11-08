'use client';

import { isLocale } from '@mawsool/ui';
import { useDemoOffsetMs } from '@mawsool/ui/components';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { deviceNow } from '../lib/clock';
import { answerFollowUp, FOLLOW_UP_ANSWERS, followUpDue, loadFollowUp, type FollowUp, type FollowUpAnswer } from '../lib/follow-up';
import { href } from '../lib/routes';
import { useDevice } from '../lib/use-device';
import { FlowHeader } from './FlowHeader';

type Load = { k: 'loading' } | { k: 'ready'; followUp: FollowUp | null };

/**
 * The next-day check after a crisis: how the person is today, and an offer of a GP or specialist. The answer is kept on this
 * phone and goes nowhere. The offer leads into the ordinary flow (the options screen, or a fresh check-in), so a ticket from here
 * is matched on the phone, needs the person's consent on the consent screen and is held back by the crisis block like any other.
 * "Help now" stays in the header, and a worse answer puts it first.
 */
export function NextDayScreen() {
  const t = useTranslations('nextDay');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const device = useDevice();
  const [load, setLoad] = useState<Load>({ k: 'loading' });
  const [saveFailed, setSaveFailed] = useState(false);
  useDemoOffsetMs();

  useEffect(() => {
    if (device === null || device === 'unavailable') return;
    void loadFollowUp(device.storage).then((followUp) => setLoad({ k: 'ready', followUp }), () => setLoad({ k: 'ready', followUp: null }));
  }, [device]);

  async function answer(value: FollowUpAnswer) {
    if (!device || device === 'unavailable' || load.k !== 'ready' || !load.followUp) return;
    const kept = await answerFollowUp(device.storage, value, deviceNow);
    setSaveFailed(!kept);
    setLoad({ k: 'ready', followUp: kept ? { ...load.followUp, answer: value, answeredAt: deviceNow().toISOString() } : { ...load.followUp, answer: value } });
  }

  const leading = { href: href(lang, ''), label: t('home') };
  if (device === 'unavailable') {
    return (
      <>
        <FlowHeader leading={leading} title={t('title')} />
        <main className="mx-auto flex max-w-md flex-col gap-3 p-4">
          <p role="alert" className="t-body">{t('storageUnavailable')}</p>
        </main>
      </>
    );
  }

  const followUp = load.k === 'ready' ? load.followUp : null;
  const due = followUpDue(followUp, deviceNow());
  const answered = followUp?.answer ?? null;
  const showQuestion = load.k === 'ready' && due && answered === null;

  return (
    <>
      <FlowHeader leading={leading} title={t('title')} />
      <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-5" data-screen="next-day">
        {load.k === 'ready' && !showQuestion && answered === null && (
          <section className="flex flex-col gap-3" data-state="not-due">
            <h1 className="t-h1">{t('title')}</h1>
            <p className="t-body">{t('notDue')}</p>
            <a className="btn-primary" href={href(lang, '')}>{t('home')}</a>
          </section>
        )}
        {showQuestion && (
          <section className="flex flex-col gap-3" data-state="question">
            <h1 className="t-h1">{t('title')}</h1>
            <p className="t-body text-muted">{t('intro')}</p>
            <div className="flex flex-col gap-2.5">
              {FOLLOW_UP_ANSWERS.map((value) => (
                <button key={value} type="button" className="btn-primary" onClick={() => void answer(value)} data-answer={value}>
                  {t(value)}
                </button>
              ))}
            </div>
          </section>
        )}
        {answered !== null && (
          <>
            <section className="flex flex-col gap-3" data-state="answered" data-answer-given={answered}>
              <h1 className="t-h1">{t('title')}</h1>
              <p className="t-body" role="status">{t(answered === 'better' ? 'afterBetter' : answered === 'same' ? 'afterSame' : 'afterWorse')}</p>
              {!saveFailed && <p className="t-small text-muted">{t('saved')}</p>}
              {saveFailed && <p role="alert" className="t-small text-muted">{t('saveFailed')}</p>}
              {answered === 'worse' && <a className="btn-primary" href={href(lang, 'crisis')} data-help-now>{t('helpNow')}</a>}
            </section>
            <section className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-4" data-offer>
              <h2 className="text-[16px] font-semibold">{t('offerTitle')}</h2>
              <p className="t-body">{t('offerBody')}</p>
              <a className="btn-primary" href={href(lang, 'options')} data-offer-options>{t('offerAction')}</a>
              <a className="tap flex items-center font-semibold text-accent" href={href(lang, 'check-in')}>{t('checkInAction')}</a>
            </section>
          </>
        )}
      </main>
    </>
  );
}
