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
const SERVICE_AR = { ...SERVICE, name: 'نموذج: مركز الرعاية الأولية' };
const now = () => new Date('2026-11-01T08:00:00+04:00');
const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const offline = () =>
  vi.fn(async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
const base = { apiUrl: 'http://api.test', locale: 'en' as const, now };

describe('loadDirectory', () => {
  it('asks for the whole list with a GET that has no header, credential or body and one query value: the page language', async () => {
    const { storage } = memoryStorage();
    const fetchFn = respond([SERVICE]);
    const directory = await loadDirectory({ ...base, storage, fetch: fetchFn });
    expect(directory).toMatchObject({ source: 'network', services: [SERVICE] });
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]!;
    expect(url).toBe('http://api.test/services?locale=en');
    expect(init).toEqual({ signal: expect.any(AbortSignal) });
  });

  it('asks in Arabic on an Arabic page and returns the names the server wrote in Arabic', async () => {
    const { storage } = memoryStorage();
    const fetchFn = respond([SERVICE_AR]);
    const directory = await loadDirectory({ ...base, locale: 'ar', storage, fetch: fetchFn });
    expect(vi.mocked(fetchFn).mock.calls[0]![0]).toBe('http://api.test/services?locale=ar');
    expect(directory?.services[0]?.name).toBe(SERVICE_AR.name);
  });

  it('keeps a copy and serves it when the network is down', async () => {
    const { storage } = memoryStorage();
    await loadDirectory({ ...base, storage, fetch: respond([SERVICE]) });
    const directory = await loadDirectory({ ...base, storage, fetch: offline() });
    expect(directory).toMatchObject({ source: 'cache', services: [SERVICE], fetchedAt: now().toISOString() });
  });

  it('keeps one copy per language: offline, each page gets its own names when it has them', async () => {
    const { storage } = memoryStorage();
    await loadDirectory({ ...base, storage, fetch: respond([SERVICE]) });
    await loadDirectory({ ...base, locale: 'ar', storage, fetch: respond([SERVICE_AR]) });
    expect((await loadDirectory({ ...base, locale: 'ar', storage, fetch: offline() }))?.services[0]?.name).toBe(SERVICE_AR.name);
    expect((await loadDirectory({ ...base, locale: 'en', storage, fetch: offline() }))?.services[0]?.name).toBe(SERVICE.name);
  });

  it('offline in a language never visited, serves the saved copy of the other language rather than nothing, in either direction', async () => {
    const english = memoryStorage();
    await loadDirectory({ ...base, storage: english.storage, fetch: respond([SERVICE]) });
    const arabicPage = await loadDirectory({ ...base, locale: 'ar', storage: english.storage, fetch: offline() });
    expect(arabicPage).toMatchObject({ source: 'cache', services: [SERVICE], fetchedAt: now().toISOString() });

    const arabic = memoryStorage();
    await loadDirectory({ ...base, locale: 'ar', storage: arabic.storage, fetch: respond([SERVICE_AR]) });
    expect(await loadDirectory({ ...base, locale: 'en', storage: arabic.storage, fetch: offline() })).toMatchObject({ source: 'cache', services: [SERVICE_AR] });
  });

  it('serves the copy when the server errors or answers with something that is not a directory', async () => {
    const { storage } = memoryStorage();
    await loadDirectory({ ...base, storage, fetch: respond([SERVICE]) });
    expect((await loadDirectory({ ...base, storage, fetch: respond({}, 500) }))?.source).toBe('cache');
    expect((await loadDirectory({ ...base, storage, fetch: respond({ nope: true }) }))?.source).toBe('cache');
  });

  it('is null with no network and no copy, or an unreadable copy', async () => {
    expect(await loadDirectory({ ...base, storage: memoryStorage().storage, fetch: offline() })).toBeNull();
    expect(await loadDirectory({ ...base, storage: memoryStorage({ directory: { junk: 1 } }).storage, fetch: offline() })).toBeNull();
    const broken = memoryStorage();
    broken.failures.read = true;
    expect(await loadDirectory({ ...base, storage: broken.storage, fetch: offline() })).toBeNull();
  });

  it('still returns the fresh list when the copy cannot be saved', async () => {
    const { storage, failures } = memoryStorage();
    failures.write = true;
    expect((await loadDirectory({ ...base, storage, fetch: respond([SERVICE]) }))?.source).toBe('network');
  });
});
