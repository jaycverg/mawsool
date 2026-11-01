import { ServicesResponseSchema } from '@mawsool/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeed } from '../src/seed/run';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';

describe('GET /services', () => {
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

  const get = (url: string) => ctx.app.inject({ method: 'GET', url });

  it('returns the whole mock directory, unfiltered, with no credential', async () => {
    const res = await get('/services');
    expect(res.statusCode).toBe(200);
    const services = ServicesResponseSchema.parse(res.json());
    expect(services.length).toBeGreaterThanOrEqual(20);
    expect(services.every((service) => service.sample)).toBe(true);
    expect(new Set(services.map((service) => service.tier))).toEqual(new Set(['self_help', 'community', 'tele', 'gp', 'specialist']));
  });

  it('lists the services in a stable order', async () => {
    const names = (await get('/services')).json().map((service: { name: string }) => service.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('filters by tier, region, modality and language, alone and together', async () => {
    const all = (await get('/services')).json() as { tier: string; region: string; modality: string; languages: string[] }[];
    const gp = (await get('/services?tier=gp')).json() as typeof all;
    expect(gp.length).toBeGreaterThan(0);
    expect(gp.every((service) => service.tier === 'gp')).toBe(true);
    expect(gp.length).toBe(all.filter((service) => service.tier === 'gp').length);

    const alAin = (await get('/services?region=al_ain')).json() as typeof all;
    expect(alAin.length).toBe(all.filter((service) => service.region === 'al_ain').length);

    const tele = (await get('/services?modality=tele')).json() as typeof all;
    expect(tele.length).toBe(all.filter((service) => service.modality === 'tele').length);

    const urdu = (await get('/services?language=ur')).json() as typeof all;
    expect(urdu.length).toBeGreaterThan(0);
    expect(urdu.length).toBe(all.filter((service) => service.languages.includes('ur')).length);

    const both = (await get('/services?tier=gp&language=ar')).json() as typeof all;
    expect(both.every((service) => service.tier === 'gp' && service.languages.includes('ar'))).toBe(true);
  });

  it('refuses an unknown filter value', async () => {
    expect((await get('/services?tier=surgery')).statusCode).toBe(400);
  });

  it('carries the facility link, which is null only for self-help', async () => {
    const services = (await get('/services')).json() as { tier: string; facilityId: string | null }[];
    for (const service of services) expect(service.facilityId === null).toBe(service.tier === 'self_help');
  });
});
