import { randomUUID } from 'node:crypto';
import type { AgeBand, CareLanguage, Gender, Region, TicketSource, TicketState, TicketTier } from '@mawsool/types';
import { schema, type Db } from '../../src/db/client';
import { inviteCodeHash } from '../../src/inbound/service';
import { sha256Hex } from '../../src/security';
import { FACILITY_A_ID } from '../../src/seed/fixtures';

/** A tiny database the metrics tests build by hand, so every count in an assertion is one the test put there. */
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export interface WorldTicket {
  tier?: TicketTier;
  source?: TicketSource;
  language?: CareLanguage;
  /** The states the ticket moved through after `issued`, in order, one event each, an hour apart from `issuedAt`. */
  path?: TicketState[];
  issuedAt: Date;
  /** Defaults to 7 days after issue. */
  deadlineAt?: Date;
  parent?: string;
  person?: string;
  /** Hours after issue for each event in `path`; defaults to 1, 2, 3 and so on. */
  hours?: number[];
}

export interface WorldPerson {
  optIn?: boolean;
  /** The separate choice to count shared totals in the anonymous symptom-change figures; off unless said. */
  statsOptIn?: boolean;
  ageBand?: AgeBand;
  gender?: Gender;
  region?: Region;
  language?: CareLanguage;
}

/** Creates the facility and one service per tier, and hands back helpers that insert people, tickets, invites and crisis events. */
export async function createWorld(db: Db) {
  await db.insert(schema.facilities).values({ id: FACILITY_A_ID, name: 'Sample facility', region: 'abu_dhabi_city', contactText: 'Sample', sample: true });
  const services: Record<string, string> = {};
  for (const tier of ['community', 'tele', 'gp', 'specialist'] as const) {
    const id = randomUUID();
    services[tier] = id;
    await db.insert(schema.services).values({ id, name: `Sample ${tier}`, tier, modality: 'in_person', languages: ['en'], clinicianGenders: [], insuranceClasses: [], region: 'abu_dhabi_city', indicativeWaitDays: 3, facilityId: FACILITY_A_ID, sample: true });
  }
  let codes = 0;

  const addPerson = async (person: WorldPerson = {}): Promise<string> => {
    const id = randomUUID();
    await db.insert(schema.persons).values({
      id,
      secretHash: 'x',
      locale: 'en',
      equityOptIn: person.optIn ?? false,
      outcomeStatsOptIn: person.statsOptIn ?? false,
      ageBand: person.optIn ? (person.ageBand ?? null) : null,
      gender: person.optIn ? (person.gender ?? null) : null,
      region: person.optIn ? (person.region ?? null) : null,
      language: person.optIn ? (person.language ?? null) : null,
      createdAt: new Date(0),
    });
    return id;
  };

  const addTicket = async (ticket: WorldTicket): Promise<{ id: string; personId: string; shortCode: string }> => {
    const id = randomUUID();
    const personId = ticket.person ?? (await addPerson());
    const path = ticket.path ?? [];
    const tier = ticket.tier ?? 'gp';
    const shortCode = `MW${String(1000 + (codes += 1))}`;
    await db.insert(schema.tickets).values({
      id,
      shortCode,
      personId,
      tier,
      serviceId: services[tier]!,
      state: path.at(-1) ?? 'issued',
      language: ticket.language ?? 'en',
      deadlineAt: ticket.deadlineAt ?? new Date(ticket.issuedAt.getTime() + 7 * DAY),
      source: ticket.source ?? 'app',
      parentTicketId: ticket.parent ?? null,
      createdAt: ticket.issuedAt,
    });
    const states: TicketState[] = ['issued', ...path];
    await db.insert(schema.ticketEvents).values(
      states.map((to, index) => ({
        ticketId: id,
        seq: index + 1,
        fromState: index === 0 ? null : states[index - 1]!,
        toState: to,
        actor: 'system' as const,
        channel: 'test',
        at: new Date(ticket.issuedAt.getTime() + (index === 0 ? 0 : (ticket.hours?.[index - 1] ?? index)) * HOUR),
      })),
    );
    return { id, personId, shortCode };
  };

  const addInvite = async (invite: { source: 'phc' | 'tamm' | 'school'; createdAt: Date; expiresAt: Date; claimedBy?: string; ticketId?: string }): Promise<string> => {
    const id = randomUUID();
    codes += 1;
    await db.insert(schema.inboundInvites).values({
      id,
      source: invite.source,
      codeHash: inviteCodeHash(`WORLD${codes}`),
      screenedAt: invite.createdAt,
      locale: 'en',
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      claimedBy: invite.claimedBy ?? null,
      claimedAt: invite.claimedBy ? invite.createdAt : null,
      ticketId: invite.ticketId ?? null,
    });
    return id;
  };

  const addCrisis = async (event: { shownAt: Date; called?: boolean; contactMinutes?: number }): Promise<void> => {
    await db.insert(schema.crisisEvents).values({
      id: randomUUID(),
      trigger: 'phq9_item9',
      shownAt: event.shownAt,
      callTapped: event.called ? '800725462' : null,
      humanContactConfirmed: event.contactMinutes !== undefined,
      contactSource: event.contactMinutes !== undefined ? 'self_report' : null,
      contactAt: event.contactMinutes !== undefined ? new Date(event.shownAt.getTime() + event.contactMinutes * 60_000) : null,
      locale: 'en',
    });
  };

  /** Inserts `count` identical tickets, each for its own person. */
  const addMany = async (count: number, ticket: WorldTicket, person?: WorldPerson): Promise<void> => {
    for (let i = 0; i < count; i += 1) await addTicket({ ...ticket, person: await addPerson(person) });
  };

  /** An ops user with a live session, and the bearer header to call a metrics route with. */
  const opsHeaders = async (): Promise<{ authorization: string }> => {
    const staffUserId = randomUUID();
    await db.insert(schema.staffUsers).values({ id: staffUserId, email: `ops-${staffUserId}@demo.test`, name: 'Ops', role: 'ops', facilityId: null, active: true, createdAt: new Date(0) });
    const token = `world-ops-${staffUserId}`;
    await db.insert(schema.staffSessions).values({ staffUserId, tokenHash: sha256Hex(token), createdAt: new Date(0), expiresAt: new Date('2100-01-01T00:00:00Z') });
    return { authorization: `Bearer ${token}` };
  };

  return { services, addPerson, addTicket, addInvite, addCrisis, addMany, opsHeaders };
}
