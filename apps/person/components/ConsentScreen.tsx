'use client';

import { redact, wordCount } from '@mawsool/consent';
import { AGE_BANDS, CARE_LANGUAGES, GENDERS, REGIONS, SUMMARY_WORD_LIMIT, SummaryDraftSchema, type BundleContent, type ConsentElement, type Demographics, type Preferences, type Screening, type Service } from '@mawsool/types';
import { isLocale } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { API_URL } from '../lib/api';
import { deviceNow } from '../lib/clock';
import { loadDirectory } from '../lib/directory';
import { loadInvite } from '../lib/invite';
import { formatDate } from '../lib/format';
import { loadPendingChoice, loadPreferences, type PendingChoice } from '../lib/prefs';
import { href } from '../lib/routes';
import { loadScreenings } from '../lib/screening-store';
import { sendReferral } from '../lib/send-referral';
import { callServer, markServerFootprint, type ServerDeps } from '../lib/server';
import { EMPTY_SHARING, buildContent, loadEquity, loadSharing, parseConditions, saveEquity, saveSharing, type Sharing } from '../lib/share';
import { useDevice, type Device } from '../lib/use-device';
import { FlowHeader } from './FlowHeader';

type Translate = ReturnType<typeof useTranslations>;

interface Loaded {
  pending: PendingChoice;
  service: Service | null;
  screenings: Screening[];
  base: BundleContent;
  sharing: Sharing;
  /** The front-door invite this phone claimed and no ticket has used yet. A failure to read it is no invite: the ticket is then an app ticket. */
  inviteId: string | null;
}

type Problem = 'offline' | 'rejected' | 'changed' | 'localFailed' | null;

/** The optional elements in the order the board lists them: one row each, all off until ticked. */
const ROWS = ['scores', 'trajectory', 'conditions', 'preferences', 'free_text'] as const;
type Row = (typeof ROWS)[number];

const FIELD = 'w-full rounded-input border border-[#9AAAA7] bg-surface px-2.5 py-2 text-[16px] text-ink';
const SELECT = 'h-11 w-full rounded-input border border-[#9AAAA7] bg-surface px-2.5 text-[16px] text-ink';

/**
 * Share with the clinic: what the person lets the chosen clinic see. Every optional element is off until ticked; the
 * only required one is the ticket itself. What the person types for the clinic stays on the phone until they send.
 * The preview says in plain words what will leave. An AI-drafted summary is only a draft: nothing is shared until the
 * person edits it and approves it. The equity opt-in is a separate choice and defaults to off.
 */
export function ConsentScreen() {
  const t = useTranslations('consent');
  const to = useTranslations('options');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const device = useDevice();
  const [loaded, setLoaded] = useState<Loaded | null | 'none'>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<Row>>(new Set());
  const [conditionsText, setConditionsText] = useState('');
  const [sharing, setSharing] = useState<Sharing>(EMPTY_SHARING);
  const [summary, setSummary] = useState<{ text: string; source: 'ai' | 'template'; approved: boolean; draftedFrom: ConsentElement[]; acceptedWithout: ConsentElement[] } | null>(null);
  const [typedFailed, setTypedFailed] = useState(false);
  const [storedOptIn, setStoredOptIn] = useState(false);
  const [drafting, setDrafting] = useState<'idle' | 'working' | 'failed'>('idle');
  const [equity, setEquity] = useState<{ on: boolean; buckets: Partial<Demographics> }>({ on: false, buckets: {} });
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);

  useEffect(() => {
    if (device === null || device === 'unavailable') return;
    void (async () => {
      const [pending, screenings, preferences, saved, equityStored] = await Promise.all([loadPendingChoice(device.storage), loadScreenings(device.storage), loadPreferences(device.storage), loadSharing(device.storage), loadEquity(device.storage)]);
      setStoredOptIn(equityStored.optIn);
      setEquity({ on: equityStored.optIn, buckets: equityStored.buckets as Partial<Demographics> });
      if (!pending) return setLoaded('none');
      const directory = await loadDirectory({ storage: device.storage, fetch: window.fetch.bind(window), apiUrl: API_URL, now: deviceNow });
      setSharing(saved);
      setConditionsText(saved.conditions.join('\n'));
      const invite = await loadInvite(device.storage).catch(() => null);
      setLoaded({ pending, service: directory?.services.find((service) => service.id === pending.serviceId) ?? null, screenings, base: buildContent(screenings, preferences, saved), sharing: saved, inviteId: invite?.inviteId ?? null });
    })().catch(() => setUnreadable(true));
  }, [device]);

  const content = useMemo<BundleContent>(() => {
    if (!loaded || loaded === 'none') return {};
    const { base } = loaded;
    return { ...base, free_text: sharing.note.trim() || undefined, conditions: parseConditions(conditionsText).length > 0 ? parseConditions(conditionsText) : undefined };
  }, [loaded, sharing.note, conditionsText]);

  const elements = useMemo<ConsentElement[]>(() => ['ticket', ...ROWS.filter((row) => ticked.has(row) && redact(content, [row])[row] !== undefined)], [ticked, content]);
  const stale = summary !== null && isStale(summary, elements);
  // An approval holds only for what it was drafted from: when an element it used is unticked, it has to be given again.
  useEffect(() => {
    if (summary?.approved && stale) setSummary({ ...summary, approved: false });
  }, [stale, summary]);

  const serverDeps = (d: Device): ServerDeps => ({ storage: d.storage, fetch: window.fetch.bind(window), apiUrl: API_URL, locale: lang, random: window.crypto });

  if (device === 'unavailable' || unreadable) return <Shell lang={lang} t={t}><p role="alert" className="t-body">{t('storageUnavailable')}</p></Shell>;
  if (loaded === 'none') {
    return (
      <Shell lang={lang} t={t}>
        <p className="t-body">{t('noChoice')}</p>
        <a className="btn-primary" href={href(lang, 'options')}>{t('back')}</a>
      </Shell>
    );
  }
  if (loaded === null || device === null) return <Shell lang={lang} t={t}>{null}</Shell>;

  const dev: Device = device;
  const { pending, service, screenings, inviteId } = loaded;
  const latestScores = (content.scores ?? []).map((score) => `${score.instrument === 'phq9' ? 'PHQ-9' : score.instrument === 'gad7' ? 'GAD-7' : 'WHO-5'} ${score.total}`).join(', ');
  const trend = content.trajectory ?? [];
  const summaryWords = summary ? wordCount(summary.text) : 0;
  const approvedSummary = summary?.approved && summaryWords > 0 && summaryWords <= SUMMARY_WORD_LIMIT ? summary.text.trim() : null;

  const details: Record<Row, { title: string; detail: string; available: boolean }> = {
    scores: { title: t('scoresTitle'), detail: content.scores ? t('scoresDetail', { list: latestScores }) : t('scoresNone'), available: content.scores !== undefined },
    trajectory: { title: t('trendTitle'), detail: trend.length > 0 ? t('trendDetail', { count: trend.length, date: formatDate(trend[0]!.takenAt, lang) }) : t('trendNone'), available: trend.length > 0 },
    conditions: { title: t('conditionsTitle'), detail: content.conditions ? content.conditions.join(', ') : t('conditionsNone'), available: content.conditions !== undefined },
    preferences: { title: t('prefsTitle'), detail: content.preferences ? preferenceText(content.preferences, to) : t('prefsNone'), available: content.preferences !== undefined },
    free_text: { title: t('noteTitle'), detail: content.free_text ? t('noteWritten') : t('noteNone'), available: content.free_text !== undefined },
  };

  function toggle(row: Row, on: boolean) {
    setTicked((previous) => {
      const next = new Set(previous);
      if (on) next.add(row);
      else next.delete(row);
      return next;
    });
  }

  async function keepTyped(next: Sharing, conditions: string) {
    setSharing(next);
    setConditionsText(conditions);
    setTypedFailed(false);
    await saveSharing(dev.storage, { ...next, conditions: parseConditions(conditions) }).catch(() => setTypedFailed(true));
  }

  async function draft() {
    setDrafting('working');
    try {
      await markServerFootprint(dev.storage, deviceNow);
      // With the AI box unticked nothing about the person goes with the request: the server only returns the template.
      const aiOn = sharing.useAi;
      const result = await callServer<unknown>(serverDeps(dev), 'POST', '/summary/draft', {
        requestId: pending.requestId,
        locale: lang,
        useAi: aiOn,
        consented: aiOn ? elements : ['ticket'],
        content: aiOn ? redact(content, elements) : {},
      });
      const parsed = result.ok ? SummaryDraftSchema.safeParse(result.body) : null;
      if (!parsed?.success) return setDrafting('failed');
      // Only a draft the AI wrote is built from the ticked elements. A template (flag off, no AI box, or a provider that failed) is built from nothing: no tick stales it and no stop deletes text the person typed.
      setSummary({ text: parsed.data.text, source: parsed.data.source, approved: false, draftedFrom: parsed.data.source === 'ai' ? elements : [], acceptedWithout: [] });
      setDrafting('idle');
    } catch {
      setDrafting('failed');
    }
  }

  async function send() {
    setSending(true);
    setProblem(null);
    const deps = serverDeps(dev);
    try {
      let optInSaved = true;
      if (equity.on || storedOptIn) {
        const buckets: Demographics = { ageBand: equity.buckets.ageBand ?? null, gender: equity.buckets.gender ?? null, language: equity.buckets.language ?? null, region: equity.buckets.region ?? null };
        await markServerFootprint(dev.storage, deviceNow);
        const saved = await callServer(deps, 'PUT', '/me/equity', equity.on ? { optIn: true, buckets } : { optIn: false });
        if (!saved.ok) {
          setSending(false);
          return setProblem(saved.reason === 'offline' ? 'offline' : 'rejected');
        }
        optInSaved = await saveEquity(dev.storage, { optIn: equity.on, buckets: equity.on ? buckets : {} }).then(() => true, () => false);
      }
      const outcome = await sendReferral(deps, {
        pending,
        elements,
        content,
        approvedSummary,
        summaryRequestId: summary ? pending.requestId : null,
        summaryBuiltFrom: summary?.draftedFrom ?? [],
        language: content.preferences?.language ?? lang,
        inviteId,
        now: deviceNow,
      });
      if (outcome.status === 'sent') {
        // The server has the ticket, so the person always goes to it; a note that this phone could not keep its own copy travels with them.
        window.location.assign(href(lang, 'ticket', outcome.saved && optInSaved ? { id: outcome.ticketId } : { id: outcome.ticketId, saved: '0' }));
        return;
      }
      setProblem(outcome.status === 'offline' ? 'offline' : outcome.status === 'changed' ? 'changed' : outcome.status === 'not_saved' ? 'localFailed' : 'rejected');
    } catch {
      setProblem('localFailed');
    }
    setSending(false);
  }

  const preview = [
    t('previewTicket'),
    ...elements.filter((e) => e !== 'ticket').map((e) => (e === 'scores' ? t('previewScores', { list: latestScores }) : e === 'trajectory' ? t('previewTrend') : e === 'conditions' ? t('previewConditions') : e === 'preferences' ? t('previewPrefs') : t('previewNote'))),
    ...(approvedSummary ? [t('previewSummary')] : []),
  ].join(' · ');

  return (
    <>
      <FlowHeader leading={{ href: href(lang, 'options'), label: t('back') }} title={t('title')} />
      <main className="mx-auto flex max-w-md flex-col gap-3.5 px-4 py-5" data-screen="consent">
        <div className="flex flex-col gap-1">
          <h1 className="t-h1">{t('heading')}</h1>
          <p className="t-body text-muted">
            {t('sendingTo')} <b className="text-ink" dir="auto">{service?.name ?? ''}</b> <span className="ms-1 inline-flex whitespace-nowrap rounded-chip bg-mock px-2 py-[3px] text-[12px] font-semibold text-mock-ink" data-sample>{t('sample')}</span>
          </p>
          {pending.reroute && <p className="t-small text-muted">{t('reroutingNote')}</p>}
        </div>

        <section className="flex flex-col rounded-card border border-border bg-surface">
          <div className="flex items-center gap-3 border-b border-[#E6ECEA] px-4 py-3.5">
            <div className="flex-1">
              <div className="text-[16px] font-semibold">{t('ticketTitle')}</div>
              <div className="text-[13px] leading-[18px] text-muted">{t('ticketDetail')}</div>
            </div>
            <span className="flex items-center gap-1 text-[13px] text-muted" data-element="ticket">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <rect x="5" y="11" width="14" height="9" rx="2" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
              {t('needed')}
            </span>
          </div>
          {ROWS.map((row, index) => (
            <label key={row} className={`flex min-h-tap items-center gap-3 px-4 py-3.5 ${index < ROWS.length - 1 ? 'border-b border-[#E6ECEA]' : ''} ${details[row].available ? '' : 'opacity-60'}`}>
              <div className="flex-1">
                <div className="text-[16px] font-semibold">{details[row].title}</div>
                <div className="text-[13px] leading-[18px] text-muted">{details[row].detail}</div>
              </div>
              <input type="checkbox" data-element={row} className="size-6 accent-accent" checked={ticked.has(row) && details[row].available} disabled={!details[row].available} onChange={(event) => toggle(row, event.target.checked)} />
            </label>
          ))}
        </section>

        <section className="flex flex-col gap-2 rounded-staff border border-border bg-surface px-3.5 py-3">
          <h2 className="text-[14px] font-semibold">{t('writeTitle')}</h2>
          <p className="t-small text-muted">{t('writeHint')}</p>
          <label htmlFor="note" className="text-[13px] font-semibold text-muted">{t('noteLabel')}</label>
          <textarea id="note" rows={3} maxLength={2000} className={FIELD} value={sharing.note} onChange={(event) => void keepTyped({ ...sharing, note: event.target.value }, conditionsText)} />
          <label htmlFor="conditions" className="text-[13px] font-semibold text-muted">{t('conditionsLabel')}</label>
          <textarea id="conditions" rows={2} className={FIELD} value={conditionsText} onChange={(event) => void keepTyped(sharing, event.target.value)} />
        </section>

        <section className="flex flex-col gap-2 rounded-staff border border-dashed border-[#9AAAA7] bg-surface px-3.5 py-3">
          <div className="flex items-center gap-3">
            <p className="t-small flex-1 text-muted">{t('aiText')}</p>
            <button type="button" className="h-11 shrink-0 rounded-pill border-[1.5px] border-accent bg-surface px-3.5 text-[14px] font-semibold text-accent" disabled={drafting === 'working'} onClick={() => void draft()}>
              {drafting === 'working' ? t('drafting') : t('draft')}
            </button>
          </div>
          <label className="flex min-h-tap items-center gap-3 text-[14px] font-semibold">
            <input type="checkbox" id="use-ai" className="size-6 accent-accent" checked={sharing.useAi} onChange={(event) => void keepTyped({ ...sharing, useAi: event.target.checked }, conditionsText)} />
            {t('aiTick')}
          </label>
          {typedFailed && <p role="alert" className="t-small text-danger">{t('typedNotSaved')}</p>}
          {drafting === 'failed' && <p role="alert" className="t-small text-danger">{t('draftFailed')}</p>}
          {summary && (
            <div className="flex flex-col gap-1.5" data-summary={summary.source}>
              <label htmlFor="summary" className="text-[13px] font-semibold text-muted">{t('summaryLabel')}</label>
              <textarea id="summary" rows={5} className={FIELD} value={summary.text} onChange={(event) => setSummary({ ...summary, text: event.target.value, approved: false })} />
              <p className="t-small text-muted">{summary.source === 'ai' ? t('sourceAi') : t('sourceTemplate')}</p>
              <p className={`t-small ${summaryWords > SUMMARY_WORD_LIMIT ? 'text-danger' : 'text-muted'}`}>{summaryWords > SUMMARY_WORD_LIMIT ? t('tooLong') : t('words', { count: summaryWords })}</p>
              <p className="t-small text-muted">{t('summaryHint')}</p>
              {!summary.approved && stale && <p className="t-small text-danger" data-stale>{t('staleSummary')}</p>}
              {summary.approved ? (
                <p role="status" className="text-[14px] font-semibold text-accent-dark">{t('approved')}</p>
              ) : (
                <button type="button" className="tap self-start rounded-pill bg-accent px-4 text-[14px] font-semibold text-surface" disabled={summaryWords === 0 || summaryWords > SUMMARY_WORD_LIMIT} onClick={() => setSummary({ ...summary, approved: true, acceptedWithout: summary.draftedFrom.filter((element) => !elements.includes(element)) })}>
                  {t('approve')}
                </button>
              )}
            </div>
          )}
        </section>

        <EquityPanel t={t} to={to} value={equity} onChange={setEquity} />

        <section className="flex flex-col gap-1.5 rounded-staff bg-accent-tint px-4 py-3.5" data-preview>
          <span className="text-[13px] font-semibold uppercase tracking-[0.6px] text-accent-dark">{t('previewTitle')}</span>
          <p className="t-body">{preview}</p>
        </section>

        <p className="flex gap-2.5 text-[14px] leading-5 text-[#34484A]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0E6B63" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
            <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
          </svg>
          <span>{t('privacy')}</span>
        </p>

        {problem && <p role="alert" className="t-body text-danger">{t(problem)}</p>}
        <button type="button" className="btn-primary" disabled={sending || screenings === null} onClick={() => void send()}>
          {sending ? t('sending') : t('send')}
        </button>
      </main>
    </>
  );
}

/**
 * True when the person has unticked an element the draft was written from and has not accepted the summary without it.
 * `draftedFrom` is what the draft used and never shrinks, so a later re-tick still sends the true list; Approve records
 * the unticked ones in `acceptedWithout`, which is what keeps that approval from going stale.
 */
function isStale(summary: { draftedFrom: readonly ConsentElement[]; acceptedWithout: readonly ConsentElement[] }, elements: readonly ConsentElement[]): boolean {
  return summary.draftedFrom.some((element) => !elements.includes(element) && !summary.acceptedWithout.includes(element));
}

function Shell({ lang, t, children }: { lang: 'ar' | 'en'; t: Translate; children: React.ReactNode }) {
  return (
    <>
      <FlowHeader leading={{ href: href(lang, 'options'), label: t('back') }} title={t('title')} />
      <main className="mx-auto flex max-w-md flex-col gap-3 p-4">{children}</main>
    </>
  );
}

function EquityPanel({ t, to, value, onChange }: { t: Translate; to: Translate; value: { on: boolean; buckets: Partial<Demographics> }; onChange: (next: { on: boolean; buckets: Partial<Demographics> }) => void }) {
  const set = (key: keyof Demographics, entry: string) => onChange({ ...value, buckets: { ...value.buckets, [key]: entry === '' ? null : entry } });
  const fields = [
    { key: 'ageBand', label: t('ageBand'), values: AGE_BANDS, text: (v: string) => t(`ageBands.${v}`) },
    { key: 'gender', label: t('gender'), values: GENDERS, text: (v: string) => t(`genders.${v}`) },
    { key: 'language', label: t('language'), values: CARE_LANGUAGES, text: (v: string) => to(`languageName.${v}`) },
    { key: 'region', label: t('region'), values: REGIONS, text: (v: string) => to(`regionName.${v}`) },
  ] as const;
  return (
    <section className="flex flex-col gap-2 rounded-staff border border-border bg-surface px-3.5 py-3" data-panel="equity">
      <h2 className="text-[14px] font-semibold">{t('equityTitle')}</h2>
      <p className="t-small text-muted">{t('equityBody')}</p>
      <label className="flex min-h-tap items-center gap-3 text-[14px] font-semibold">
        <input type="checkbox" id="equity-on" className="size-6 accent-accent" checked={value.on} onChange={(event) => onChange({ ...value, on: event.target.checked })} />
        {t('equityToggle')}
      </label>
      {value.on &&
        fields.map((field) => (
          <div key={field.key} className="flex flex-col gap-1">
            <label htmlFor={`equity-${field.key}`} className="text-[13px] font-semibold text-muted">{field.label}</label>
            <select id={`equity-${field.key}`} className={SELECT} value={value.buckets[field.key] ?? ''} onChange={(event) => set(field.key, event.target.value)}>
              <option value="">{t('choose')}</option>
              {field.values.map((entry) => (
                <option key={entry} value={entry}>{field.text(entry)}</option>
              ))}
            </select>
          </div>
        ))}
    </section>
  );
}

const PREFERENCE_LABELS = { language: 'languageName', clinicianGender: 'genderValue', modality: 'modalityValue', region: 'regionName', timeOfDay: 'timeName' } as const;

/** The preferences as the person reads them on the options screen, in their language, never as stored codes. */
function preferenceText(preferences: Preferences, to: Translate): string {
  return (Object.keys(PREFERENCE_LABELS) as (keyof typeof PREFERENCE_LABELS)[])
    .flatMap((key) => (preferences[key] === undefined ? [] : [to(`${PREFERENCE_LABELS[key]}.${preferences[key]}`)]))
    .join(', ');
}
