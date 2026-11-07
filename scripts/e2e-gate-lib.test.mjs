import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { UPDATE_RUN_EXIT_CODE, gateOutcome, isUpdateRun } from './e2e-gate-lib.mjs';
import { ROOT } from './lib.mjs';

test('a normal run exits 0 only when Playwright passed and the registry check found nothing', () => {
  assert.deepEqual(gateOutcome({ updating: false, playwrightStatus: 0, problems: [] }), { code: 0, note: null });
  assert.equal(gateOutcome({ updating: false, playwrightStatus: 1, problems: [] }).code, 1);
  assert.equal(gateOutcome({ updating: false, playwrightStatus: 0, problems: ['not passed: x'] }).code, 1);
});

test('a run that rewrites the baselines never exits 0, and says it is not an acceptance result', () => {
  const outcome = gateOutcome({ updating: true, playwrightStatus: 0, problems: [] });
  assert.equal(outcome.code, UPDATE_RUN_EXIT_CODE);
  assert.notEqual(outcome.code, 0);
  assert.match(outcome.note ?? '', /not an acceptance result/);
});

test('an update run that also failed exits 1, not the update code, so a failure is never taken for a rewrite', () => {
  assert.equal(gateOutcome({ updating: true, playwrightStatus: 1, problems: [] }).code, 1);
  assert.equal(gateOutcome({ updating: true, playwrightStatus: 0, problems: ['unregistered test ran: y'] }).code, 1);
});

test('only E2E_UPDATE_SNAPSHOTS=1 makes a run an update run, the one value the Playwright config reads as on', () => {
  assert.equal(isUpdateRun({ E2E_UPDATE_SNAPSHOTS: '1' }), true);
  for (const value of [undefined, '', '0', 'true']) assert.equal(isUpdateRun({ E2E_UPDATE_SNAPSHOTS: value }), false, String(value));
  assert.match(readFileSync(resolve(ROOT, 'apps/person/playwright.config.ts'), 'utf8'), /process\.env\.E2E_UPDATE_SNAPSHOTS === '1'/);
});

test('every browser gate runs through the shared runner that applies the outcome', () => {
  for (const gate of ['phase2', 'phase3', 'phase4', 'c']) {
    const source = readFileSync(resolve(ROOT, `scripts/gate-${gate}.mjs`), 'utf8');
    assert.match(source, /runGate\(/, `gate-${gate}.mjs runs through runGate`);
  }
  assert.match(readFileSync(resolve(ROOT, 'scripts/e2e-gate.mjs'), 'utf8'), /gateOutcome\(/);
});

/**
 * The `gate_status` function of the container script, run on its own in bash with the environment given.
 * @param {number} code
 * @param {Record<string, string>} env
 */
function gateStatus(code, env) {
  const script = readFileSync(resolve(ROOT, 'scripts/e2e-linux-inner.sh'), 'utf8');
  const fn = /^gate_status\(\) \{\n[\s\S]*?\n\}$/m.exec(script)?.[0];
  assert.ok(fn, 'gate_status is defined in e2e-linux-inner.sh');
  return spawnSync('bash', ['-c', `${fn}\ngate_status ${code}`], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).status;
}

test('the container script counts the update exit code as a pass only in a run that asked for the rewrite', () => {
  assert.equal(gateStatus(UPDATE_RUN_EXIT_CODE, { E2E_UPDATE_SNAPSHOTS: '1' }), 0);
  assert.equal(gateStatus(UPDATE_RUN_EXIT_CODE, {}), UPDATE_RUN_EXIT_CODE);
  assert.equal(gateStatus(1, { E2E_UPDATE_SNAPSHOTS: '1' }), 1);
  assert.equal(gateStatus(0, {}), 0);
});
