import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeed } from '../src/seed/run';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';

describe('GET /docs (OpenAPI)', () => {
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

  it('serves an OpenAPI 3 document without a credential', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ openapi: '3.0.3', info: { title: 'Mawsool Ticket API' } });
  });

  it('describes every registered route and the shape of the bodies it takes, generated from the Zod schemas', async () => {
    const doc = (await ctx.app.inject({ method: 'GET', url: '/docs' })).json() as { paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: unknown }> } }>> };
    const toOpenApi = (url: string) => url.replace(/:(\w+)/g, '{$1}');
    for (const route of ctx.app.routeRegistry.filter((entry) => entry.method !== 'HEAD' && entry.method !== 'OPTIONS')) {
      expect(doc.paths[toOpenApi(route.url)]?.[route.method.toLowerCase()], `${route.method} ${route.url}`).toBeDefined();
    }
    const body = JSON.stringify(doc.paths['/tickets']!['post']!.requestBody);
    for (const field of ['clientRequestId', 'windowDays', 'consents', 'content', 'approvedSummary']) expect(body).toContain(field);
    expect(JSON.stringify(doc.paths['/consents/{id}']!['delete'])).toContain('ticketState');
  });
});

describe('CORS', () => {
  it('lets the browser apps use every method the API serves, PUT and DELETE included', async () => {
    const testDb = await createTestDb();
    const ctx = await createTestApp(testDb.db);
    try {
      const methods = [...new Set(ctx.app.routeRegistry.map((route) => route.method).filter((method) => method !== 'HEAD' && method !== 'OPTIONS'))];
      expect(methods.sort()).toEqual(['DELETE', 'GET', 'POST', 'PUT']);
      for (const method of methods) {
        const res = await ctx.app.inject({ method: 'OPTIONS', url: '/consents/00000000-0000-4000-8000-000000000000', headers: { origin: 'http://localhost:3001', 'access-control-request-method': method, 'access-control-request-headers': 'authorization,content-type' } });
        expect(res.headers['access-control-allow-methods'], method).toContain(method);
      }
    } finally {
      await ctx.app.close();
      await testDb.close();
    }
  });
});

describe('GET /docs for the front-door hand-over', () => {
  it('tells a front door which headers to sign and send, and what it gets back', async () => {
    const testDb = await createTestDb();
    const ctx = await createTestApp(testDb.db);
    try {
      const doc = (await ctx.app.inject({ method: 'GET', url: '/docs' })).json() as { paths: Record<string, Record<string, { parameters?: { name: string; in: string; required?: boolean }[]; responses: Record<string, unknown> }>> };
      const post = doc.paths['/inbound/screens']!['post']!;
      const headers = post.parameters!.filter((parameter) => parameter.in === 'header').map((parameter) => parameter.name).sort();
      expect(headers).toEqual(['x-mawsool-nonce', 'x-mawsool-signature', 'x-mawsool-source', 'x-mawsool-timestamp']);
      expect(Object.keys(post.responses).sort()).toEqual(['201', '400', '401']);
      expect(JSON.stringify(doc.paths['/inbound/screens'])).toContain('claimUrl');
      for (const path of ['/tickets', '/tickets/{id}/fhir', '/me/invites/claim']) expect(doc.paths[path], path).toBeDefined();
    } finally {
      await ctx.app.close();
      await testDb.close();
    }
  });
});

describe('GET /docs for the dashboard and the demo', () => {
  type Doc = { paths: Record<string, Record<string, { parameters?: { name: string; in: string }[]; requestBody?: unknown; responses: Record<string, unknown> }>> };

  it('describes the metrics routes with their filters and the suppressed answer, and the open clock read', async () => {
    const testDb = await createTestDb();
    const ctx = await createTestApp(testDb.db);
    try {
      const doc = (await ctx.app.inject({ method: 'GET', url: '/docs' })).json() as Doc;
      const funnel = doc.paths['/metrics/funnel']!['get']!;
      expect(funnel.parameters!.filter((parameter) => parameter.in === 'query').map((parameter) => parameter.name).sort()).toEqual(['period', 'source', 'tier']);
      for (const path of ['/metrics/timeliness', '/metrics/crisis', '/metrics/equity', '/metrics/outcomes']) {
        expect(doc.paths[path]!['get']!.parameters!.map((parameter) => parameter.name), path).toEqual(['period']);
      }
      for (const path of ['/metrics/funnel', '/metrics/timeliness', '/metrics/crisis', '/metrics/equity', '/metrics/outcomes']) expect(JSON.stringify(doc.paths[path]), path).toContain('suppressed');
      expect(JSON.stringify(doc.paths['/clock']!['get'])).toContain('offsetMs');
      // With DEMO_MODE unset the write controls are not part of the API at all, so they are not in its document either.
      expect(doc.paths['/demo/reset']).toBeUndefined();
      expect(doc.paths['/demo/clock/advance']).toBeUndefined();
    } finally {
      await ctx.app.close();
      await testDb.close();
    }
  });

  it('describes the demo controls when DEMO_MODE is set', async () => {
    const testDb = await createTestDb();
    const ctx = await createTestApp(testDb.db, { demoMode: true });
    try {
      const doc = (await ctx.app.inject({ method: 'GET', url: '/docs' })).json() as Doc;
      expect(JSON.stringify(doc.paths['/demo/clock/advance']!['post']!.requestBody)).toContain('7d');
      expect(JSON.stringify(doc.paths['/demo/reset']!['post']!.responses)).toContain('tammUrl');
    } finally {
      await ctx.app.close();
      await testDb.close();
    }
  });
});
