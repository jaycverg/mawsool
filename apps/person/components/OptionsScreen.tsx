'use client';

import { indicativeCoverage, match, splitCards, type RankedOption } from '@mawsool/rules';
import { CARE_LANGUAGES, GENDERS, INSURANCE_CLASSES, MODALITIES, REGIONS, RerouteReasonSchema, TIERS, TIMES_OF_DAY, type InsuranceClass, type Preferences, type Screening, type Tier } from '@mawsool/types';
import { isLocale } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_URL } from '../lib/api';
import { deviceNow } from '../lib/clock';
import { loadDirectory, type Directory } from '../lib/directory';
import { currentTier, loadChoice, loadInsurance, loadPreferences, pendingFrom, saveChoice, savePendingChoice, saveInsurance, savePreferences, type Choice, type PendingChoice } from '../lib/prefs';
import { href } from '../lib/routes';
import { loadScreenings } from '../lib/screening-store';
import { useDevice, type Device } from '../lib/use-device';
import { FlowHeader } from './FlowHeader';

type Translate = ReturnType<typeof useTranslations>;

interface Loaded {
  screenings: Screening[];
  preferences: Preferences;
  insurance: InsuranceClass;
  choice: Choice | null;
  crisisResolvedAt: string | null;
}

const SELECT = 'h-11 w-full rounded-input border border-[#9AAAA7] bg-surface px-2.5 text-[16px] text-ink';

/**
 * Support options. Matching runs here on the phone: the latest scores, the preferences, the health plan and the
 * region go into `match()` and none of them goes anywhere. The only network call is the unfiltered sample
 * directory. Self-help is saved on the device with no consent and no ticket; every other tier goes on to consent.
 */
export function OptionsScreen() {
  const t = useTranslations('options');
  const tf = useTranslations('flow');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const device = useDevice();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [directory, setDirectory] = useState<Directory | null | 'loading'>('loading');
  const [showOther, setShowOther] = useState(false);
  const [saved, setSaved] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const params = useSearchParams();
  const rerouteReason = RerouteReasonSchema.safeParse(params.get('reason'));
  const rerouteId = params.get('reroute');
  /** Set when the person came here to replace a stalled referral: the ticket and the reason they gave. */
  const reroute: PendingChoice['reroute'] = rerouteId && /^[0-9a-f-]{36}$/.test(rerouteId) && rerouteReason.success ? { ticketId: rerouteId, reason: rerouteReason.data } : null;

  const fetchDirectory = useCallback(
    (d: Device) => {
      setDirectory('loading');
      void loadDirectory({ storage: d.storage, fetch: window.fetch.bind(window), apiUrl: API_URL, now: deviceNow }).then(setDirectory, () => setDirectory(null));
    },
    [],
  );

  useEffect(() => {
    if (device === null || device === 'unavailable') return;
    void Promise.all([loadScreenings(device.storage), loadPreferences(device.storage), loadInsurance(device.storage), loadChoice(device.storage), device.crisis.read()]).then(
      ([screenings, preferences, insurance, choice, crisis]) => setLoaded({ screenings, preferences, insurance, choice, crisisResolvedAt: crisis.record?.resolvedAt ?? null }),
      () => setUnreadable(true),
    );
    fetchDirectory(device);
  }, [device, fetchDirectory]);

  const region = loaded?.preferences.region ?? 'abu_dhabi_city';
  const options = useMemo(
    () =>
      loaded && directory && directory !== 'loading'
        ? match(loaded.screenings, loaded.preferences, loaded.insurance, region, directory.services, {
            currentTier: currentTier(loaded.choice),
            crisisResolvedAt: loaded.crisisResolvedAt,
          })
        : null,
    [loaded, directory, region],
  );

  // Defence in depth: the guard keeps this screen shut during a crisis, and matching itself refuses to offer options.
  useEffect(() => {
    if (options?.[0]?.kind === 'crisis') window.location.replace(href(lang, 'crisis'));
  }, [options, lang]);

  const leading = { href: href(lang, 'check-ins'), label: t('title') };

  if (device === 'unavailable' || unreadable) {
    return (
      <>
        <FlowHeader leading={{ href: href(lang, ''), label: t('savedHome') }} title={t('title')} />
        <main className="mx-auto flex max-w-md flex-col gap-3 p-4">
          <p role="alert" className="t-body">{t('storageUnavailable')}</p>
        </main>
      </>
    );
  }

  /** Applies a change to the screen and saves it; if the phone refuses, the person is told, since the change is not kept. */
  function update(change: Partial<Pick<Loaded, 'preferences' | 'insurance'>>) {
    if (!loaded || !device || device === 'unavailable') return;
    setLoaded({ ...loaded, ...change });
    setSaveFailed(false);
    const saving = change.preferences ? savePreferences(device.storage, change.preferences) : change.insurance ? saveInsurance(device.storage, change.insurance) : Promise.resolve();
    saving.catch(() => setSaveFailed(true));
  }

  async function choose(option: RankedOption) {
    if (!device || device === 'unavailable' || !option.service || option.tier === 'crisis') return;
    setSaveFailed(false);
    try {
      if (option.tier === 'self_help') {
        // Guided self-help stays on the phone: it becomes the current support at once, with no consent and no request.
        const choice: Choice = { tier: option.tier, serviceId: option.service.id, chosenAt: deviceNow().toISOString(), confirmed: true };
        await saveChoice(device.storage, choice);
        setLoaded((previous) => (previous ? { ...previous, choice } : previous));
        setSaved(true);
      } else {
        // Any other tier waits for consent. The pick is kept apart from the current choice, so leaving the consent
        // screen unsent costs the person nothing they already have.
        await savePendingChoice(device.storage, pendingFrom({ tier: option.tier, serviceId: option.service.id, handoffWindowDays: option.handoffWindowDays }, { now: deviceNow, newId: () => crypto.randomUUID() }, reroute));
        window.location.assign(href(lang, 'consent'));
      }
    } catch {
      setSaveFailed(true);
    }
  }

  // A reroute replaces a clinic referral, so guided self-help is not offered there.
  const offered = options && reroute ? options.filter((option) => option.tier !== 'self_help') : options;
  const { cards, others } = offered ? splitCards(offered) : { cards: [], others: [] };

  return (
    <>
      <FlowHeader leading={leading} title={t('title')} />
      <main className="mx-auto flex max-w-md flex-col gap-3.5 px-4 py-5">
        <div className="flex flex-col gap-1">
          <h1 className="t-h1">{t(reroute ? 'rerouteHeading' : 'heading')}</h1>
          <p className="t-body text-muted">{t(reroute ? 'rerouteIntro' : 'intro')}</p>
        </div>

        {loaded && (
          <>
            <InsurancePanel t={t} insurance={loaded.insurance} onChange={(insurance) => update({ insurance })} />
            <PreferencesPanel t={t} preferences={loaded.preferences} onChange={(preferences) => update({ preferences })} />
          </>
        )}

        {saveFailed && (
          <p role="alert" className="t-body text-danger">
            {t('saveFailed')}
          </p>
        )}

        {saved && (
          <section role="status" className="flex flex-col gap-2 rounded-card border-2 border-accent bg-accent-tint p-4">
            <h2 className="text-[16px] font-semibold">{t('savedTitle')}</h2>
            <p className="text-[15px]">{t('savedBody')}</p>
            <a className="tap flex items-center font-semibold text-accent" href={href(lang, '')}>
              {t('savedHome')}
            </a>
          </section>
        )}

        {directory === 'loading' && <p className="t-body text-muted" role="status">{t('loading')}</p>}
        {directory === null && (
          <div className="flex flex-col gap-2" role="alert">
            <p className="t-body">{t('unavailable')}</p>
            <button type="button" className="btn-primary" onClick={() => device && fetchDirectory(device)}>
              {tf('retry')}
            </button>
          </div>
        )}

        {options && loaded && directory && directory !== 'loading' && (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] text-muted">{t('count', { count: cards.length + others.length, region: t(`regionName.${region}`) })}</span>
              <span className="rounded-chip bg-mock px-2 py-[3px] text-[12px] font-semibold text-mock-ink">{t('sampleServices')}</span>
            </div>
            {directory.source === 'cache' && <p className="t-small text-muted">{t('fromCopy')}</p>}
            {cards.length === 0 && <p className="t-body">{t('noOptions')}</p>}
            {cards.map((option, position) => (
              <OptionCard key={option.rank} t={t} option={option} insurance={loaded.insurance} lead={position === 0 && option.kind === 'recommended'} onChoose={choose} />
            ))}
            {others.length > 0 && (
              <>
                <button type="button" aria-expanded={showOther} className="tap self-center text-[15px] font-semibold text-accent" onClick={() => setShowOther(!showOther)}>
                  {t(showOther ? 'hideOther' : 'showOther')}
                </button>
                {showOther && others.map((option) => <OptionCard key={option.rank} t={t} option={option} insurance={loaded.insurance} lead={false} onChoose={choose} />)}
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}

function InsurancePanel({ t, insurance, onChange }: { t: Translate; insurance: InsuranceClass; onChange: (insurance: InsuranceClass) => void }) {
  return (
    <section className="flex flex-col gap-1.5 rounded-staff border border-border bg-surface px-3.5 py-3" data-panel="insurance">
      <label htmlFor="plan" className="text-[13px] font-semibold text-muted">
        {t('planLabel')}
      </label>
      <select id="plan" className={SELECT} value={insurance} onChange={(event) => onChange(event.target.value as InsuranceClass)}>
        {INSURANCE_CLASSES.map((plan) => (
          <option key={plan} value={plan}>
            {t(`insurance.${plan}`)}
          </option>
        ))}
      </select>
      <span className="text-[13px] leading-[18px] text-muted">{t('planNote')}</span>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-muted">{t('coverageTitle')}</h2>
        <span className="inline-flex whitespace-nowrap rounded-chip bg-mock px-2 py-[3px] text-[12px] font-semibold text-mock-ink" data-sample-insurance>
          {t('sampleInsurance')}
        </span>
      </div>
      <dl className="m-0 flex flex-col gap-1 text-[14px]">
        {TIERS.map((tier) => (
          <div key={tier} className="flex justify-between gap-3" data-coverage-row={tier}>
            <dt>{t(`tierShort.${tier}`)}</dt>
            <dd className="m-0 font-semibold">{t(`coverage.${indicativeCoverage(insurance, tier)}`)}</dd>
          </div>
        ))}
      </dl>
      <span className="text-[13px] font-semibold text-warning-ink" data-indicative>
        {t('indicative')}
      </span>
    </section>
  );
}

const PREFERENCE_FIELDS = [
  { key: 'language', values: CARE_LANGUAGES, label: 'languageName' },
  { key: 'clinicianGender', values: GENDERS.filter((g) => g !== 'another'), label: 'genderValue' },
  { key: 'modality', values: MODALITIES, label: 'modalityValue' },
  { key: 'region', values: REGIONS, label: 'regionName' },
  { key: 'timeOfDay', values: TIMES_OF_DAY, label: 'timeName' },
] as const;

const PREFERENCE_TITLES = { language: 'language', clinicianGender: 'gender', modality: 'modality', region: 'region', timeOfDay: 'timeOfDay' } as const;

function PreferencesPanel({ t, preferences, onChange }: { t: Translate; preferences: Preferences; onChange: (preferences: Preferences) => void }) {
  return (
    <details className="rounded-staff border border-border bg-surface px-3.5 py-1" data-panel="preferences">
      <summary className="tap flex cursor-pointer items-center text-[14px] font-semibold">{t('prefsTitle')}</summary>
      <div className="flex flex-col gap-2.5 pb-3">
        <p className="t-small text-muted">{t('prefsHint')}</p>
        {PREFERENCE_FIELDS.map((field) => (
          <div key={field.key} className="flex flex-col gap-1">
            <label htmlFor={`pref-${field.key}`} className="text-[13px] font-semibold text-muted">
              {t(PREFERENCE_TITLES[field.key])}
            </label>
            <select
              id={`pref-${field.key}`}
              className={SELECT}
              value={preferences[field.key] ?? ''}
              onChange={(event) => {
                const { [field.key]: _removed, ...rest } = preferences;
                onChange(event.target.value === '' ? rest : { ...rest, [field.key]: event.target.value });
              }}
            >
              <option value="">{t('anyPreference')}</option>
              {field.values.map((value) => (
                <option key={value} value={value}>
                  {t(`${field.label}.${value}`)}
                </option>
              ))}
            </select>
            {field.key === 'timeOfDay' && <span className="t-small text-muted">{t('timeOfDayHint')}</span>}
          </div>
        ))}
      </div>
    </details>
  );
}

function reasonText(t: Translate, reason: RankedOption['reasons'][number]): string {
  switch (reason.code) {
    case 'score_phq9':
      return t('fit.scorePhq9', { total: Number(reason.params?.['total']) });
    case 'score_gad7':
      return t('fit.scoreGad7', { total: Number(reason.params?.['total']) });
    case 'no_scores':
      return t('fit.noScores');
    case 'bridge_option':
      return t('fit.bridge');
    case 'current_tier':
      return t('fit.current');
    case 'other_tier':
      return t('fit.other');
    case 'crisis_active':
      return '';
  }
}

function OptionCard({ t, option, insurance, lead, onChoose }: { t: Translate; option: RankedOption; insurance: InsuranceClass; lead: boolean; onChoose: (option: RankedOption) => void }) {
  const service = option.service!;
  const tier = option.tier as Tier;
  const toCheck = option.eligibility.filter((item) => item.status === 'check').map((item) => t(`check.${item.kind}`));
  const why = option.reasons.map((reason) => reasonText(t, reason)).filter(Boolean).join(', ');
  // The board's self-help card is the compact one: 14 px above and below, a 16 px title and a 44 px button.
  const compact = tier === 'self_help' && !lead;
  return (
    <article className={`flex flex-col gap-2.5 rounded-card bg-surface px-4 ${compact ? 'py-3.5' : 'py-4'} ${lead ? 'border-2 border-accent' : 'border border-border'}`} data-tier={tier} data-lead={lead || undefined}>
      <div className="flex flex-wrap items-center gap-2">
        {lead && <span className="rounded-[10px] bg-accent px-2.5 py-[3px] text-[12px] font-semibold text-surface">{t('bestMatch')}</span>}
        {option.current && <span className="rounded-[10px] bg-accent-tint px-2.5 py-[3px] text-[12px] font-semibold text-accent-dark">{t('currentSupport')}</span>}
        <span className="rounded-chip bg-mock px-2 py-[3px] text-[12px] font-semibold text-mock-ink">{t('sampleData')}</span>
      </div>
      <div>
        <h2 className={`font-bold leading-6 ${compact ? 'text-[16px]' : 'text-[18px]'}`}>{t(`tier.${tier}`)}</h2>
        <p className="mt-0.5 text-[14px] text-muted">
          <span dir="auto">{service.name}</span> · {t(`regionName.${service.region}`)}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5 text-[13px]">
        {[t(`modalityValue.${service.modality}`), service.languages.map((language) => t(`languageName.${language}`)).join(' · '), ...service.clinicianGenders.map((gender) => t(`genderAvailable.${gender}`))].map(
          (tag) => (
            <span key={tag} className="rounded-chip bg-[#EEF2F1] px-2 py-1">
              {tag}
            </span>
          ),
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-input bg-ground px-2.5 py-2">
          <div className="text-[12px] text-muted">{t('wait')}</div>
          <div className="text-[15px] font-semibold">{t('waitDays', { days: service.indicativeWaitDays })}</div>
        </div>
        <div className="rounded-input bg-ground px-2.5 py-2">
          <div className="text-[12px] text-muted">{t(`insurance.${insurance}`)}</div>
          <div className="text-[15px] font-semibold" data-coverage={option.coverage ?? undefined}>
            {option.coverage ? t(`coverage.${option.coverage}`) : ''}
          </div>
        </div>
      </div>
      <p className="text-[14px] leading-5 text-[#34484A]">
        <b>{t('why')}</b> {why}
      </p>
      {toCheck.length > 0 && <p className="t-small text-muted">{t('toCheck', { items: toCheck.join(', ') })}</p>}
      {option.handoffWindowDays !== null && (
        <p className="flex gap-2 text-[14px] leading-5 text-accent-dark" data-promise={option.handoffWindowDays}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          {t('promise', { days: option.handoffWindowDays })}
        </p>
      )}
      <button
        type="button"
        onClick={() => onChoose(option)}
        className={
          lead
            ? 'btn-primary'
            : compact
              ? 'tap min-h-tap rounded-pill border-[1.5px] border-accent px-4 text-[15px] font-semibold text-accent'
              : 'tap min-h-12 rounded-full border-[1.5px] border-accent px-4 text-[16px] font-semibold text-accent'
        }
      >
        {t(lead ? 'choose' : 'chooseOther')}
      </button>
    </article>
  );
}
