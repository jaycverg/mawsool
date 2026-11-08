/**
 * The sample lab results the context panel shows beside a person's self-reported conditions. They are a fixed mock of what
 * Malaffi (the Abu Dhabi health information exchange) would return, the same for every ticket, and are not data about anyone:
 * they exist only in this file and on the screen that draws them, always under the label "Sample — would come from Malaffi".
 * Nothing on the server reads them, so they cannot enter a bundle or the FHIR export (a test walks the server sources to prove it).
 */
export interface SampleLab {
  /** The key of the lab's name in the message files, under `detail.lab`. */
  id: 'hba1c' | 'fastingGlucose' | 'tsh';
  value: string;
  unit: string;
}

export const SAMPLE_LABS: readonly SampleLab[] = [
  { id: 'hba1c', value: '6.1', unit: '%' },
  { id: 'fastingGlucose', value: '5.8', unit: 'mmol/L' },
  { id: 'tsh', value: '2.1', unit: 'mIU/L' },
];

/**
 * Whether the panel shows the sample labs: only beside conditions the person chose to share and listed. Without them the panel
 * says "Not shared by the person" and shows no lab at all, so a mock result never sits on a ticket whose person kept their
 * physical health back.
 */
export function showsSampleLabs(content: { conditions?: readonly string[] }, conditionsShared: boolean): boolean {
  return conditionsShared && (content.conditions ?? []).length > 0;
}
