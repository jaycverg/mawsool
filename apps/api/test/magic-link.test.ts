import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { MAGIC_LINK_TTL_MS } from '../src/routes/auth';
import { sha256Hex } from '../src/security';
import { runSeed } from '../src/seed/run';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';

const EMAIL = 'clinician.a@demo.mawsool.test';

describe('staff magic-link sign-in', () => {
  let testDb: TestDb;
  let ctx: TestApp;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db);
    ctx = await createTestApp(testDb.db);
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const requestLink = (email = EMAIL) => ctx.app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const verify = (token: string) => ctx.app.inject({ method: 'POST', url: '/auth/verify', payload: { token } });

  it('hands the link to the notifier, which logs it and sends nothing else', async () => {
    const before = ctx.notifier.sent.length;
    expect((await requestLink()).statusCode).toBe(202);
    expect(ctx.notifier.sent).toHaveLength(before + 1);
    const message = ctx.notifier.sent.at(-1)!;
    expect(message.to).toBe(EMAIL);
    expect(message.link).toMatch(/^http:\/\/localhost:3001\/en\/sign-in\/\?token=[A-Za-z0-9_-]{43}$/);
  });

  it('stores only the hash of the token, never the token', async () => {
    await requestLink();
    const token = ctx.notifier.lastToken();
    const rows = await testDb.db.select().from(schema.staffMagicLinks);
    expect(rows.some((row) => row.tokenHash === sha256Hex(token))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('works once: the second use of the same link is refused', async () => {
    await requestLink();
    const token = ctx.notifier.lastToken();
    const first = await verify(token);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ role: 'clinician' });
    const second = await verify(token);
    expect(second.statusCode).toBe(401);
    expect(second.json().error).toBe('invalid_link');
  });

  it('stays valid for 14 minutes 59 seconds and is refused from 15 minutes', async () => {
    await requestLink();
    const token = ctx.notifier.lastToken();
    ctx.clock.advance(MAGIC_LINK_TTL_MS - 1000);
    const early = await verify(token);
    expect(early.statusCode).toBe(200);

    await requestLink();
    const lateToken = ctx.notifier.lastToken();
    ctx.clock.advance(MAGIC_LINK_TTL_MS);
    expect((await verify(lateToken)).statusCode).toBe(401);
  });

  it('records the 15-minute expiry on the row', async () => {
    await requestLink();
    const [row] = await testDb.db
      .select()
      .from(schema.staffMagicLinks)
      .where(eq(schema.staffMagicLinks.tokenHash, sha256Hex(ctx.notifier.lastToken())));
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(15 * 60 * 1000);
    expect(row!.usedAt).toBeNull();
  });

  it('refuses a token it never issued', async () => {
    expect((await verify('x'.repeat(43))).statusCode).toBe(401);
  });

  it('answers 202 for an unknown address and sends no link, so accounts cannot be discovered', async () => {
    const before = ctx.notifier.sent.length;
    const res = await requestLink('nobody@demo.mawsool.test');
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted' });
    expect(ctx.notifier.sent).toHaveLength(before);
  });

  it('matches the address regardless of case', async () => {
    const before = ctx.notifier.sent.length;
    await requestLink('Clinician.A@Demo.Mawsool.Test');
    expect(ctx.notifier.sent).toHaveLength(before + 1);
  });

  it('sends no link to a deactivated user', async () => {
    await testDb.db.update(schema.staffUsers).set({ active: false }).where(eq(schema.staffUsers.email, EMAIL));
    try {
      const before = ctx.notifier.sent.length;
      expect((await requestLink()).statusCode).toBe(202);
      expect(ctx.notifier.sent).toHaveLength(before);
    } finally {
      await testDb.db.update(schema.staffUsers).set({ active: true }).where(eq(schema.staffUsers.email, EMAIL));
    }
  });

  it('refuses a link issued before the user was deactivated', async () => {
    await requestLink();
    const token = ctx.notifier.lastToken();
    await testDb.db.update(schema.staffUsers).set({ active: false }).where(eq(schema.staffUsers.email, EMAIL));
    try {
      expect((await verify(token)).statusCode).toBe(401);
    } finally {
      await testDb.db.update(schema.staffUsers).set({ active: true }).where(eq(schema.staffUsers.email, EMAIL));
    }
  });

  it('still answers 202 when delivery fails, and says nothing about it to the caller', async () => {
    ctx.notifier.failWith = new Error('smtp down');
    try {
      const res = await requestLink();
      expect(res.statusCode).toBe(202);
      expect(res.body).not.toContain('smtp');
    } finally {
      ctx.notifier.failWith = null;
    }
  });

  it('rejects a malformed address and a missing token with 400', async () => {
    expect((await requestLink('not-an-email')).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: '/auth/verify', payload: {} })).statusCode).toBe(400);
  });

  it('lets only one of two simultaneous verifications of the same link succeed', async () => {
    await requestLink();
    const token = ctx.notifier.lastToken();
    const results = await Promise.all([verify(token), verify(token)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });
});
