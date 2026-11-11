import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Writable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { schema } from '../src/db/client';
import { loadConfig } from '../src/config';
import {
  NOTIFIER_DRIVERS,
  TEMPLATES,
  TEMPLATE_KEYS,
  createConsoleDriver,
  createDriver,
  createLogDriver,
  createNotifier,
  recipientRef,
  renderMessage,
  templateLocale,
  type OutboundMessage,
} from '../src/notifier';
import { runSeed } from '../src/seed/run';
import { createTestApp, signIn, type TestApp } from './helpers/app';
import { TEST_CONFIG, TEST_ENCRYPTION_KEY } from './helpers/config';
import { createTestDb, type TestDb } from './helpers/db';
import { registerPerson } from './helpers/flow';

const KEY = TEST_ENCRYPTION_KEY;
const PHONE = '+971509990123';
const EXPIRES = new Date('2026-11-01T08:15:00Z');
/** The random id of a stored number's row, which is all a reminder record names its recipient by. */
const ROW = '0b1c2d3e-4f50-4a60-8b70-9c8d7e6f5a4b';

const messages: Record<(typeof TEMPLATE_KEYS)[number], OutboundMessage> = {
  staff_sign_in: { template: 'staff_sign_in', locale: 'en', to: 'ops@demo.mawsool.test', link: 'http://ops.test/en/sign-in/?token=abc', expiresAt: EXPIRES },
  clinic_link: { template: 'clinic_link', locale: 'en', facility: 'Sample Clinic', ticketCode: 'MW1234', link: 'http://clinic.test/en/clinic-link/#id.token', expiresAt: EXPIRES },
  reminder_text: { template: 'reminder_text', locale: 'ar', to: PHONE, recipientId: ROW },
};

/** Both drivers, with what each one wrote collected as text. */
function drivers() {
  const logged: { fields: Record<string, unknown>; message: string }[] = [];
  const printed: string[] = [];
  return {
    logged,
    printed,
    log: createLogDriver({ info: (fields, message) => void logged.push({ fields, message }) }, KEY),
    console: createConsoleDriver((line) => void printed.push(line), KEY),
    everything: () => JSON.stringify(logged) + printed.join(''),
  };
}

describe('the drivers', () => {
  it('has exactly two, a console driver and a log driver, and both say they are mocks', () => {
    expect([...NOTIFIER_DRIVERS]).toEqual(['console', 'log']);
    const d = drivers();
    expect(d.log.label).toMatch(/mock: nothing is sent/);
    expect(d.console.label).toMatch(/mock: nothing is sent/);
  });

  it('log driver: writes one structured record per message through the logger, with the template, language, channel, a recipient reference and that it is a mock', async () => {
    const d = drivers();
    await createNotifier(d.log).send(messages.reminder_text);
    expect(d.logged).toHaveLength(1);
    expect(d.logged[0]).toEqual({
      message: 'text reminder sample (mock: nothing sent)',
      fields: { driver: 'log', mock: true, template: 'reminder_text', locale: 'ar', channel: 'sms', recipientRef: recipientRef(ROW, KEY) },
    });
  });

  it('console driver: prints one readable line per message with the same record, and writes nothing through the logger', async () => {
    const d = drivers();
    await createNotifier(d.console).send(messages.reminder_text);
    expect(d.printed).toHaveLength(1);
    expect(d.printed[0]).toBe(`[mock notifier] text reminder sample (mock: nothing sent): driver=console mock=true template=reminder_text locale=ar channel=sms recipientRef=${recipientRef(ROW, KEY)}\n`);
    expect(d.logged).toEqual([]);
  });

  it('keeps the staff sign-in link logged, on purpose, in both drivers, with the address and the expiry, as the presenter and the end-to-end run read it', async () => {
    const d = drivers();
    await createNotifier(d.log).send(messages.staff_sign_in);
    expect(d.logged[0]).toMatchObject({
      message: 'staff sign-in link (logged, not sent)',
      fields: { template: 'staff_sign_in', channel: 'staff_link', to: 'ops@demo.mawsool.test', link: 'http://ops.test/en/sign-in/?token=abc', expiresAt: '2026-11-01T08:15:00.000Z', mock: true },
    });
    await createNotifier(d.console).send(messages.staff_sign_in);
    expect(d.printed[0]).toContain('link=http://ops.test/en/sign-in/?token=abc');
    expect(d.printed[0]).toContain('to=ops@demo.mawsool.test');
  });

  it('keeps the clinic link logged, on purpose, in both drivers, with the facility, the ticket code, the link and the expiry', async () => {
    const d = drivers();
    await createNotifier(d.log).send(messages.clinic_link);
    expect(d.logged[0]).toMatchObject({
      message: 'clinic link (logged, not sent)',
      fields: { template: 'clinic_link', channel: 'clinic_link', facility: 'Sample Clinic', ticketCode: 'MW1234', link: 'http://clinic.test/en/clinic-link/#id.token', expiresAt: '2026-11-01T08:15:00.000Z' },
    });
    await createNotifier(d.console).send(messages.clinic_link);
    expect(d.printed[0]).toContain('link=http://clinic.test/en/clinic-link/#id.token');
    expect(d.printed[0]).toContain('ticketCode=MW1234');
  });

  it('never writes a phone number or the text of a reminder, in either driver, in either language', async () => {
    for (const locale of ['ar', 'en', 'fr', null]) {
      const d = drivers();
      const message: OutboundMessage = { template: 'reminder_text', locale, to: PHONE, recipientId: ROW };
      const body = renderMessage(message).body;
      await createNotifier(d.log).send(message);
      await createNotifier(d.console).send(message);
      const written = d.everything();
      expect(written, String(locale)).not.toContain(PHONE);
      expect(written).not.toContain(PHONE.slice(1));
      expect(written).not.toContain(PHONE.slice(-7));
      expect(written).not.toContain(body);
      for (const word of body.split(/\s+/).filter((w) => w.length > 4)) expect(written, word).not.toContain(word);
      expect(d.logged[0]!.fields).not.toHaveProperty('to');
      expect(d.logged[0]!.fields).not.toHaveProperty('body');
    }
  });

  it('makes a recipient reference that is the same for the same row, differs for another row, depends on the key and does not contain the row id', () => {
    const a = recipientRef(ROW, KEY);
    expect(a).toMatch(/^rcp_[0-9a-f]{12}$/);
    expect(recipientRef(ROW, KEY)).toBe(a);
    expect(recipientRef('a0b1c2d3-4e5f-4a6b-8c7d-9e8f7a6b5c4d', KEY)).not.toBe(a);
    expect(recipientRef(ROW, Buffer.alloc(32, 8).toString('base64'))).not.toBe(a);
    expect(a).not.toContain(ROW.slice(0, 8));
  });

  it('never derives a reminder record\'s reference from the number: not a hash of it under the key, and the same whatever number the row holds', async () => {
    const reference = async (to: string) => {
      const d = drivers();
      await createNotifier(d.log).send({ template: 'reminder_text', locale: 'en', to, recipientId: ROW });
      return d.logged[0]!.fields['recipientRef'];
    };
    const first = await reference(PHONE);
    // Another number in the same row: the same reference, so nothing in it depends on the number.
    expect(await reference('+971509990124')).toBe(first);
    // Not the keyed hash of any number: a holder of the key who enumerates numbers finds none that matches.
    const candidates = Array.from({ length: 2000 }, (_unused, i) => `+97150999${String(i).padStart(4, '0')}`);
    expect(candidates.map((number) => recipientRef(number, KEY))).not.toContain(first);
    expect(first).not.toBe(recipientRef(PHONE, KEY));
    // A row that was deleted and made again is a new reference: it maps to nothing that was written before.
    const again = drivers();
    await createNotifier(again.log).send({ template: 'reminder_text', locale: 'en', to: PHONE, recipientId: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a' });
    expect(again.logged[0]!.fields['recipientRef']).not.toBe(first);
  });

  it('writes no recipient reference for the staff sign-in link or the clinic link, whose address, facility and ticket code are written on purpose', async () => {
    const d = drivers();
    await createNotifier(d.log).send(messages.staff_sign_in);
    await createNotifier(d.log).send(messages.clinic_link);
    for (const record of d.logged) expect(record.fields).not.toHaveProperty('recipientRef');
  });

  it('sends nothing: no driver opens a connection', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const d = drivers();
    for (const message of Object.values(messages)) {
      await createNotifier(d.log).send(message);
      await createNotifier(d.console).send(message);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('builds the driver a name asks for', async () => {
    const lines: string[] = [];
    const info = vi.fn();
    await createNotifier(createDriver('console', { log: { info }, encryptionKey: KEY, write: (line) => void lines.push(line) })).send(messages.reminder_text);
    expect([lines.length, info.mock.calls.length]).toEqual([1, 0]);
    await createNotifier(createDriver('log', { log: { info }, encryptionKey: KEY, write: (line) => void lines.push(line) })).send(messages.reminder_text);
    expect([lines.length, info.mock.calls.length]).toEqual([1, 1]);
  });
});

describe('the templates', () => {
  const sample = (key: (typeof TEMPLATE_KEYS)[number], locale: string | null): OutboundMessage => ({ ...messages[key], locale }) as OutboundMessage;

  for (const key of TEMPLATE_KEYS) {
    for (const locale of ['ar', 'en'] as const) {
      it(`${key} reads in ${locale}: the right language, the right channel, and the link or the number is where it belongs`, () => {
        const rendered = renderMessage(sample(key, locale));
        expect(rendered).toMatchObject({ template: key, locale, channel: TEMPLATES[key].channel });
        expect(rendered.body.trim()).not.toBe('');
        if (locale === 'ar') expect(rendered.body).toMatch(/[؀-ۿ]/);
        else expect(rendered.body).not.toMatch(/[؀-ۿ]/);
        if (key === 'reminder_text') expect(rendered.body).not.toContain(PHONE);
        else expect(rendered.body).toContain((messages[key] as { link: string }).link);
      });
    }

    it(`${key} falls back to English for a language that is not Arabic or English, and for none`, () => {
      const english = renderMessage(sample(key, 'en')).body;
      for (const locale of ['fr', 'ur', '', null, undefined]) expect(renderMessage(sample(key, locale as string | null)), String(locale)).toMatchObject({ locale: 'en', body: english });
    });
  }

  it('picks the language by the recipient, and only ever Arabic or English', () => {
    expect(templateLocale('ar')).toBe('ar');
    expect(templateLocale('en')).toBe('en');
    expect(templateLocale('hi')).toBe('en');
    expect(templateLocale(undefined)).toBe('en');
  });

  describe('carry no clinical content', () => {
    // Words that would tell a bystander reading a lock screen something about a person's health or care (the same lists the
    // app's own reminder is held to), and any digit.
    const PERSON_EN = /\b(score|scores|result|results|band|phq|gad|who-5|depress\w*|anxi\w*|mood|crisis|suicid\w*|risk|therap\w*|treat\w*|clinic\w*|doctor|diagnos\w*|referral|ticket|service|symptom\w*|mental|instrument\w*|condition\w*)\b|\d/i;
    const PERSON_AR = /(نتيج|نتائج|درج|اكتئاب|قلق|مزاج|أزم|انتحار|خطر|علاج|عياد|طبيب|تشخيص|إحالة|تذكرة|خدمة|أعراض|نفس|أداة|حالة|PHQ|GAD|WHO)|\d/i;
    // A message to staff names the ticket and the facility (it has to), but still no score, band, instrument, condition or crisis wording.
    const STAFF_EN = /\b(score|scores|result|results|band|phq|gad|who-5|depress\w*|anxi\w*|mood|crisis|suicid\w*|risk|diagnos\w*|symptom\w*|mental|instrument\w*|condition\w*)\b/i;
    const STAFF_AR = /(نتيج|نتائج|درج|اكتئاب|قلق|مزاج|أزم|انتحار|خطر|تشخيص|أعراض|أداة|PHQ|GAD|WHO)/i;

    for (const key of TEMPLATE_KEYS) {
      for (const [locale, person, staff] of [['en', PERSON_EN, STAFF_EN], ['ar', PERSON_AR, STAFF_AR]] as const) {
        it(`${key} in ${locale}`, () => {
          const message = key === 'reminder_text' ? { ...messages[key], locale } : ({ ...messages[key], locale } as OutboundMessage);
          // What a recipient would read around the link: the template with the link, the address and the expiry taken out.
          const text = renderMessage(message).body.replace(/https?:\/\/\S+/g, '').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '').replace(/MW\d+/g, '');
          expect(text, key).not.toMatch(TEMPLATES[key].personFacing ? person : staff);
        });
      }
    }

    it('catches clinical wording, so the checks above are not vacuous', () => {
      for (const bad of ['Your PHQ-9 score is high', 'Time to check your depression', 'Your clinic referral', 'Your total is 12', 'Your anxiety band', 'Your condition']) expect(bad).toMatch(PERSON_EN);
      for (const bad of ['نتيجة الفحص', 'علاج الاكتئاب', 'عيادتك', 'درجتك 12']) expect(bad).toMatch(PERSON_AR);
      for (const bad of ['Her PHQ-9 score', 'crisis follow-up', 'a depression band']) expect(bad).toMatch(STAFF_EN);
      for (const bad of ['درجة الاكتئاب', 'متابعة الأزمة']) expect(bad).toMatch(STAFF_AR);
    });

    it('holds a person-facing template to the strict list, and only the reminder is one', () => {
      expect(TEMPLATE_KEYS.filter((key) => TEMPLATES[key].personFacing)).toEqual(['reminder_text']);
    });
  });
});

describe('NOTIFIER_DRIVER', () => {
  const env = (value: string | undefined) => loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, ...(value === undefined ? {} : { NOTIFIER_DRIVER: value }) });

  it('is the log driver when unset or empty, and either named driver when set', () => {
    expect(env(undefined).notifierDriver).toBe('log');
    expect(env('').notifierDriver).toBe('log');
    expect(env('console').notifierDriver).toBe('console');
    expect(env('log').notifierDriver).toBe('log');
  });

  it('stops the API from starting for anything else, and says what the choices are', () => {
    for (const value of ['smtp', 'sms', 'Console', 'LOG', 'true', '1', 'none', ' console']) expect(() => env(value), value).toThrow(/NOTIFIER_DRIVER must be console or log/);
  });

  it('is read at startup: the app builds the driver the setting names, and a staff link reaches only that one', async () => {
    const testDb = await createTestDb();
    try {
      await runSeed(testDb.db, testDb.cipher);
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const printedLines = () => out.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes('[mock notifier]'));
      const consoleLog: string[] = [];
      const consoleApp = await buildApp({ db: testDb.db, config: { ...TEST_CONFIG, corsOrigins: [], notifierDriver: 'console' }, logger: { level: 'info', stream: new Writable({ write: (chunk, _e, done) => (consoleLog.push(String(chunk)), done()) }) } });
      await consoleApp.inject({ method: 'POST', url: '/auth/magic-link', payload: { email: 'ops@demo.mawsool.test' } });
      expect(printedLines()).toHaveLength(1);
      expect(printedLines()[0]).toContain('staff sign-in link (logged, not sent)');
      expect(consoleLog.some((line) => line.includes('staff sign-in link'))).toBe(false);

      const logged: string[] = [];
      const logApp = await buildApp({ db: testDb.db, config: { ...TEST_CONFIG, corsOrigins: [], notifierDriver: 'log' }, logger: { level: 'info', stream: new Writable({ write: (chunk, _e, done) => (logged.push(String(chunk)), done()) }) } });
      await logApp.inject({ method: 'POST', url: '/auth/magic-link', payload: { email: 'ops@demo.mawsool.test' } });
      expect(logged.some((line) => line.includes('staff sign-in link (logged, not sent)') && line.includes('"driver":"log"'))).toBe(true);
      expect(printedLines()).toHaveLength(1); // the log driver printed nothing more

      // With no driver named the app logs, as it always did.
      const unset: string[] = [];
      const defaultApp = await buildApp({ db: testDb.db, config: { ...TEST_CONFIG, corsOrigins: [] }, logger: { level: 'info', stream: new Writable({ write: (chunk, _e, done) => (unset.push(String(chunk)), done()) }) } });
      await defaultApp.inject({ method: 'POST', url: '/auth/magic-link', payload: { email: 'ops@demo.mawsool.test' } });
      expect(unset.some((line) => line.includes('"driver":"log"'))).toBe(true);
      out.mockRestore();
      for (const app of [consoleApp, logApp, defaultApp]) await app.close();
    } finally {
      await testDb.close();
    }
  });
});

describe('the reminder sample, end to end', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let lines: string[];
  const text = { en: TEMPLATES.reminder_text.text.en({ template: 'reminder_text', locale: 'en', to: PHONE, recipientId: ROW }), ar: TEMPLATES.reminder_text.text.ar({ template: 'reminder_text', locale: 'ar', to: PHONE, recipientId: ROW }) };

  beforeEach(async () => {
    testDb = await createTestDb();
    lines = [];
    const stream = new Writable({ write: (chunk, _encoding, done) => (lines.push(String(chunk)), done()) });
    ctx = await createTestApp(testDb.db);
    // The same app, with the real notifier and a logger that keeps every line, instead of the capturing one.
    await ctx.app.close();
    ctx = { ...ctx, app: await buildApp({ db: testDb.db, clock: ctx.clock, config: { ...TEST_CONFIG, corsOrigins: [], notifierDriver: 'log' }, logger: { level: 'trace', stream } }) };
  });

  afterEach(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  it('prepares a sample in the person\'s own language through the notifier, answers that nothing was sent, and writes neither the number nor the text anywhere in the log', async () => {
    for (const locale of ['ar', 'en'] as const) {
      const person = await registerPerson(ctx, locale);
      expect((await ctx.app.inject({ method: 'PUT', url: '/me/reminder-phone', headers: person.headers, payload: { phone: PHONE, intervalWeeks: 4 } })).statusCode).toBe(200);
      const before = lines.length;
      const res = await ctx.app.inject({ method: 'POST', url: '/me/reminder-phone/sample', headers: person.headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sample: true, nothingSent: true });
      const record = lines.slice(before).map((line) => JSON.parse(line) as { msg?: string; locale?: string; template?: string; recipientRef?: string }).find((entry) => entry.msg === 'text reminder sample (mock: nothing sent)');
      // The reference is the keyed hash of the stored row's own random id, never of the number.
      const [row] = await testDb.db.select({ notifyRef: schema.reminderPhones.notifyRef }).from(schema.reminderPhones).where(eq(schema.reminderPhones.personId, person.id));
      expect(record, locale).toMatchObject({ template: 'reminder_text', locale, recipientRef: recipientRef(row!.notifyRef, KEY) });
      expect(record!.recipientRef).not.toBe(recipientRef(PHONE, KEY));
      // Another number in the same row keeps the row's reference; after the row is deleted a new one gets a new reference.
      await ctx.app.inject({ method: 'PUT', url: '/me/reminder-phone', headers: person.headers, payload: { phone: '+971509990999', intervalWeeks: 2 } });
      const mark = lines.length;
      await ctx.app.inject({ method: 'POST', url: '/me/reminder-phone/sample', headers: person.headers });
      const second = lines.slice(mark).map((line) => JSON.parse(line) as { msg?: string; recipientRef?: string }).find((entry) => entry.msg === 'text reminder sample (mock: nothing sent)');
      expect(second!.recipientRef, 'the same row keeps its reference when its number changes').toBe(record!.recipientRef);
      expect((await ctx.app.inject({ method: 'DELETE', url: '/me/reminder-phone', headers: person.headers })).statusCode).toBe(200);
    }
    const everything = lines.join('');
    expect(everything).not.toContain(PHONE);
    expect(everything).not.toContain(PHONE.slice(4));
    expect(everything).not.toContain('09990999');
    expect(everything).not.toContain(text.en);
    expect(everything).not.toContain(text.ar);
    expect(everything).not.toMatch(/phone_ciphertext|v1\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/);
  });

  it('refuses a sample for a person who gave no number (404), after the number is removed, and to anyone else\'s credential, and sends nothing', async () => {
    const person = await registerPerson(ctx);
    const before = lines.length;
    expect((await ctx.app.inject({ method: 'POST', url: '/me/reminder-phone/sample', headers: person.headers })).statusCode).toBe(404);
    await ctx.app.inject({ method: 'PUT', url: '/me/reminder-phone', headers: person.headers, payload: { phone: PHONE, intervalWeeks: 2 } });
    await ctx.app.inject({ method: 'DELETE', url: '/me/reminder-phone', headers: person.headers });
    expect((await ctx.app.inject({ method: 'POST', url: '/me/reminder-phone/sample', headers: person.headers })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'POST', url: '/me/reminder-phone/sample' })).statusCode).toBe(401);
    expect(lines.slice(before).some((line) => line.includes('text reminder sample'))).toBe(false);
  });

  it('answers 502 and changes nothing when the notifier cannot deliver, without the number in the error log', async () => {
    const person = await registerPerson(ctx);
    await ctx.app.inject({ method: 'PUT', url: '/me/reminder-phone', headers: person.headers, payload: { phone: PHONE, intervalWeeks: 4 } });
    const failing = await buildApp({
      db: testDb.db,
      clock: ctx.clock,
      config: { ...TEST_CONFIG, corsOrigins: [] },
      notifier: { send: async () => Promise.reject(new Error('the channel is down')) },
    });
    const res = await failing.inject({ method: 'POST', url: '/me/reminder-phone/sample', headers: person.headers });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(PHONE);
    expect(res.json().error).toBe('not_delivered');
    await failing.close();
  });
});

describe('the staff sign-in link through the notifier', () => {
  it('reaches the notifier as its own template, in English, with the link', async () => {
    const testDb = await createTestDb();
    try {
      await runSeed(testDb.db, testDb.cipher);
      const ctx = await createTestApp(testDb.db);
      await signIn(ctx, 'ops@demo.mawsool.test');
      expect(ctx.notifier.sent.at(-1)).toMatchObject({ template: 'staff_sign_in', locale: 'en', to: 'ops@demo.mawsool.test' });
      expect(ctx.notifier.sent.at(-1)!.link).toContain('/en/sign-in/?token=');
      await ctx.app.close();
    } finally {
      await testDb.close();
    }
  });
});

describe('nothing else writes the log with a number or a reminder\'s text', () => {
  const SRC = join(import.meta.dirname, '..', 'src');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : name.endsWith('.ts') ? [join(dir, name)] : []));
  const WRITES = /(\.log\.(trace|debug|info|warn|error|fatal)\(|\blog\.(trace|debug|info|warn|error|fatal)\(|console\.(log|info|warn|error|debug)|process\.std(out|err)\.write|\bdeps\.log\b)/;
  /** Every place in the API that can write a line, outside the notifier, as `file: the line`. The notifier's own drivers are the only writers of a message. */
  const writers = () =>
    files(SRC)
      .filter((file) => !relative(SRC, file).startsWith('notifier'))
      .flatMap((file) => readFileSync(file, 'utf8').split('\n').filter((line) => WRITES.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//')).map((line) => `${relative(SRC, file)}: ${line.trim()}`));

  it('lists every writer that exists, each reviewed: job and request errors and counts, the seed and migrate command lines, and the harnesses', () => {
    expect(writers().sort()).toEqual(
      [
        "app.ts: if (status >= 500) request.log.error({ err: error }, 'request failed');",
        "clinic-links/service.ts: deps.log.error({ err: error }, 'could not issue the clinic link');",
        "cli/metric-definitions-doc.ts: console.log(`wrote ${target.pathname}`);",
        "cli/migrate.ts: console.log('migrations applied');",
        'cli/seed.ts: console.log(',
        "cli/seed.ts: console.log(`loop-closed: overall ${gap.overallRate.toFixed(1)}%, Urdu ${gap.urduRate.toFixed(1)}%, gap ${gap.gapPoints.toFixed(1)} points`);",
        'cli/serve-e2e.ts: if (/"level":(50|60)/.test(line)) process.stdout.write(line);',
        'cli/serve-e2e.ts: console.log(`e2e api ready on http://127.0.0.1:${apiPort}, inspect on http://127.0.0.1:${inspectPort}`);',
        "cli/verify-postgres.ts: const say = (message: string) => console.log(`[gate:postgres] ${message}`);",
        "cli/verify-postgres.ts: const jobs = await startJobs({ databaseUrl: gateUrl.toString(), db, clock, log: { error: console.error, info: () => undefined } as never });",
        "jobs.ts: boss.on('error', (error) => options.log.error({ err: error }, 'job queue error'));",
        "jobs.ts: if (result.marked > 0) options.log.info(result, 'tickets marked overdue');",
        "routes/auth.ts: deps.log.error({ err: error }, 'could not deliver the staff sign-in link');",
      ].sort(),
    );
  });

  it('has none of them name a phone number, a message body or a reminder', () => {
    for (const line of writers()) expect(line, line).not.toMatch(/\b(phone|body|reminder|ciphertext|number)\b/i);
  });

  it('would catch a new writer that does: the scan sees a log call', () => {
    expect("request.log.info({ phone }, 'x')").toMatch(WRITES);
    expect('console.log(body)').toMatch(WRITES);
    expect('app.log.warn(x)').toMatch(WRITES);
  });
});
