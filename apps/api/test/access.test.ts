import { ROUTE_ACCESS, STAFF_ROLES, type RouteAccess } from '@mawsool/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeed } from '../src/seed/run';
import { createTestApp, signIn, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { CONDITION, FREE_TEXT, issue, registerPerson, serviceAt, ticketRequest, type TestPerson } from './helpers/flow';

/**
 * No employer or insurer access (the spec's guardrail), enforced by walking the live route registry. Every route the
 * API registers must be reviewed here: a route that is not in this table fails the test, so a new route cannot return
 * wellbeing data to a role that should not see it without someone adding a line and defending it.
 *
 *  - open:             returns no wellbeing data to anyone (health, the sample directory, sign-in, the OpenAPI document)
 *  - person-own:       the caller's own data, behind a device credential and an ownership check
 *  - clinician-scoped: a ticket's data, behind a staff session, a clinician role and the facility scope
 */
type Kind = 'open' | 'person-own' | 'clinician-scoped';

const REVIEWED: Record<string, { access: RouteAccess; kind: Kind }> = {
  'GET /health': { access: 'public', kind: 'open' },
  'POST /persons': { access: 'public', kind: 'open' },
  'POST /auth/magic-link': { access: 'public', kind: 'open' },
  'POST /auth/verify': { access: 'public', kind: 'open' },
  'GET /services': { access: 'public', kind: 'open' },
  'GET /docs': { access: 'public', kind: 'open' },
  'POST /crisis-events': { access: 'person', kind: 'person-own' },
  'POST /tickets': { access: 'person', kind: 'person-own' },
  'GET /me/tickets': { access: 'person', kind: 'person-own' },
  'GET /me/tickets/:id': { access: 'person', kind: 'person-own' },
  'GET /me/tickets/:id/reads': { access: 'person', kind: 'person-own' },
  'POST /me/tickets/:id/events': { access: 'person', kind: 'person-own' },
  'POST /me/tickets/:id/reroute': { access: 'person', kind: 'person-own' },
  'POST /consents': { access: 'person', kind: 'person-own' },
  'DELETE /consents/:id': { access: 'person', kind: 'person-own' },
  'DELETE /me/data': { access: 'person', kind: 'person-own' },
  'PUT /me/equity': { access: 'person', kind: 'person-own' },
  'POST /summary/draft': { access: 'person', kind: 'person-own' },
  'GET /tickets/:id': { access: 'clinician', kind: 'clinician-scoped' },
  'POST /tickets/:id/events': { access: 'clinician', kind: 'clinician-scoped' },
  'GET /tickets/:id/bundle': { access: 'clinician', kind: 'clinician-scoped' },
};

describe('no employer or insurer access (MW-505)', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let owner: TestPerson;
  let stranger: TestPerson;
  let ticketId: string;
  let consentId: string;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db);
    ctx = await createTestApp(testDb.db);
    owner = await registerPerson(ctx);
    stranger = await registerPerson(ctx);
    const ticket = await issue(ctx, owner, ticketRequest(await serviceAt(testDb.db, 'A', 'gp'), { consents: ['ticket', 'free_text', 'conditions'], approvedSummary: 'SUMMARY-MARKER' }));
    ticketId = ticket.id;
    consentId = ticket.consents[0]!.id;
    tokens['clinician A'] = await signIn(ctx, 'clinician.a@demo.mawsool.test');
    tokens['clinician B'] = await signIn(ctx, 'clinician.b@demo.mawsool.test');
    tokens['ops'] = await signIn(ctx, 'ops@demo.mawsool.test');
    tokens['admin'] = await signIn(ctx, 'admin@demo.mawsool.test');
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const registered = () => ctx.app.routeRegistry.filter((route) => route.method !== 'HEAD' && route.method !== 'OPTIONS');
  const key = (route: { method: string; url: string }) => `${route.method} ${route.url}`;

  it('has a reviewed entry for every registered route and no entry for a route that is gone', () => {
    const live = registered().map(key).sort();
    expect(live.length).toBeGreaterThan(20);
    expect(Object.keys(REVIEWED).sort()).toEqual(live);
  });

  it('declares, for every route, the access the review expects', () => {
    for (const route of registered()) expect(route.access, key(route)).toBe(REVIEWED[key(route)]!.access);
  });

  it('serves wellbeing data only through person and clinician routes: no other role, and no employer or insurer role at all', () => {
    expect([...STAFF_ROLES]).toEqual(['clinician', 'ops', 'admin']);
    expect([...ROUTE_ACCESS]).toEqual(['public', 'person', 'clinician', 'ops', 'admin', 'inbound']);
    for (const route of registered()) {
      const { kind } = REVIEWED[key(route)]!;
      if (kind === 'person-own') expect(route.access).toBe('person');
      if (kind === 'clinician-scoped') expect(route.access).toBe('clinician');
      if (kind === 'open') expect(route.access).toBe('public');
    }
  });

  it('refuses every principal that is not the right one, on every person and clinician route, without returning any data', async () => {
    const routes = registered().filter((route) => REVIEWED[key(route)]!.kind !== 'open');
    expect(routes.length).toBeGreaterThanOrEqual(15);
    const bodies: Record<string, unknown> = {
      'POST /crisis-events': {},
      'POST /tickets': ticketRequest('00000000-0000-4000-8000-000000000001'),
      'POST /me/tickets/:id/events': { to: 'declined' },
      'POST /me/tickets/:id/reroute': { ...ticketRequest('00000000-0000-4000-8000-000000000001'), reason: 'cost' },
      'POST /consents': { ticketId, element: 'scores', content: {} },
      'PUT /me/equity': { optIn: false },
      'POST /summary/draft': { requestId: crypto.randomUUID(), locale: 'en', useAi: false, consented: [], content: {} },
      'POST /tickets/:id/events': { to: 'acknowledged' },
    };
    const outsiders: Record<RouteAccess, { name: string; headers: Record<string, string> }[]> = {
      person: [
        { name: 'no credential', headers: {} },
        { name: 'another person', headers: stranger.headers },
        { name: 'clinician', headers: { authorization: `Bearer ${tokens['clinician A']}` } },
        { name: 'ops', headers: { authorization: `Bearer ${tokens['ops']}` } },
        { name: 'admin', headers: { authorization: `Bearer ${tokens['admin']}` } },
      ],
      clinician: [
        { name: 'no credential', headers: {} },
        { name: 'the owner', headers: owner.headers },
        { name: 'ops', headers: { authorization: `Bearer ${tokens['ops']}` } },
        { name: 'admin', headers: { authorization: `Bearer ${tokens['admin']}` } },
        { name: 'a clinician at another facility', headers: { authorization: `Bearer ${tokens['clinician B']}` } },
      ],
      public: [],
      ops: [],
      admin: [],
      inbound: [],
    };
    const leaked: string[] = [];
    let attempts = 0;
    for (const route of routes) {
      const url = route.url.replace(':id', route.url.startsWith('/consents') ? consentId : ticketId);
      for (const outsider of outsiders[route.access]) {
        const isOtherPersonsOwn = outsider.name === 'another person';
        if (isOtherPersonsOwn && !route.url.includes(':id') && route.url !== '/consents') continue; // those routes act on the caller's own rows
        const res = await ctx.app.inject({ method: route.method as 'GET', url, headers: outsider.headers, payload: bodies[key(route)] as object | undefined });
        attempts += 1;
        if (![401, 403, 404].includes(res.statusCode) || res.body.includes(FREE_TEXT) || res.body.includes(CONDITION) || res.body.includes('SUMMARY-MARKER')) {
          leaked.push(`${key(route)} as ${outsider.name}: ${res.statusCode}`);
        }
      }
    }
    expect(attempts).toBeGreaterThan(50);
    expect(leaked).toEqual([]);
  });

  it('lets the right principals through, so the refusals above are not just everything failing', async () => {
    const asClinician = await ctx.app.inject({ method: 'GET', url: `/tickets/${ticketId}/bundle`, headers: { authorization: `Bearer ${tokens['clinician A']}` } });
    expect(asClinician.statusCode).toBe(200);
    expect(asClinician.body).toContain(FREE_TEXT);
    const asOwner = await ctx.app.inject({ method: 'GET', url: `/me/tickets/${ticketId}`, headers: owner.headers });
    expect(asOwner.statusCode).toBe(200);
  });
});
