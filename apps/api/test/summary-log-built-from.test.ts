import type { SummaryPrompt, SummaryProvider } from '@mawsool/summary';
import type { ConsentElement } from '@mawsool/types';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { runSeed } from '../src/seed/run';
import { summaryLogContext } from '../src/tickets/service';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { FREE_TEXT, cipher, issue, rawBundle, registerPerson, serviceAt, ticketRequest, type TestPerson } from './helpers/flow';

const PROVIDER_TEXT = 'PROVIDER-WORDS-FROM-THE-NOTE';

class StubProvider implements SummaryProvider {
  async complete(_prompt: SummaryPrompt): Promise<string> {
    return PROVIDER_TEXT;
  }
}

/**
 * Every logged summary records the consent elements it was made from. Stopping an element deletes this person's rows
 * that hold it, whether or not an approved summary goes with it. Raw rows throughout; the provider is a stub.
 */
describe('logged summaries and the elements they were made from', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let gpA: string;
  let person: TestPerson;
  let other: TestPerson;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    ctx = await createTestApp(testDb.db, { summaryLlmEnabled: true, summaryProvider: new StubProvider() });
    gpA = await serviceAt(testDb.db, 'A', 'gp');
    person = await registerPerson(ctx);
    other = await registerPerson(ctx);
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  /** A draft the AI writes from the given consented elements. */
  const aiDraft = async (who: TestPerson, requestId: string, consented: ConsentElement[]) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/summary/draft',
      headers: who.headers,
      payload: { requestId, locale: 'en', useAi: true, consented, content: { free_text: FREE_TEXT, scores: [{ instrument: 'phq9', total: 12, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' }] } },
    });
    expect(res.json()).toMatchObject({ source: 'ai', text: PROVIDER_TEXT });
  };
  const rowsOf = (who: TestPerson, requestId: string) =>
    testDb.db
      .select()
      .from(schema.summaryLogs)
      .where(and(eq(schema.summaryLogs.personId, who.id), eq(schema.summaryLogs.requestId, requestId)));
  const stop = (ticket: { consents: { id: string; element: string }[] }, element: string) =>
    ctx.app.inject({ method: 'DELETE', url: `/consents/${ticket.consents.find((c) => c.element === element)!.id}`, headers: person.headers });

  it('records the consented elements on a draft, once each, and keeps the text bound to its row', async () => {
    const requestId = crypto.randomUUID();
    await aiDraft(person, requestId, ['ticket', 'free_text', 'free_text']);
    const [row] = await rowsOf(person, requestId);
    expect([...row!.builtFrom].sort()).toEqual(['free_text', 'ticket']);
    expect(row!.ciphertext).not.toContain(PROVIDER_TEXT);
    expect(cipher.decrypt(row!.ciphertext, summaryLogContext(person.id, requestId, 'draft'))).toBe(PROVIDER_TEXT);
    expect(() => cipher.decrypt(row!.ciphertext, summaryLogContext(person.id, requestId, 'approved'))).toThrow();
  });

  it('deletes a draft made with the note when the note is stopped, though the ticket claimed it and no summary was approved', async () => {
    const requestId = crypto.randomUUID();
    const othersRequest = crypto.randomUUID();
    await aiDraft(person, requestId, ['ticket', 'free_text']);
    await aiDraft(other, othersRequest, ['ticket', 'free_text']);
    const ticket = await issue(ctx, person, ticketRequest(gpA, { clientRequestId: requestId, summaryRequestId: requestId, approvedSummary: null }));
    const [claimed] = await rowsOf(person, requestId);
    expect(claimed!.ticketId).toBe(ticket.id);

    const res = await stop(ticket, 'free_text');
    expect(res.json()).toMatchObject({ summaryRemoved: false });
    expect(await rowsOf(person, requestId)).toHaveLength(0);
    expect(await rowsOf(other, othersRequest)).toHaveLength(1); // someone else's rows are never touched
  });

  it('deletes the first draft, made with the note, when the note is stopped, and keeps the second draft and the approved text made without it', async () => {
    const requestId = crypto.randomUUID();
    await aiDraft(person, requestId, ['ticket', 'scores', 'free_text']);
    await aiDraft(person, requestId, ['ticket', 'scores']);
    const ticket = await issue(
      ctx,
      person,
      ticketRequest(gpA, { clientRequestId: requestId, summaryRequestId: requestId, approvedSummary: 'APPROVED-WITHOUT-THE-NOTE', summaryBuiltFrom: ['ticket', 'scores'] }),
    );
    const before = await rowsOf(person, requestId);
    expect(before).toHaveLength(3);
    const approved = before.find((row) => row.kind === 'approved')!;
    expect([...approved.builtFrom].sort()).toEqual(['scores', 'ticket']); // the ticket's stored list

    const res = await stop(ticket, 'free_text');
    expect(res.json()).toMatchObject({ summaryRemoved: false });
    const after = await rowsOf(person, requestId);
    expect(after.map((row) => row.id).sort()).toEqual(before.filter((row) => !row.builtFrom.includes('free_text')).map((row) => row.id).sort());
    expect(after).toHaveLength(2);
    expect(after.some((row) => row.builtFrom.includes('free_text'))).toBe(false);
    expect((await rawBundle(testDb.db, ticket.id)).approvedSummaryCiphertext).not.toBeNull();
  });

  it('deletes a draft left unlinked under the ticket’s request id when the page reloaded before the send', async () => {
    const requestId = crypto.randomUUID();
    await aiDraft(person, requestId, ['ticket', 'free_text']); // the page reloaded: the send below carries no summaryRequestId
    const ticket = await issue(ctx, person, ticketRequest(gpA, { clientRequestId: requestId, summaryRequestId: null, approvedSummary: null }));
    const [unlinked] = await rowsOf(person, requestId);
    expect(unlinked!.ticketId).toBeNull();
    expect((await stop(ticket, 'free_text')).json()).toMatchObject({ summaryRemoved: false });
    expect(await rowsOf(person, requestId)).toHaveLength(0);
  });

  it('leaves a row made without the stopped element', async () => {
    const requestId = crypto.randomUUID();
    await aiDraft(person, requestId, ['ticket', 'scores']);
    const ticket = await issue(ctx, person, ticketRequest(gpA, { clientRequestId: requestId, summaryRequestId: requestId }));
    expect((await stop(ticket, 'free_text')).json()).toMatchObject({ summaryRemoved: false });
    expect(await rowsOf(person, requestId)).toHaveLength(1);
  });

  it('still removes every log of the ticket when the stopped element is one the approved summary was built from', async () => {
    const requestId = crypto.randomUUID();
    await aiDraft(person, requestId, ['ticket', 'free_text']);
    const ticket = await issue(ctx, person, ticketRequest(gpA, { clientRequestId: requestId, summaryRequestId: requestId, approvedSummary: 'APPROVED-FROM-THE-NOTE', summaryBuiltFrom: ['free_text'] }));
    expect((await stop(ticket, 'free_text')).json()).toMatchObject({ summaryRemoved: true });
    expect(await rowsOf(person, requestId)).toHaveLength(0);
  });
});
