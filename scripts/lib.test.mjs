// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE_PORTS, appUrls, deriveEnv } from './lib.mjs';

test('defaults use the base ports and project name mawsool-0', () => {
  const env = deriveEnv({});
  assert.equal(env.API_PORT, '4000');
  assert.equal(env.PERSON_PORT, '3000');
  assert.equal(env.CLINICIAN_PORT, '3001');
  assert.equal(env.OPS_PORT, '3002');
  assert.equal(env.POSTGRES_PORT, '54329');
  assert.equal(env.COMPOSE_PROJECT_NAME, 'mawsool-0');
  assert.equal(env.DATABASE_URL, 'postgres://mawsool:mawsool@localhost:54329/mawsool');
});

test('PORT_OFFSET shifts every port, the URLs built from them and the Compose project', () => {
  const env = deriveEnv({ PORT_OFFSET: '100' });
  assert.equal(env.API_PORT, '4100');
  assert.equal(env.PERSON_PORT, '3100');
  assert.equal(env.CLINICIAN_PORT, '3101');
  assert.equal(env.OPS_PORT, '3102');
  assert.equal(env.POSTGRES_PORT, '54429');
  assert.equal(env.NEXT_PUBLIC_API_URL, 'http://localhost:4100');
  assert.equal(env.DATABASE_URL, 'postgres://mawsool:mawsool@localhost:54429/mawsool');
  assert.equal(env.CORS_ORIGINS, 'http://localhost:3100,http://localhost:3101,http://localhost:3102');
  assert.equal(env.COMPOSE_PROJECT_NAME, 'mawsool-100');
  assert.equal(env.PERSON_APP_URL, 'http://localhost:3100');
  assert.equal(env.CLINICIAN_APP_URL, 'http://localhost:3101');
  assert.equal(env.OPS_APP_URL, 'http://localhost:3102');
});

test('two offsets never share a port', () => {
  const ports = (/** @type {Record<string,string>} */ e) =>
    [e.API_PORT, e.PERSON_PORT, e.CLINICIAN_PORT, e.OPS_PORT, e.POSTGRES_PORT].map(Number);
  const first = ports(deriveEnv({ PORT_OFFSET: '0' }));
  const second = ports(deriveEnv({ PORT_OFFSET: '10' }));
  assert.equal(new Set([...first, ...second]).size, 10);
});

test('explicit overrides win over the offset', () => {
  const env = deriveEnv({ PORT_OFFSET: '5', API_PORT: '4999', COMPOSE_PROJECT_NAME: 'custom' });
  assert.equal(env.API_PORT, '4999');
  assert.equal(env.NEXT_PUBLIC_API_URL, 'http://localhost:4999');
  assert.equal(env.COMPOSE_PROJECT_NAME, 'custom');
  assert.equal(env.PERSON_PORT, String(BASE_PORTS.person + 5));
});

test('an invalid offset is rejected', () => {
  for (const bad of ['-1', '1001', '1.5', 'abc']) {
    assert.throws(() => deriveEnv({ PORT_OFFSET: bad }), /PORT_OFFSET/);
  }
});

test('appUrls lists the API health route, the three locale roots, both staff sign-in pages and each app favicon', () => {
  const urls = appUrls(deriveEnv({}));
  assert.deepEqual(
    urls.map((u) => u.name),
    ['api', 'person', 'clinician', 'ops', 'clinician sign-in', 'ops sign-in', 'person favicon', 'clinician favicon', 'ops favicon'],
  );
  assert.deepEqual(urls.slice(6).map((u) => u.url), ['http://localhost:3000/icon.svg', 'http://localhost:3001/icon.svg', 'http://localhost:3002/icon.svg']);
  assert.equal(urls[0]?.url, 'http://localhost:4000/health');
  assert.equal(urls[4]?.url, 'http://localhost:3001/en/sign-in/');
  assert.equal(urls[5]?.url, 'http://localhost:3002/en/sign-in/');
});

test('appUrls follows PORT_OFFSET for the sign-in pages and the favicons', () => {
  const urls = appUrls(deriveEnv({ PORT_OFFSET: '100' }));
  assert.equal(urls[4]?.url, 'http://localhost:3101/en/sign-in/');
  assert.equal(urls[5]?.url, 'http://localhost:3102/en/sign-in/');
  assert.equal(urls.at(-1)?.url, 'http://localhost:3102/icon.svg');
});

test('docs/demo-e2e-spec.md is the current demo spec and registry', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { renderDemoSpec, OUTPUT_FILE } = await import('./export-demo-spec.mjs');
  const { ROOT } = await import('./lib.mjs');
  assert.equal(readFileSync(resolve(ROOT, OUTPUT_FILE), 'utf8'), renderDemoSpec(), 'run `node scripts/export-demo-spec.mjs` to refresh docs/demo-e2e-spec.md');
});
