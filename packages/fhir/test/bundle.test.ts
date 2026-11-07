import { CONSENT_ELEMENTS, TICKET_STATES, type BundleContent, type ConsentElement } from '@mawsool/types';
import { describe, expect, it } from 'vitest';
import { EXPORT_LABEL, buildFhirBundle, serviceRequestStatus, type FhirExportInput } from '../src';
import { validateFhir } from '../src/validate';

const NOTE = 'FREE-TEXT-MARKER-4471';
const CONDITION = 'CONDITION-MARKER-9023';
const SUMMARY = 'SUMMARY-MARKER-1180';

const CONTENT: BundleContent = {
  scores: [
    { instrument: 'phq9', total: 7, band: 'mild', takenAt: '2026-10-29T08:00:00+04:00' },
    { instrument: 'gad7', total: 14, band: 'moderate', takenAt: '2026-10-29T08:05:00+04:00' },
  ],
  trajectory: [
    { instrument: 'gad7', total: 9, band: 'mild', takenAt: '2026-10-08T08:00:00+04:00' },
    { instrument: 'gad7', total: 14, band: 'moderate', takenAt: '2026-10-29T08:05:00+04:00' },
  ],
  free_text: NOTE,
  conditions: [CONDITION, 'Hypertension'],
  preferences: { language: 'ar', modality: 'in_person' },
};

function input(granted: readonly ConsentElement[], overrides: Partial<FhirExportInput> = {}): FhirExportInput {
  return {
    ticket: { shortCode: 'MW4K7Q', tier: 'gp', state: 'acknowledged', language: 'ar', createdAt: '2026-10-29T04:00:00.000Z', deadlineAt: '2026-11-05T19:59:59.000Z' },
    content: CONTENT,
    approvedSummary: SUMMARY,
    granted,
    exportedAt: '2026-11-01T04:00:00.000Z',
    ...overrides,
  };
}

const resources = (bundle: Record<string, unknown>) => (bundle['entry'] as { resource: Record<string, unknown> }[]).map((entry) => entry.resource);
const typesOf = (bundle: Record<string, unknown>) => resources(bundle).map((resource) => resource['resourceType']);

describe('the FHIR R4 export', () => {
  it('validates against the official R4 schema with everything shared', () => {
    const bundle = buildFhirBundle(input(CONSENT_ELEMENTS));
    expect(validateFhir(bundle)).toEqual({ valid: true });
    expect(typesOf(bundle)).toEqual(['ServiceRequest', 'QuestionnaireResponse', 'QuestionnaireResponse', 'QuestionnaireResponse', 'Condition', 'Condition']);
  });

  it('exports the totals of a repeat check beside the referral\'s own: two entries for one instrument each become their own response, with distinct ids, and the bundle still validates', () => {
    const repeated: BundleContent = {
      ...CONTENT,
      scores: [
        ...CONTENT.scores!,
        { instrument: 'phq9', total: 4, band: 'minimal', takenAt: '2026-12-21T09:00:00+04:00' },
        { instrument: 'gad7', total: 3, band: 'minimal', takenAt: '2026-12-21T09:05:00+04:00' },
      ],
    };
    const bundle = buildFhirBundle(input(['ticket', 'scores'], { content: repeated }));
    expect(validateFhir(bundle)).toEqual({ valid: true });
    const responses = resources(bundle).filter((resource) => resource['resourceType'] === 'QuestionnaireResponse');
    expect(responses).toHaveLength(4);
    expect(new Set(responses.map((resource) => resource['id'])).size).toBe(4);
  });

  it('validates with only the required ticket element, holding just the ServiceRequest and the approved summary', () => {
    const bundle = buildFhirBundle(input(['ticket']));
    expect(validateFhir(bundle)).toEqual({ valid: true });
    expect(typesOf(bundle)).toEqual(['ServiceRequest']);
    expect(resources(bundle)[0]!['note']).toEqual([{ authorString: 'The person, who approved this summary', text: SUMMARY }]);
  });

  it('leaves the summary out when there is none, and has no note at all when nothing was written', () => {
    const bundle = buildFhirBundle(input(['ticket'], { approvedSummary: null }));
    expect(validateFhir(bundle)).toEqual({ valid: true });
    expect(JSON.stringify(bundle)).not.toContain('SUMMARY-MARKER');
    expect(resources(bundle)[0]).not.toHaveProperty('note');
  });

  it('is labelled as not sent', () => {
    const bundle = buildFhirBundle(input(['ticket']));
    expect(EXPORT_LABEL).toBe('Malaffi-ready export — not sent');
    expect(bundle['meta']).toEqual({ tag: [{ system: 'urn:mawsool:export', code: 'not-sent', display: EXPORT_LABEL }] });
  });

  it.each(CONSENT_ELEMENTS.filter((element) => element !== 'ticket'))('holds nothing from %s unless it is consented to, even when the content has it', (element) => {
    const granted: ConsentElement[] = ['ticket', element];
    const text = JSON.stringify(buildFhirBundle(input(granted)));
    const markers = { free_text: NOTE, conditions: CONDITION, scores: 'phq9', trajectory: '2026-10-08', preferences: 'in_person' } as const;
    for (const [other, marker] of Object.entries(markers)) {
      if (other === element && element !== 'preferences') expect(text, `${other} is shared`).toContain(marker);
      if (other !== element) expect(text, `${other} is not`).not.toContain(marker);
    }
  });

  it('never exports preferences, which have no home in the three resources', () => {
    expect(JSON.stringify(buildFhirBundle(input(CONSENT_ELEMENTS)))).not.toContain('in_person');
  });

  it('puts the note into the ServiceRequest only when free text is shared', () => {
    const shared = resources(buildFhirBundle(input(['ticket', 'free_text'])))[0]!['note'] as { text: string }[];
    expect(shared.map((note) => note.text)).toEqual([SUMMARY, NOTE]);
    const unshared = resources(buildFhirBundle(input(['ticket'])))[0]!['note'] as { text: string }[];
    expect(unshared.map((note) => note.text)).toEqual([SUMMARY]);
    const noSummary = resources(buildFhirBundle(input(['ticket', 'free_text'], { approvedSummary: null })))[0]!['note'] as { text: string }[];
    expect(noSummary.map((note) => note.text)).toEqual([NOTE]);
  });

  it('tags each score with the element it was shared under, once, when a score is in both', () => {
    const bundle = buildFhirBundle(input(['ticket', 'scores', 'trajectory']));
    const tags = resources(bundle)
      .filter((resource) => resource['resourceType'] === 'QuestionnaireResponse')
      .map((resource) => ((resource['meta'] as { tag: { code: string }[] }).tag.map((tag) => tag.code)));
    // phq9 and the latest gad7 are in scores, the latest gad7 is also in the trajectory, and the first gad7 only there.
    expect(tags).toEqual([['scores'], ['scores', 'trajectory'], ['trajectory']]);
  });

  it('carries a total and a band for a score and never an item answer', () => {
    const bundle = buildFhirBundle(input(['ticket', 'scores']));
    const phq = resources(bundle).find((resource) => resource['questionnaire'] === 'urn:mawsool:instrument:phq9')!;
    expect(phq['item']).toEqual([
      { linkId: 'total', text: 'Total score', answer: [{ valueInteger: 7 }] },
      { linkId: 'band', text: 'Severity band', answer: [{ valueString: 'mild' }] },
    ]);
  });

  it('leaves the band out of a score that has none', () => {
    const bundle = buildFhirBundle(input(['ticket', 'scores'], { content: { scores: [{ instrument: 'who5', total: 44, band: null, takenAt: '2026-10-29T08:00:00+04:00' }] } }));
    expect(validateFhir(bundle)).toEqual({ valid: true });
    expect(resources(bundle)[1]!['item']).toEqual([{ linkId: 'total', text: 'Total score', answer: [{ valueInteger: 44 }] }]);
  });

  it('marks a condition as unconfirmed, because the person reported it', () => {
    const bundle = buildFhirBundle(input(['ticket', 'conditions']));
    const condition = resources(bundle).find((resource) => resource['resourceType'] === 'Condition')!;
    expect(condition['verificationStatus']).toMatchObject({ coding: [{ code: 'unconfirmed' }], text: 'Self-reported' });
  });

  it('names the person by nothing but the ticket code', () => {
    const text = JSON.stringify(buildFhirBundle(input(CONSENT_ELEMENTS)));
    expect(text).toContain('"identifier":{"system":"urn:mawsool:ticket","value":"MW4K7Q"}');
    expect(text).not.toMatch(/personId|"name"|telecom|birthDate/);
  });

  it('leaves out a language that is not a language code', () => {
    const bundle = buildFhirBundle(input(['ticket'], { ticket: { ...input(['ticket']).ticket, language: 'other' } }));
    expect(validateFhir(bundle)).toEqual({ valid: true });
    expect(resources(bundle)[0]).not.toHaveProperty('language');
    expect(resources(buildFhirBundle(input(['ticket'])))[0]).toHaveProperty('language', 'ar');
  });

  it('is cut down to the consented elements again here, so a caller that passes everything cannot leak', () => {
    const text = JSON.stringify(buildFhirBundle(input(['ticket'], { content: CONTENT })));
    expect(text).not.toContain(NOTE);
    expect(text).not.toContain(CONDITION);
  });

  it('refuses to export a ticket whose share has ended', () => {
    expect(() => buildFhirBundle(input(['scores', 'free_text']))).toThrow(/share has ended/);
    expect(() => buildFhirBundle(input([]))).toThrow(/share has ended/);
  });

  it('maps every ticket state to a ServiceRequest status the schema accepts', () => {
    for (const state of TICKET_STATES) {
      const bundle = buildFhirBundle(input(['ticket'], { ticket: { ...input(['ticket']).ticket, state } }));
      expect(validateFhir(bundle), state).toEqual({ valid: true });
    }
    expect(Object.fromEntries(TICKET_STATES.map((state) => [state, serviceRequestStatus(state)]))).toEqual({
      issued: 'active',
      acknowledged: 'active',
      overdue: 'active',
      seen: 'completed',
      remeasured: 'completed',
      closed: 'completed',
      rerouted: 'revoked',
      declined: 'revoked',
      withdrawn: 'revoked',
    });
  });
});

describe('the schema check itself', () => {
  it('rejects a bundle the R4 schema does not accept, so a pass above means something', () => {
    const bundle = buildFhirBundle(input(['ticket']));
    const resource = (bundle['entry'] as { resource: Record<string, unknown> }[])[0]!.resource;
    // The schema checks structure and types; it does not check code values, so the status mapping is tested above.
    expect(validateFhir({ ...bundle, entry: [{ fullUrl: 'urn:x', resource: { ...resource, status: 5 } }] }).valid).toBe(false);
    expect(validateFhir({ ...bundle, entry: [{ fullUrl: 'urn:x', resource: { ...resource, invented: true } }] }).valid).toBe(false);
    expect(validateFhir({ ...bundle, type: 'a-pile' }).valid).toBe(false);
    const rejected = validateFhir({ resourceType: 'Bundle', type: 'collection', entry: [{ resource: { resourceType: 'ServiceRequest' } }] });
    expect(rejected.valid).toBe(false);
    expect(rejected.valid === false && rejected.errors.length).toBeGreaterThan(0);
  });

  it('accepts a bundle on a second call too (the compiled schema is reused)', () => {
    expect(validateFhir(buildFhirBundle(input(['ticket']))).valid).toBe(true);
    expect(validateFhir(buildFhirBundle(input(['ticket']))).valid).toBe(true);
  });
});
