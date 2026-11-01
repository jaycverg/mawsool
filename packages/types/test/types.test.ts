import { describe, expect, it } from 'vitest';
import {
  CONSENT_ELEMENTS,
  CrisisEventSchema,
  DemographicsSchema,
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
    expect([...ROUTE_ACCESS]).toEqual(['public', 'person', 'clinician', 'ops', 'admin', 'inbound']);
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
