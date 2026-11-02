import { ServicesResponseSchema, type Locale, type Service } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import { z } from 'zod';
import { KEYS } from './keys';

const CopySchema = z.object({ fetchedAt: z.iso.datetime({ offset: true }), services: ServicesResponseSchema });
/** One saved copy per language, so each page gets its own language's names whenever it has them. */
const CachedDirectorySchema = z.object({ ar: CopySchema.optional(), en: CopySchema.optional() });

export interface Directory {
  services: Service[];
  /** `network` when this call fetched it, `cache` when the network failed and the last copy was used. */
  source: 'network' | 'cache';
  fetchedAt: string;
}

/**
 * The mock service directory for on-device matching. It asks for the whole list with a GET that carries no credential,
 * no header and no body, and one query value: the language of the page, so the names come back in it. Nothing about
 * the person goes with it. The copy is kept on the device for each language. Offline, a page gets its own language's copy,
 * else the other language's, so matching still works after one online visit in either. Returns null when there is neither
 * a network nor a saved copy.
 */
export async function loadDirectory(deps: { storage: StorageAdapter; fetch: typeof fetch; apiUrl: string; locale: Locale; now: () => Date }): Promise<Directory | null> {
  try {
    const response = await deps.fetch(`${deps.apiUrl}/services?locale=${deps.locale}`, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const parsed = ServicesResponseSchema.safeParse(await response.json());
      if (parsed.success) {
        const fetchedAt = deps.now().toISOString();
        await saveCopy(deps.storage, deps.locale, { fetchedAt, services: parsed.data }).catch(() => undefined);
        return { services: parsed.data, source: 'network', fetchedAt };
      }
    }
  } catch {
    // Offline or the server is down: fall through to the saved copy.
  }
  try {
    const cached = CachedDirectorySchema.safeParse(await deps.storage.get<unknown>(KEYS.directory));
    // This language's copy first. With none, the other language's saved copy: stored text in the other language, nothing made
    // up, and matching keeps working offline for someone who visited in one language and then switched.
    const copy = cached.success ? (cached.data[deps.locale] ?? cached.data[deps.locale === 'ar' ? 'en' : 'ar']) : undefined;
    return copy ? { ...copy, source: 'cache' } : null;
  } catch {
    return null;
  }
}

/** Keeps the copy for one language and leaves the other language's copy as it was. */
async function saveCopy(storage: StorageAdapter, locale: Locale, copy: z.infer<typeof CopySchema>): Promise<void> {
  const current = CachedDirectorySchema.safeParse(await storage.get<unknown>(KEYS.directory).catch(() => undefined));
  await storage.set(KEYS.directory, { ...(current.success ? current.data : {}), [locale]: copy });
}
