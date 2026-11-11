import { ServicesResponseSchema } from '@mawsool/types';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { FACILITIES, FACILITY_A_ID, SERVICE_NAMES_AR, SERVICES } from '../src/seed/fixtures';
import { runSeed } from '../src/seed/run';
import { createTestApp, signIn, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { issue, registerPerson, serviceAt, ticketRequest, type TestPerson } from './helpers/flow';

const LATIN = /[A-Za-z]/;
const ARABIC = /[؀-ۿ]/;
const FACILITY_A = FACILITIES.find((facility) => facility.id === FACILITY_A_ID)!;

describe('the directory in Arabic and English', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let gpA: string;
  let arabic: TestPerson;
  let english: TestPerson;
  let arabicTicket: { id: string };

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    ctx = await createTestApp(testDb.db);
    gpA = await serviceAt(testDb.db, 'A', 'gp');
    arabic = await registerPerson(ctx, 'ar');
    english = await registerPerson(ctx, 'en');
    arabicTicket = await issue(ctx, arabic, ticketRequest(gpA));
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const services = async (query = '') => ServicesResponseSchema.parse((await ctx.app.inject({ method: 'GET', url: `/services${query}` })).json());
  const get = (url: string, person: TestPerson) => ctx.app.inject({ method: 'GET', url, headers: person.headers });

  describe('GET /services', () => {
    it('serves every sample service by its Arabic name in Arabic, with no Latin letter in any of them', async () => {
      const list = await services('?locale=ar');
      expect(list).toHaveLength(SERVICES.length);
      for (const service of list) {
        expect(service.name, service.name).toMatch(ARABIC);
        expect(service.name, service.name).not.toMatch(LATIN);
      }
      expect(new Set(list.map((service) => service.name))).toEqual(new Set(Object.values(SERVICE_NAMES_AR)));
    });

    it('serves the English names for ?locale=en and when no locale is given', async () => {
      const english = new Set(SERVICES.map((service) => service.name));
      expect(new Set((await services('?locale=en')).map((service) => service.name))).toEqual(english);
      expect(new Set((await services()).map((service) => service.name))).toEqual(english);
    });

    it('lists the same services in the same order in both languages, so a service is in the same place in either', async () => {
      const [ar, en] = [await services('?locale=ar'), await services('?locale=en')];
      expect(ar.map((service) => service.id)).toEqual(en.map((service) => service.id));
      expect(ar.map(({ name: _name, ...rest }) => rest)).toEqual(en.map(({ name: _name, ...rest }) => rest));
    });

    it('refuses a language it does not serve', async () => {
      expect((await ctx.app.inject({ method: 'GET', url: '/services?locale=fr' })).statusCode).toBe(400);
    });

    it('serves the stored English text where no Arabic name was written, not a made-up one, and never a blank', async () => {
      const [first, second] = await testDb.db.select().from(schema.services).orderBy(schema.services.id).limit(2);
      await testDb.db.update(schema.services).set({ nameAr: null }).where(eq(schema.services.id, first!.id));
      await testDb.db.update(schema.services).set({ nameAr: '   ' }).where(eq(schema.services.id, second!.id));
      try {
        const list = await services('?locale=ar');
        expect(list.find((service) => service.id === first!.id)!.name).toBe(first!.name);
        expect(list.find((service) => service.id === second!.id)!.name).toBe(second!.name);
        expect(list.filter((service) => LATIN.test(service.name))).toHaveLength(2);
      } finally {
        await testDb.db.update(schema.services).set({ nameAr: first!.nameAr }).where(eq(schema.services.id, first!.id));
        await testDb.db.update(schema.services).set({ nameAr: second!.nameAr }).where(eq(schema.services.id, second!.id));
      }
    });
  });

  describe('the person\'s ticket', () => {
    it('names the service, the clinic and the contact in Arabic for an Arabic page, with no Latin letter', async () => {
      const ticket = (await get(`/me/tickets/${arabicTicket.id}?locale=ar`, arabic)).json();
      for (const field of ['serviceName', 'clinicName', 'clinicContact'] as const) {
        expect(ticket[field], field).toMatch(ARABIC);
        expect(ticket[field], field).not.toMatch(LATIN);
      }
      expect(ticket.clinicName).toBe(FACILITY_A.nameAr);
      expect(ticket.clinicContact).toBe(FACILITY_A.contactTextAr);
      expect(Object.values(SERVICE_NAMES_AR)).toContain(ticket.serviceName);
    });

    it('names them in English for an English page, whatever language the person registered with', async () => {
      const ticket = (await get(`/me/tickets/${arabicTicket.id}?locale=en`, arabic)).json();
      expect(ticket.clinicName).toBe(FACILITY_A.name);
      expect(ticket.clinicContact).toBe(FACILITY_A.contactText);
      expect(SERVICES.map((service) => service.name)).toContain(ticket.serviceName);
    });

    it('uses the language the person registered with when the page does not say, on a read and on the ticket just issued', async () => {
      expect((await get(`/me/tickets/${arabicTicket.id}`, arabic)).json().clinicName).toBe(FACILITY_A.nameAr);
      expect((await get('/me/tickets', arabic)).json()[0].clinicName).toBe(FACILITY_A.nameAr);
      const englishTicket = await issue(ctx, english, ticketRequest(gpA));
      expect((await get(`/me/tickets/${englishTicket.id}`, english)).json().clinicName).toBe(FACILITY_A.name);
      const issuedForArabic = await ctx.app.inject({ method: 'POST', url: '/tickets', headers: arabic.headers, payload: ticketRequest(gpA) });
      expect(issuedForArabic.json().ticket.clinicName).toBe(FACILITY_A.nameAr);
    });

    it('serves the list of tickets in the page language too', async () => {
      const list = (await get('/me/tickets?locale=en', arabic)).json() as { clinicName: string }[];
      expect(list.map((ticket) => ticket.clinicName)).not.toContain(FACILITY_A.nameAr);
      expect(list.length).toBeGreaterThan(0);
    });

    it('names the clinic that read the bundle in the page language', async () => {
      const clinician = await signIn(ctx, 'clinician.a@demo.mawsool.test');
      expect((await ctx.app.inject({ method: 'GET', url: `/tickets/${arabicTicket.id}/bundle`, headers: { authorization: `Bearer ${clinician}` } })).statusCode).toBe(200);
      expect((await get(`/me/tickets/${arabicTicket.id}/reads?locale=ar`, arabic)).json()).toEqual([{ at: expect.any(String), role: 'clinician', facilityName: FACILITY_A.nameAr }]);
      expect((await get(`/me/tickets/${arabicTicket.id}/reads?locale=en`, arabic)).json()).toEqual([{ at: expect.any(String), role: 'clinician', facilityName: FACILITY_A.name }]);
    });

    it('falls back to the stored English text, never invented text, where the clinic or service has no Arabic', async () => {
      const [service] = await testDb.db.select().from(schema.services).where(eq(schema.services.id, gpA));
      await testDb.db.update(schema.facilities).set({ nameAr: null, contactTextAr: '' }).where(eq(schema.facilities.id, FACILITY_A_ID));
      await testDb.db.update(schema.services).set({ nameAr: null }).where(eq(schema.services.id, service!.id));
      try {
        const ticket = (await get(`/me/tickets/${arabicTicket.id}?locale=ar`, arabic)).json();
        expect(ticket.clinicName).toBe(FACILITY_A.name);
        expect(ticket.clinicContact).toBe(FACILITY_A.contactText);
        expect(ticket.serviceName).toBe(service!.name);
        expect(ticket.serviceName).toMatch(/^Sample /);
      } finally {
        await testDb.db.update(schema.facilities).set({ nameAr: FACILITY_A.nameAr, contactTextAr: FACILITY_A.contactTextAr }).where(eq(schema.facilities.id, FACILITY_A_ID));
        await testDb.db.update(schema.services).set({ nameAr: service!.nameAr }).where(eq(schema.services.id, service!.id));
      }
    });

    it('still answers 404 for a ticket that is not the caller\'s, in either language', async () => {
      expect((await get(`/me/tickets/${arabicTicket.id}?locale=ar`, english)).statusCode).toBe(404);
      expect((await get(`/me/tickets/${arabicTicket.id}/reads?locale=ar`, english)).statusCode).toBe(404);
    });
  });
});
