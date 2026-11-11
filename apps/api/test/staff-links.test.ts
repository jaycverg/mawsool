import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { runSeed } from '../src/seed/run';
import { STAFF_LINK_LOCALE, staffAppFor, staffSignInLink } from '../src/staff-links';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { TEST_CONFIG } from './helpers/config';

const APPS = { clinician: 'http://clinic.test', ops: 'http://ops.test' };

describe('staff sign-in link target', () => {
  it('opens the clinician app for a clinician and the ops app for ops and admin', () => {
    expect(staffAppFor('clinician')).toBe('clinician');
    expect(staffAppFor('ops')).toBe('ops');
    expect(staffAppFor('admin')).toBe('ops');
    expect(staffSignInLink('clinician', 'tok', APPS)).toBe('http://clinic.test/en/sign-in/?token=tok');
    expect(staffSignInLink('ops', 'tok', APPS)).toBe('http://ops.test/en/sign-in/?token=tok');
    expect(staffSignInLink('admin', 'tok', APPS)).toBe('http://ops.test/en/sign-in/?token=tok');
    expect(STAFF_LINK_LOCALE).toBe('en');
  });

  it('url-encodes the token', () => {
    expect(staffSignInLink('ops', 'a b&c', APPS)).toBe('http://ops.test/en/sign-in/?token=a%20b%26c');
  });
});

describe('the link the API actually issues', () => {
  let testDb: TestDb;
  let ctx: TestApp;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    ctx = await createTestApp(testDb.db);
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const linkFor = async (email: string) => {
    await ctx.app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
    return ctx.notifier.sent.at(-1)!.link;
  };

  it('points a clinician at the clinician app, with a locale', async () => {
    expect(await linkFor('clinician.a@demo.mawsool.test')).toMatch(/^http:\/\/localhost:3001\/en\/sign-in\/\?token=/);
  });

  it('points ops and admin at the ops app, not the clinician app', async () => {
    expect(await linkFor('ops@demo.mawsool.test')).toMatch(/^http:\/\/localhost:3002\/en\/sign-in\/\?token=/);
    expect(await linkFor('admin@demo.mawsool.test')).toMatch(/^http:\/\/localhost:3002\/en\/sign-in\/\?token=/);
  });

  it('writes the link to the API log when no notifier is injected', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = await buildApp({
      db: testDb.db,
      clock: ctx.clock,
      config: { ...TEST_CONFIG, corsOrigins: [], clinicianAppUrl: APPS.clinician, opsAppUrl: APPS.ops },
      logger: { level: 'info', stream },
    });
    try {
      const res = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email: 'ops@demo.mawsool.test' } });
      expect(res.statusCode).toBe(202);
      const logged = lines.map((line) => JSON.parse(line)).find((entry) => entry.msg === 'staff sign-in link (logged, not sent)');
      expect(logged).toMatchObject({ to: 'ops@demo.mawsool.test' });
      expect(logged.link).toMatch(/^http:\/\/ops\.test\/en\/sign-in\/\?token=[A-Za-z0-9_-]{43}$/);
    } finally {
      await app.close();
    }
  });
});
