import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PersonTicketView, Screening } from '@mawsool/types';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OutcomeStatisticsPanel, type StatisticsState } from '../components/OutcomeStatisticsPanel';
import { Totals } from '../components/RemeasureScreen';
import { KEYS } from '../lib/keys';
import { loadOutcomeStatistics, saveOutcomeStatistics, turnOffOutcomeStatistics } from '../lib/outcome-statistics';
import { finishRepeatCheck, sendRemeasure } from '../lib/remeasure';
import { forgetRegistration } from '../lib/server';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { memoryStorage } from './helpers/memory';

const MESSAGES = { en, ar } as const;
const TICKET_ID = '11111111-1111-4111-8111-111111111111';

function server(reply: { status: number; body?: unknown } | 'offline') {
  const store = memoryStorage();
  forgetRegistration(store.storage);
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/persons') return new Response('{}', { status: 201 });
    calls.push({ method: String(init?.method), path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (reply === 'offline') throw new TypeError('network down');
    return new Response(JSON.stringify(reply.body ?? { optIn: false, state: 'closed', scoresShared: true, events: [] }), { status: reply.status });
  }) as unknown as typeof fetch;
  return { store, calls, deps: { storage: store.storage, fetch: fetchFn, apiUrl: 'http://api.test', locale: 'en' as const, random: globalThis.crypto } };
}

describe('the phone\'s note of the anonymous statistics choice', () => {
  it('reads as off until it is saved, as saved after, and as off for a damaged value', async () => {
    const { storage, data } = memoryStorage();
    expect(await loadOutcomeStatistics(storage)).toBe(false);
    await saveOutcomeStatistics(storage, true);
    expect(await loadOutcomeStatistics(storage)).toBe(true);
    await saveOutcomeStatistics(storage, false);
    expect(await loadOutcomeStatistics(storage)).toBe(false);
    data.set(KEYS.outcomeStatistics, { optIn: 'yes' });
    expect(await loadOutcomeStatistics(storage)).toBe(false);
  });

  it('is kept apart from the equity choice, so neither can turn the other on', async () => {
    const { storage } = memoryStorage({ [KEYS.equity]: { optIn: true, buckets: {} } });
    expect(await loadOutcomeStatistics(storage)).toBe(false);
    await saveOutcomeStatistics(storage, true);
    expect(await storage.get(KEYS.equity)).toEqual({ optIn: true, buckets: {} });
  });

  it('is removed by the wipe like every other key', async () => {
    const { storage, data } = memoryStorage();
    await saveOutcomeStatistics(storage, true);
    await storage.clear();
    expect(data.has(KEYS.outcomeStatistics)).toBe(false);
  });
});

describe('turning the choice off', () => {
  it('asks the server first, with exactly the choice and nothing else, and then notes it on the phone', async () => {
    const { deps, calls, store } = server({ status: 200 });
    await saveOutcomeStatistics(store.storage, true);
    expect(await turnOffOutcomeStatistics(deps)).toBe('done');
    expect(calls).toEqual([{ method: 'PUT', path: '/me/outcome-statistics', body: { optIn: false } }]);
    expect(await loadOutcomeStatistics(store.storage)).toBe(false);
  });

  it.each([
    ['the server cannot be reached', 'offline' as const],
    ['the server fails', { status: 503 }],
    ['the server refuses', { status: 400 }],
  ])('leaves the choice on, on the phone, when %s', async (_name, reply) => {
    const { deps, store } = server(reply);
    await saveOutcomeStatistics(store.storage, true);
    expect(await turnOffOutcomeStatistics(deps)).toBe('failed');
    expect(await loadOutcomeStatistics(store.storage)).toBe(true);
  });

  it('is done when the server stopped counting even though the phone could not note it', async () => {
    const { deps, store } = server({ status: 200 });
    await saveOutcomeStatistics(store.storage, true);
    // Only the note fails to save: the device's own identity still can, or the call would not be made at all.
    const storage = { ...store.storage, set: (key: string, value: unknown) => (key === KEYS.outcomeStatistics ? Promise.reject(new Error('storage write failed')) : store.storage.set(key, value)) };
    expect(await turnOffOutcomeStatistics({ ...deps, storage })).toBe('done');
    expect(await loadOutcomeStatistics(store.storage)).toBe(true);
  });
});

describe('what the repeat check sends', () => {
  const SCORES = [{ instrument: 'phq9' as const, total: 7, band: 'mild', takenAt: '2026-12-21T09:00:00+04:00' }];

  it('adds the choice only when it is given, so a request without totals says nothing about it', async () => {
    const without = server({ status: 200 });
    await sendRemeasure(without.deps, TICKET_ID, []);
    expect(without.calls[0]!.body).toEqual({ scores: [] });
    const on = server({ status: 200 });
    await sendRemeasure(on.deps, TICKET_ID, SCORES, true);
    expect(on.calls[0]!.body).toEqual({ scores: SCORES, statisticsOptIn: true });
    const off = server({ status: 200 });
    await sendRemeasure(off.deps, TICKET_ID, SCORES, false);
    expect(off.calls[0]!.body).toEqual({ scores: SCORES, statisticsOptIn: false });
  });
});

describe('finishing the repeat check keeps the phone\'s note of the choice honest about what the server may hold', () => {
  const SCORES = [{ instrument: 'phq9' as const, total: 7, band: 'mild', takenAt: '2026-12-21T09:00:00+04:00' }];
  const noteOf = async (store: ReturnType<typeof memoryStorage>) => loadOutcomeStatistics(store.storage);
  /** The same store with writes of the note refused, so the identity and everything else still save. */
  const refusingNote = (store: ReturnType<typeof memoryStorage>) => ({ ...store.storage, set: (key: string, value: unknown) => (key === KEYS.outcomeStatistics ? Promise.reject(new Error('storage write failed')) : store.storage.set(key, value)) });

  it('writes the note before a send that carries true, and keeps it when the reply is lost, since the server may have turned it on', async () => {
    const { deps, store, calls } = server('offline');
    expect(await finishRepeatCheck(deps, TICKET_ID, SCORES, true)).toBe('failed');
    expect(calls).toHaveLength(1);
    expect(await noteOf(store)).toBe(true);
  });

  it('keeps the note true when the server answers 200 with something that cannot be read', async () => {
    const { deps, store } = server({ status: 200, body: { nope: true } });
    expect(await finishRepeatCheck(deps, TICKET_ID, SCORES, true)).toBe('failed');
    expect(await noteOf(store)).toBe(true);
  });

  it('keeps the note true when the server fails', async () => {
    const { deps, store } = server({ status: 503 });
    expect(await finishRepeatCheck(deps, TICKET_ID, SCORES, true)).toBe('failed');
    expect(await noteOf(store)).toBe(true);
  });

  it('sends nothing, and says so, when the note cannot be written before a send that carries true', async () => {
    const { deps, store, calls } = server({ status: 200 });
    expect(await finishRepeatCheck({ ...deps, storage: refusingNote(store) }, TICKET_ID, SCORES, true)).toBe('note_failed');
    expect(calls).toEqual([]);
    expect(await noteOf(store)).toBe(false);
  });

  it('keeps the note true even when the server refuses (409), since another tab may have turned the choice on there', async () => {
    for (const before of [false, true]) {
      const { deps, store } = server({ status: 409 });
      await saveOutcomeStatistics(store.storage, before);
      expect(await finishRepeatCheck(deps, TICKET_ID, SCORES, true)).toBe('not_ready');
      expect(await noteOf(store), `was ${before}`).toBe(true);
    }
  });

  it('keeps the note true when a send that carries true is confirmed', async () => {
    const { deps, store } = server({ status: 200 });
    expect(await finishRepeatCheck(deps, TICKET_ID, SCORES, true)).toBe('done');
    expect(await noteOf(store)).toBe(true);
  });

  it('clears the note only on a confirmed send that carries false', async () => {
    const { deps, store, calls } = server({ status: 200 });
    await saveOutcomeStatistics(store.storage, true);
    expect(await finishRepeatCheck(deps, TICKET_ID, SCORES, false)).toBe('done');
    expect((calls[0]!.body as { statisticsOptIn: boolean }).statisticsOptIn).toBe(false);
    expect(await noteOf(store)).toBe(false);
  });

  it.each([
    ['the reply is lost', 'offline' as const],
    ['the server answers something that cannot be read', { status: 200, body: { nope: true } }],
    ['the server refuses', { status: 409 }],
    ['the server fails', { status: 503 }],
  ])('leaves the note as it was when a send that carries false gets no confirmation: %s', async (_name, reply) => {
    const { deps, store } = server(reply);
    await saveOutcomeStatistics(store.storage, true);
    await finishRepeatCheck(deps, TICKET_ID, SCORES, false);
    expect(await noteOf(store)).toBe(true);
  });

  it('leaves the note true, so Settings can still turn it off, when a confirmed send of false cannot clear it', async () => {
    const { deps, store } = server({ status: 200 });
    await saveOutcomeStatistics(store.storage, true);
    expect(await finishRepeatCheck({ ...deps, storage: refusingNote(store) }, TICKET_ID, SCORES, false)).toBe('done');
    expect(await noteOf(store)).toBe(true);
  });

  it('does not touch the note, and sends no choice, when the totals are not sent', async () => {
    const { deps, store, calls } = server({ status: 200 });
    await saveOutcomeStatistics(store.storage, true);
    expect(await finishRepeatCheck(deps, TICKET_ID, [], undefined)).toBe('done');
    expect(calls[0]!.body).toEqual({ scores: [] });
    expect(await noteOf(store)).toBe(true);
  });
});

describe('the box beside the totals', () => {
  const ticket = { consents: [{ id: 'c', element: 'ticket', recipient: 'x', grantedAt: '2026-10-01T08:00:00+04:00', revokedAt: null }] } as unknown as PersonTicketView;
  const screening = (instrument: 'phq9' | 'gad7'): Screening => ({ id: instrument, instrument, answers: [], total: 3, band: 'mild', item9Flag: false, takenAt: '2026-12-21T09:00:00+04:00' }) as Screening;
  const render = (locale: 'ar' | 'en', share: boolean, statistics: boolean, shared = ticket) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
        <Totals
          check={{ phq9: screening('phq9'), gad7: screening('gad7') }}
          ticket={shared}
          bandNames={{ mild: 'mild' }}
          names={{ phq9: 'PHQ-9', gad7: 'GAD-7' }}
          share={share}
          setShare={() => undefined}
          statistics={statistics}
          setStatistics={() => undefined}
          send="idle"
          onFinish={() => undefined}
        />
      </NextIntlClientProvider>,
    );
  /** The tag of the statistics box, with its attributes. */
  const box = (html: string) => /<input[^>]*data-control="count-in-statistics"[^>]*>/.exec(html)?.[0] ?? '';

  it.each(['en', 'ar'] as const)('is unticked and disabled by default in %s, and says it in its own words', (locale) => {
    const html = render(locale, false, false);
    expect(box(html)).toContain('disabled');
    expect(box(html)).not.toContain('checked');
    expect(html).toContain(MESSAGES[locale].remeasure.statisticsLabel);
    expect(html).toContain(MESSAGES[locale].remeasure.statisticsHelp);
  });

  it.each(['en', 'ar'] as const)('is available but still unticked once the totals are to be sent, in %s', (locale) => {
    const tag = box(render(locale, true, false));
    expect(tag).not.toContain('disabled');
    expect(tag).not.toContain('checked');
  });

  it.each(['en', 'ar'] as const)('shows ticked only with the totals to be sent, and unticked and disabled again when they are not, in %s', (locale) => {
    expect(box(render(locale, true, true))).toContain('checked');
    expect(box(render(locale, true, true))).not.toContain('disabled');
    const withoutTotals = box(render(locale, false, true));
    expect(withoutTotals).toContain('disabled');
    expect(withoutTotals).not.toContain('checked');
  });

  it.each(['en', 'ar'] as const)('tells the person nothing was sent when the phone could not keep its note of the choice, in %s', (locale) => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
        <Totals
          check={{ phq9: screening('phq9'), gad7: screening('gad7') }}
          ticket={ticket}
          bandNames={{ mild: 'mild' }}
          names={{ phq9: 'PHQ-9', gad7: 'GAD-7' }}
          share
          setShare={() => undefined}
          statistics
          setStatistics={() => undefined}
          send="note_failed"
          onFinish={() => undefined}
        />
      </NextIntlClientProvider>,
    );
    expect(html).toContain(MESSAGES[locale].remeasure.statisticsNoteFailed);
    expect(html).toContain('data-note-failed');
    expect(render(locale, true, true)).not.toContain('data-note-failed');
  });

  it('is not offered when the share with the clinic has ended, since there is nothing to count', () => {
    const ended = { consents: [{ id: 'c', element: 'ticket', recipient: 'x', grantedAt: '2026-10-01T08:00:00+04:00', revokedAt: '2026-10-02T08:00:00+04:00' }] } as unknown as PersonTicketView;
    expect(render('en', false, false, ended)).not.toContain('count-in-statistics');
  });

  it.each(['en', 'ar'] as const)('says the totals count only in groups of 10 or more and that a clinic never sees the choice, in %s', (locale) => {
    const help = MESSAGES[locale].remeasure.statisticsHelp;
    expect(help).toContain('10');
    expect(help).toContain(locale === 'en' ? 'ever sees this choice' : 'هذا الاختيار أبدًا');
    expect(help).toContain(locale === 'en' ? 'anonymous group figures' : 'مجمّعة مجهولة');
    expect(help, 'covers every referral, not only this one').toContain(locale === 'en' ? 'all your referrals' : 'جميع إحالاتك');
    expect(help, 'says the scope in so many words').toContain(locale === 'en' ? 'every total you have sent or will send your clinics' : 'كل مجموع أرسلته أو سترسله إلى عياداتك');
    expect(MESSAGES[locale].remeasure.statisticsLabel, 'the label says it too').toContain(locale === 'en' ? 'every total I have sent or will send my clinics' : 'كل مجموع أرسلته أو سأرسله إلى عياداتي');
    if (locale === 'ar') expect(help).toMatch(/[؀-ۿ]/);
  });
});

describe('Settings\' note on the choice', () => {
  const render = (locale: 'ar' | 'en', on: boolean, state: StatisticsState) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
        <OutcomeStatisticsPanel on={on} state={state} onTurnOff={() => undefined} />
      </NextIntlClientProvider>,
    );

  it.each(['en', 'ar'] as const)('shows nothing while the choice is off, which is the default, in %s', (locale) => {
    expect(render(locale, false, 'idle')).toBe('');
    expect(render(locale, false, 'working')).toBe('');
  });

  it.each(['en', 'ar'] as const)('says it is on, in its own words, with one button that turns it off, in %s', (locale) => {
    const html = render(locale, true, 'idle');
    expect(html).toContain(MESSAGES[locale].settings.statisticsTitle);
    expect(html).toContain(MESSAGES[locale].settings.statisticsOnBody);
    expect(html).toContain(MESSAGES[locale].settings.statisticsOptOut);
    expect(html.match(/<button/g)).toHaveLength(1);
    const body = MESSAGES[locale].settings.statisticsOnBody;
    expect(body).toContain('10');
    expect(body).toContain(locale === 'en' ? 'ever sees this choice' : 'هذا الاختيار أبدًا');
    expect(body, 'covers every referral').toContain(locale === 'en' ? 'all your referrals' : 'جميع إحالاتك');
    expect(body, 'says the scope in so many words').toContain(locale === 'en' ? 'every total you have sent or will send your clinics' : 'كل مجموع أرسلته أو سترسله إلى عياداتك');
    expect(html, 'says the choice turns itself off when the phone is not used').toContain(MESSAGES[locale].settings.optInIdleNote);
  });

  it('turns off and confirms in the same all-referrals scope, with no two-totals wording, in both languages', () => {
    expect(en.settings.statisticsOptOut).toBe('Stop counting my totals');
    expect(en.settings.statisticsRemoved).toBe('Your totals no longer count in anonymous statistics.');
    expect(ar.settings.statisticsOptOut).toBe('أوقف احتساب مجاميعي');
    expect(ar.settings.statisticsRemoved).toBe('لم تعد مجاميعك تُحتسب في الإحصاءات المجهولة.');
    for (const text of [ar.settings.statisticsOptOut, ar.settings.statisticsRemoved, ar.settings.statisticsOnBody, ar.remeasure.statisticsLabel, ar.remeasure.statisticsHelp]) expect(text).not.toMatch(/هذين|مجموعاك|مجموعين|المجموعين/);
    for (const text of [en.settings.statisticsOptOut, en.settings.statisticsRemoved, en.settings.statisticsOnBody]) expect(text).not.toMatch(/these two|both totals|two totals/i);
  });

  it.each(['en', 'ar'] as const)('says nothing about turning itself off while the choice is off or just turned off, in %s', (locale) => {
    expect(render(locale, false, 'removed')).not.toContain(MESSAGES[locale].settings.optInIdleNote);
  });

  it.each(['en', 'ar'] as const)('says it was turned off, with no button, and says when turning it off failed with the button still there, in %s', (locale) => {
    const removed = render(locale, false, 'removed');
    expect(removed).toContain(MESSAGES[locale].settings.statisticsRemoved);
    expect(removed).not.toContain('<button');
    const failed = render(locale, true, 'failed');
    expect(failed).toContain(MESSAGES[locale].settings.statisticsFailed);
    expect(failed).toContain('<button');
  });

  it.each(['en', 'ar'] as const)('says, in %s, why a choice was turned off while the phone was idle, in the words of the other Settings notes', (locale) => {
    const settings = MESSAGES[locale].settings;
    const notes = [settings.optInsClearedEquity, settings.optInsClearedStatistics, settings.optInsClearedBoth];
    for (const note of notes) {
      expect(note, 'names the six months of the idle limit, written as the existing note writes it').toContain(locale === 'en' ? '6 months' : '6 أشهر');
      expect(note, 'says it was turned off').toContain(locale === 'en' ? 'turned off' : 'أُوقف');
      expect(note, 'says the person can turn it on again').toMatch(locale === 'en' ? /turn (it|either) on again/ : /من جديد/);
      expect(note, 'no clinical words').not.toMatch(locale === 'en' ? /\b(score|band|depress|anxi|PHQ|GAD|crisis|diagnos)/i : /(درجة|اكتئاب|قلق|أزمة|تشخيص)/);
    }
    expect(settings.optInsClearedEquity).toContain(locale === 'en' ? 'group totals' : 'مجاميع المجموعات');
    expect(settings.optInsClearedStatistics).toContain(locale === 'en' ? 'anonymous statistics' : 'الإحصاءات المجهولة');
    expect(settings.optInsClearedBoth).toContain(locale === 'en' ? 'group totals' : 'مجاميع المجموعات');
    expect(settings.optInsClearedBoth).toContain(locale === 'en' ? 'anonymous statistics' : 'الإحصاءات المجهولة');
    if (locale === 'ar') for (const note of notes) expect(note).toMatch(/[؀-ۿ]/);
  });

  it('has the same keys in both languages and Arabic text in Arabic script', () => {
    const keys = (section: Record<string, unknown>) => Object.keys(section).filter((key) => key.startsWith('statistic')).sort();
    expect(keys(ar.settings)).toEqual(keys(en.settings));
    expect(keys(ar.remeasure)).toEqual(keys(en.remeasure));
    expect(keys(en.settings)).toHaveLength(5);
    expect(ar.settings.optInIdleNote).toMatch(/[؀-ۿ]/);
    expect(en.settings.optInIdleNote).toContain('6 months');
    expect(keys(en.remeasure)).toHaveLength(3);
    for (const text of [ar.settings.statisticsTitle, ar.settings.statisticsOnBody, ar.remeasure.statisticsLabel, ar.remeasure.statisticsHelp]) expect(text).toMatch(/[؀-ۿ]/);
  });
});

describe('the choice never travels with what a clinic receives', () => {
  const read = (...parts: string[]) => readFileSync(join(__dirname, '..', ...parts), 'utf8');

  it('is named by no module that builds or sends a referral, a consent, a bundle or a summary', () => {
    for (const file of ['lib/send-referral.ts', 'lib/share.ts', 'lib/summary.ts', 'lib/prefs.ts', 'components/ConsentScreen.tsx']) {
      let source: string;
      try {
        source = read(file);
      } catch {
        continue;
      }
      expect(source, file).not.toMatch(/outcome-?statistic|statisticsOptIn|outcomeStat/i);
    }
  });

  it('is stored under its key by one module and put in a request body by one other, and no other module touches either', () => {
    const found: string[] = [];
    for (const dir of ['lib', 'components']) {
      for (const name of readdirSync(join(__dirname, '..', dir))) {
        if (/KEYS\.outcomeStatistics|statisticsOptIn/.test(read(dir, name))) found.push(`${dir}/${name}`);
      }
    }
    expect(found.sort()).toEqual(['lib/outcome-statistics.ts', 'lib/remeasure.ts']);
  });
});
