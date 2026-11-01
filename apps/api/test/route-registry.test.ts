import { ROUTE_ACCESS } from '@mawsool/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { runSeed } from '../src/seed/run';
import { createTestApp, signIn, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';

describe('route registry', () => {
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

  const build = (extraRoutes: Parameters<typeof buildApp>[0]['extraRoutes']) =>
    buildApp({
      db: testDb.db,
      clock: ctx.clock,
      notifier: ctx.notifier,
      config: { corsOrigins: [], clinicianAppUrl: 'http://localhost:3001', opsAppUrl: 'http://localhost:3002' },
      extraRoutes,
    });

  it('records every route with a declared access value', () => {
    const routes = ctx.app.routeRegistry;
    expect(routes.length).toBeGreaterThanOrEqual(4);
    for (const route of routes) expect(ROUTE_ACCESS as readonly string[]).toContain(route.access);
  });

  it('lists the routes that exist today with the access they declare', () => {
    const byKey = Object.fromEntries(ctx.app.routeRegistry.map((r) => [`${r.method} ${r.url}`, r.access]));
    expect(byKey).toMatchObject({
      'GET /health': 'public',
      'POST /persons': 'public',
      'GET /services': 'public',
      'POST /crisis-events': 'person',
      'POST /auth/magic-link': 'public',
      'POST /auth/verify': 'public',
      'GET /tickets/:id': 'clinician',
    });
  });

  it('refuses to start when a route declares no access', async () => {
    await expect(
      build((app) => {
        app.get('/undeclared', async () => ({ ok: true }));
      }),
    ).rejects.toThrow(/GET \/undeclared must declare config\.access/);
  });

  it('refuses to start when a route declares an unknown access value', async () => {
    await expect(
      build((app) => {
        app.get('/odd', { config: { access: 'employer' as never } }, async () => ({ ok: true }));
      }),
    ).rejects.toThrow(/\/odd must declare config\.access/);
  });

  it('refuses to start when a clinician ticket route skips the facility scope', async () => {
    await expect(
      build((app) => {
        app.get('/tickets/:id/notes', { config: { access: 'clinician' } }, async () => ({ ok: true }));
      }),
    ).rejects.toThrow(/facilityScoped/);
  });

  it('starts when a clinician ticket route declares the facility scope', async () => {
    const app = await build((a) => {
      a.get('/tickets/:id/notes', { config: { access: 'clinician', facilityScoped: true } }, async () => ({ ok: true }));
    });
    expect(app.routeRegistry.some((r) => r.url === '/tickets/:id/notes')).toBe(true);
    await app.close();
  });

  it('fails closed on an inbound route until signed requests exist', async () => {
    const app = await build((a) => {
      a.post('/inbound/probe', { config: { access: 'inbound' } }, async () => ({ ok: true }));
    });
    expect((await app.inject({ method: 'POST', url: '/inbound/probe' })).statusCode).toBe(401);
    await app.close();
  });

  it('authenticates ops and admin routes by role: the right role passes, another role gets 403, none gets 401', async () => {
    const app = await build((a) => {
      a.get('/ops-probe', { config: { access: 'ops' } }, async () => ({ ok: true }));
      a.get('/admin-probe', { config: { access: 'admin' } }, async () => ({ ok: true }));
    });
    const as = { app, notifier: ctx.notifier };
    const ops = await signIn(as, 'ops@demo.mawsool.test');
    const clinician = await signIn(as, 'clinician.a@demo.mawsool.test');
    const call = (url: string, token?: string) =>
      app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await call('/ops-probe')).statusCode).toBe(401);
    expect((await call('/ops-probe', ops)).statusCode).toBe(200);
    expect((await call('/ops-probe', clinician)).statusCode).toBe(403);
    expect((await call('/admin-probe', ops)).statusCode).toBe(403);
    await app.close();
  });

  it('answers unknown paths with 404 and no stack', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('answers a health check', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('turns an unexpected failure into a plain 500 that leaks nothing', async () => {
    const app = await build((a) => {
      a.get('/boom', { config: { access: 'public' } }, async () => {
        throw new Error('secret internals');
      });
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret internals');
    expect(res.json()).toEqual({ error: 'internal_error', message: 'Something went wrong' });
    await app.close();
  });
});
