import { ServicesResponseSchema, type Locale, type Service } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import { z } from 'zod';
import { KEYS } from './keys';

const CopySchema = z.object({ fetchedAt: z.iso.datetime({ offset: true }), services: ServicesResponseSchema });
/** One saved copy per language, so an Arabic reader offline is never handed the English names saved for someone else. */
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
 * the person goes with it. The copy is kept on the device for each language, so matching still works offline after one
 * online visit in that language. Returns null when there is neither a network nor a saved copy.
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
    const copy = cached.success ? cached.data[deps.locale] : undefined;
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
