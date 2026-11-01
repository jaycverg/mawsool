// @ts-check
// `pnpm gate:b`: the server side of Phase 3's exit acceptance (the spec's Gate B), run against the real thing.
//
// It runs the whole Vitest suite of every project the registry (scripts/gate-b.json) names, with the real migrations on
// in-process Postgres (PGlite, no Docker), then checks every sentence of the exit acceptance against the tests that ran:
// each named test must exist, be unambiguous and have passed, and no test in those projects may have failed, been
// skipped or been left todo. A sentence that only a browser can prove names its test in the browser gate's registry
// (apps/person/e2e/acceptance-phase3.json); run `pnpm gate:phase3` for those. Nothing here needs a network.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT } from './lib.mjs';
import { evaluateRegistry, runProblem } from './gate-b-lib.mjs';

const TIME_LIMIT_MS = 9 * 60_000;
const log = (/** @type {string} */ message) => console.log(`[gate:b] ${message}`);

/** @type {import('./gate-b-lib.mjs').Entry[]} */
const registry = JSON.parse(readFileSync(resolve(ROOT, 'scripts/gate-b.json'), 'utf8'));
/** @type {{ id: string }[]} */
const browser = JSON.parse(readFileSync(resolve(ROOT, 'apps/person/e2e/acceptance-phase3.json'), 'utf8'));

const projects = [...new Set(registry.flatMap((entry) => (entry.project ? [entry.project] : [])))].sort();
const scratch = mkdtempSync(join(tmpdir(), 'gate-b-'));
const deadline = Date.now() + TIME_LIMIT_MS;
/** @type {import('./gate-b-lib.mjs').Reports} */
const reports = {};
const problems = [];

for (const project of projects) {
  const outputFile = join(scratch, `${project.replaceAll('/', '_')}.json`);
  log(`running ${project}`);
  const run = spawnSync('pnpm', ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${outputFile}`], {
    cwd: resolve(ROOT, project),
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: Math.max(1000, deadline - Date.now()),
  });
  /** @type {import('./gate-b-lib.mjs').Result[]} */
  let results = [];
  try {
    const report = JSON.parse(readFileSync(outputFile, 'utf8'));
    results = report.testResults.flatMap((/** @type {any} */ file) => file.assertionResults.map((/** @type {any} */ test) => ({ file: file.name, fullName: test.fullName, status: test.status })));
  } catch {
    problems.push(`${project}: no report was written`);
  }
  reports[project] = results;
  if (run.signal) problems.push(`${project}: killed by ${run.signal}`);
  else if (run.status !== 0) problems.push(`${project}: vitest exited ${run.status}`);
  const bad = runProblem(results);
  if (bad) problems.push(`${project}: ${bad}`);
  log(`${project}: ${results.filter((result) => result.status === 'passed').length} of ${results.length} tests passed`);
}

problems.push(...evaluateRegistry(registry, reports, browser.map((entry) => entry.id)));
for (const problem of problems) log(`PROBLEM ${problem}`);
const covered = registry.length - new Set(problems.map((problem) => problem.split(':')[0])).size;
log(`${covered} of ${registry.length} sentences covered by passing tests${registry.some((entry) => entry.browser) ? '; browser sentences are proved by pnpm gate:phase3' : ''}`);
process.exit(problems.length === 0 ? 0 : 1);
