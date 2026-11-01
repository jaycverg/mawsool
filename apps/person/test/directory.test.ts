import { describe, expect, it, vi } from 'vitest';
import { loadDirectory } from '../lib/directory';
import { memoryStorage } from './helpers/memory';

const SERVICE = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Sample PHC',
  tier: 'gp',
  modality: 'in_person',
  languages: ['ar', 'en'],
  clinicianGenders: ['female'],
  insuranceClasses: ['daman_basic'],
  region: 'abu_dhabi_city',
  indicativeWaitDays: 3,
  facilityId: '00000000-0000-4000-8000-000000000002',
  sample: true,
};
const now = () => new Date('2026-11-01T08:00:00+04:00');
const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('loadDirectory', () => {
  it('asks for the whole list with a bare GET: no query, no headers, no credential, no body', async () => {
    const { storage } = memoryStorage();
    const fetchFn = respond([SERVICE]);
    const directory = await loadDirectory({ storage, fetch: fetchFn, apiUrl: 'http://api.test', now });
    expect(directory).toMatchObject({ source: 'network', services: [SERVICE] });
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]!;
    expect(url).toBe('http://api.test/services');
    expect(init).toEqual({ signal: expect.any(AbortSignal) });
  });

  it('keeps a copy and serves it when the network is down', async () => {
    const { storage } = memoryStorage();
    await loadDirectory({ storage, fetch: respond([SERVICE]), apiUrl: 'http://api.test', now });
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const directory = await loadDirectory({ storage, fetch: offline, apiUrl: 'http://api.test', now });
    expect(directory).toMatchObject({ source: 'cache', services: [SERVICE], fetchedAt: now().toISOString() });
  });

  it('serves the copy when the server errors or answers with something that is not a directory', async () => {
    const { storage } = memoryStorage();
    await loadDirectory({ storage, fetch: respond([SERVICE]), apiUrl: 'http://api.test', now });
    expect((await loadDirectory({ storage, fetch: respond({}, 500), apiUrl: 'http://api.test', now }))?.source).toBe('cache');
    expect((await loadDirectory({ storage, fetch: respond({ nope: true }), apiUrl: 'http://api.test', now }))?.source).toBe('cache');
  });

  it('is null with no network and no copy, or an unreadable copy', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await loadDirectory({ storage: memoryStorage().storage, fetch: offline, apiUrl: 'http://api.test', now })).toBeNull();
    expect(await loadDirectory({ storage: memoryStorage({ directory: { junk: 1 } }).storage, fetch: offline, apiUrl: 'http://api.test', now })).toBeNull();
    const broken = memoryStorage();
    broken.failures.read = true;
    expect(await loadDirectory({ storage: broken.storage, fetch: offline, apiUrl: 'http://api.test', now })).toBeNull();
  });

  it('still returns the fresh list when the copy cannot be saved', async () => {
    const { storage, failures } = memoryStorage();
    failures.write = true;
    expect((await loadDirectory({ storage, fetch: respond([SERVICE]), apiUrl: 'http://api.test', now }))?.source).toBe('network');
  });
});
