// @ts-check
// The server side of a gate: runs the whole Vitest suite of every project a registry names, with the real migrations on
// in-process Postgres (PGlite, no Docker), then checks every sentence of the registry against the tests that ran. Used by
// `pnpm gate:b` and by the first half of `pnpm gate:c`. See gate-b-lib.mjs for what a registry entry may say.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT } from './lib.mjs';
import { evaluateRegistry, runProblem } from './gate-b-lib.mjs';

/**
 * @param {{ name: string, registry: string, browser: string, delegated?: Record<string, string>, timeLimitMs: number }} options
 *   `registry` is a path under the repository root; `browser` the registry of this gate's own browser tests and `delegated`
 *   the gate name and registry of each other gate a sentence may leave its browser proof to, both under apps/person/e2e.
 * @returns {Promise<boolean>} whether every sentence is covered by tests that ran and passed (or is registered in a browser gate)
 */
export async function runServerSide(options) {
  const log = (/** @type {string} */ message) => console.log(`[${options.name}] ${message}`);
  /** @type {import('./gate-b-lib.mjs').Entry[]} */
  const registry = JSON.parse(readFileSync(resolve(ROOT, options.registry), 'utf8'));
  /** @type {{ id: string }[]} */
  const browser = JSON.parse(readFileSync(resolve(ROOT, 'apps/person/e2e', options.browser), 'utf8'));
  /** @type {Record<string, { gate: string, ids: string[] }>} */
  const delegated = {};
  for (const [gate, file] of Object.entries(options.delegated ?? {})) {
    delegated[gate] = { gate, ids: JSON.parse(readFileSync(resolve(ROOT, 'apps/person/e2e', file), 'utf8')).map((/** @type {{ id: string }} */ entry) => entry.id) };
  }

  const projects = [...new Set(registry.flatMap((entry) => [...(entry.project ? [entry.project] : []), ...(entry.tests ?? []).flatMap((ref) => (ref.project ? [ref.project] : []))]))].sort();
  const scratch = mkdtempSync(join(tmpdir(), `${options.name.replace(':', '-')}-`));
  const deadline = Date.now() + options.timeLimitMs;
  /** @type {import('./gate-b-lib.mjs').Reports} */
  const reports = {};
  /** @type {string[]} */
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

  problems.push(...evaluateRegistry(registry, reports, browser.map((entry) => entry.id), Object.fromEntries(Object.entries(delegated).map(([gate, value]) => [gate, value.ids]))));
  for (const problem of problems) log(`PROBLEM ${problem}`);
  // A sentence only a browser can prove is checked here only for having a test in a browser registry. Whether it passes is
  // that gate's to say, so these are counted apart and never as covered by a passing test.
  const here = registry.filter((entry) => !entry.browser && !entry.delegated);
  const own = registry.filter((entry) => entry.browser);
  const elsewhere = registry.filter((entry) => entry.delegated);
  const failing = new Set(problems.map((problem) => problem.split(':')[0]));
  log(`${here.filter((entry) => !failing.has(entry.id)).length} of ${here.length} sentences covered by tests that ran and passed here`);
  log(`${own.length} sentences carried by this gate's browser run and NOT run here (${own.filter((entry) => !failing.has(entry.id)).length} have their test registered)`);
  log(`${elsewhere.length} sentences delegated to another gate's browser run and NOT run here (${elsewhere.filter((entry) => !failing.has(entry.id)).length} have their test registered)`);
  return problems.length === 0;
}
