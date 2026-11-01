import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeed } from '../src/seed/run';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';

describe('GET /docs (OpenAPI)', () => {
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
