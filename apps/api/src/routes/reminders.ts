import { ErrorResponseSchema, ReminderPhoneRequestSchema, ReminderPhoneResultSchema, ReminderSampleResultSchema } from '@mawsool/types';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { personIdOf } from '../plugins/auth';
import { removeReminderPhone, saveReminderPhone, sendReminderSample, type ReminderSampleDeps } from '../reminders/service';
import { sendError } from '../plugins/auth';

/**
 * The optional number for text reminders. A person who has not turned reminders on, or chose not to give a number,
 * never calls these. Both act on the caller's own row only, and neither answers with the number.
 */
export function registerReminderRoutes(app: FastifyInstance, deps: ReminderSampleDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.put(
    '/me/reminder-phone',
    { config: { access: 'person' }, schema: { body: ReminderPhoneRequestSchema, response: { 200: ReminderPhoneResultSchema, 400: ErrorResponseSchema } } },
    async (request) => {
      await saveReminderPhone(deps, personIdOf(request), request.body);
      return { stored: true, intervalWeeks: request.body.intervalWeeks };
    },
  );

  // A sample of the text reminder, for the number this person gave. It goes to the mock notifier and nothing is sent.
  typed.post(
    '/me/reminder-phone/sample',
    { config: { access: 'person' }, schema: { response: { 200: ReminderSampleResultSchema, 404: ErrorResponseSchema, 502: ErrorResponseSchema } } },
    async (request, reply) => {
      const result = await sendReminderSample(deps, personIdOf(request));
      if (result === 'none') return sendError(reply, 404, 'not_found', 'No number is stored');
      if (result === 'failed') return sendError(reply, 502, 'not_delivered', 'The sample could not be prepared');
      return { sample: true as const, nothingSent: true as const };
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
