'use client';

import type { Screening } from '@mawsool/types';
import { useEffect, useState } from 'react';
import { loadScreenings } from './screening-store';
import { useDevice } from './use-device';

/** The check-ins on this device: `null` while loading, `'unavailable'` when the browser cannot keep data. */
export function useScreenings(): Screening[] | 'unavailable' | null {
  const device = useDevice();
  const [screenings, setScreenings] = useState<Screening[] | null>(null);
  useEffect(() => {
    if (device === null || device === 'unavailable') return;
    void loadScreenings(device.storage).then(setScreenings, () => setScreenings([]));
  }, [device]);
  return device === 'unavailable' ? 'unavailable' : screenings;
}
