import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  ACTORS,
  AGE_BANDS,
  CARE_LANGUAGES,
  CONSENT_ELEMENTS,
  CRISIS_NUMBERS,
  CRISIS_TRIGGERS,
  GENDERS,
  INSURANCE_CLASSES,
  LOCALES,
  MODALITIES,
  REGIONS,
  STAFF_ROLES,
  TICKET_SOURCES,
  TICKET_STATES,
  TIERS,
} from '@mawsool/types';

/**
 * No column here defaults to the database clock. Every timestamp is written by the application from
 * `clock.ts`, so the demo clock, the sweep and the seed all agree and stay reproducible.
 */
const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const localeEnum = pgEnum('locale', LOCALES);
export const tierEnum = pgEnum('tier', TIERS);
export const modalityEnum = pgEnum('modality', MODALITIES);
export const regionEnum = pgEnum('region', REGIONS);
export const insuranceClassEnum = pgEnum('insurance_class', INSURANCE_CLASSES);
export const ticketStateEnum = pgEnum('ticket_state', TICKET_STATES);
export const actorEnum = pgEnum('actor', ACTORS);
export const ticketSourceEnum = pgEnum('ticket_source', TICKET_SOURCES);
export const consentElementEnum = pgEnum('consent_element', CONSENT_ELEMENTS);
export const staffRoleEnum = pgEnum('staff_role', STAFF_ROLES);
export const ageBandEnum = pgEnum('age_band', AGE_BANDS);
export const genderEnum = pgEnum('gender', GENDERS);
export const careLanguageEnum = pgEnum('care_language', CARE_LANGUAGES);
export const crisisTriggerEnum = pgEnum('crisis_trigger', CRISIS_TRIGGERS);
export const crisisNumberEnum = pgEnum('crisis_number', CRISIS_NUMBERS);

export const facilities = pgTable('facilities', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  region: regionEnum('region').notNull(),
  contactText: text('contact_text').notNull(),
  sample: boolean('sample').notNull().default(true),
});

/** Mock directory. Every tier except self-help belongs to a facility, tele included. */
export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    tier: tierEnum('tier').notNull(),
    modality: modalityEnum('modality').notNull(),
    languages: careLanguageEnum('languages').array().notNull(),
    clinicianGenders: genderEnum('clinician_genders').array().notNull(),
    insuranceClasses: insuranceClassEnum('insurance_classes').array().notNull(),
    region: regionEnum('region').notNull(),
    indicativeWaitDays: integer('indicative_wait_days').notNull(),
    facilityId: uuid('facility_id').references(() => facilities.id),
    sample: boolean('sample').notNull().default(true),
  },
  (t) => [
    check('services_facility_unless_self_help', sql`(${t.tier} = 'self_help') = (${t.facilityId} IS NULL)`),
    index('services_facility_idx').on(t.facilityId),
  ],
);

/**
 * Pseudonymous. The server stores the hash of the device's secret and, only when the person opted in,
 * the four coarse equity buckets. No name, email, Emirates ID or phone column exists.
 */
export const persons = pgTable(
  'persons',
  {
    id: uuid('id').primaryKey(),
    secretHash: text('secret_hash').notNull(),
    locale: localeEnum('locale').notNull(),
    equityOptIn: boolean('equity_opt_in').notNull().default(false),
    ageBand: ageBandEnum('age_band'),
    gender: genderEnum('gender'),
    language: careLanguageEnum('language'),
    region: regionEnum('region'),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    check(
      'persons_buckets_only_when_opted_in',
      sql`${t.equityOptIn} OR (${t.ageBand} IS NULL AND ${t.gender} IS NULL AND ${t.language} IS NULL AND ${t.region} IS NULL)`,
    ),
  ],
);

export const staffUsers = pgTable(
  'staff_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    role: staffRoleEnum('role').notNull(),
    facilityId: uuid('facility_id').references(() => facilities.id),
    active: boolean('active').notNull().default(true),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    check('staff_users_clinician_has_facility', sql`(${t.role} = 'clinician') = (${t.facilityId} IS NOT NULL)`),
    check('staff_users_email_lowercase', sql`${t.email} = lower(${t.email})`),
  ],
);

/** One-time sign-in links. Only the SHA-256 of the token is stored. */
export const staffMagicLinks = pgTable('staff_magic_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  staffUserId: uuid('staff_user_id')
    .notNull()
    .references(() => staffUsers.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: at('created_at').notNull(),
  expiresAt: at('expires_at').notNull(),
  usedAt: at('used_at'),
});

export const staffSessions = pgTable('staff_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  staffUserId: uuid('staff_user_id')
    .notNull()
    .references(() => staffUsers.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: at('created_at').notNull(),
  expiresAt: at('expires_at').notNull(),
});

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shortCode: text('short_code').notNull().unique(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    tier: tierEnum('tier').notNull(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id),
    state: ticketStateEnum('state').notNull(),
    language: careLanguageEnum('language').notNull(),
    deadlineAt: at('deadline_at').notNull(),
    source: ticketSourceEnum('source').notNull(),
    parentTicketId: uuid('parent_ticket_id').references((): AnyPgColumn => tickets.id),
    clientRequestId: uuid('client_request_id').unique(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    index('tickets_service_idx').on(t.serviceId),
    index('tickets_person_idx').on(t.personId),
    index('tickets_state_deadline_idx').on(t.state, t.deadlineAt),
    check('tickets_not_self_help', sql`${t.tier} <> 'self_help'`),
  ],
);

/** Append-only. `seq` counts from 1 per ticket, and (ticket_id, seq) is unique so a racing writer loses. */
export const ticketEvents = pgTable(
  'ticket_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    seq: integer('seq').notNull(),
    fromState: ticketStateEnum('from_state'),
    toState: ticketStateEnum('to_state').notNull(),
    actor: actorEnum('actor').notNull(),
    channel: text('channel').notNull(),
    reason: text('reason'),
    selfConfirmed: boolean('self_confirmed').notNull().default(false),
    at: at('at').notNull(),
  },
  (t) => [unique('ticket_events_ticket_seq_unique').on(t.ticketId, t.seq), check('ticket_events_seq_positive', sql`${t.seq} >= 1`)],
);

/** Append-only consent ledger. A revoke sets `revoked_at`; rows are never deleted. */
export const consents = pgTable(
  'consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    ticketId: uuid('ticket_id').references(() => tickets.id),
    recipient: text('recipient').notNull(),
    element: consentElementEnum('element').notNull(),
    grantedAt: at('granted_at').notNull(),
    revokedAt: at('revoked_at'),
  },
  (t) => [index('consents_person_idx').on(t.personId), index('consents_ticket_idx').on(t.ticketId)],
);

/**
 * Consented elements as AES-256-GCM ciphertext (a JSON object keyed by element), one row per ticket. Nothing writes
 * plaintext here. A revoke of one element rewrites the ciphertext without it; a revoke of the required `ticket`
 * element empties both ciphertext columns and sets `deleted_at`.
 */
export const sharedBundles = pgTable(
  'shared_bundles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    recipient: text('recipient').notNull(),
    contentCiphertext: text('content_ciphertext'),
    approvedSummaryCiphertext: text('approved_summary_ciphertext'),
    /** The consent elements the approved summary was written from; empty for one written by hand or when there is none. */
    summaryBuiltFrom: consentElementEnum('summary_built_from').array().notNull().default(sql`'{}'`),
    createdAt: at('created_at').notNull(),
    deletedAt: at('deleted_at'),
  },
  (t) => [unique('shared_bundles_ticket_unique').on(t.ticketId)],
);

/** One row for every time staff opened a ticket's bundle. The person can read their own ticket's rows. */
export const bundleReads = pgTable(
  'bundle_reads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    staffUserId: uuid('staff_user_id')
      .notNull()
      .references(() => staffUsers.id),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    at: at('at').notNull(),
  },
  (t) => [index('bundle_reads_ticket_idx').on(t.ticketId)],
);

/**
 * Every summary the API drafted or the person approved, encrypted like the bundle. A draft is written before the
 * ticket exists, so `request_id` (the ticket's client request id) links it, and `ticket_id` is filled in when the
 * ticket is issued. A revoke of the `ticket` element deletes the ticket's rows.
 */
export const summaryLogs = pgTable(
  'summary_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    ticketId: uuid('ticket_id').references(() => tickets.id),
    requestId: uuid('request_id').notNull(),
    kind: text('kind').notNull(),
    ciphertext: text('ciphertext').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [index('summary_logs_person_idx').on(t.personId), index('summary_logs_ticket_idx').on(t.ticketId), check('summary_logs_kind', sql`${t.kind} IN ('draft', 'approved')`)],
);

/** Carries no person id and no item answers, so a crisis can never be traced to a ticket. */
export const crisisEvents = pgTable(
  'crisis_events',
  {
    id: uuid('id').primaryKey(),
    trigger: crisisTriggerEnum('trigger').notNull(),
    shownAt: at('shown_at').notNull(),
    callTapped: crisisNumberEnum('call_tapped'),
    contextShared: boolean('context_shared').notNull().default(false),
    humanContactConfirmed: boolean('human_contact_confirmed').notNull().default(false),
    contactSource: text('contact_source'),
    contactAt: at('contact_at'),
    resolvedAt: at('resolved_at'),
    followUpAt: at('follow_up_at'),
    locale: localeEnum('locale').notNull(),
  },
  (t) => [
    check('crisis_events_contact_pair', sql`${t.humanContactConfirmed} = (${t.contactAt} IS NOT NULL)`),
    check('crisis_events_contact_source', sql`${t.contactSource} IS NULL OR ${t.contactSource} IN ('self_report', 'mock_line')`),
  ],
);

export const adverseEvents = pgTable('adverse_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').references(() => tickets.id),
  crisisEventId: uuid('crisis_event_id').references(() => crisisEvents.id),
  type: text('type').notNull(),
  severity: text('severity').notNull(),
  status: text('status').notNull(),
  reportedBy: text('reported_by').notNull(),
  at: at('at').notNull(),
});

/** Names of every table, in an order that is safe to truncate in one statement. */
export const ALL_TABLE_NAMES = [
  'adverse_events',
  'bundle_reads',
  'summary_logs',
  'crisis_events',
  'shared_bundles',
  'consents',
  'ticket_events',
  'tickets',
  'staff_sessions',
  'staff_magic_links',
  'staff_users',
  'persons',
  'services',
  'facilities',
] as const;
