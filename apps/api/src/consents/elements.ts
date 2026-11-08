import { CONSENT_ELEMENTS, type ConsentElement } from '@mawsool/types';

/**
 * Narrows a ledger element to a ticket's. The ledger also holds the crisis hand-off, which has no ticket; every read that
 * starts from a ticket id can only meet ticket elements, and this makes that a checked fact instead of a cast.
 */
export function ticketElement(element: string): ConsentElement {
  if (!(CONSENT_ELEMENTS as readonly string[]).includes(element)) throw new Error(`ledger element ${element} does not belong to a ticket`);
  return element as ConsentElement;
}
