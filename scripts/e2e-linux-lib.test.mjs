import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { BROWSER_GATES, nodeVersion, parseArgs, playwrightImage, pnpmVersion } from './e2e-linux-lib.mjs';
import { ROOT } from './lib.mjs';

const read = (/** @type {string} */ file) => readFileSync(resolve(ROOT, file), 'utf8');

test('the Playwright image is the official one for the exact version the person app pins', () => {
  assert.deepEqual(playwrightImage('{"devDependencies":{"@playwright/test":"1.64.1"}}'), { version: '1.64.1', image: 'mcr.microsoft.com/playwright:v1.64.1-noble' });
});

test('a Playwright range, or no Playwright, is refused: an image that moves would redraw every baseline unannounced', () => {
  assert.throws(() => playwrightImage('{"devDependencies":{"@playwright/test":"^1.64.1"}}'), /exact version/);
  assert.throws(() => playwrightImage('{"devDependencies":{"@playwright/test":"latest"}}'), /exact version/);
  assert.throws(() => playwrightImage('{"devDependencies":{}}'), /exact version/);
});

test('Node and pnpm are read from the files that pin them, and only as exact versions', () => {
  assert.equal(nodeVersion('24.11.1\n'), '24.11.1');
  assert.equal(nodeVersion('v24.11.1'), '24.11.1');
  assert.throws(() => nodeVersion('lts/*'), /exact Node version/);
  assert.equal(pnpmVersion('{"packageManager":"pnpm@12.6.0"}'), '12.6.0');
  assert.throws(() => pnpmVersion('{"packageManager":"npm@10.0.0"}'), /pnpm@/);
  assert.throws(() => pnpmVersion('{}'), /pnpm@/);
});

test('the arguments name the gates and the platform, and refuse anything else', () => {
  assert.deepEqual(parseArgs([]), { update: false, platform: 'linux/amd64', gates: [...BROWSER_GATES], run: null });
  assert.deepEqual(parseArgs(['--update', 'c', 'phase2']), { update: true, platform: 'linux/amd64', gates: ['c', 'phase2'], run: null });
  assert.equal(parseArgs(['--platform=linux/arm64']).platform, 'linux/arm64');
  assert.equal(parseArgs(['--run=pnpm test']).run, 'pnpm test');
  assert.throws(() => parseArgs(['phase9']), /unknown argument/);
  assert.throws(() => parseArgs(['--platform=darwin/arm64']), /linux\/amd64 or linux\/arm64/);
  // A baseline is only written by the build CI draws with: a check may run on arm64, an update may not.
  assert.deepEqual(parseArgs(['--platform=linux/arm64', 'c']), { update: false, platform: 'linux/arm64', gates: ['c'], run: null });
  assert.throws(() => parseArgs(['--update', '--platform=linux/arm64']), /only writes baselines on linux\/amd64/);
  assert.throws(() => parseArgs(['--platform=linux/arm64', '--update', 'phase2']), /only writes baselines on linux\/amd64/);
  assert.equal(parseArgs(['--update', '--platform=linux/amd64']).update, true);
  // One command runs on its own: it is not a gate, and it never rewrites a baseline.
  assert.throws(() => parseArgs(['--run=pnpm test', '--update']), /takes no gate/);
  assert.throws(() => parseArgs(['--run=pnpm test', 'c']), /takes no gate/);
  assert.throws(() => parseArgs(['--run=']), /takes no gate/);
});

test('the CI workflow runs the browser gates in the same container and the same Node as the Linux baselines', () => {
  const workflow = read('.github/workflows/ci.yml');
  const { image } = playwrightImage(read('apps/person/package.json'));
  assert.ok(workflow.includes(`image: ${image}`), `ci.yml must run the browser gates in ${image}`);
  assert.match(workflow, /node-version-file: \.nvmrc/);
  for (const gate of BROWSER_GATES) assert.match(workflow, new RegExp(`(?:gate: \\[[^\\]]*\\b${gate}\\b)|(?:pnpm gate:${gate}\\b)`), `ci.yml must run gate:${gate}`);
  // Snapshot comparison stays on in CI: a missing or stale Linux baseline fails the run instead of being skipped.
  assert.doesNotMatch(workflow, /E2E_UPDATE_SNAPSHOTS/);
});

test('every committed macOS baseline has a Linux one beside it, so CI has something to compare against', async () => {
  const { readdirSync, existsSync } = await import('node:fs');
  const e2e = resolve(ROOT, 'apps/person/e2e');
  const folders = readdirSync(e2e).filter((name) => name.endsWith('-snapshots'));
  assert.ok(folders.length >= 4, 'the snapshot folders were found');
  for (const folder of folders) {
    for (const file of readdirSync(resolve(e2e, folder)).filter((name) => name.endsWith('-chromium-darwin.png'))) {
      const linux = file.replace('-chromium-darwin.png', '-chromium-linux.png');
      assert.ok(existsSync(resolve(e2e, folder, linux)), `${folder}/${linux} is missing; run pnpm e2e:linux --update`);
    }
  }
});
