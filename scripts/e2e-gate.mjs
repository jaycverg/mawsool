// @ts-check
// The browser gate behind `pnpm gate:phase2`, `pnpm gate:phase3` and `pnpm gate:phase4`: an exit acceptance run against
// the real thing. Each gate names its Playwright spec, its registry of tests and a port shift (see gate-phase2.mjs,
// gate-phase3.mjs, gate-phase4.mjs).
//
//   1. builds the person app's static export with the API address of this run baked in;
//   2. installs the Chromium browser if it is missing (only Chromium);
//   3. starts the real Ticket API on an in-process Postgres with the seed, and a static server for the export;
//      a gate with `clinician: true` also builds the clinician app (into its own folder, so a running `pnpm dev` is
//      left alone) and serves the production build, with the API's sign-in links pointing at it;
//   4. runs the gate's Playwright spec in apps/person/e2e with a real service worker;
//   5. checks the report holds exactly the tests in the gate's registry, in both languages, none skipped;
//   6. stops every server by process id, whatever happened.
//
// Ports are the dev ports plus the gate's shift (phase 2: 250, phase 3: 300, phase 4: 375, gate C: 450, with PORT_OFFSET added), so a
// gate runs beside `pnpm dev` and beside the other gates; 375 is not a multiple of 50, so no PORT_OFFSET in steps of
// 100 makes it meet another gate's ports, and 450 meets none of the others at any such offset. No Docker is needed. Everything is bounded: 60 s per test, 10 minutes for
// the suite, 16 minutes in all.
//
// `E2E_GREP=<text>` runs only the tests whose title contains the text, to work on one test. A subset run checks
// nothing against the registry, prints that it is not an acceptance result and exits non-zero. So does a run with
// `E2E_UPDATE_SNAPSHOTS=1`, which rewrites the pixel baselines instead of comparing against them (exit 3 when it otherwise passed).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gateOutcome, isUpdateRun } from './e2e-gate-lib.mjs';
import { ROOT, killTree, resolveEnv } from './lib.mjs';

const DEFAULT_TOTAL_LIMIT_MS = 16 * 60_000;
const LOCALES = ['ar', 'en'];

/**
 * @typedef {{ name: string, spec: string, registry: string, portShift: number, clinician?: boolean, ops?: boolean, demo?: boolean, limitMs?: number, suiteTimeoutMs?: number }} Gate
 * `spec` and `registry` are paths under apps/person/e2e. `clinician` and `ops` also build and serve that staff app. `demo` starts
 * the API with `DEMO_MODE` on (the demo clock and reset routes); every other gate leaves them unregistered. `limitMs` and
 * `suiteTimeoutMs` raise the gate's total limit (default 16 minutes) and Playwright's suite limit (default 10) for a longer run.
 */

/** @param {Gate} gate */
export async function runGate(gate) {
const env = /** @type {Record<string, string>} */ (resolveEnv());
const apiPort = Number(env.API_PORT) + gate.portShift;
const inspectPort = apiPort + 1;
const staticPort = Number(env.PERSON_PORT) + gate.portShift;
const base = `http://127.0.0.1:${staticPort}`;
const api = `http://127.0.0.1:${apiPort}`;
const inspect = `http://127.0.0.1:${inspectPort}`;
const personDir = resolve(ROOT, 'apps/person');
// The staff apps, for a gate that drives them: dev port plus the gate's shift, each built into its own folder.
/** @type {{ key: 'clinician' | 'ops', filter: string, port: number, url: string, env: Record<string, string> }[]} */
const staffApps = [];
if (gate.clinician) {
  const port = Number(env.CLINICIAN_PORT) + gate.portShift;
  staffApps.push({ key: 'clinician', filter: '@mawsool/clinician', port, url: `http://127.0.0.1:${port}`, env: { NEXT_PUBLIC_API_URL: api, CLINICIAN_DIST_DIR: '.next-e2e' } });
}
if (gate.ops) {
  const port = Number(env.OPS_PORT) + gate.portShift;
  staffApps.push({ key: 'ops', filter: '@mawsool/ops', port, url: `http://127.0.0.1:${port}`, env: { NEXT_PUBLIC_API_URL: api, OPS_DIST_DIR: '.next-e2e' } });
}
/** The environment the API and the spec learn the staff apps' addresses from. */
const staffUrlEnv = Object.fromEntries(staffApps.map((app) => [app.key === 'clinician' ? 'E2E_CLINICIAN_URL' : 'E2E_OPS_URL', app.url]));

/** @type {import('node:child_process').ChildProcess[]} */
const started = [];
let finished = false;

/** @param {string} message */
const log = (message) => console.log(`[${gate.name}] ${message}`);

/**
 * Runs a command to completion in the foreground.
 * @param {string} command @param {string[]} args @param {Record<string, string>} [extraEnv]
 */
function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, env: { ...env, ...extraEnv }, stdio: 'inherit' });
  return result.status ?? 1;
}

/** Starts a long-running server and remembers it for cleanup. @param {string} command @param {string[]} args @param {Record<string, string>} extraEnv @param {string} [cwd] */
function serve(command, args, extraEnv, cwd = ROOT) {
  const child = spawn(command, args, { cwd, env: { ...env, ...extraEnv }, stdio: ['ignore', 'inherit', 'inherit'] });
  started.push(child);
  return child;
}

/** @param {string} url @param {number} timeoutMs */
async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return false;
}

async function stopServers() {
  for (const child of started) if (child.pid && child.exitCode === null) await killTree(child.pid, 5000);
}

/** @param {number} code */
async function finish(code) {
  if (finished) return;
  finished = true;
  await stopServers();
  process.exit(code);
}

const totalLimitMs = gate.limitMs ?? DEFAULT_TOTAL_LIMIT_MS;
const watchdog = setTimeout(() => {
  log(`gave up after ${totalLimitMs / 60_000} minutes`);
  void finish(1);
}, totalLimitMs);
watchdog.unref();
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.on(signal, () => void finish(130));

try {
  log(`building the person app with the API at ${api}`);
  if (run('pnpm', ['--filter', '@mawsool/person', 'build'], { NEXT_PUBLIC_API_URL: api }) !== 0) await finish(1);

  for (const app of staffApps) {
    log(`building the ${app.key} app with the API at ${api}`);
    if (run('pnpm', ['--filter', app.filter, 'build'], app.env) !== 0) await finish(1);
  }

  log('making sure Chromium is installed (only Chromium)');
  if (run('pnpm', ['--filter', '@mawsool/person', 'exec', 'playwright', 'install', 'chromium']) !== 0) await finish(1);

  log(`starting the API on ${api} and the export on ${base}`);
  serve('pnpm', ['--filter', '@mawsool/api', 'serve:e2e'], {
    E2E_API_PORT: String(apiPort),
    E2E_INSPECT_PORT: String(inspectPort),
    E2E_ORIGIN: base,
    ...(gate.demo ? { E2E_DEMO_MODE: '1' } : {}),
    ...staffUrlEnv,
  });
  serve('node', ['apps/person/e2e/serve-static.mjs'], { E2E_STATIC_PORT: String(staticPort) });
  // Next is started directly, not through pnpm, so stopping it at the end prints no package-manager error.
  for (const app of staffApps) serve('node', ['node_modules/next/dist/bin/next', 'start', '-p', String(app.port)], app.env, resolve(ROOT, 'apps', app.key));
  let up = (await waitFor(`${api}/health`, 90_000)) && (await waitFor(`${base}/en/`, 30_000));
  for (const app of staffApps) up = up && (await waitFor(`${app.url}/en/sign-in/`, 60_000));
  if (!up) {
    log('a server did not come up');
    await finish(1);
  }

  log('running the Playwright suite');
  const reportFile = resolve(personDir, 'test-results/e2e-report.json');
  const grep = process.env.E2E_GREP ? ['--grep', process.env.E2E_GREP] : [];
  const status = run('pnpm', ['--filter', '@mawsool/person', 'exec', 'playwright', 'test', `e2e/${gate.spec}`, ...grep], {
    E2E_BASE_URL: base,
    E2E_API_URL: api,
    E2E_INSPECT_URL: inspect,
    ...(gate.suiteTimeoutMs ? { E2E_SUITE_TIMEOUT_MS: String(gate.suiteTimeoutMs) } : {}),
    ...staffUrlEnv,
  });

  if (grep.length > 0) {
    log(`subset run (E2E_GREP=${process.env.E2E_GREP}), playwright exit ${status}: not an acceptance result`);
    await finish(1);
  }

  // The suite must have run what it claims to run: one passing test per entry and language, nothing skipped.
  /** @type {{ id: string, sentence: string }[]} */
  const registry = JSON.parse(readFileSync(resolve(personDir, `e2e/${gate.registry}`), 'utf8'));
  const expected = new Set(registry.flatMap((entry) => LOCALES.map((locale) => `${entry.id} [${locale}]: ${entry.sentence}`)));
  /** @type {Map<string, string>} */
  const outcomes = new Map();
  /** @param {any} suite */
  const collect = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) outcomes.set(spec.title, test.status);
    }
    for (const child of suite.suites ?? []) collect(child);
  };
  if (existsSync(reportFile)) for (const suite of JSON.parse(readFileSync(reportFile, 'utf8')).suites ?? []) collect(suite);

  const problems = [
    ...[...expected].filter((title) => outcomes.get(title) !== 'expected').map((title) => `not passed: ${title} (${outcomes.get(title) ?? 'not run'})`),
    ...[...outcomes.keys()].filter((title) => !expected.has(title)).map((title) => `unregistered test ran: ${title}`),
  ];
  for (const problem of problems) log(problem);
  const passed = [...expected].filter((title) => outcomes.get(title) === 'expected').length;
  log(`${passed} of ${expected.size} registered tests passed (playwright exit ${status})`);
  const outcome = gateOutcome({ updating: isUpdateRun(env), playwrightStatus: status, problems });
  if (outcome.note) log(outcome.note);
  await finish(outcome.code);
} catch (error) {
  log(`failed: ${error instanceof Error ? error.stack : String(error)}`);
  await finish(1);
}
}
