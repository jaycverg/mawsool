import type { InboundSource } from '@mawsool/types';
import type { AppDeps } from '../../src/app';

/** A throwaway key for tests: 32 bytes, base64. It protects nothing. */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

/** Throwaway signing keys for the front doors, one per source. They protect nothing. */
export const TEST_INBOUND_KEYS: Record<InboundSource, string> = {
  tamm: 'test-only-tamm-signing-key-0123456789',
  phc: 'test-only-phc--signing-key-0123456789',
  school: 'test-only-school-signing-key-0123456789',
};

export const TEST_CONFIG: AppDeps['config'] = {
  corsOrigins: ['http://localhost:3001'],
  clinicianAppUrl: 'http://localhost:3001',
  opsAppUrl: 'http://localhost:3002',
  personAppUrl: 'http://localhost:3000',
  inboundKeys: TEST_INBOUND_KEYS,
  encryptionKey: TEST_ENCRYPTION_KEY,
  summaryLlmEnabled: false,
};
