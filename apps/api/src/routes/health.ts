import { HealthResponseSchema } from '@mawsool/types';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    { config: { access: 'public' }, schema: { response: { 200: HealthResponseSchema } } },
    async () => ({ status: 'ok' as const }),
  );
}
