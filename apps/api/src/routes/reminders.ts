import { ErrorResponseSchema, ReminderPhoneRequestSchema, ReminderPhoneResultSchema } from '@mawsool/types';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { personIdOf } from '../plugins/auth';
import { removeReminderPhone, saveReminderPhone, type ReminderDeps } from '../reminders/service';

/**
 * The optional number for text reminders. A person who has not turned reminders on, or chose not to give a number,
 * never calls these. Both act on the caller's own row only, and neither answers with the number.
 */
export function registerReminderRoutes(app: FastifyInstance, deps: ReminderDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.put(
    '/me/reminder-phone',
    { config: { access: 'person' }, schema: { body: ReminderPhoneRequestSchema, response: { 200: ReminderPhoneResultSchema, 400: ErrorResponseSchema } } },
    async (request) => {
      await saveReminderPhone(deps, personIdOf(request), request.body);
      return { stored: true, intervalWeeks: request.body.intervalWeeks };
    },
  );

  typed.delete(
    '/me/reminder-phone',
    { config: { access: 'person' }, schema: { response: { 200: ReminderPhoneResultSchema } } },
    async (request) => {
      await removeReminderPhone(deps.db, personIdOf(request));
      return { stored: false, intervalWeeks: null };
    },
  );
}
