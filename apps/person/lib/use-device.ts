'use client';

import type { StorageAdapter } from '@mawsool/ui';
import { useEffect, useState } from 'react';
import { deviceNow } from './clock';
import { createCrisisStore, type CrisisStore } from './crisis';
import { deviceStorage } from './device';

export interface Device {
  storage: StorageAdapter;
  crisis: CrisisStore;
}

let device: Device | null = null;

/** The device's store and crisis state, shared by every screen in a page-load. Browser only; throws if storage is unavailable. */
export function getDevice(): Device {
  if (!device) {
    const storage = deviceStorage();
    device = { storage, crisis: createCrisisStore(storage, { now: deviceNow, newId: () => crypto.randomUUID() }) };
  }
  return device;
}

/** `null` while loading, `'unavailable'` when the browser cannot keep data on the device. */
export function useDevice(): Device | 'unavailable' | null {
  const [state, setState] = useState<Device | 'unavailable' | null>(null);
  useEffect(() => {
    try {
      setState(getDevice());
    } catch {
      setState('unavailable');
    }
  }, []);
  return state;
}
