import { REQUIRED_ELEMENT, redact } from '@mawsool/consent';
import type { BundleContent, CareLanguage, ConsentElement, ScoreEntry, Tier, TicketState } from '@mawsool/types';

/** The label every export carries: it is built for Malaffi, and nothing is sent. */
export const EXPORT_LABEL = 'Malaffi-ready export — not sent';

const TICKET_SYSTEM = 'urn:mawsool:ticket';
const ELEMENT_SYSTEM = 'urn:mawsool:consent-element';
const INSTRUMENT_SYSTEM = 'urn:mawsool:instrument';
const VERIFICATION_STATUS_SYSTEM = 'http://terminology.hl7.org/CodeSystem/condition-ver-status';

/** The ticket fields an export needs. They come from the ticket element, which every export holds. */
export interface FhirTicket {
  shortCode: string;
  tier: Tier;
  state: TicketState;
  /** The language care is wanted in. `other` has no language code and is left out. */
  language: CareLanguage;
  createdAt: string;
  deadlineAt: string;
}

export interface FhirExportInput {
  ticket: FhirTicket;
  /** What the bundle holds. It is cut down to `granted` again here, so a caller that forgot to redact cannot leak. */
  content: BundleContent;
  /** The approved summary. It sits under the ticket element, so it is in the export exactly when the ticket is shared. */
  approvedSummary: string | null;
  /** The elements consented to now. */
  granted: readonly ConsentElement[];
  /** When the export was made, as an instant. */
  exportedAt: string;
}

/** A FHIR resource or bundle, as plain JSON. The R4 schema is the check on its shape, in tests. */
export type FhirObject = Record<string, unknown>;

/** The exported Bundle: a FHIR object that says it is one. */
export type FhirBundleObject = FhirObject & { resourceType: 'Bundle' };

/** A ServiceRequest's status for a ticket's state: a live referral is active, a seen one completed, one that ended without being seen revoked. */
export function serviceRequestStatus(state: TicketState): 'active' | 'completed' | 'revoked' {
  switch (state) {
    case 'issued':
    case 'acknowledged':
    case 'overdue':
      return 'active';
    case 'seen':
    case 'remeasured':
    case 'closed':
      return 'completed';
    case 'rerouted':
    case 'declined':
    case 'withdrawn':
      return 'revoked';
  }
}

/** A resource id is made of the ticket code and a suffix: letters, digits and dashes only. */
const idFor = (shortCode: string, suffix: string) => `${shortCode.toLowerCase()}-${suffix}`;

/** Which consent element a resource came from, so a reader (and a test) can see that nothing is in the export without one. */
const elementTag = (element: ConsentElement) => ({ system: ELEMENT_SYSTEM, code: element });

interface ScoreResource {
  entry: ScoreEntry;
  from: ConsentElement[];
}

/** One resource per distinct score, noting every element it was shared under: the latest score is often in the trajectory too. */
function distinctScores(content: BundleContent): ScoreResource[] {
  const found = new Map<string, ScoreResource>();
  for (const [element, entries] of [['scores', content.scores], ['trajectory', content.trajectory]] as const) {
    for (const entry of entries ?? []) {
      const key = `${entry.instrument}|${entry.takenAt}|${entry.total}`;
      const known = found.get(key);
      if (known) known.from.push(element);
      else found.set(key, { entry, from: [element] });
    }
  }
  return [...found.values()];
}

/**
 * The FHIR R4 export of a ticket, built from what is stored and consented to now: a `ServiceRequest` for the ticket
 * (its approved summary and, if shared, the person's note as notes), a `QuestionnaireResponse` for each shared score
 * (total and band, never item answers) and a `Condition` for each shared self-reported condition.
 *
 * Preferences have no home in those three resources and are not exported. Nothing identifies the person: the subject
 * is the ticket code. The bundle is labelled "Malaffi-ready export — not sent".
 *
 * Throws when the ticket element is not among `granted`, since an export of a share that has ended must never exist.
 */
export function buildFhirBundle(input: FhirExportInput): FhirBundleObject {
  if (!input.granted.includes(REQUIRED_ELEMENT)) throw new Error('A ticket whose share has ended cannot be exported');
  const { ticket, granted } = input;
  const content = redact(input.content, granted);
  const code = ticket.shortCode;
  const subject = { type: 'Patient', identifier: { system: TICKET_SYSTEM, value: code } };
  const requestId = idFor(code, 'request');

  const notes = [
    ...(input.approvedSummary ? [{ authorString: 'The person, who approved this summary', text: input.approvedSummary }] : []),
    ...(content.free_text !== undefined ? [{ authorString: 'The person, in their own words', text: content.free_text }] : []),
  ];

  const serviceRequest: FhirObject = {
    resourceType: 'ServiceRequest',
    id: requestId,
    identifier: [{ system: TICKET_SYSTEM, value: code }],
    status: serviceRequestStatus(ticket.state),
    intent: 'order',
    priority: 'routine',
    code: { text: `Mental health referral, ${ticket.tier} tier` },
    subject,
    authoredOn: ticket.createdAt,
    occurrencePeriod: { start: ticket.createdAt, end: ticket.deadlineAt },
    ...(ticket.language === 'other' ? {} : { language: ticket.language }),
    ...(notes.length > 0 ? { note: notes } : {}),
  };

  const scores: FhirObject[] = distinctScores(content).map(({ entry, from }, index) => ({
    resourceType: 'QuestionnaireResponse',
    id: idFor(code, `${entry.instrument}-${index + 1}`),
    meta: { tag: from.map(elementTag) },
    basedOn: [{ reference: `urn:mawsool:ServiceRequest/${requestId}` }],
    questionnaire: `${INSTRUMENT_SYSTEM}:${entry.instrument}`,
    status: 'completed',
    subject,
    authored: entry.takenAt,
    item: [
      { linkId: 'total', text: 'Total score', answer: [{ valueInteger: entry.total }] },
      ...(entry.band === null ? [] : [{ linkId: 'band', text: 'Severity band', answer: [{ valueString: entry.band }] }]),
    ],
  }));

  const conditions: FhirObject[] = (content.conditions ?? []).map((name, index) => ({
    resourceType: 'Condition',
    id: idFor(code, `condition-${index + 1}`),
    meta: { tag: [elementTag('conditions')] },
    verificationStatus: { coding: [{ system: VERIFICATION_STATUS_SYSTEM, code: 'unconfirmed', display: 'Unconfirmed' }], text: 'Self-reported' },
    code: { text: name },
    subject,
    recordedDate: ticket.createdAt,
  }));

  return {
    resourceType: 'Bundle',
    id: idFor(code, 'export'),
    meta: { tag: [{ system: 'urn:mawsool:export', code: 'not-sent', display: EXPORT_LABEL }] },
    type: 'collection',
    timestamp: input.exportedAt,
    entry: [serviceRequest, ...scores, ...conditions].map((resource) => ({ fullUrl: `urn:mawsool:${String(resource['resourceType'])}/${String(resource['id'])}`, resource })),
  };
}
