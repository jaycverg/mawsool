'use client';

import {
  StaffBundleViewSchema,
  StaffTicketDetailSchema,
  UNABLE_REASONS,
  type BundleContent,
  type ConsentElement,
  type Session,
  type StaffBundleView,
  type StaffTicketDetail,
  type UnableReason,
} from '@mawsool/types';
import { formatDate, isLocale, staffCall, type StaffCall } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ACTIONABLE_STATES, API_URL, displayCode, sparkline, trajectoryByInstrument } from '../lib/queue';

type Translate = ReturnType<typeof useTranslations>;

/**
 * What the screen knows about the open ticket. `withdrawn` carries nothing on purpose: once the person has ended the
 * share the clinic is shown the banner and no data, not even the code it had in the queue a moment ago.
 */
type View =
  | { k: 'loading' }
  | { k: 'failed' }
  | { k: 'notFound' }
  | { k: 'withdrawn' }
  | { k: 'ready'; ticket: StaffTicketDetail; bundle: StaffBundleView | 'none' };

type Panel = 'none' | 'unable';

export interface TicketDetailProps {
  session: Session;
  ticketId: string;
  /** Called after an action changed the ticket, so the queue beside it can reload. */
  onChanged: () => void;
  /** The session is no longer good: the screen ends it and goes to sign-in. */
  onUnauthorized: () => void;
}

const call = <T,>(session: Session, path: string, extra: { method?: 'GET' | 'POST'; body?: unknown } = {}) =>
  staffCall<T>({ fetch: window.fetch.bind(window), apiUrl: API_URL, session, path, ...extra });

/**
 * The ticket the clinic opened: its fields from `GET /tickets/:id` and what the person chose to share from the bundle
 * read, which is audited by the API. The bundle is read once per opening (an action refreshes only the ticket's own
 * fields), and a 410 from either replaces the whole view with "Withdrawn by the person".
 */
export function TicketDetail({ session, ticketId, onChanged, onUnauthorized }: TicketDetailProps) {
  const t = useTranslations('detail');
  const root = useTranslations();
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const [view, setView] = useState<View>({ k: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [panel, setPanel] = useState<Panel>('none');
  const [reason, setReason] = useState<UnableReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<'actionFailed' | 'actionChanged' | null>(null);
  const [exported, setExported] = useState<{ text: string; copied: boolean } | 'failed' | null>(null);
  // One request pair per opening, however many times the effect runs (React runs it twice in development).
  const opening = useRef<{ key: string; done: Promise<View | 'unauthorized'> } | null>(null);
  // The queue beside this panel must hear about a withdrawal however it was found, so its row (code, tier, deadline) goes too.
  const changed = useRef(onChanged);
  changed.current = onChanged;

  useEffect(() => {
    let active = true;
    const key = `${ticketId}:${attempt}`;
    if (opening.current?.key !== key) {
      opening.current = {
        key,
        done: Promise.all([call<unknown>(session, `/tickets/${ticketId}`), call<unknown>(session, `/tickets/${ticketId}/bundle`)]).then(([ticket, bundle]) => viewOf(ticket, bundle)),
      };
    }
    void opening.current.done.then((next) => {
      if (!active) return;
      if (next === 'unauthorized') return onUnauthorized();
      setView(next);
      if (next.k === 'withdrawn') changed.current();
    });
    return () => {
      active = false;
    };
  }, [session, ticketId, attempt, onUnauthorized]);

  /** Reads the ticket's own fields again after an action. The bundle is not read again. */
  const refreshTicket = useCallback(async () => {
    const ticket = await call<unknown>(session, `/tickets/${ticketId}`);
    if (ticket.status === 'unauthorized') return onUnauthorized();
    if (ticket.status === 'refused' && ticket.httpStatus === 410) return setView({ k: 'withdrawn' });
    const parsed = ticket.status === 'ok' ? StaffTicketDetailSchema.safeParse(ticket.body) : null;
    if (!parsed?.success) return setView({ k: 'failed' });
    setView((current) => (current.k === 'ready' ? { ...current, ticket: parsed.data } : current));
  }, [session, ticketId, onUnauthorized]);

  async function act(body: object) {
    setBusy(true);
    setMessage(null);
    const result = await call<unknown>(session, `/tickets/${ticketId}/events`, { method: 'POST', body });
    setBusy(false);
    if (result.status === 'unauthorized') return onUnauthorized();
    setPanel('none');
    setReason(null);
    if (result.status !== 'ok') setMessage(result.status === 'refused' && result.httpStatus === 409 ? 'actionChanged' : 'actionFailed');
    await refreshTicket();
    onChanged();
  }

  async function exportBundle() {
    setExported(null);
    const result = await call<unknown>(session, `/tickets/${ticketId}/fhir`);
    if (result.status === 'unauthorized') return onUnauthorized();
    if (result.status === 'refused' && result.httpStatus === 410) {
      setView({ k: 'withdrawn' });
      return changed.current();
    }
    if (result.status !== 'ok') return setExported('failed');
    const text = JSON.stringify(result.body, null, 2);
    const copied = await navigator.clipboard.writeText(text).then(() => true, () => false);
    setExported({ text, copied });
  }

  return (
    <section aria-label={t('heading')} data-detail className="flex min-w-0 flex-col gap-3.5 rounded-staff border border-border bg-surface p-[18px]">
      {view.k === 'loading' && <p role="status" className="t-body text-muted">{t('loading')}</p>}
      {view.k === 'failed' && (
        <div role="alert" className="flex flex-col gap-2">
          <p className="t-body">{t('failed')}</p>
          <button type="button" className="btn-primary" onClick={() => { setView({ k: 'loading' }); setAttempt((n) => n + 1); }}>{t('retry')}</button>
        </div>
      )}
      {view.k === 'notFound' && <p role="alert" className="t-body" data-detail-state="not-found">{t('notFound')}</p>}
      {view.k === 'withdrawn' && (
        <div role="alert" className="flex flex-col gap-1" data-detail-state="withdrawn">
          <h2 className="text-[17px] font-semibold">{t('withdrawn')}</h2>
          <p className="t-body text-muted">{t('withdrawnBody')}</p>
        </div>
      )}
      {view.k === 'ready' && (
        <Ready
          t={t}
          root={root}
          lang={lang}
          ticket={view.ticket}
          bundle={view.bundle}
          panel={panel}
          setPanel={setPanel}
          reason={reason}
          setReason={setReason}
          busy={busy}
          message={message}
          exported={exported}
          onAcknowledge={() => void act({ to: 'acknowledged' })}
          onSeen={() => void act({ to: 'seen' })}
          onUnable={() => reason && void act({ unable: true, reason })}
          onExport={() => void exportBundle()}
        />
      )}
    </section>
  );
}

/** Turns the two answers into what the screen shows. A 410 from either is a withdrawal; no bundle at all is a ticket with nothing shared. */
function viewOf(ticket: StaffCall<unknown>, bundle: StaffCall<unknown>): View | 'unauthorized' {
  if (ticket.status === 'unauthorized' || bundle.status === 'unauthorized') return 'unauthorized';
  if ((ticket.status === 'refused' && ticket.httpStatus === 410) || (bundle.status === 'refused' && bundle.httpStatus === 410)) return { k: 'withdrawn' };
  if (ticket.status === 'refused' && ticket.httpStatus === 404) return { k: 'notFound' };
  const parsedTicket = ticket.status === 'ok' ? StaffTicketDetailSchema.safeParse(ticket.body) : null;
  if (!parsedTicket?.success) return { k: 'failed' };
  // A ticket that never had anything shared (a seeded one) has no bundle: 404, not a withdrawal.
  if (bundle.status === 'refused' && bundle.httpStatus === 404) return { k: 'ready', ticket: parsedTicket.data, bundle: 'none' };
  const parsedBundle = bundle.status === 'ok' ? StaffBundleViewSchema.safeParse(bundle.body) : null;
  return parsedBundle?.success ? { k: 'ready', ticket: parsedTicket.data, bundle: parsedBundle.data } : { k: 'failed' };
}

interface ReadyProps {
  t: Translate;
  root: Translate;
  lang: 'ar' | 'en';
  ticket: StaffTicketDetail;
  bundle: StaffBundleView | 'none';
  panel: Panel;
  setPanel: (panel: Panel) => void;
  reason: UnableReason | null;
  setReason: (reason: UnableReason) => void;
  busy: boolean;
  message: 'actionFailed' | 'actionChanged' | null;
  exported: { text: string; copied: boolean } | 'failed' | null;
  onAcknowledge: () => void;
  onSeen: () => void;
  onUnable: () => void;
  onExport: () => void;
}

const SECTION = 'text-[12px] font-semibold uppercase tracking-[0.5px] text-muted';
const OUTLINE_BUTTON = 'tap rounded-pill border-[1.5px] border-accent bg-surface px-[18px] text-[15px] font-semibold text-accent disabled:opacity-60';

function Ready({ t, root, lang, ticket, bundle, panel, setPanel, reason, setReason, busy, message, exported, onAcknowledge, onSeen, onUnable, onExport }: ReadyProps) {
  const actionable = (ACTIONABLE_STATES as readonly string[]).includes(ticket.state);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="t-code text-[22px]" dir="ltr" data-code>{displayCode(ticket.shortCode)}</span>
        <span className="rounded-chip bg-accent-tint px-2 py-[3px] text-[12px] font-semibold text-accent-dark" data-state={ticket.state}>{root(`state.${ticket.state}`)}</span>
      </div>
      <p className="-mt-2 text-[14px] text-muted">
        {t('referred', { referred: formatDate(ticket.createdAt, lang, 'long'), deadline: formatDate(ticket.deadlineAt, lang, 'long'), tier: root(`tier.${ticket.tier}`) })}
      </p>

      {bundle === 'none' ? (
        <p className="rounded-input bg-ground px-3 py-2.5 text-[13px] leading-[18px]" data-nothing-shared>{t('nothingShared')}</p>
      ) : (
        <Shared t={t} root={root} lang={lang} bundle={bundle} />
      )}

      {ticket.unable && (
        <p role="status" className="rounded-input bg-warning px-3 py-2.5 text-[14px] text-warning-ink" data-unable-standing>
          {t('unableStanding', { reason: t(`unableReason.${ticket.unable.reason}`) })}
        </p>
      )}
      {message && <p role="alert" className="t-body text-danger" data-message={message}>{t(message)}</p>}

      {actionable ? (
        <div className="mt-1 flex flex-col gap-2.5">
          <div className="flex flex-wrap gap-2.5">
            {ticket.state === 'issued' && <button type="button" className={`${OUTLINE_BUTTON}`} disabled={busy} onClick={onAcknowledge}>{t('acknowledge')}</button>}
            <button type="button" className="tap rounded-pill bg-accent px-[18px] text-[15px] font-semibold text-surface disabled:opacity-60" disabled={busy} onClick={onSeen}>{t('markSeen')}</button>
            <button type="button" className={OUTLINE_BUTTON} disabled={busy} aria-expanded={panel === 'unable'} onClick={() => setPanel(panel === 'unable' ? 'none' : 'unable')}>{t('unable')}</button>
          </div>
          {panel === 'unable' && (
            <fieldset className="flex flex-col gap-1 rounded-input border border-border p-3" data-panel="unable">
              <legend className="px-1 text-[14px] font-semibold">{t('unableTitle')}</legend>
              {UNABLE_REASONS.map((code) => (
                <label key={code} className="flex min-h-tap items-center gap-2 text-[15px]">
                  <input type="radio" name="unable-reason" value={code} checked={reason === code} onChange={() => setReason(code)} className="size-5 accent-accent" />
                  {t(`unableReason.${code}`)}
                </label>
              ))}
              <div className="flex flex-wrap gap-2.5 pt-1">
                <button type="button" className="tap rounded-pill bg-accent px-[18px] text-[15px] font-semibold text-surface disabled:opacity-60" disabled={busy || reason === null} onClick={onUnable}>{t('unableConfirm')}</button>
                <button type="button" className={OUTLINE_BUTTON} onClick={() => setPanel('none')}>{t('cancel')}</button>
              </div>
            </fieldset>
          )}
        </div>
      ) : (
        <p className="t-small text-muted" data-no-actions>{t('noActions')}</p>
      )}

      {bundle !== 'none' && (
        <div className="flex flex-col gap-2.5 border-t border-[#E6ECEA] pt-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <button type="button" className="tap rounded-input border border-[#9AAAA7] bg-surface px-3.5 text-[14px] text-ink" onClick={onExport}>{t('copyFhir')}</button>
            <span className="t-small text-muted" data-export-label>{t('exportLabel')}</span>
          </div>
          {exported === 'failed' && <p role="alert" className="t-small text-danger">{t('exportFailed')}</p>}
          {exported && exported !== 'failed' && (
            <>
              <p role="status" className="t-small">{exported.copied ? t('copied') : t('copyFailed')}</p>
              <pre dir="ltr" aria-label={t('exportShown')} data-fhir className="max-h-72 overflow-auto rounded-input bg-ground p-3 text-[12px] leading-[16px]">{exported.text}</pre>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** The consented content, section by section. Anything the person did not share is marked, in the same place it would have been. */
function Shared({ t, root, lang, bundle }: { t: Translate; root: Translate; lang: 'ar' | 'en'; bundle: StaffBundleView }) {
  const missing = (element: ConsentElement) => bundle.notShared.includes(element);
  const { content } = bundle;
  return (
    <>
      <p className="rounded-input bg-ground px-3 py-2.5 text-[13px] leading-[18px] text-[#34484A]">{t('notice')}</p>

      <Section title={t('summaryTitle')} data="summary">
        {bundle.approvedSummary !== null ? <p className="whitespace-pre-wrap text-[15px]" dir="auto" data-summary>{bundle.approvedSummary}</p> : <p className="text-[15px] text-muted" data-no-summary>{t('noSummary')}</p>}
      </Section>

      <Section title={t('scoresTitle')} data="scores">
        {missing('scores') ? <NotShared t={t} /> : (content.scores ?? []).length === 0 ? <Empty t={t} /> : <ul className="m-0 flex list-none flex-col gap-1 p-0">{(content.scores ?? []).map((score) => <li key={`${score.instrument}-${score.takenAt}`} className="text-[15px]"><b>{t('scoreLine', { instrument: t(`instrument.${score.instrument}`), total: score.total })}</b>{score.band && <> · {t.has(`band.${score.band}`) ? t(`band.${score.band as 'mild'}`) : score.band}</>}</li>)}</ul>}
      </Section>

      <Section title={t('trajectoryTitle')} data="trajectory">
        {missing('trajectory') ? <NotShared t={t} /> : <Trajectory t={t} lang={lang} content={content} />}
      </Section>

      <Section title={t('conditionsTitle')} data="conditions">
        {missing('conditions') ? <NotShared t={t} /> : (content.conditions ?? []).length === 0 ? <Empty t={t} /> : <ul className="m-0 flex list-none flex-col gap-1 p-0">{(content.conditions ?? []).map((name) => <li key={name} className="text-[15px]" dir="auto">{t('conditionLine', { name })}</li>)}</ul>}
      </Section>

      <Section title={t('preferencesTitle')} data="preferences">
        {missing('preferences') ? <NotShared t={t} /> : content.preferences === undefined ? <Empty t={t} /> : <p className="text-[15px]">{preferenceLines(t, root, content.preferences).join(' · ')}</p>}
      </Section>

      <Section title={t('noteTitle')} data="free_text">
        {missing('free_text') ? <NotShared t={t} /> : content.free_text === undefined ? <Empty t={t} /> : <p className="whitespace-pre-wrap text-[15px]" dir="auto" data-note>{content.free_text}</p>}
      </Section>
    </>
  );
}

function Section({ title, data, children }: { title: string; data: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1" data-section={data}>
      <span className={SECTION}>{title}</span>
      {children}
    </div>
  );
}

const NotShared = ({ t }: { t: Translate }) => <span className="text-[15px] italic text-muted" data-not-shared>{t('notShared')}</span>;
const Empty = ({ t }: { t: Translate }) => <span className="text-[15px] text-muted">{t('noneToShow')}</span>;

function Trajectory({ t, lang, content }: { t: Translate; lang: 'ar' | 'en'; content: BundleContent }) {
  const series = trajectoryByInstrument(content);
  if (series.length === 0) return <Empty t={t} />;
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {series.map(({ instrument, entries }) => {
        const first = entries[0]!;
        const last = entries[entries.length - 1]!;
        const name = t(`instrument.${instrument}`);
        return (
          <li key={instrument} className="flex items-center gap-3" data-trajectory={instrument}>
            <span className="flex-1 text-[15px]">
              {entries.length === 1 ? t('scoreLine', { instrument: name, total: last.total }) : t('trajectoryLine', { instrument: name, from: first.total, to: last.total })}
              {entries.length > 1 && <span className="text-muted"> · {formatDate(first.takenAt, lang)} – {formatDate(last.takenAt, lang)}</span>}
            </span>
            {entries.length > 1 && (
              <svg width="72" height="28" viewBox="0 0 72 28" role="img" aria-label={t('trajectoryChart', { instrument: name, from: first.total, to: last.total })} className="rtl-flip shrink-0">
                <polyline points={sparkline(entries, 72, 28)} fill="none" stroke="#0E6B63" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One line per preference the person set, in words. */
function preferenceLines(t: Translate, root: Translate, preferences: NonNullable<BundleContent['preferences']>): string[] {
  const lines: string[] = [];
  if (preferences.language) lines.push(t('pref.language', { value: root(`language.${preferences.language}`) }));
  if (preferences.clinicianGender) lines.push(t('pref.clinicianGender', { value: t(`gender.${preferences.clinicianGender}`) }));
  if (preferences.modality) lines.push(t('pref.modality', { value: t(`modality.${preferences.modality}`) }));
  if (preferences.region) lines.push(t('pref.region', { value: t(`region.${preferences.region}`) }));
  if (preferences.timeOfDay) lines.push(t('pref.timeOfDay', { value: t(`timeOfDay.${preferences.timeOfDay}`) }));
  return lines;
}
