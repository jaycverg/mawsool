import { describe, expect, it } from 'vitest';
import {
  CONSENT_ELEMENTS,
  CRISIS_HANDOFF_ELEMENT,
  CreateCrisisHandoffRequestSchema,
  LEDGER_ELEMENTS,
  CrisisEventSchema,
  DemographicsSchema,
  PhoneNumberSchema,
  REMINDER_INTERVAL_WEEKS,
  ReminderPhoneRequestSchema,
  RegisterPersonRequestSchema,
  ROUTE_ACCESS,
  SHORT_CODE_ALPHABET,
  ShortCodeSchema,
  TICKET_STATES,
  TIERS,
  formatShortCode,
} from '../src';

describe('enums', () => {
  it('lists the spec ticket states', () => {
    expect([...TICKET_STATES].sort()).toEqual(
      ['acknowledged', 'closed', 'declined', 'issued', 'overdue', 'remeasured', 'rerouted', 'seen', 'withdrawn'],
    );
  });

  it('orders tiers from least to most intensive', () => {
    expect(TIERS).toEqual(['self_help', 'community', 'tele', 'gp', 'specialist']);
  });

  it('keeps the required ticket element first and offers no demographics element', () => {
    expect(CONSENT_ELEMENTS[0]).toBe('ticket');
    expect(CONSENT_ELEMENTS).not.toContain('demographics');
  });

  it('declares the route access values the registry accepts', () => {
    expect([...ROUTE_ACCESS]).toEqual(['public', 'person', 'clinician', 'ops', 'admin', 'crisis_line', 'inbound']);
  });
});

describe('equity buckets', () => {
  it('has no nationality field', () => {
    expect(Object.keys(DemographicsSchema.shape).sort()).toEqual(['ageBand', 'gender', 'language', 'region']);
  });
});

describe('short codes', () => {
  it('accepts MW plus four unambiguous characters and formats them for display', () => {
    expect(ShortCodeSchema.safeParse('MW4K7Q').success).toBe(true);
    expect(formatShortCode('MW4K7Q')).toBe('MW-4K7Q');
  });

  it('rejects ambiguous characters, wrong length and lowercase', () => {
    for (const bad of ['MW0K7Q', 'MW1K7Q', 'MWOK7Q', 'MWIK7Q', 'MW4K7', 'MW4K7QQ', 'mw4k7q']) {
      expect(ShortCodeSchema.safeParse(bad).success).toBe(false);
    }
    expect(SHORT_CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });
});

describe('POST /persons contract', () => {
  const valid = { id: crypto.randomUUID(), secret: 'A'.repeat(43), locale: 'ar' };

  it('accepts exactly id, secret and locale', () => {
    expect(RegisterPersonRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a short secret and a bad locale', () => {
    expect(RegisterPersonRequestSchema.safeParse({ ...valid, secret: 'short' }).success).toBe(false);
    expect(RegisterPersonRequestSchema.safeParse({ ...valid, locale: 'fr' }).success).toBe(false);
  });

  it('strips fields it does not define, so a phone number cannot ride along', () => {
    const parsed = RegisterPersonRequestSchema.parse({ ...valid, phone: '+971500000000', name: 'x' });
    expect(Object.keys(parsed).sort()).toEqual(['id', 'locale', 'secret']);
  });
});

describe('CrisisEvent', () => {
  it('carries no person id and no item answers', () => {
    const keys = Object.keys(CrisisEventSchema.shape);
    expect(keys).not.toContain('personId');
    expect(keys).not.toContain('answers');
  });
});

describe('the number for text reminders', () => {
  it('accepts an international number and nothing else', () => {
    for (const good of ['+971501234567', '+14155550123', '+12345678']) expect(PhoneNumberSchema.safeParse(good).success, good).toBe(true);
    for (const bad of ['971501234567', '0501234567', '+0501234567', '+1234567', '+1234567890123456', '+971 50 123 4567', '+97150abc', '']) expect(PhoneNumberSchema.safeParse(bad).success, bad).toBe(false);
  });

  it('offers 2 or 4 weeks and refuses an extra field on the request', () => {
    expect([...REMINDER_INTERVAL_WEEKS]).toEqual([2, 4]);
    expect(ReminderPhoneRequestSchema.safeParse({ phone: '+971501234567', intervalWeeks: 2 }).success).toBe(true);
    expect(ReminderPhoneRequestSchema.safeParse({ phone: '+971501234567', intervalWeeks: 3 }).success).toBe(false);
    expect(ReminderPhoneRequestSchema.safeParse({ phone: '+971501234567', intervalWeeks: 4, name: 'x' }).success).toBe(false);
  });
});

describe('the crisis hand-off contracts', () => {
  const body = { crisisEventId: '11111111-1111-4111-8111-111111111111', consented: true, language: 'ar', trigger: 'phq9_item9', scores: [], callbackNumber: null };

  it('keeps the hand-off element out of the ticket consent list and in the ledger list', () => {
    expect(CONSENT_ELEMENTS).not.toContain(CRISIS_HANDOFF_ELEMENT);
    expect([...LEDGER_ELEMENTS]).toEqual([...CONSENT_ELEMENTS, 'crisis_handoff']);
  });

  it('accepts a consented template and refuses a missing or false consent, extra keys and a callback number that is not international', () => {
    expect(CreateCrisisHandoffRequestSchema.safeParse(body).success).toBe(true);
    expect(CreateCrisisHandoffRequestSchema.safeParse({ ...body, consented: false }).success).toBe(false);
    expect(CreateCrisisHandoffRequestSchema.safeParse({ ...body, consented: undefined }).success).toBe(false);
    expect(CreateCrisisHandoffRequestSchema.safeParse({ ...body, answers: [3] }).success).toBe(false);
    expect(CreateCrisisHandoffRequestSchema.safeParse({ ...body, callbackNumber: '0501234567' }).success).toBe(false);
  });
});
