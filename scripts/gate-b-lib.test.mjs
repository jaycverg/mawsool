import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateRegistry, runProblem } from './gate-b-lib.mjs';

/** @param {string} file @param {string} fullName */
const pass = (file, fullName) => ({ file, fullName, status: 'passed' });
const reports = { 'apps/api': [pass('/x/test/a.test.ts', 'suite one does the thing'), pass('/x/test/a.test.ts', 'suite two does another thing'), pass('/x/test/b.test.ts', 'b works')] };
/** @param {any[]} tests @param {Record<string, unknown>} [extra] */
const entry = (tests, extra = {}) => ({ id: 'e1', sentence: 's', project: 'apps/api', tests, ...extra });

test('a sentence whose tests all exist and passed has no problem', () => {
  assert.deepEqual(evaluateRegistry([entry([{ file: 'test/a.test.ts', name: 'does the thing' }, { file: 'test/b.test.ts' }])], reports, []), []);
});

test('a missing test fails the gate', () => {
  assert.match(String(evaluateRegistry([entry([{ file: 'test/a.test.ts', name: 'never written' }])], reports, [])[0]), /no such test/);
  assert.match(String(evaluateRegistry([entry([{ file: 'test/gone.test.ts' }])], reports, [])[0]), /no such test/);
});

test('a name that matches two tests is ambiguous and fails', () => {
  assert.match(String(evaluateRegistry([entry([{ file: 'test/a.test.ts', name: 'does' }])], reports, [])[0]), /matches 2 tests/);
});

test('a failed, skipped or todo test fails the gate', () => {
  for (const status of ['failed', 'skipped', 'todo']) {
    const run = { 'apps/api': [{ file: '/x/test/a.test.ts', fullName: 'suite one does the thing', status }] };
    assert.match(String(evaluateRegistry([entry([{ file: 'test/a.test.ts', name: 'does the thing' }])], run, [])[0]), new RegExp(status));
  }
});

test('a sentence with no test, a duplicate id and a project that was not run all fail', () => {
  assert.match(String(evaluateRegistry([entry([])], reports, [])[0]), /no test is named/);
  assert.match(String(evaluateRegistry([entry([{ file: 'test/b.test.ts' }]), entry([{ file: 'test/b.test.ts' }])], reports, []).join('\n')), /listed twice/);
  assert.match(String(evaluateRegistry([entry([{ file: 'test/b.test.ts' }], { project: 'apps/other' })], reports, [])[0]), /was not run/);
});

test('a browser sentence needs its test in the browser gate registry', () => {
  assert.deepEqual(evaluateRegistry([{ id: 'b', sentence: 's', browser: 'redirect' }], {}, ['redirect']), []);
  assert.match(evaluateRegistry([{ id: 'b', sentence: 's', browser: 'redirect' }], {}, ['other']).join('\n'), /not in the browser gate/);
});

test('a browser test that no sentence claims is a problem, so a new one cannot sit unregistered', () => {
  assert.match(String(evaluateRegistry([], {}, ['orphan'])[0]), /no sentence in this registry claims/);
});

test('a run with no tests, or any test not passed, is a problem', () => {
  assert.equal(runProblem([]), 'ran no tests');
  assert.match(String(runProblem([pass('f', 'a'), { file: 'f', fullName: 'b', status: 'skipped' }])), /skipped/);
  assert.equal(runProblem([pass('f', 'a')]), null);
});
