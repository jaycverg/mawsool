import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');

/** Every directory that holds an ar.json and en.json pair. */
function messageDirs(): string[] {
  const dirs = [join(ROOT, 'packages', 'ui', 'messages')];
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const dir = join(ROOT, 'apps', app, 'messages');
    if (existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else Object.assign(out, leaves(value, path));
  }
  return out;
}

// Argument names only: a name right after an opening brace and followed by a comma or a closing brace. Words inside
// a plural or select branch (`one {# day}`, `=0 {No wait}`) are text, not arguments.
const placeholders = (text: string) => [...text.matchAll(/{\s*(\w+)\s*[,}]/g)].map((m) => m[1]).sort();
const read = (dir: string, locale: 'ar' | 'en') => leaves(JSON.parse(readFileSync(join(dir, `${locale}.json`), 'utf8')) as Tree);

describe('message files', () => {
  const dirs = messageDirs();

  it('finds the shared messages and every app', () => {
    expect(dirs.length).toBeGreaterThanOrEqual(4);
  });

  it.each(dirs.map((d) => [d.replace(ROOT, '')]))('%s has the same keys in ar and en', (rel) => {
    const dir = join(ROOT, rel);
    expect(Object.keys(read(dir, 'ar')).sort()).toEqual(Object.keys(read(dir, 'en')).sort());
  });

  it.each(dirs.map((d) => [d.replace(ROOT, '')]))('%s has no empty strings and matching placeholders', (rel) => {
    const dir = join(ROOT, rel);
    const ar = read(dir, 'ar');
    const en = read(dir, 'en');
    for (const [key, text] of Object.entries(en)) {
      expect(text.trim(), `en ${key}`).not.toBe('');
      expect(ar[key]?.trim(), `ar ${key}`).toBeTruthy();
      expect(placeholders(ar[key]!), key).toEqual(placeholders(text));
    }
  });

  it.each(dirs.map((d) => [d.replace(ROOT, '')]))('%s Arabic text is not a copy of the English text', (rel) => {
    const dir = join(ROOT, rel);
    const ar = read(dir, 'ar');
    const en = read(dir, 'en');
    for (const [key, text] of Object.entries(en)) {
      if (/^[\w\s·]+$/.test(text) && text === ar[key]) continue; // a proper name such as a product name written the same way
      expect(ar[key], key).not.toBe(text);
    }
  });
});
