import type { InboundSource } from '@mawsool/types';

/**
 * Signing keys of the throwaway end-to-end API, one per front door. The API harness (`serve-e2e.ts`) accepts requests
 * signed with them and the end-to-end spec signs with them, so both read this file. They protect nothing.
 */
export const E2E_INBOUND_KEYS: Record<InboundSource, string> = {
  tamm: 'e2e-only-tamm-signing-key-0123456789abcd',
  phc: 'e2e-only-phc-signing-key-0123456789abcdef',
  school: 'e2e-only-school-signing-key-0123456789abc',
};
