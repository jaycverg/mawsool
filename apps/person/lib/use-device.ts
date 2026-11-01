'use client';

import { createTabFlag, safeSessionStorage, type StorageAdapter, type TabFlagAdapter } from '@mawsool/ui';
import { useEffect, useState } from 'react';
import { deviceNow } from './clock';
import { createCrisisStore, type CrisisStore } from './crisis';
import { deviceStorage } from './device';

export interface Device {
  storage: StorageAdapter;
  crisis: CrisisStore;
  /** The tab's own copy of the crisis block. Deleting everything clears it with the store. */
  tabFlag: TabFlagAdapter;
}

let device: Device | null = null;

/** The device's store and crisis state, shared by every screen in a page-load. Browser only; throws if storage is unavailable. */
export function getDevice(): Device {
  if (!device) {
    const storage = deviceStorage();
    const tabFlag = createTabFlag(safeSessionStorage(), 'mawsool.crisis-block');
    device = { storage, tabFlag, crisis: createCrisisStore(storage, { now: deviceNow, newId: () => crypto.randomUUID(), fallback: tabFlag }) };
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
