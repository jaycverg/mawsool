import { ServicesQuerySchema, ServicesResponseSchema, type Service } from '@mawsool/types';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { schema, type Db } from '../db/client';
import { localized } from '../locale';

/**
 * GET /services is the mock directory the person app fetches whole and matches against on the device, so the
 * person's preferences, insurance class and region never leave the phone. The filters exist for other callers;
 * the app sends none, only the page's `locale`, which picks the language of each service's name (English when absent
 * or when no Arabic name was written). It is public because every record is sample data and the device may not be
 * registered yet.
 */
export function registerServiceRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/services',
    {
      config: { access: 'public' },
      schema: { querystring: ServicesQuerySchema, response: { 200: ServicesResponseSchema } },
    },
    async (request): Promise<Service[]> => {
      const { tier, region, modality, language, locale = 'en' } = request.query;
      const filters = [
        tier ? eq(schema.services.tier, tier) : undefined,
        region ? eq(schema.services.region, region) : undefined,
        modality ? eq(schema.services.modality, modality) : undefined,
        language ? sql`${language} = ANY(${schema.services.languages})` : undefined,
      ];
      const rows = await deps.db
        .select()
        .from(schema.services)
        .where(and(...filters))
        .orderBy(asc(schema.services.name), asc(schema.services.id));
      // The order is by the English name in both languages, so a service sits in the same place whichever language is asked for.
      return rows.map(({ nameAr, ...service }) => ({ ...service, name: localized(service.name, nameAr, locale) }));
    },
  );
}
