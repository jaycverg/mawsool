import { ROUTE_ACCESS, STAFF_ROLES, type RouteAccess } from '@mawsool/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '../src/db/client';
import { signInbound } from '../src/inbound/signing';
import { FACILITY_A_ID } from '../src/seed/fixtures';
import { runSeed } from '../src/seed/run';
import { createTestApp, signIn, type TestApp } from './helpers/app';
import { TEST_INBOUND_KEYS } from './helpers/config';
import { createTestDb, type TestDb } from './helpers/db';
import { CALLBACK, CONDITION, FREE_TEXT, handoffBody, issue, registerPerson, sendCrisisEvent, serviceAt, ticketRequest, type TestPerson } from './helpers/flow';

/**
 * No employer or insurer access (the spec's guardrail), enforced by walking the live route registry. Every route the
 * API registers must be reviewed here: a route that is not in this table fails the test, so a new route cannot return
 * wellbeing data to a role that should not see it without someone adding a line and defending it.
 *
 *  - open:             returns no wellbeing data to anyone (health, the sample directory, sign-in, the OpenAPI document)
 *  - person-own:       the caller's own data, behind a device credential and an ownership check
 *  - clinician-scoped: a ticket's data, behind a staff session, a clinician role and the facility scope
 *  - inbound-signed:   a front door's hand-over: no bearer token works on it, only a valid per-source signature
 *                      (`inbound.test.ts` holds the signature cases); it returns a claim code and no wellbeing data
 *  - ops-aggregate:    the dashboard's numbers, behind an ops session; every figure is suppressed under ten (`metrics.test.ts` holds the cases)
 *  - ops-or-admin-log:  the adverse-events log, behind an ops or admin session (`alsoAdmin`); it records coded incidents and holds no person
 *                      (`adverse-events.test.ts` holds the cases)
 * - crisis-line-consented: the mock crisis line's console, behind a crisis_line session and only under /crisis-handoffs: it reads a
 *                      hand-off while the person's consent for it is live, and 404s once it is revoked (`crisis-handoffs.test.ts`)
 */
type Kind = 'open' | 'person-own' | 'clinician-scoped' | 'inbound-signed' | 'ops-aggregate' | 'crisis-line-consented' | 'clinic-link-one-ticket' | 'admin-config' | 'ops-or-admin-log';

const REVIEWED: Record<string, { access: RouteAccess; kind: Kind }> = {
  'GET /health': { access: 'public', kind: 'open' },
  'POST /persons': { access: 'public', kind: 'open' },
  'POST /auth/magic-link': { access: 'public', kind: 'open' },
  'POST /auth/verify': { access: 'public', kind: 'open' },
  'GET /services': { access: 'public', kind: 'open' },
  'GET /docs': { access: 'public', kind: 'open' },
  // Opens to anyone because a browser logs a console error for a 404; it holds the demo clock's offset and no person data.
  'GET /clock': { access: 'public', kind: 'open' },
  'GET /metrics/funnel': { access: 'ops', kind: 'ops-aggregate' },
  'GET /metrics/timeliness': { access: 'ops', kind: 'ops-aggregate' },
  'GET /metrics/crisis': { access: 'ops', kind: 'ops-aggregate' },
  'GET /metrics/equity': { access: 'ops', kind: 'ops-aggregate' },
  'GET /metrics/outcomes': { access: 'ops', kind: 'ops-aggregate' },
  'POST /crisis-events': { access: 'person', kind: 'person-own' },
  'POST /me/crisis-handoffs': { access: 'person', kind: 'person-own' },
  'DELETE /me/crisis-handoffs/:id': { access: 'person', kind: 'person-own' },
  'GET /crisis-handoffs': { access: 'crisis_line', kind: 'crisis-line-consented' },
  'GET /crisis-handoffs/:id': { access: 'crisis_line', kind: 'crisis-line-consented' },
  'POST /crisis-handoffs/:id/contact': { access: 'crisis_line', kind: 'crisis-line-consented' },
  'POST /tickets': { access: 'person', kind: 'person-own' },
  'GET /me/tickets': { access: 'person', kind: 'person-own' },
  'GET /me/tickets/:id': { access: 'person', kind: 'person-own' },
  'GET /me/tickets/:id/reads': { access: 'person', kind: 'person-own' },
  'POST /me/tickets/:id/events': { access: 'person', kind: 'person-own' },
  'POST /me/tickets/:id/reroute': { access: 'person', kind: 'person-own' },
  'POST /me/tickets/:id/remeasure': { access: 'person', kind: 'person-own' },
  'POST /consents': { access: 'person', kind: 'person-own' },
  'DELETE /consents/:id': { access: 'person', kind: 'person-own' },
  'DELETE /me/data': { access: 'person', kind: 'person-own' },
  'GET /me/opt-ins': { access: 'person', kind: 'person-own' },
  'PUT /me/equity': { access: 'person', kind: 'person-own' },
  'PUT /me/outcome-statistics': { access: 'person', kind: 'person-own' },
  'PUT /me/reminder-phone': { access: 'person', kind: 'person-own' },
  'DELETE /me/reminder-phone': { access: 'person', kind: 'person-own' },
  'POST /me/reminder-phone/sample': { access: 'person', kind: 'person-own' },
  'POST /summary/draft': { access: 'person', kind: 'person-own' },
  'POST /me/invites/claim': { access: 'person', kind: 'person-own' },
  'GET /tickets': { access: 'clinician', kind: 'clinician-scoped' },
  'GET /tickets/:id': { access: 'clinician', kind: 'clinician-scoped' },
  'POST /tickets/:id/events': { access: 'clinician', kind: 'clinician-scoped' },
  'GET /tickets/:id/bundle': { access: 'clinician', kind: 'clinician-scoped' },
  'GET /tickets/:id/fhir': { access: 'clinician', kind: 'clinician-scoped' },
  'POST /inbound/screens': { access: 'inbound', kind: 'inbound-signed' },
  'POST /clinic-link/open': { access: 'clinic_link', kind: 'clinic-link-one-ticket' },
  'POST /clinic-link/act': { access: 'clinic_link', kind: 'clinic-link-one-ticket' },
  'PUT /facilities/:id/portal-access': { access: 'admin', kind: 'admin-config' },
  'POST /adverse-events': { access: 'ops', kind: 'ops-or-admin-log' },
  'GET /adverse-events': { access: 'ops', kind: 'ops-or-admin-log' },
  'POST /adverse-events/:id/status': { access: 'ops', kind: 'ops-or-admin-log' },
};

describe('no employer or insurer access (MW-505)', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let owner: TestPerson;
  let stranger: TestPerson;
  let ticketId: string;
  let consentId: string;
  let handoffId: string;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
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
    tokens['crisis line'] = await signIn(ctx, 'crisisline@demo.mawsool.test');
    const eventId = await sendCrisisEvent(ctx, owner);
    const handoff = await ctx.app.inject({ method: 'POST', url: '/me/crisis-handoffs', headers: owner.headers, payload: handoffBody(eventId) });
    handoffId = handoff.json().handoffId;
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
    expect([...STAFF_ROLES]).toEqual(['clinician', 'ops', 'admin', 'crisis_line']);
    expect([...ROUTE_ACCESS]).toEqual(['public', 'person', 'clinician', 'ops', 'admin', 'crisis_line', 'inbound', 'clinic_link']);
    for (const route of registered()) {
      const { kind } = REVIEWED[key(route)]!;
      if (kind === 'person-own') expect(route.access).toBe('person');
      if (kind === 'clinician-scoped') expect(route.access).toBe('clinician');
      if (kind === 'inbound-signed') expect(route.access).toBe('inbound');
      if (kind === 'ops-aggregate') expect(route.access).toBe('ops');
      if (kind === 'ops-or-admin-log') {
        expect(route.access).toBe('ops');
        expect(route.alsoAdmin).toBe(true);
      } else {
        expect(route.alsoAdmin, key(route)).toBe(false);
      }
      if (kind === 'crisis-line-consented') expect(route.access).toBe('crisis_line');
      if (kind === 'clinic-link-one-ticket') expect(route.access).toBe('clinic_link');
      if (kind === 'admin-config') expect(route.access).toBe('admin');
      if (kind === 'open') expect(route.access).toBe('public');
    }
  });

  it('gives the crisis-line role exactly the three hand-off routes and no other route', () => {
    const open = registered().filter((route) => route.access === 'crisis_line').map(key).sort();
    expect(open).toEqual(['GET /crisis-handoffs', 'GET /crisis-handoffs/:id', 'POST /crisis-handoffs/:id/contact']);
  });

  it('gives the no-login clinic link exactly two routes, both under /clinic-link/, and none of them reads a bundle', () => {
    const open = registered().filter((route) => route.access === 'clinic_link').map(key).sort();
    expect(open).toEqual(['POST /clinic-link/act', 'POST /clinic-link/open']);
  });

  it('refuses every principal that is not the right one, on every person and clinician route, without returning any data', async () => {
    const routes = registered().filter((route) => REVIEWED[key(route)]!.kind !== 'open');
    expect(routes.length).toBeGreaterThanOrEqual(15);
    const bodies: Record<string, unknown> = {
      'POST /inbound/screens': { result: 'positive', screenedAt: '2026-11-01T08:00:00+04:00', locale: 'ar' },
      'POST /me/invites/claim': { code: 'ABCD-EFGH' },
      'POST /crisis-events': {},
      'POST /me/crisis-handoffs': handoffBody('00000000-0000-4000-8000-000000000002'),
      'POST /tickets': ticketRequest('00000000-0000-4000-8000-000000000001'),
      'POST /me/tickets/:id/events': { to: 'declined' },
      'POST /me/tickets/:id/remeasure': { scores: [] },
      'POST /me/tickets/:id/reroute': { ...ticketRequest('00000000-0000-4000-8000-000000000001'), reason: 'cost' },
      'POST /consents': { ticketId, element: 'scores', content: {} },
      'PUT /me/equity': { optIn: false },
      'PUT /me/outcome-statistics': { optIn: false },
      'PUT /me/reminder-phone': { phone: '+971501234567', intervalWeeks: 4 },
      'POST /summary/draft': { requestId: crypto.randomUUID(), locale: 'en', useAi: false, consented: [], content: {} },
      'POST /tickets/:id/events': { to: 'acknowledged' },
      'POST /clinic-link/open': { ticketId, token: 'not-a-token' },
      'POST /clinic-link/act': { ticketId, token: 'not-a-token', to: 'seen' },
      'PUT /facilities/:id/portal-access': { portalAccess: false },
      'POST /adverse-events': { type: 'wrong_routing', severity: 'low' },
      'POST /adverse-events/:id/status': { to: 'closed' },
    };
    const outsiders: Record<RouteAccess, { name: string; headers: Record<string, string> }[]> = {
      person: [
        { name: 'no credential', headers: {} },
        { name: 'another person', headers: stranger.headers },
        { name: 'clinician', headers: { authorization: `Bearer ${tokens['clinician A']}` } },
        { name: 'ops', headers: { authorization: `Bearer ${tokens['ops']}` } },
        { name: 'admin', headers: { authorization: `Bearer ${tokens['admin']}` } },
        { name: 'the crisis line', headers: { authorization: `Bearer ${tokens['crisis line']}` } },
      ],
      clinician: [
        { name: 'no credential', headers: {} },
        { name: 'the owner', headers: owner.headers },
        { name: 'ops', headers: { authorization: `Bearer ${tokens['ops']}` } },
        { name: 'admin', headers: { authorization: `Bearer ${tokens['admin']}` } },
        { name: 'a clinician at another facility', headers: { authorization: `Bearer ${tokens['clinician B']}` } },
        { name: 'the crisis line', headers: { authorization: `Bearer ${tokens['crisis line']}` } },
      ],
      public: [],
      // The dashboard is for the ops role alone: a clinician, a person, an anonymous caller (and an admin, whose panel is separate) are refused.
      ops: [
        { name: 'no credential', headers: {} },
        { name: 'the owner', headers: owner.headers },
        { name: 'a clinician', headers: { authorization: `Bearer ${tokens['clinician A']}` } },
        { name: 'a clinician at another facility', headers: { authorization: `Bearer ${tokens['clinician B']}` } },
        { name: 'admin', headers: { authorization: `Bearer ${tokens['admin']}` } },
        { name: 'the crisis line', headers: { authorization: `Bearer ${tokens['crisis line']}` } },
      ],
      // A facility's portal switch is the admin's: no other role, no person and no anonymous caller may move it.
      admin: [
        { name: 'no credential', headers: {} },
        { name: 'the owner', headers: owner.headers },
        { name: 'a clinician', headers: { authorization: `Bearer ${tokens['clinician A']}` } },
        { name: 'ops', headers: { authorization: `Bearer ${tokens['ops']}` } },
        { name: 'the crisis line', headers: { authorization: `Bearer ${tokens['crisis line']}` } },
      ],
      // No bearer token opens a clinic link, the facility's own clinician's and the owner's included: the link's token is the only credential.
      clinic_link: [
        { name: 'no credential', headers: {} },
        { name: 'the owner', headers: owner.headers },
        { name: 'the facility’s own clinician', headers: { authorization: `Bearer ${tokens['clinician A']}` } },
        { name: 'ops', headers: { authorization: `Bearer ${tokens['ops']}` } },
        { name: 'admin', headers: { authorization: `Bearer ${tokens['admin']}` } },
        { name: 'the crisis line', headers: { authorization: `Bearer ${tokens['crisis line']}` } },
      ],
      // The console reads a person's hand-off and nothing else: a person (even the one who made it), every other staff role and an anonymous caller are refused.
      crisis_line: [
        { name: 'no credential', headers: {} },
        { name: 'the owner', headers: owner.headers },
        { name: 'a clinician', headers: { authorization: `Bearer ${tokens['clinician A']}` } },
        { name: 'ops', headers: { authorization: `Bearer ${tokens['ops']}` } },
        { name: 'admin', headers: { authorization: `Bearer ${tokens['admin']}` } },
      ],
      // A bearer token of any kind is no substitute for a signature. Unsigned and mis-signed requests are in inbound.test.ts.
      inbound: [
        { name: 'no credential', headers: {} },
        { name: 'a person', headers: owner.headers },
        { name: 'a clinician', headers: { authorization: `Bearer ${tokens['clinician A']}` } },
        { name: 'ops', headers: { authorization: `Bearer ${tokens['ops']}` } },
        { name: 'the crisis line', headers: { authorization: `Bearer ${tokens['crisis line']}` } },
      ],
    };
    const leaked: string[] = [];
    let attempts = 0;
    for (const route of routes) {
      const idFor = route.url.includes('crisis-handoffs') ? handoffId : route.url.startsWith('/consents') ? consentId : ticketId;
      const url = route.url.replace(':id', idFor);
      // An ops route that also admits an admin has no reason to turn an admin away.
      for (const outsider of outsiders[route.access].filter((entry) => !(route.alsoAdmin && entry.name === 'admin'))) {
        const isOtherPersonsOwn = outsider.name === 'another person';
        if (isOtherPersonsOwn && !route.url.includes(':id') && route.url !== '/consents') continue; // those routes act on the caller's own rows
        // The queue has no ticket id to be wrong about: a clinician at another facility reads their own list, which holds none of this facility's tickets (checked in queue.test.ts).
        if (outsider.name === 'a clinician at another facility' && route.url === '/tickets') continue;
        const res = await ctx.app.inject({ method: route.method as 'GET', url, headers: outsider.headers, payload: bodies[key(route)] as object | undefined });
        attempts += 1;
        if (![401, 403, 404].includes(res.statusCode) || res.body.includes(FREE_TEXT) || res.body.includes(CONDITION) || res.body.includes('SUMMARY-MARKER') || res.body.includes(CALLBACK)) {
          leaked.push(`${key(route)} as ${outsider.name}: ${res.statusCode}`);
        }
      }
    }
    expect(attempts).toBeGreaterThan(50);
    expect(leaked).toEqual([]);
  });

  it('refuses a correctly signed inbound request and a valid clinic-link token on the adverse-events routes, the symptom-change route and the reminder-sample route', async () => {
    // A real clinic link: facility A has no portal for the moment, so a ticket there is given one.
    const adminHeaders = { authorization: `Bearer ${tokens['admin']}` };
    expect((await ctx.app.inject({ method: 'PUT', url: `/facilities/${FACILITY_A_ID}/portal-access`, headers: adminHeaders, payload: { portalAccess: false } })).statusCode).toBe(200);
    try {
      await issue(ctx, owner, ticketRequest(await serviceAt(testDb.db, 'A', 'gp')));
      const link = ctx.notifier.lastClinicCredential();
      const eventsBefore = (await testDb.db.select().from(schema.adverseEvents)).length;
      const routes: [string, string, Record<string, unknown> | undefined][] = [
        ['POST', '/adverse-events', { type: 'wrong_routing', severity: 'low' }],
        ['GET', '/adverse-events', undefined],
        ['POST', `/adverse-events/${randomUUID()}/status`, { to: 'closed' }],
        ['GET', '/metrics/outcomes', undefined],
        ['POST', '/me/reminder-phone/sample', undefined],
      ];
      const registeredKeys = registered().map(key);
      for (const [method, url] of routes) expect(registeredKeys, `${method} ${url}`).toContain(`${method} ${url.replace(/[0-9a-f-]{36}/, ':id')}`);
      const signedFor = (payload: Record<string, unknown> | undefined) => {
        const body = payload === undefined ? '' : JSON.stringify(payload);
        return { body, headers: signInbound({ key: TEST_INBOUND_KEYS.tamm, source: 'tamm', timestamp: Math.floor(ctx.clock.now().getTime() / 1000), nonce: randomUUID().replaceAll('-', ''), body }) };
      };
      for (const [method, url, payload] of routes) {
        const signed = signedFor(payload);
        const inbound = await ctx.app.inject({ method: method as 'GET', url, headers: { ...signed.headers, ...(payload ? { 'content-type': 'application/json' } : {}) }, payload: payload ? signed.body : undefined });
        expect([401, 403], `a signed inbound request to ${method} ${url}`).toContain(inbound.statusCode);
        // The link's token is the only credential it has; it is presented as a bearer token and in the body, and opens nothing here.
        const clinic = await ctx.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${link.token}` }, payload: payload ? { ...payload, ticketId: link.ticketId, token: link.token } : undefined });
        expect([401, 403], `a valid clinic link on ${method} ${url}`).toContain(clinic.statusCode);
        const bodyOnly = await ctx.app.inject({ method: method as 'GET', url, payload: payload ? { ...payload, ticketId: link.ticketId, token: link.token } : undefined });
        expect([401, 403], `a clinic link in the body of ${method} ${url}`).toContain(bodyOnly.statusCode);
      }
      expect((await testDb.db.select().from(schema.adverseEvents)).length, 'nothing was recorded').toBe(eventsBefore);
    } finally {
      await ctx.app.inject({ method: 'PUT', url: `/facilities/${FACILITY_A_ID}/portal-access`, headers: adminHeaders, payload: { portalAccess: true } });
    }
  });

  it('lets the right principals through, so the refusals above are not just everything failing', async () => {
    const asClinician = await ctx.app.inject({ method: 'GET', url: `/tickets/${ticketId}/bundle`, headers: { authorization: `Bearer ${tokens['clinician A']}` } });
    expect(asClinician.statusCode).toBe(200);
    expect(asClinician.body).toContain(FREE_TEXT);
    const exported = await ctx.app.inject({ method: 'GET', url: `/tickets/${ticketId}/fhir`, headers: { authorization: `Bearer ${tokens['clinician A']}` } });
    expect(exported.statusCode).toBe(200);
    const queue = await ctx.app.inject({ method: 'GET', url: '/tickets', headers: { authorization: `Bearer ${tokens['clinician A']}` } });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().items.map((item: { id: string }) => item.id)).toContain(ticketId);
    const asOwner = await ctx.app.inject({ method: 'GET', url: `/me/tickets/${ticketId}`, headers: owner.headers });
    expect(asOwner.statusCode).toBe(200);
    const asLine = await ctx.app.inject({ method: 'GET', url: `/crisis-handoffs/${handoffId}`, headers: { authorization: `Bearer ${tokens['crisis line']}` } });
    expect(asLine.statusCode).toBe(200);
    expect(asLine.body).toContain(CALLBACK);
    for (const who of ['ops', 'admin']) {
      const log = await ctx.app.inject({ method: 'GET', url: '/adverse-events', headers: { authorization: `Bearer ${tokens[who]}` } });
      expect(log.statusCode, `the log as ${who}`).toBe(200);
    }
    for (const path of ['funnel', 'timeliness', 'crisis', 'equity', 'outcomes']) {
      const asOps = await ctx.app.inject({ method: 'GET', url: `/metrics/${path}`, headers: { authorization: `Bearer ${tokens['ops']}` } });
      expect(asOps.statusCode, path).toBe(200);
    }
  });
});

describe('the demo routes (clock and reset)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
  });

  afterAll(async () => {
    await testDb.close();
  });

  const demoRoutes = ['POST /demo/clock/advance', 'POST /demo/reset'];

  it('are not registered at all with DEMO_MODE unset: the paths are 404 for every principal, the admin included', async () => {
    const ctx = await createTestApp(testDb.db);
    try {
      const live = ctx.app.routeRegistry.map((route) => `${route.method} ${route.url}`);
      for (const route of demoRoutes) expect(live).not.toContain(route);
      const admin = await signIn(ctx, 'admin@demo.mawsool.test');
      for (const [method, url] of [['POST', '/demo/clock/advance'], ['POST', '/demo/reset']] as const) {
        for (const headers of [{}, { authorization: `Bearer ${admin}` }]) {
          const res = await ctx.app.inject({ method, url, headers, payload: url.endsWith('advance') ? { by: '7d' } : undefined });
          expect(res.statusCode, `${url} ${JSON.stringify(Object.keys(headers))}`).toBe(404);
        }
      }
    } finally {
      await ctx.app.close();
    }
  });

  it('are admin access with DEMO_MODE set: nobody else may move the clock or reset, and the admin may', async () => {
    const ctx = await createTestApp(testDb.db, { demoMode: true });
    try {
      for (const route of demoRoutes) expect(ctx.app.routeRegistry.find((entry) => `${entry.method} ${entry.url}` === route)?.access, route).toBe('admin');
      const tokens = {
        clinician: await signIn(ctx, 'clinician.a@demo.mawsool.test'),
        ops: await signIn(ctx, 'ops@demo.mawsool.test'),
        admin: await signIn(ctx, 'admin@demo.mawsool.test'),
      };
      const person = await registerPerson(ctx);
      const refused: Record<string, Record<string, string>> = {
        'no credential': {},
        person: person.headers,
        clinician: { authorization: `Bearer ${tokens.clinician}` },
        ops: { authorization: `Bearer ${tokens.ops}` },
      };
      for (const [name, headers] of Object.entries(refused)) {
        const advance = await ctx.app.inject({ method: 'POST', url: '/demo/clock/advance', headers, payload: { by: '7d' } });
        expect([401, 403], `advance as ${name}`).toContain(advance.statusCode);
        const reset = await ctx.app.inject({ method: 'POST', url: '/demo/reset', headers });
        expect([401, 403], `reset as ${name}`).toContain(reset.statusCode);
      }
      const clock = await ctx.app.inject({ method: 'GET', url: '/clock' });
      expect(clock.json()).toEqual({ demoMode: true, offsetMs: 0 });
      const advanced = await ctx.app.inject({ method: 'POST', url: '/demo/clock/advance', headers: { authorization: `Bearer ${tokens.admin}` }, payload: { by: '7d' } });
      expect(advanced.statusCode).toBe(200);
      expect(advanced.json().offsetMs).toBe(7 * 86_400_000);
    } finally {
      await ctx.app.close();
    }
  });
});
