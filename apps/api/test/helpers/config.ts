import type { AppDeps } from '../../src/app';

/** A throwaway key for tests: 32 bytes, base64. It protects nothing. */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

export const TEST_CONFIG: AppDeps['config'] = {
  corsOrigins: ['http://localhost:3001'],
  clinicianAppUrl: 'http://localhost:3001',
  opsAppUrl: 'http://localhost:3002',
  encryptionKey: TEST_ENCRYPTION_KEY,
  summaryLlmEnabled: false,
};
