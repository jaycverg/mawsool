import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LAYOUT = readFileSync(join(__dirname, '..', 'app', '[locale]', 'layout.tsx'), 'utf8');

describe('where the reminder notifier is mounted', () => {
  it('is imported from its component and rendered exactly once, by the locale layout', () => {
    expect(LAYOUT).toContain("import { ReminderNotifier } from '../../components/ReminderNotifier';");
    expect(LAYOUT.match(/<ReminderNotifier \/>/g)).toHaveLength(1);
  });

  it('sits inside the intl provider, because it reads the reminder words from the messages, and beside the crisis guard rather than inside it', () => {
    const provider = { open: LAYOUT.indexOf('<NextIntlClientProvider'), close: LAYOUT.indexOf('</NextIntlClientProvider>') };
    const notifier = LAYOUT.indexOf('<ReminderNotifier />');
    expect(provider.open).toBeGreaterThan(-1);
    expect(notifier).toBeGreaterThan(provider.open);
    expect(notifier).toBeLessThan(provider.close);
    const guard = { open: LAYOUT.indexOf('<CrisisGuard>'), close: LAYOUT.indexOf('</CrisisGuard>') };
    expect(notifier < guard.open || notifier > guard.close, 'not a child of the crisis guard').toBe(true);
  });

  it('is the only layout or page that mounts it, so a reminder is shown once per page open', () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(tsx|ts)$/.test(entry.name) && readFileSync(path, 'utf8').includes('<ReminderNotifier')) found.push(path.slice(join(__dirname, '..').length + 1));
      }
    };
    walk(join(__dirname, '..', 'app'));
    walk(join(__dirname, '..', 'components'));
    expect(found).toEqual([join('app', '[locale]', 'layout.tsx')]);
  });
});
