import type { StorageAdapter } from '@mawsool/ui';

/** An in-memory store with the adapter's contract, plus switches to make reads or writes fail. */
export function memoryStorage(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  const failures = { read: false, write: false };
  const guard = (kind: 'read' | 'write') => {
    if (failures[kind]) throw new Error(`storage ${kind} failed`);
  };
  const storage: StorageAdapter = {
    async get<T>(key: string) {
      guard('read');
      return structuredClone(data.get(key)) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      guard('write');
      data.set(key, structuredClone(value));
    },
    async setIfAbsent<T>(key: string, value: T) {
      guard('write');
      if (!data.has(key)) data.set(key, structuredClone(value));
      return structuredClone(data.get(key)) as T;
    },
    async remove(key) {
      guard('write');
      data.delete(key);
    },
    async keys() {
      return [...data.keys()];
    },
    async clear() {
      guard('write');
      data.clear();
    },
  };
  return { storage, data, failures };
}

/** A clock that moves only when told to, and ids that count up. */
export function fixtureClock(start = '2026-11-01T08:00:00+04:00') {
  let time = new Date(start).getTime();
  let counter = 0;
  return {
    now: () => new Date(time),
    advance: (minutes: number) => void (time += minutes * 60_000),
    newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  };
}
