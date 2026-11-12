import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { ROOT } from './lib.mjs';

/** @type {import('node:child_process').ChildProcess} */
let child;
let base = '';

/** A port nothing listens on, asked of the system. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
      probe.close(() => resolvePort(port));
    });
  });
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn('node', [resolve(ROOT, 'apps/person/e2e/serve-static.mjs')], { env: { ...process.env, E2E_STATIC_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolveReady) => child.stdout?.once('data', resolveReady));
});

after(() => {
  child.kill('SIGTERM');
});

const json = async (/** @type {string} */ path) => (await fetch(`${base}${path}`)).json();

test('a service worker update check is counted apart from page requests, and every other request still counts as a page request', async () => {
  await fetch(`${base}/sw.js`, { headers: { 'service-worker': 'script' } });
  assert.deepEqual(await json('/__e2e/hits'), {}, 'the browser\'s own update check is not a page request');
  assert.deepEqual(await json('/__e2e/update-checks'), { '/sw.js': 1 });

  // A request for the script that is not the browser's update check is a page request like any other: offline, it must fail a test.
  await fetch(`${base}/sw.js`);
  await fetch(`${base}/ar/`);
  await fetch(`${base}/sw.js`, { headers: { 'service-worker': 'something-else' } });
  assert.deepEqual(await json('/__e2e/hits'), { '/sw.js': 2, '/ar/': 1 });
  assert.deepEqual(await json('/__e2e/update-checks'), { '/sw.js': 1 });
});
