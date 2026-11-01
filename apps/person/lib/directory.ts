import { ServicesResponseSchema, type Service } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import { z } from 'zod';
import { KEYS } from './keys';

const CachedDirectorySchema = z.object({ fetchedAt: z.iso.datetime({ offset: true }), services: ServicesResponseSchema });

export interface Directory {
  services: Service[];
  /** `network` when this call fetched it, `cache` when the network failed and the last copy was used. */
  source: 'network' | 'cache';
  fetchedAt: string;
}

/**
 * The mock service directory for on-device matching. It asks for the whole list with a bare GET: no query, no
 * headers, no credential, so nothing about the person goes with it. The copy is kept on the device, so matching
 * still works offline after one online visit. Returns null when there is neither a network nor a saved copy.
 */
export async function loadDirectory(deps: { storage: StorageAdapter; fetch: typeof fetch; apiUrl: string; now: () => Date }): Promise<Directory | null> {
  try {
    const response = await deps.fetch(`${deps.apiUrl}/services`, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const parsed = ServicesResponseSchema.safeParse(await response.json());
      if (parsed.success) {
        const fetchedAt = deps.now().toISOString();
        await deps.storage.set(KEYS.directory, { fetchedAt, services: parsed.data }).catch(() => undefined);
        return { services: parsed.data, source: 'network', fetchedAt };
      }
    }
  } catch {
    // Offline or the server is down: fall through to the saved copy.
  }
  try {
    const cached = CachedDirectorySchema.safeParse(await deps.storage.get<unknown>(KEYS.directory));
    return cached.success ? { ...cached.data, source: 'cache' } : null;
  } catch {
    return null;
  }
}
