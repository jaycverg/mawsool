import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdverseEventsResponseSchema,
  CrisisResponseSchema,
  EquityResponseSchema,
  FunnelResponseSchema,
  METRIC_DEFINITIONS,
  METRIC_ROUTES,
  OutcomesResponseSchema,
  TimelinessResponseSchema,
  type MetricRoute,
} from '@mawsool/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { messageAt, renderMetricDefinitionsDoc } from '../src/docs/metric-definitions-doc';
import { runSeed } from '../src/seed/run';
import { SEED_ANCHOR } from '../src/seed/fixtures';
import { createTestApp, signIn, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const messages = (lang: 'en' | 'ar') => JSON.parse(read(`apps/ops/messages/${lang}.json`)) as Record<string, unknown>;
const EN = messages('en');
const AR = messages('ar');

const SCHEMAS: Record<MetricRoute, z.ZodType> = {
  '/metrics/funnel': FunnelResponseSchema,
  '/metrics/timeliness': TimelinessResponseSchema,
  '/metrics/crisis': CrisisResponseSchema,
  '/metrics/equity': EquityResponseSchema,
  '/metrics/outcomes': OutcomesResponseSchema,
  '/adverse-events': AdverseEventsResponseSchema,
};

/** The schemas a field named `key` can have under `schema`, going through arrays, optional and nullable wrappers and every branch of a union. */
function childrenOf(schema: z.ZodType, key: string): z.ZodType[] {
  const def = (schema as unknown as { _zod: { def: { type: string; shape?: Record<string, z.ZodType>; element?: z.ZodType; options?: z.ZodType[]; innerType?: z.ZodType } } })._zod.def;
  switch (def.type) {
    case 'object':
      return def.shape?.[key] ? [def.shape[key]!] : [];
    case 'array':
      return childrenOf(def.element!, key);
    case 'union':
      return def.options!.flatMap((option) => childrenOf(option, key));
    case 'optional':
    case 'nullable':
    case 'default':
      return childrenOf(def.innerType!, key);
    default:
      return [];
  }
}

/** Whether a dotted path names a field the response schema declares. */
export function schemaHasPath(schema: z.ZodType, path: string): boolean {
  const walk = (current: z.ZodType, rest: string[]): boolean => (rest.length === 0 ? true : childrenOf(current, rest[0]!).some((child) => walk(child, rest.slice(1))));
  return walk(schema, path.split('.'));
}

/** What a real response holds at a path: a value, the suppressed answer standing in for it (at the path or above it), or nothing. */
function found(value: unknown, path: string[]): 'present' | 'suppressed' | 'missing' {
  if (path.length === 0) return value === undefined ? 'missing' : 'present';
  if (Array.isArray(value)) {
    const results = value.map((item) => found(item, path));
    if (results.includes('present')) return 'present';
    return results.includes('suppressed') ? 'suppressed' : 'missing';
  }
  if (value && typeof value === 'object') {
    if ((value as { suppressed?: unknown }).suppressed === true) return 'suppressed';
    return found((value as Record<string, unknown>)[path[0]!], path.slice(1));
  }
  return 'missing';
}

const flatten = (node: unknown, prefix = ''): string[] =>
  typeof node === 'string' ? [prefix] : Object.entries(node as Record<string, unknown>).flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key));

describe('every dashboard tile and section has a definition', () => {
  const sources = ['apps/ops/components/Dashboard.tsx', 'apps/ops/components/AdverseEvents.tsx'].map(read).join('\n');
  const all = (pattern: RegExp) => [...sources.matchAll(pattern)].map((match) => match[1]!);
  const tiles = all(/<Tile\s+id="([a-z-]+)"/g);
  const sections = all(/data-section="([a-z-]+)"/g);
  const panels = all(/<InfoPanel id="([a-z-]+)"/g);
  const defined = METRIC_DEFINITIONS.map((definition) => definition.id) as string[];

  it('finds the tiles and sections on the dashboard, so the checks below are not vacuous', () => {
    expect(tiles.sort()).toEqual(['crisis-contact', 'loop-closed', 'median-seen', 'within-target']);
    expect(sections.sort()).toEqual(['adverse-events', 'equity', 'funnel', 'outcomes', 'safety', 'timeliness']);
  });

  it('has a definition for each tile and section, and none for a figure that is not on the dashboard', () => {
    for (const id of [...tiles, ...sections]) expect(defined, id).toContain(id);
    expect([...defined].sort()).toEqual([...tiles, ...sections, 'overdue'].sort());
    for (const definition of METRIC_DEFINITIONS) expect(definition.surface, definition.id).toBe(tiles.includes(definition.id) ? 'tile' : 'section');
  });

  it('puts an info panel on each section (and on the overdue list), and every tile gets one from the tile component', () => {
    expect([...panels].sort()).toEqual([...sections, 'overdue'].sort());
    expect(sources).toMatch(/function Tile\(.*\n[\s\S]*<InfoPanel id=\{id\} label=\{label\} \/>/);
  });

  it('is written in both languages for every definition, with the Arabic in Arabic script and no placeholder left in any of it', () => {
    const wording = (lang: Record<string, unknown>, id: string) => ['definition', 'numerator', 'denominator'].map((part) => messageAt(lang, `defs.${id}.${part}`));
    for (const definition of METRIC_DEFINITIONS) {
      for (const text of wording(AR, definition.id)) {
        expect(text, `${definition.id} (ar)`).toMatch(/[؀-ۿ]/);
        expect(text).not.toMatch(/[{}]/);
      }
      for (const text of wording(EN, definition.id)) {
        expect(text, `${definition.id} (en)`).not.toMatch(/[؀-ۿ]/);
        expect(text).not.toMatch(/[{}]/);
      }
      for (const lang of [EN, AR]) {
        messageAt(lang, `defs.period.${definition.period}`);
        messageAt(lang, `defs.suppression.${definition.suppression}`);
        messageAt(lang, definition.label);
      }
    }
    for (const label of ['toggle', 'definitionLabel', 'numeratorLabel', 'denominatorLabel', 'periodLabel', 'suppressionLabel', 'close']) {
      messageAt(EN, `defs.${label}`);
      messageAt(AR, `defs.${label}`);
    }
  });

  it('has the same keys in English and Arabic under defs, adverse and dash.outcomes', () => {
    for (const section of ['defs', 'adverse', 'dash.outcomes']) {
      const at = (lang: Record<string, unknown>) => section.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], lang);
      expect(flatten(at(AR)).sort(), section).toEqual(flatten(at(EN)).sort());
    }
  });
});

describe('every numerator and denominator is something the server computes', () => {
  it('names only fields that the metric route\'s response declares', () => {
    for (const definition of METRIC_DEFINITIONS) {
      expect(definition.numerator.length, `${definition.id} has a numerator`).toBeGreaterThan(0);
      for (const field of [...definition.numerator, ...definition.denominator]) {
        expect(METRIC_ROUTES as readonly string[], `${definition.id}: ${field.route}`).toContain(field.route);
        expect(schemaHasPath(SCHEMAS[field.route], field.path), `${definition.id}: ${field.route} ${field.path}`).toBe(true);
      }
    }
  });

  it('fails for a field the response does not hold, so the check above can go red', () => {
    expect(schemaHasPath(FunnelResponseSchema, 'stages.count')).toBe(true);
    expect(schemaHasPath(FunnelResponseSchema, 'stages.countt')).toBe(false);
    expect(schemaHasPath(EquityResponseSchema, 'overall.loopClosed')).toBe(true);
    expect(schemaHasPath(EquityResponseSchema, 'overall.loopClosedd')).toBe(false);
    expect(schemaHasPath(CrisisResponseSchema, 'contactConfirmed.of')).toBe(true);
    expect(schemaHasPath(CrisisResponseSchema, 'nobody')).toBe(false);
  });

  describe('on the live routes', () => {
    let testDb: TestDb;
    let ctx: TestApp;
    let headers: { authorization: string };

    beforeAll(async () => {
      testDb = await createTestDb();
      await runSeed(testDb.db, SEED_ANCHOR);
      ctx = await createTestApp(testDb.db);
      ctx.clock.set(SEED_ANCHOR);
      headers = { authorization: `Bearer ${await signIn(ctx, 'ops@demo.mawsool.test')}` };
    });

    afterAll(async () => {
      await ctx.app.close();
      await testDb.close();
    });

    it('returns each named field, as a figure or as the suppressed answer standing in for it, and never leaves it out', async () => {
      const bodies = new Map<MetricRoute, unknown>();
      for (const route of METRIC_ROUTES) {
        const res = await ctx.app.inject({ method: 'GET', url: route === '/adverse-events' ? route : `${route}?period=${route === '/metrics/equity' ? '90d' : 'all'}`, headers });
        expect(res.statusCode, route).toBe(200);
        bodies.set(route, res.json());
      }
      for (const definition of METRIC_DEFINITIONS) {
        for (const field of [...definition.numerator, ...definition.denominator]) {
          expect(found(bodies.get(field.route), field.path.split('.')), `${definition.id}: ${field.route} ${field.path}`).not.toBe('missing');
        }
      }
    });
  });
});

describe('docs/metric-definitions.md', () => {
  it('is the file generated from the definitions and the wording, so it says what the info panels say (run pnpm docs:metrics to refresh it)', () => {
    expect(read('docs/metric-definitions.md')).toBe(renderMetricDefinitionsDoc(EN, AR));
  });

  it('cannot be rendered for a definition with no wording', () => {
    const broken = JSON.parse(JSON.stringify(EN)) as { defs: Record<string, Record<string, unknown>> };
    delete broken.defs['outcomes']!['numerator'];
    expect(() => renderMetricDefinitionsDoc(broken, AR)).toThrow(/defs\.outcomes\.numerator/);
  });
});
