import { computeDeadline } from '@mawsool/rules';
import {
  AGE_BANDS,
  SHORT_CODE_ALPHABET,
  type Actor,
  type CareLanguage,
  type CrisisNumber,
  type TicketSource,
  type TicketState,
  type Tier,
} from '@mawsool/types';
import type { schema } from '../db/client';
import { sha256Hex } from '../security';
import { INVITE_TTL_MS } from '../inbound/service';
import {
  FACILITIES,
  FACILITY_A_ID,
  FACILITY_B_ID,
  INSURANCE_BY_TIER,
  SEED_ANCHOR,
  SERVICES,
  SERVICE_NAMES_AR,
  STAFF,
} from './fixtures';
import { createRng, type Rng } from './prng';

/** The insert shape of a table, with its id required: every seeded row carries a deterministic id. */
type Insert<T extends { $inferInsert: unknown }> = T['$inferInsert'] & { id: string };

export interface SeedData {
  facilities: Insert<typeof schema.facilities>[];
  services: Insert<typeof schema.services>[];
  staffUsers: Insert<typeof schema.staffUsers>[];
  persons: Insert<typeof schema.persons>[];
  tickets: Insert<typeof schema.tickets>[];
  ticketEvents: Insert<typeof schema.ticketEvents>[];
  crisisEvents: Insert<typeof schema.crisisEvents>[];
  inboundInvites: Insert<typeof schema.inboundInvites>[];
}

/** Sizes the spec and plan fix. */
export const TICKET_COUNT = 500;
export const URDU_TICKET_COUNT = 60;
/**
 * Tickets that reached `seen` or later, by group. With 28 of 60 Urdu tickets (46.7%) and 308 of 440 others
 * (70.0%) the overall rate is 67.2%, so Urdu sits 20.5 points below overall: the planted equity gap.
 */
export const LOOP_CLOSED_URDU = 28;
export const LOOP_CLOSED_OTHER = 308;
const REROUTED_PARENTS = { urdu: 4, other: 26 };
const CRISIS_EVENT_COUNT = 40;
/** Of the 40: this many tapped a number, and of those this many also confirmed they reached someone. */
const CRISIS_TAPPED = 28;
const CRISIS_CONFIRMED = 16;
const HISTORY_DAYS = 90;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SEED_NAME = 'mawsool-seed-v1';

type Outcome =
  | 'seen_ontime'
  | 'seen_late'
  | 'seen_remeasured'
  | 'seen_withdrawn'
  | 'open'
  | 'overdue'
  | 'declined'
  | 'withdrawn'
  | 'rerouted';

interface Slot {
  language: CareLanguage;
  closed: boolean;
  role: 'root' | 'parent' | 'child';
  /** For a child: index of its parent slot. */
  parent?: number;
}

interface EventDraft {
  fromState: TicketState | null;
  toState: TicketState;
  actor: Actor;
  channel: string;
  reason: string | null;
  selfConfirmed: boolean;
  at: number;
}

const NON_LANGUAGES_URDU: [CareLanguage, number][] = [
  ['ar', 0.45],
  ['en', 0.3],
  ['hi', 0.1],
  ['tl', 0.1],
  ['other', 0.05],
];

function between(rng: Rng, from: number, to: number): number {
  return Math.floor(from + rng.next() * (to - from));
}

function windowDaysFor(rng: Rng, tier: Tier): number {
  if (tier === 'specialist' || tier === 'community') return 14;
  if (tier === 'tele') return 7;
  return rng.weighted([
    [7, 0.7],
    [14, 0.3],
  ]);
}

/** Days after issue that the timeline of an outcome needs, so that every event falls before the anchor. */
function spanDays(outcome: Outcome, windowDays: number): number {
  switch (outcome) {
    case 'seen_ontime':
      return windowDays + 1;
    case 'seen_late':
      return windowDays + 12;
    case 'seen_remeasured':
      return windowDays + 62;
    case 'seen_withdrawn':
      return windowDays + 22;
    case 'overdue':
      return windowDays + 2;
    case 'declined':
      return 8;
    case 'withdrawn':
      return 12;
    case 'rerouted':
    case 'open':
      return 0;
  }
}

class Timeline {
  readonly events: EventDraft[] = [];

  constructor(private readonly anchorMs: number) {}

  get last(): EventDraft | undefined {
    return this.events.at(-1);
  }

  push(toState: TicketState, actor: Actor, channel: string, at: number, extra: { reason?: string; selfConfirmed?: boolean } = {}): number {
    const previous = this.last;
    const when = previous ? Math.max(at, previous.at + 1000) : at;
    if (when > this.anchorMs) throw new Error(`seed event at ${new Date(when).toISOString()} falls after the anchor`);
    this.events.push({
      fromState: previous?.toState ?? null,
      toState,
      actor,
      channel,
      reason: extra.reason ?? null,
      selfConfirmed: extra.selfConfirmed ?? false,
      at: when,
    });
    return when;
  }
}

const REROUTE_REASONS = ['could_not_book', 'cost', 'wait_too_long', 'other'];

/** Builds the event list for one ticket. `createdAt` and `deadline` are in epoch milliseconds. */
function buildTimeline(
  rng: Rng,
  anchorMs: number,
  outcome: Outcome,
  createdAt: number,
  deadline: number,
  windowDays: number,
): EventDraft[] {
  const t = new Timeline(anchorMs);
  t.push('issued', 'person', 'app', createdAt);
  const maybeAcknowledge = (probability: number, latest: number): void => {
    if (rng.next() < probability) t.push('acknowledged', 'clinic', 'portal', Math.min(between(rng, createdAt + HOUR, createdAt + 48 * HOUR), latest));
  };
  const seenOnTime = (): number => {
    const acknowledged = rng.next() < 0.8;
    if (acknowledged) {
      t.push('acknowledged', 'clinic', 'portal', between(rng, createdAt + HOUR, createdAt + 48 * HOUR));
      return t.push('seen', 'clinic', 'portal', between(rng, t.last!.at + 2 * HOUR, deadline - HOUR));
    }
    // No acknowledgement: the person confirms on the day-7 check, or at the deadline if that comes first.
    return t.push('seen', 'person', 'app', Math.min(createdAt + 7 * DAY, deadline - HOUR), { selfConfirmed: true });
  };
  const overdueAt = deadline + between(rng, 1000, 60_000);

  switch (outcome) {
    case 'seen_ontime':
      seenOnTime();
      break;
    case 'seen_late': {
      maybeAcknowledge(0.3, deadline - DAY);
      const overdue = t.push('overdue', 'system', 'sweep', overdueAt);
      if (rng.next() < 0.25) t.push('seen', 'person', 'app', between(rng, overdue + HOUR, overdue + 10 * DAY), { selfConfirmed: true });
      else t.push('seen', 'clinic', 'portal', between(rng, overdue + HOUR, overdue + 10 * DAY));
      break;
    }
    case 'seen_remeasured': {
      const seen = seenOnTime();
      const remeasured = t.push('remeasured', 'person', 'app', between(rng, seen + 42 * DAY, seen + 56 * DAY));
      t.push('closed', 'system', 'sweep', between(rng, remeasured + DAY, remeasured + 3 * DAY));
      break;
    }
    case 'seen_withdrawn': {
      const seen = seenOnTime();
      t.push('withdrawn', 'person', 'app', between(rng, seen + DAY, seen + 20 * DAY));
      break;
    }
    case 'open':
      // Created recently enough that the deadline is still ahead of the anchor.
      if (rng.next() < 0.6) {
        const ackAt = between(rng, createdAt + HOUR, createdAt + 36 * HOUR);
        if (ackAt < anchorMs - 60_000) t.push('acknowledged', 'clinic', 'portal', ackAt);
      }
      break;
    case 'overdue':
      maybeAcknowledge(0.4, deadline - DAY);
      t.push('overdue', 'system', 'sweep', overdueAt);
      break;
    case 'declined': {
      maybeAcknowledge(0.3, createdAt + 2 * DAY);
      t.push('declined', 'person', 'app', between(rng, createdAt + 2 * DAY, createdAt + 6 * DAY));
      break;
    }
    case 'withdrawn':
      t.push('withdrawn', 'person', 'app', between(rng, createdAt + DAY, createdAt + 10 * DAY));
      break;
    case 'rerouted': {
      const reason = rng.pick(REROUTE_REASONS);
      maybeAcknowledge(0.3, createdAt + 3 * DAY);
      if (rng.next() < 0.7) {
        const overdue = t.push('overdue', 'system', 'sweep', overdueAt);
        t.push('rerouted', 'person', 'app', between(rng, overdue + HOUR, overdue + 3 * DAY), { reason });
      } else {
        // "Not yet" or "Change option" before the deadline.
        t.push('rerouted', 'person', 'app', between(rng, createdAt + 4 * DAY, createdAt + windowDays * DAY), { reason });
      }
      break;
    }
  }
  return t.events;
}

/**
 * Unclaimed invites the seed leaves open, by front door. Each is unexpired at the seed's own reference time (the anchor), and
 * each was handed over in the 12 hours before it, so it is still open 28 days later (the demo moves the clock that far
 * before it shows the dashboard) and each front door has the ten or more that its first funnel stage needs to be shown.
 */
export const SEED_OPEN_INVITES = { phc: 12, tamm: 12, school: 12 } as const;
/** Unclaimed invites that had already expired by the anchor, so they must not be counted as positive screens. */
export const SEED_EXPIRED_INVITES = 4;
/** Invites claimed by the person of a seeded front-door ticket, so a claimed invite and its ticket are in the data once each. */
export const SEED_CLAIMED_INVITES = 12;

type InviteRow = Insert<typeof schema.inboundInvites>;

/**
 * The seed's invites. Their codes are not known to anyone (only a hash of a throwaway value is stored), so none of them
 * can be claimed; they exist to be counted. Dates are relative to the anchor, never to the wall clock: open ones were
 * created between 1 and 12 hours before it, so they expire about 30 days after it, and expired ones expired between 5
 * and 30 days before it.
 */
function buildInvites(rng: Rng, anchorMs: number, tickets: SeedData['tickets'], persons: SeedData['persons']): InviteRow[] {
  const rows: InviteRow[] = [];
  const add = (source: InviteRow['source'], createdAt: number, locale: 'ar' | 'en', claim?: { personId: string; claimedAt: number; ticketId: string }): void => {
    const id = rng.uuid();
    rows.push({
      id,
      source,
      codeHash: sha256Hex(`seed-invite-${id}`),
      screenedAt: new Date(createdAt - between(rng, HOUR, 12 * HOUR)),
      locale,
      createdAt: new Date(createdAt),
      expiresAt: new Date(createdAt + INVITE_TTL_MS),
      claimedBy: claim?.personId ?? null,
      claimedAt: claim ? new Date(claim.claimedAt) : null,
      ticketId: claim?.ticketId ?? null,
    });
  };
  for (const [source, count] of Object.entries(SEED_OPEN_INVITES) as [keyof typeof SEED_OPEN_INVITES, number][]) {
    for (let i = 0; i < count; i += 1) add(source, anchorMs - between(rng, HOUR, 12 * HOUR), rng.weighted<'ar' | 'en'>([['ar', 0.6], ['en', 0.4]]));
  }
  for (let i = 0; i < SEED_EXPIRED_INVITES; i += 1) {
    add(rng.pick(['phc', 'tamm', 'school'] as const), anchorMs - INVITE_TTL_MS - between(rng, 5 * DAY, 30 * DAY), 'ar');
  }
  const localeOf = new Map(persons.map((person) => [person.id, person.locale]));
  const frontDoorTickets = tickets.filter((ticket) => ticket.parentTicketId === null && ticket.source !== 'app').sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime() || a.id.localeCompare(b.id));
  for (const ticket of frontDoorTickets.slice(0, SEED_CLAIMED_INVITES)) {
    const claimedAt = ticket.createdAt!.getTime() - HOUR;
    add(ticket.source, claimedAt - between(rng, HOUR, 2 * DAY), localeOf.get(ticket.personId) ?? 'en', { personId: ticket.personId, claimedAt, ticketId: ticket.id });
  }
  return rows;
}

/**
 * Generates every seed row in memory. Pure and deterministic: the same `anchor` always yields identical rows,
 * and nothing reads the wall clock.
 *
 * Contents: 2 facilities and 24 sample services (all but the 6 self-help ones tied to a facility), demo staff,
 * 500 tickets over 90 days with chains of rerouted tickets, 40 crisis events, and equity buckets for the
 * persons who opted in. Tickets come from every source. The loop-closed rate (a ticket reached `seen` or later)
 * is planted at 46.7% for Urdu-language tickets against 70.0% for the rest.
 */
export function generateSeed(anchor: Date = SEED_ANCHOR): SeedData {
  const rng = createRng(SEED_NAME);
  const anchorMs = anchor.getTime();
  const start = anchorMs - HISTORY_DAYS * DAY;

  // Reference data.
  const facilityIds = { A: FACILITY_A_ID, B: FACILITY_B_ID };
  const services: SeedData['services'] = SERVICES.map((fixture) => ({
    id: rng.uuid(),
    name: fixture.name,
    nameAr: SERVICE_NAMES_AR[fixture.name] ?? null,
    tier: fixture.tier,
    modality: fixture.modality,
    languages: fixture.languages,
    clinicianGenders: fixture.genders,
    insuranceClasses: INSURANCE_BY_TIER[fixture.tier],
    region: fixture.region,
    indicativeWaitDays: rng.int(fixture.waitDays[0], fixture.waitDays[1]),
    facilityId: fixture.facility === null ? null : facilityIds[fixture.facility],
    sample: true,
  }));
  const ticketServices = services.filter((service) => service.tier !== 'self_help');

  // Slots: language and the planted loop-closed quota per group.
  const urduClosed = rng.shuffle([...Array<boolean>(LOOP_CLOSED_URDU).fill(true), ...Array<boolean>(URDU_TICKET_COUNT - LOOP_CLOSED_URDU).fill(false)]);
  const otherCount = TICKET_COUNT - URDU_TICKET_COUNT;
  const otherClosed = rng.shuffle([...Array<boolean>(LOOP_CLOSED_OTHER).fill(true), ...Array<boolean>(otherCount - LOOP_CLOSED_OTHER).fill(false)]);
  const slots: Slot[] = [
    ...urduClosed.map((closed): Slot => ({ language: 'ur', closed, role: 'root' })),
    ...otherClosed.map((closed): Slot => ({ language: rng.weighted(NON_LANGUAGES_URDU), closed, role: 'root' })),
  ];

  // Reroute chains: parents are never loop-closed (a rerouted ticket never reached `seen`).
  const assignChains = (group: (slot: Slot) => boolean, parents: number): void => {
    const indices = slots.flatMap((slot, i) => (group(slot) ? [i] : []));
    const parentIdx = rng.shuffle(indices.filter((i) => !slots[i]!.closed)).slice(0, parents);
    for (const p of parentIdx) slots[p]!.role = 'parent';
    for (const p of parentIdx) {
      const child = rng.shuffle(indices.filter((i) => slots[i]!.role === 'root'))[0]!;
      slots[child]!.role = 'child';
      slots[child]!.parent = p;
    }
  };
  assignChains((slot) => slot.language === 'ur', REROUTED_PARENTS.urdu);
  assignChains((slot) => slot.language !== 'ur', REROUTED_PARENTS.other);

  // Decide outcomes.
  const outcomeFor = (slot: Slot): Outcome => {
    if (slot.role === 'parent') return 'rerouted';
    if (slot.closed) {
      return slot.role === 'child'
        ? rng.weighted<Outcome>([['seen_ontime', 0.6], ['seen_late', 0.3], ['seen_withdrawn', 0.1]])
        : rng.weighted<Outcome>([['seen_ontime', 0.58], ['seen_late', 0.2], ['seen_remeasured', 0.17], ['seen_withdrawn', 0.05]]);
    }
    return slot.role === 'child'
      ? rng.weighted<Outcome>([['overdue', 0.6], ['declined', 0.25], ['withdrawn', 0.15]])
      : rng.weighted<Outcome>([['open', 0.3], ['overdue', 0.35], ['declined', 0.2], ['withdrawn', 0.15]]);
  };
  const outcomes = slots.map(outcomeFor);

  const persons: SeedData['persons'] = [];
  const tickets: SeedData['tickets'] = [];
  const ticketEvents: SeedData['ticketEvents'] = [];
  const usedCodes = new Set<string>();
  const personOfSlot = new Map<number, string>();
  const rerouteTimeOfSlot = new Map<number, number>();
  const serviceOfSlot = new Map<number, (typeof services)[number]>();
  const ticketIdOfSlot = new Map<number, string>();

  const newShortCode = (): string => {
    for (;;) {
      const code = `MW${rng.code(4, SHORT_CODE_ALPHABET)}`;
      if (!usedCodes.has(code)) {
        usedCodes.add(code);
        return code;
      }
    }
  };

  const buildTicket = (index: number): void => {
    const slot = slots[index]!;
    const outcome = outcomes[index]!;
    const parentSlot = slot.role === 'child' ? slot.parent! : null;

    // Service: a different one from the parent for a rerouted child; otherwise weighted by tier.
    const tier = rng.weighted<Tier>([['community', 0.14], ['tele', 0.16], ['gp', 0.42], ['specialist', 0.28]]);
    const pool = ticketServices.filter((s) => s.tier === tier);
    const speaking = pool.filter((s) => s.languages.includes(slot.language));
    const candidates = (speaking.length > 0 ? speaking : pool).filter((s) => s !== (parentSlot === null ? null : serviceOfSlot.get(parentSlot)));
    const service = rng.pick(candidates);
    serviceOfSlot.set(index, service);

    const windowDays = windowDaysFor(rng, service.tier);
    let createdAt: number;
    if (parentSlot !== null) {
      createdAt = rerouteTimeOfSlot.get(parentSlot)! + between(rng, 5 * 60_000, HOUR);
    } else if (outcome === 'open') {
      createdAt = between(rng, anchorMs - (windowDays - 1) * DAY, anchorMs - 2 * HOUR);
    } else if (outcome === 'rerouted') {
      createdAt = between(rng, start, anchorMs - 45 * DAY);
    } else {
      createdAt = between(rng, start, anchorMs - spanDays(outcome, windowDays) * DAY);
    }
    const deadline = computeDeadline(new Date(createdAt), windowDays).getTime();
    const events = buildTimeline(rng, anchorMs, outcome, createdAt, deadline, windowDays);

    // Person: one per root ticket; a rerouted child belongs to the same person as its parent.
    let personId: string;
    if (parentSlot !== null) {
      personId = personOfSlot.get(parentSlot)!;
    } else {
      personId = rng.uuid();
      const optedIn = rng.next() < 0.72;
      persons.push({
        id: personId,
        // A stand-in hash: seeded persons have no device and cannot sign in.
        secretHash: sha256Hex(`seed-person-${personId}`),
        locale: slot.language === 'ar' ? 'ar' : rng.weighted<'ar' | 'en'>([['ar', 0.2], ['en', 0.8]]),
        equityOptIn: optedIn,
        ageBand: optedIn ? rng.weighted([...AGE_BANDS.map((band, i) => [band, [0.03, 0.25, 0.3, 0.2, 0.12, 0.1][i]!] as const)]) : null,
        gender: optedIn ? rng.weighted([['female', 0.5], ['male', 0.45], ['another', 0.05]] as const) : null,
        language: optedIn ? slot.language : null,
        region: optedIn ? service.region : null,
        createdAt: new Date(createdAt - between(rng, 0, 14 * DAY)),
      });
    }
    personOfSlot.set(index, personId);

    const ticketId = rng.uuid();
    ticketIdOfSlot.set(index, ticketId);
    const finalEvent = events.at(-1)!;
    if (outcome === 'rerouted') rerouteTimeOfSlot.set(index, finalEvent.at);

    const source: TicketSource = parentSlot !== null ? 'app' : rng.weighted<TicketSource>([['app', 0.5], ['phc', 0.25], ['tamm', 0.15], ['school', 0.1]]);
    tickets.push({
      id: ticketId,
      shortCode: newShortCode(),
      personId,
      tier: service.tier,
      serviceId: service.id,
      state: finalEvent.toState,
      language: slot.language,
      deadlineAt: new Date(deadline),
      source,
      parentTicketId: parentSlot === null ? null : ticketIdOfSlot.get(parentSlot)!,
      clientRequestId: null,
      createdAt: new Date(createdAt),
    });
    events.forEach((event, i) => {
      ticketEvents.push({
        id: rng.uuid(),
        ticketId,
        seq: i + 1,
        fromState: event.fromState,
        toState: event.toState,
        actor: event.actor,
        channel: event.channel,
        reason: event.reason,
        selfConfirmed: event.selfConfirmed,
        at: new Date(event.at),
      });
    });
  };

  // Roots and parents first, so every child can read its parent's reroute time.
  slots.forEach((slot, i) => {
    if (slot.role !== 'child') buildTicket(i);
  });
  slots.forEach((slot, i) => {
    if (slot.role === 'child') buildTicket(i);
  });

  // Crisis events: no person id, no answers.
  // All 40 fall in the last 60 days, so the default "last 90 days" still holds every one of them 28 days into a demo, and the
  // outcomes are fixed in number (28 tapped a number, 16 of those confirmed contact) so every share on the dashboard has
  // ten or more people on each side of it in that view.
  const crisisPlan = rng.shuffle(Array.from({ length: CRISIS_EVENT_COUNT }, (_, index): 'confirmed' | 'tapped' | 'none' => (index < CRISIS_CONFIRMED ? 'confirmed' : index < CRISIS_TAPPED ? 'tapped' : 'none')));
  const crisisEvents: SeedData['crisisEvents'] = crisisPlan.map((plan) => {
    const shownAt = between(rng, anchorMs - 60 * DAY, anchorMs - DAY);
    const callTapped = plan === 'none' ? null : rng.weighted<CrisisNumber>([['800725462', 0.7], ['999', 0.15], ['998', 0.15]]);
    const confirmed = plan === 'confirmed';
    const resolved = rng.next() < 0.9;
    return {
      id: rng.uuid(),
      trigger: rng.weighted<'phq9_item9' | 'cssrs'>([['phq9_item9', 0.8], ['cssrs', 0.2]]),
      shownAt: new Date(shownAt),
      callTapped,
      contextShared: false,
      humanContactConfirmed: confirmed,
      contactSource: confirmed ? 'self_report' : null,
      contactAt: confirmed ? new Date(shownAt + between(rng, 2 * 60_000, 40 * 60_000)) : null,
      resolvedAt: resolved ? new Date(shownAt + between(rng, 60_000, 60 * 60_000)) : null,
      followUpAt: null,
      locale: rng.weighted<'ar' | 'en'>([['ar', 0.55], ['en', 0.45]]),
    };
  });

  // Invites, drawn after everything above so the rows above stay exactly as they were.
  const inboundInvites = buildInvites(rng, anchorMs, tickets, persons);

  const byTime = <T extends { createdAt?: Date | null; shownAt?: Date }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => (a.createdAt ?? a.shownAt!).getTime() - (b.createdAt ?? b.shownAt!).getTime());

  return {
    facilities: FACILITIES.map((f) => ({ ...f, sample: true })),
    services,
    staffUsers: STAFF.map((s) => ({ ...s, active: true, createdAt: new Date(start) })),
    persons: byTime(persons),
    tickets: byTime(tickets),
    ticketEvents: [...ticketEvents].sort((a, b) => a.ticketId.localeCompare(b.ticketId) || a.seq - b.seq),
    crisisEvents: byTime(crisisEvents),
    inboundInvites: inboundInvites.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)),
  };
}
