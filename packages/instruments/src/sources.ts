import type { WordingSource } from './types';

const PFIZER_STATEMENT = 'Printed on the form: no permission required to reproduce, translate, display or distribute.';
const NO_VALIDATION_PRINTED = 'None printed on the source.';

/** One entry per instrument and locale. Mirrors the rows in SOURCES.md; a test keeps the two in step. */
export const WORDING_SOURCES: Record<string, WordingSource> = {
  'phq9-en': {
    id: 'phq9-en',
    instrument: 'phq9',
    locale: 'en',
    title: 'Patient Health Questionnaire-9 (PHQ-9), English',
    publisher: 'PHQ Screeners (Pfizer Inc; Spitzer, Williams, Kroenke and colleagues)',
    url: 'https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/PHQ-9_English.pdf',
    fetchedOn: '2026-11-01',
    extraction: 'Text extracted locally from the PDF and compared with the item strings; checked against the render.',
    licence: PFIZER_STATEMENT,
    validationStatement: 'English original. No validation statement printed.',
    statusBasis: "Original-language form published by the instrument's developers; the published validation study below is of this instrument in English.",
    validationSource: { citation: 'Kroenke K, Spitzer RL, Williams JBW. The PHQ-9: validity of a brief depression severity measure. J Gen Intern Med 2001;16(9):606-613.', url: 'https://pubmed.ncbi.nlm.nih.gov/11556941/' },
    caveat: 'No version or year printed on the form.',
  },
  'gad7-en': {
    id: 'gad7-en',
    instrument: 'gad7',
    locale: 'en',
    title: 'GAD-7, English',
    publisher: 'PHQ Screeners (Pfizer Inc; Spitzer, Williams, Kroenke and colleagues)',
    url: 'https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/GAD-7_English.pdf',
    fetchedOn: '2026-11-01',
    extraction: 'Text extracted locally from the PDF and compared with the item strings.',
    licence: PFIZER_STATEMENT,
    validationStatement: 'English original. No validation statement printed.',
    statusBasis: "Original-language form published by the instrument's developers; the published validation study below is of this instrument in English.",
    validationSource: { citation: 'Spitzer RL, Kroenke K, Williams JBW, Löwe B. A brief measure for assessing generalized anxiety disorder: the GAD-7. Arch Intern Med 2006;166(10):1092-1097.', url: 'https://pubmed.ncbi.nlm.nih.gov/16717171/' },
    caveat:
      'A third-party "adapted" copy circulating online words items 1 and 6 differently; this file is the distributor copy, not that one.',
  },
  'phq9-ar': {
    id: 'phq9-ar',
    instrument: 'phq9',
    locale: 'ar',
    title: 'PHQ-9, Arabic edition filed as "Arabic for Tunisia"',
    publisher: 'PHQ Screeners (Pfizer Inc; Spitzer, Williams, Kroenke and colleagues)',
    url: 'https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/PHQ9_Arabic%20for%20Tunisia.pdf',
    fetchedOn: '2026-11-01',
    extraction:
      'Text extracted locally from the PDF; presentation forms folded with Unicode NFKC and the PDF text layer\'s kaf glyph mapped back to kaf; compared with the render by two readers.',
    licence: `${PFIZER_STATEMENT} (Printed in Arabic.)`,
    validationStatement: NO_VALIDATION_PRINTED,
    statusBasis: 'The Tunisian-Arabic edition prints no validation statement, and no validation study of this Arabic text was obtained.',
    validationSource: null,
    caveat:
      'Tunisian-Arabic edition; no translator or validation statement is printed. Suitability for UAE users is not established. The stem asks how much the person suffered, not how often.',
  },
  'gad7-ar': {
    id: 'gad7-ar',
    instrument: 'gad7',
    locale: 'ar',
    title: 'GAD-7, Arabic edition filed as "Arabic for Tunisia"',
    publisher: 'PHQ Screeners (Pfizer Inc; Spitzer, Williams, Kroenke and colleagues)',
    url: 'https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/GAD7_Arabic%20for%20Tunisia.pdf',
    fetchedOn: '2026-11-01',
    extraction: 'Same method as phq9-ar.',
    licence: `${PFIZER_STATEMENT} (Printed in Arabic.)`,
    validationStatement: NO_VALIDATION_PRINTED,
    statusBasis: 'The Tunisian-Arabic edition prints no validation statement, and no validation study of this Arabic text was obtained.',
    validationSource: null,
    caveat:
      'Tunisian-Arabic edition; no translator or validation statement is printed. Suitability for UAE users is not established.',
  },
  'who5-en': {
    id: 'who5-en',
    instrument: 'who5',
    locale: 'en',
    title: 'The World Health Organization-Five Well-Being Index (WHO-5), English original',
    publisher: 'World Health Organization (WHO/UCN/MSD/MHE/2024.1)',
    url: 'https://cdn.who.int/media/docs/default-source/mental-health/who-5_english-original4da539d6ed4b49389e3afe47cda2326a.pdf',
    fetchedOn: '2026-11-01',
    extraction: 'Text extracted locally from the PDF (its text layer is doubled); compared with the render.',
    licence: 'CC BY-NC-SA 3.0 IGO (WHO 2024). The NonCommercial and ShareAlike terms need a legal read before any use beyond a demo.',
    validationStatement: 'English original. The English version is stated to be binding.',
    statusBasis:
      'WHO English original, copied from the source. The one review found pools studies of translated versions of the instrument and does not establish this English form, so no validation study is cited.',
    validationSource: null,
    caveat: 'The 0-100 score is the raw 0-25 total times four, as the document states.',
  },
  'who5-ar': {
    id: 'who5-ar',
    instrument: 'who5',
    locale: 'ar',
    title: 'WHO-5, Arabic translation (1999 version, scanned)',
    publisher: 'WHO Collaborating Centre, Psychiatric Research Unit, Hillerod (as printed on the scan)',
    url: 'https://cdn.who.int/media/docs/default-source/mental-health/five-well-being-index-%28who-5%29/who-5_arabic.pdf',
    fetchedOn: '2026-11-01',
    extraction:
      'Image-only scan with no text layer, and no Arabic OCR was available. Transcribed by eye from the render by two readers who agreed. Not machine-checked.',
    licence:
      'Not established for this scan, which prints only a collaborating-centre copyright line. The English original (who5-en) is CC BY-NC-SA 3.0 IGO.',
    validationStatement: NO_VALIDATION_PRINTED,
    statusBasis: 'Hand transcription of a scan with no text layer, and no validation study of this Arabic text was obtained.',
    validationSource: null,
    caveat:
      'UNVERIFIED. Hand transcription of a 1999 scan: check every string against page 3 of the PDF before relying on it.',
  },
  'cssrs-en': {
    id: 'cssrs-en',
    instrument: 'cssrs',
    locale: 'en',
    title: 'Columbia-Suicide Severity Rating Scale, Screener Self-Report - Recent (English)',
    publisher: 'The Columbia Lighthouse Project (Columbia University)',
    url: 'https://cssrs.columbia.edu/wp-content/uploads/C-SSRS-Screener-Self-Report-Recent-2026.pdf',
    fetchedOn: '2026-11-01',
    extraction: 'Text extracted locally from the PDF and compared with the item strings.',
    licence:
      'No licence text is printed on the form. The publisher site footer says all rights reserved and describes the protocol as free for community and healthcare use. Terms for use inside this app are not established.',
    validationStatement: 'English original. No validation statement printed.',
    statusBasis: 'This is the patient-facing self-report screener form. A validation study of the C-SSRS was found (Posner et al., Am J Psychiatry 2011;168:1266-1277), but that it covers this form was not established.',
    validationSource: null,
    caveat:
      'Self-report form, time frame "in the past month". The clinician "Screen Version - Recent" asks the same six questions.',
  },
  'cssrs-ar': {
    id: 'cssrs-ar',
    instrument: 'cssrs',
    locale: 'ar',
    title: 'Arabic C-SSRS Screener: not obtained',
    publisher: 'The Columbia Lighthouse Project (Columbia University)',
    url: null,
    fetchedOn: '2026-11-01',
    extraction: 'Not obtained. The publisher lists Arabic translations of the full scale but gave no download link, and the screener translations folder could not be opened.',
    licence: 'Not established.',
    validationStatement: 'Not established.',
    statusBasis: 'No Arabic text was obtained.',
    validationSource: null,
    caveat:
      'The publisher says a translation validated for one country should not be used where it has not been validated. Item text stays null until the publisher supplies a file.',
  },
};
