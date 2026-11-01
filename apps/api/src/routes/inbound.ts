import { ClaimInviteRequestSchema, ClaimedInviteSchema, ErrorResponseSchema, InboundScreenReceiptSchema, InboundScreenRequestSchema } from '@mawsool/types';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Clock } from '../clock';
import type { Db } from '../db/client';
import { claimInvite, createInvite, formatInviteCode } from '../inbound/service';
import { personIdOf, sendError } from '../plugins/auth';

export interface InboundRouteDeps {
  db: Db;
  clock: Clock;
  /** Where a person opens the claim link. */
  personAppUrl: string;
}

/** The link a front door shows the person: the person app's claim screen, in the language the screen was taken in, with the code. */
export function claimUrl(personAppUrl: string, locale: string, code: string): string {
  return `${personAppUrl}/${locale}/claim/?code=${encodeURIComponent(code)}`;
}

/**
 * The connector side of a front-door hand-over.
 *
 * `POST /inbound/screens` is `inbound` access: the shared auth hook refuses it unless it carries a valid per-source
 * signature, a timestamp inside the window and a nonce not seen before. It lives in its own scope so that its body
 * parser keeps the raw bytes the signature covers; no other route is affected. It creates an invite, never a ticket.
 *
 * `POST /me/invites/claim` is the person's side: the code (typed or from the link) binds the invite to their device.
 */
export function registerInboundRoutes(app: FastifyInstance, deps: InboundRouteDeps): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 4096 }, (request, body, done) => {
      request.rawBody = body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(Object.assign(new Error('The body is not valid JSON'), { statusCode: 400 }), undefined);
      }
    });

    scope.withTypeProvider<ZodTypeProvider>().post(
      '/inbound/screens',
      {
        config: { access: 'inbound' },
        schema: { body: InboundScreenRequestSchema, response: { 201: InboundScreenReceiptSchema, 400: ErrorResponseSchema, 401: ErrorResponseSchema } },
      },
      async (request, reply) => {
        const created = await createInvite(deps.db, deps.clock, request.inboundSource!, request.body);
        return reply.code(201).send({
          inviteId: created.inviteId,
          code: formatInviteCode(created.code),
          claimUrl: claimUrl(deps.personAppUrl, request.body.locale, formatInviteCode(created.code)),
          expiresAt: created.expiresAt.toISOString(),
        });
      },
    );
  });

  app.withTypeProvider<ZodTypeProvider>().post(
    '/me/invites/claim',
    { config: { access: 'person' }, schema: { body: ClaimInviteRequestSchema, response: { 200: ClaimedInviteSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema } } },
    async (request, reply) => {
      const claimed = await claimInvite(deps.db, deps.clock, personIdOf(request), request.body.code);
      if (claimed.kind === 'not_found') return sendError(reply, 404, 'not_found', 'This code is not valid or has expired');
      return { inviteId: claimed.invite.id, source: claimed.invite.source, screenedAt: claimed.invite.screenedAt.toISOString() };
    },
  );
}
