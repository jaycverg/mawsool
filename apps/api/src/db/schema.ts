import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  ACTORS,
  AGE_BANDS,
  CARE_LANGUAGES,
  CRISIS_NUMBERS,
  CRISIS_TRIGGERS,
  GENDERS,
  LEDGER_ELEMENTS,
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
export const consentElementEnum = pgEnum('consent_element', LEDGER_ELEMENTS);
export const staffRoleEnum = pgEnum('staff_role', STAFF_ROLES);
export const ageBandEnum = pgEnum('age_band', AGE_BANDS);
export const genderEnum = pgEnum('gender', GENDERS);
export const careLanguageEnum = pgEnum('care_language', CARE_LANGUAGES);
export const crisisTriggerEnum = pgEnum('crisis_trigger', CRISIS_TRIGGERS);
export const crisisNumberEnum = pgEnum('crisis_number', CRISIS_NUMBERS);

/**
 * `name` and `contact_text` are the English text. The `_ar` columns hold the Arabic text where someone has written
 * it; null means there is none, and an Arabic reader is then served the English text, never a generated translation.
 */
export const facilities = pgTable('facilities', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  nameAr: text('name_ar'),
  region: regionEnum('region').notNull(),
  contactText: text('contact_text').notNull(),
  contactTextAr: text('contact_text_ar'),
  sample: boolean('sample').notNull().default(true),
  /**
   * Whether the facility has the clinician portal. A clinic without it gets a signed one-time link (logged, not sent) to acknowledge or
   * mark seen a ticket (`clinic_links`). The seeded facilities all have it.
   */
  portalAccess: boolean('portal_access').notNull().default(true),
});

/** Mock directory. Every tier except self-help belongs to a facility, tele included. `name_ar` follows the rule of `facilities`. */
export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
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

/**
 * Consent ledger. For ticket consents it is append-only: a revoke sets `revoked_at` and the row stays.
 * A `crisis_handoff` row is deleted on Stop and Delete everything, so nothing kept ties the person to a crisis event.
 */
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
    /** The consent elements the draft was made from (what `POST /summary/draft` was told was consented), or the ticket's built-from list for an approved row. Stopping one of them deletes the row. */
    builtFrom: consentElementEnum('built_from').array().notNull().default(sql`'{}'`),
    createdAt: at('created_at').notNull(),
  },
  (t) => [index('summary_logs_person_idx').on(t.personId), index('summary_logs_ticket_idx').on(t.ticketId), check('summary_logs_kind', sql`${t.kind} IN ('draft', 'approved')`)],
);

/**
 * A positive screen handed over by a front door. It is an invite, never a ticket: it holds no name, no scores and no
 * answers, only where it came from, when the screen was taken and the language used. Only the hash of the claim code
 * is stored. Claiming binds it to a person; the ticket that person then sends carries its source and is recorded here.
 */
export const inboundInvites = pgTable(
  'inbound_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: ticketSourceEnum('source').notNull(),
    codeHash: text('code_hash').notNull().unique(),
    screenedAt: at('screened_at').notNull(),
    locale: localeEnum('locale').notNull(),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
    claimedBy: uuid('claimed_by').references(() => persons.id),
    claimedAt: at('claimed_at'),
    ticketId: uuid('ticket_id').references(() => tickets.id),
  },
  (t) => [
    check('inbound_invites_not_app', sql`${t.source} <> 'app'`),
    check('inbound_invites_claim_pair', sql`(${t.claimedBy} IS NULL) = (${t.claimedAt} IS NULL)`),
    check('inbound_invites_ticket_needs_claim', sql`${t.ticketId} IS NULL OR ${t.claimedBy} IS NOT NULL`),
    index('inbound_invites_claimed_by_idx').on(t.claimedBy),
  ],
);

/** Nonces of accepted signed requests, so a captured request cannot be sent again inside the time window. */
export const inboundNonces = pgTable(
  'inbound_nonces',
  {
    source: ticketSourceEnum('source').notNull(),
    nonce: text('nonce').notNull(),
    seenAt: at('seen_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.nonce] })],
);

/**
 * The optional mobile number for text reminders, one row per person, kept apart from tickets, bundles and anything the
 * person screened. The number is AES-256-GCM ciphertext bound to this person's row (`reminderPhoneContext`), so a value
 * copied onto another row does not decrypt. The row exists only while the person has reminders on and a number given;
 * turning reminders off, removing the number and "Delete everything" all delete it.
 */
export const reminderPhones = pgTable(
  'reminder_phones',
  {
    personId: uuid('person_id')
      .primaryKey()
      .references(() => persons.id),
    intervalWeeks: integer('interval_weeks').notNull(),
    phoneCiphertext: text('phone_ciphertext').notNull(),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [check('reminder_phones_interval', sql`${t.intervalWeeks} IN (2, 4)`)],
);

/**
 * Carries no person id and no item answers, so a crisis is never tied to a ticket or to a person. The one link is a hand-off the
 * person chose to make (`crisis_handoffs` and its ledger row), and both are deleted when they stop it or erase everything.
 */
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

/**
 * The ids of hand-offs that were stopped or erased, so a send that was already on its way (its reply lost, or its request
 * still in flight when the person pressed Stop or Delete everything) cannot create the hand-off after the stop. It holds a
 * random id the phone made and the time of the stop, and nothing else: no person, no event, no content, so it ties nobody to
 * anything. `sweep` deletes a row an hour after it was written, long past any request still on its way.
 */
export const revokedHandoffs = pgTable('revoked_handoffs', {
  handoffId: uuid('handoff_id').primaryKey(),
  revokedAt: at('revoked_at').notNull(),
});

/**
 * The no-login clinic channel: one signed, one-time link to acknowledge or mark seen one ticket, for a facility without the
 * portal. Only the SHA-256 of the token is stored (the token is logged, not sent). The link is bound to a ticket and to the
 * facility that ticket is addressed to, expires 48 hours after it was made on the wall clock, and is spent by the one
 * transition it fires, in the same transaction. It holds no person and no data: the ticket row it points to is the only tie.
 */
export const clinicLinks = pgTable(
  'clinic_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
    usedAt: at('used_at'),
  },
  (t) => [index('clinic_links_ticket_idx').on(t.ticketId)],
);

/**
 * What a person handed to the mock crisis line, one row per hand-off. The template (language, trigger, the totals of their
 * latest check-ins and the callback number if they gave one) is AES-256-GCM ciphertext bound to this row's id. The row
 * exists only while its ledger consent (`consent_id`, element `crisis_handoff`) is live. Stopping and "Delete everything"
 * delete both the row and that ledger row, so afterwards nothing the server keeps ties the person to the crisis event, by id
 * or by time: the event keeps only an anonymous `context_shared` flag. While a hand-off stands, this row is what ties a person
 * to a crisis event, which is why `crisis_events` itself carries no person id.
 */
export const crisisHandoffs = pgTable(
  'crisis_handoffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    crisisEventId: uuid('crisis_event_id')
      .notNull()
      .references(() => crisisEvents.id),
    consentId: uuid('consent_id')
      .notNull()
      .references(() => consents.id),
    contentCiphertext: text('content_ciphertext').notNull(),
    createdAt: at('created_at').notNull(),
    /** When the console's operator marked contact made; null until then. */
    contactMadeAt: at('contact_made_at'),
  },
  (t) => [unique('crisis_handoffs_event_unique').on(t.crisisEventId), unique('crisis_handoffs_consent_unique').on(t.consentId), index('crisis_handoffs_person_idx').on(t.personId)],
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

/**
 * The demo clock's offset from the wall clock, in milliseconds: one row (`id` = 1), absent while the clock has not moved.
 * It is written by the demo's clock controls and read once when the API starts, so a restart keeps the demo's date; the
 * reload of the seed truncates it with everything else. It holds no person data and no timestamp.
 */
export const demoClock = pgTable(
  'demo_clock',
  {
    id: integer('id').primaryKey(),
    offsetMs: bigint('offset_ms', { mode: 'number' }).notNull(),
  },
  (t) => [check('demo_clock_single_row', sql`${t.id} = 1`), check('demo_clock_forward', sql`${t.offsetMs} >= 0`)],
);

/** Names of every table, in an order that is safe to truncate in one statement. */
export const ALL_TABLE_NAMES = [
  'adverse_events',
  'demo_clock',
  'inbound_invites',
  'inbound_nonces',
  'bundle_reads',
  'summary_logs',
  'clinic_links',
  'revoked_handoffs',
  'crisis_handoffs',
  'crisis_events',
  'shared_bundles',
  'consents',
  'ticket_events',
  'tickets',
  'reminder_phones',
  'staff_sessions',
  'staff_magic_links',
  'staff_users',
  'persons',
  'services',
  'facilities',
] as const;
