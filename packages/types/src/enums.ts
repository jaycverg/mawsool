import { z } from 'zod';

/** UI locales. Every user-facing string exists in both. */
export const LOCALES = ['ar', 'en'] as const;
export const LocaleSchema = z.enum(LOCALES);
export type Locale = z.infer<typeof LocaleSchema>;

/** Care tiers, ordered from least to most intensive. */
export const TIERS = ['self_help', 'community', 'tele', 'gp', 'specialist'] as const;
export const TierSchema = z.enum(TIERS);
export type Tier = z.infer<typeof TierSchema>;

export const MODALITIES = ['in_person', 'tele'] as const;
export const ModalitySchema = z.enum(MODALITIES);
export type Modality = z.infer<typeof ModalitySchema>;

export const REGIONS = ['abu_dhabi_city', 'al_ain', 'al_dhafra'] as const;
export const RegionSchema = z.enum(REGIONS);
export type Region = z.infer<typeof RegionSchema>;

export const INSURANCE_CLASSES = ['thiqa', 'daman_basic', 'daman_enhanced', 'other_private', 'not_sure'] as const;
export const InsuranceClassSchema = z.enum(INSURANCE_CLASSES);
export type InsuranceClass = z.infer<typeof InsuranceClassSchema>;

export const INSTRUMENTS = ['who5', 'phq9', 'gad7', 'cssrs'] as const;
export const InstrumentSchema = z.enum(INSTRUMENTS);
export type Instrument = z.infer<typeof InstrumentSchema>;

/** Ticket states. `overdue` and the others are the spec's nine; crisis is never a ticket state. */
export const TICKET_STATES = [
  'issued',
  'acknowledged',
  'seen',
  'overdue',
  'rerouted',
  'remeasured',
  'closed',
  'declined',
  'withdrawn',
] as const;
export const TicketStateSchema = z.enum(TICKET_STATES);
export type TicketState = z.infer<typeof TicketStateSchema>;

export const ACTORS = ['person', 'clinic', 'system'] as const;
export const ActorSchema = z.enum(ACTORS);
export type Actor = z.infer<typeof ActorSchema>;

export const TICKET_SOURCES = ['app', 'phc', 'tamm', 'school'] as const;
export const TicketSourceSchema = z.enum(TICKET_SOURCES);
export type TicketSource = z.infer<typeof TicketSourceSchema>;

/** The required `ticket` element plus the elements the person may choose to share. */
export const CONSENT_ELEMENTS = ['ticket', 'scores', 'trajectory', 'free_text', 'conditions', 'preferences'] as const;
export const ConsentElementSchema = z.enum(CONSENT_ELEMENTS);
export type ConsentElement = z.infer<typeof ConsentElementSchema>;

export const STAFF_ROLES = ['clinician', 'ops', 'admin'] as const;
export const StaffRoleSchema = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof StaffRoleSchema>;

/** What a route requires of its caller. Every API route declares exactly one. */
export const ROUTE_ACCESS = ['public', 'person', 'clinician', 'ops', 'admin', 'inbound'] as const;
export const RouteAccessSchema = z.enum(ROUTE_ACCESS);
export type RouteAccess = z.infer<typeof RouteAccessSchema>;

/** Equity buckets: age band, gender, language, region only. Nationality is deliberately absent. */
export const AGE_BANDS = ['under_18', '18_24', '25_34', '35_44', '45_54', '55_plus'] as const;
export const AgeBandSchema = z.enum(AGE_BANDS);
export type AgeBand = z.infer<typeof AgeBandSchema>;

export const GENDERS = ['female', 'male', 'another'] as const;
export const GenderSchema = z.enum(GENDERS);
export type Gender = z.infer<typeof GenderSchema>;

/** Care languages. ISO 639-1 codes. */
export const CARE_LANGUAGES = ['ar', 'en', 'ur', 'hi', 'tl', 'other'] as const;
export const CareLanguageSchema = z.enum(CARE_LANGUAGES);
export type CareLanguage = z.infer<typeof CareLanguageSchema>;

export const CRISIS_TRIGGERS = ['phq9_item9', 'cssrs'] as const;
export const CrisisTriggerSchema = z.enum(CRISIS_TRIGGERS);
export type CrisisTrigger = z.infer<typeof CrisisTriggerSchema>;

/** Numbers a person can tap on the crisis screen. */
export const CRISIS_NUMBERS = ['800725462', '999', '998'] as const;
export const CrisisNumberSchema = z.enum(CRISIS_NUMBERS);
export type CrisisNumber = z.infer<typeof CrisisNumberSchema>;

/** Indicative coverage of a tier for an insurance class. Always shown as indicative, never as eligibility. */
export const COVERAGE_LEVELS = ['covered', 'copay', 'pay_and_claim', 'unknown'] as const;
export const CoverageSchema = z.enum(COVERAGE_LEVELS);
export type Coverage = z.infer<typeof CoverageSchema>;

export const TIMES_OF_DAY = ['morning', 'afternoon', 'evening'] as const;
export const TimeOfDaySchema = z.enum(TIMES_OF_DAY);
export type TimeOfDay = z.infer<typeof TimeOfDaySchema>;

/** Why a person moves on from a stalled or unsuitable referral. `unable_to_see` is what a clinic reports. */
export const REROUTE_REASONS = ['could_not_book', 'cost', 'wait_too_long', 'change_option', 'unable_to_see', 'other'] as const;
export const RerouteReasonSchema = z.enum(REROUTE_REASONS);
export type RerouteReason = z.infer<typeof RerouteReasonSchema>;

/**
 * Why a clinic could not see a person: a fixed list, never free text, so nothing a clinician types is stored in the
 * event log and nothing in it can identify anyone. Accepted only on an "unable to see" event.
 */
export const UNABLE_REASONS = ['could_not_reach', 'no_capacity', 'not_eligible', 'wrong_service', 'other'] as const;
export const UnableReasonSchema = z.enum(UNABLE_REASONS);
export type UnableReason = z.infer<typeof UnableReasonSchema>;

/** Instruments whose scores can be shared. C-SSRS answers are never shared. */
export const SHAREABLE_INSTRUMENTS = ['who5', 'phq9', 'gad7'] as const;
