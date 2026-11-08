import { ClinicLinkActRequestSchema, ClinicLinkActResultSchema, ClinicLinkCredentialSchema, ClinicLinkTicketSchema, ErrorResponseSchema, PortalAccessRequestSchema } from '@mawsool/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actOnClinicLink, openClinicLink, type ClinicLinkDeps } from '../clinic-links/service';
import { schema } from '../db/client';
import { sendError } from '../plugins/auth';

const Errors = { 401: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 410: ErrorResponseSchema };

/** The one refusal for a link that is not live: unknown, tampered, used, expired, or made for another ticket. */
const invalidLink = (reply: FastifyReply) => sendError(reply, 401, 'invalid_link', 'This link is invalid, expired or already used');

const UUID = z.uuid();

/**
 * The no-login clinic channel: a clinic without portal access gets a signed one-time link (logged, not sent) to acknowledge or
 * mark seen one ticket. A mock channel.
 *
 * Both routes are `clinic_link` access: the credential is the link's token and ticket id, sent in the request body (the link
 * carries them in its URL fragment, which a browser never sends, so no request URL holds them; the link as a whole is logged on
 * purpose, as the mock delivery, like a staff sign-in link). A route here can open or act on the one ticket
 * its link was made for and nothing else; the registry refuses any `clinic_link` route outside `/clinic-link/`.
 *
 *  - `/clinic-link/open` shows what is needed to act (code, tier, state, deadline, the moves open) and writes nothing. It never
 *    returns a bundle, a summary or any score.
 *  - `/clinic-link/act` fires one move the transition table allows the clinic, and spends the link in the same transaction.
 *
 * A credential that is not a live link is 401 with one body, whatever was wrong with it, and nothing is written. Once it is a live
 * link: another facility's ticket is 404 and a ticket whose person ended the share is 410, as on the staff routes.
 *
 * Also here: the admin's switch for whether a facility has the portal (a facility without it is the one that gets links).
 */
export function registerClinicLinkRoutes(app: FastifyInstance, deps: ClinicLinkDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post('/clinic-link/open', { config: { access: 'clinic_link' }, schema: { body: ClinicLinkCredentialSchema, response: { 200: ClinicLinkTicketSchema, ...Errors } } }, async (request, reply) => {
    if (!UUID.safeParse(request.body.ticketId).success) return invalidLink(reply);
    const opened = await openClinicLink(deps, request.body);
    if (opened.kind === 'invalid') return invalidLink(reply);
    if (opened.kind === 'not_found') return sendError(reply, 404, 'not_found', 'Ticket not found');
    if (opened.kind === 'withdrawn') return sendError(reply, 410, 'withdrawn', 'Withdrawn by the person');
    return opened.ticket;
  });

  typed.post('/clinic-link/act', { config: { access: 'clinic_link' }, schema: { body: ClinicLinkActRequestSchema, response: { 200: ClinicLinkActResultSchema, ...Errors } } }, async (request, reply) => {
    if (!UUID.safeParse(request.body.ticketId).success) return invalidLink(reply);
    const { to, ...credential } = request.body;
    const done = await actOnClinicLink(deps, credential, to);
    if (done.kind === 'invalid') return invalidLink(reply);
    if (done.kind === 'not_found') return sendError(reply, 404, 'not_found', 'Ticket not found');
    if (done.kind === 'withdrawn') return sendError(reply, 410, 'withdrawn', 'Withdrawn by the person');
    if (done.kind === 'conflict') return sendError(reply, 409, 'conflict', 'That change is not allowed from the current state');
    return { state: done.state, nextLink: done.nextLink };
  });

  typed.put(
    '/facilities/:id/portal-access',
    {
      config: { access: 'admin' },
      schema: { params: z.object({ id: z.uuid() }), body: PortalAccessRequestSchema, response: { 200: z.object({ id: z.uuid(), portalAccess: z.boolean() }), 404: ErrorResponseSchema } },
    },
    async (request, reply) => {
      const [row] = await deps.db.update(schema.facilities).set({ portalAccess: request.body.portalAccess }).where(eq(schema.facilities.id, request.params.id)).returning({ id: schema.facilities.id, portalAccess: schema.facilities.portalAccess });
      return row ?? sendError(reply, 404, 'not_found', 'Facility not found');
    },
  );
}
