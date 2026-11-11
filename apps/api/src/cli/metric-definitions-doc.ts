import { readFileSync, writeFileSync } from 'node:fs';
import { renderMetricDefinitionsDoc } from '../docs/metric-definitions-doc';

/** Rewrites `docs/metric-definitions.md` from the definitions list and the ops app's messages (`pnpm docs:metrics`). */
const read = (file: string) => JSON.parse(readFileSync(new URL(`../../../ops/messages/${file}`, import.meta.url), 'utf8')) as Record<string, unknown>;
const target = new URL('../../../../docs/metric-definitions.md', import.meta.url);
writeFileSync(target, renderMetricDefinitionsDoc(read('en.json'), read('ar.json')));
console.log(`wrote ${target.pathname}`);
