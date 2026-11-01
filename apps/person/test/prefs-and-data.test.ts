import { createTabMark } from '@mawsool/ui';
import { describe, expect, it } from 'vitest';
import { deleteDeviceData, exportDeviceData } from '../lib/device-data';
import { currentTier, loadChoice, loadInsurance, loadPreferences, saveChoice, saveInsurance, savePreferences } from '../lib/prefs';
import { memoryStorage } from './helpers/memory';

describe('preferences, insurance and choice', () => {
  it('start empty: no preferences, "not sure", no choice', async () => {
    const { storage } = memoryStorage();
    expect(await loadPreferences(storage)).toEqual({});
    expect(await loadInsurance(storage)).toBe('not_sure');
    expect(await loadChoice(storage)).toBeNull();
  });

  it('round-trip what the person picked', async () => {
    const { storage } = memoryStorage();
    await savePreferences(storage, { language: 'ar', clinicianGender: 'female', modality: 'in_person', region: 'al_ain', timeOfDay: 'evening' });
    await saveInsurance(storage, 'daman_basic');
    await saveChoice(storage, { tier: 'self_help', serviceId: 'x', chosenAt: '2026-11-01T08:00:00+04:00', confirmed: true });
    expect(await loadPreferences(storage)).toEqual({ language: 'ar', clinicianGender: 'female', modality: 'in_person', region: 'al_ain', timeOfDay: 'evening' });
    expect(await loadInsurance(storage)).toBe('daman_basic');
    expect(currentTier(await loadChoice(storage))).toBe('self_help');
  });

  it('read damaged values as nothing rather than failing', async () => {
    const { storage } = memoryStorage({ preferences: { language: 'klingon' }, insurance: 7, choice: { tier: 'gp' } });
    expect(await loadPreferences(storage)).toEqual({});
    expect(await loadInsurance(storage)).toBe('not_sure');
    expect(await loadChoice(storage)).toBeNull();
  });

  it('count a choice as the current tier only once it is confirmed', () => {
    expect(currentTier(null)).toBeNull();
    expect(currentTier({ tier: 'gp', serviceId: 'x', chosenAt: '2026-11-01T08:00:00+04:00', confirmed: false })).toBeNull();
    expect(currentTier({ tier: 'gp', serviceId: 'x', chosenAt: '2026-11-01T08:00:00+04:00', confirmed: true })).toBe('gp');
  });
});

describe('download and delete', () => {
  const full = {
    screenings: [{ id: 'a', instrument: 'gad7', answers: [1, 1, 1, 1, 1, 1, 1], total: 7, band: 'mild', item9Flag: false, takenAt: '2026-11-01T08:00:00+04:00' }],
    preferences: { language: 'ar' },
    insurance: 'thiqa',
    choice: { tier: 'self_help', serviceId: 'x', chosenAt: '2026-11-01T08:00:00+04:00', confirmed: true },
    'crisis:block': { blocked: false },
    identity: { id: 'device-id', secret: 'device-secret-value' },
    directory: { services: [] },
    'crisis:outbox': [{ id: 'queued' }],
  };

  it('exports the person\'s data as JSON, and never the device secret, the directory or the queue', async () => {
    const { storage } = memoryStorage(full);
    const json = await exportDeviceData(storage, () => new Date('2026-11-02T08:00:00+04:00'));
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed).sort()).toEqual(['choice', 'crisis', 'exportedAt', 'insurance', 'preferences', 'screenings']);
    expect(parsed.screenings).toEqual(full.screenings);
    expect(json).not.toContain('device-secret-value');
    expect(json).not.toContain('queued');
  });

  it('deleting everything also clears the tab\'s crisis mark, so nothing is left that could hold a block', async () => {
    const { storage } = memoryStorage(full);
    const mark = createTabMark<{ id: string }>(undefined, 'crisis', (value): value is { id: string } => typeof value === 'object');
    mark.set({ id: 'e' });
    await deleteDeviceData(storage, mark);
    expect(mark.get()).toBeNull();
  });

  it('exports an empty device as empty values', async () => {
    const parsed = JSON.parse(await exportDeviceData(memoryStorage().storage, () => new Date('2026-11-02T08:00:00+04:00')));
    expect(parsed).toMatchObject({ screenings: [], preferences: {}, insurance: null, choice: null, crisis: null });
  });

  it('deletes everything on the device', async () => {
    const { storage, data } = memoryStorage(full);
    await deleteDeviceData(storage);
    expect(data.size).toBe(0);
    expect(await storage.keys()).toEqual([]);
  });
});
