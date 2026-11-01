// @ts-check
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Default host ports. PORT_OFFSET shifts all of them together. */
export const BASE_PORTS = Object.freeze({
  api: 4000,
  person: 3000,
  clinician: 3001,
  ops: 3002,
  postgres: 54329,
});

/**
 * Derive every port, URL and Compose setting from PORT_OFFSET and explicit overrides.
 * Pure: reads only the env object it is given, so a second copy of the repo needs one variable.
 * @param {Record<string, string | undefined>} source
 * @returns {Record<string, string>}
 */
export function deriveEnv(source) {
  const rawOffset = source.PORT_OFFSET ?? '0';
  const offset = Number(rawOffset);
  if (!Number.isInteger(offset) || offset < 0 || offset > 1000) {
    throw new Error(`PORT_OFFSET must be an integer from 0 to 1000, got "${rawOffset}"`);
  }
  const port = (/** @type {keyof typeof BASE_PORTS} */ key, /** @type {string} */ envName) =>
    source[envName] ?? String(BASE_PORTS[key] + offset);

  const apiPort = port('api', 'API_PORT');
  const personPort = port('person', 'PERSON_PORT');
  const clinicianPort = port('clinician', 'CLINICIAN_PORT');
  const opsPort = port('ops', 'OPS_PORT');
  const postgresPort = source.POSTGRES_PORT ?? String(BASE_PORTS.postgres + offset);

  const user = source.POSTGRES_USER ?? 'mawsool';
  const password = source.POSTGRES_PASSWORD ?? 'mawsool';
  const db = source.POSTGRES_DB ?? 'mawsool';

  return {
    PORT_OFFSET: String(offset),
    API_PORT: apiPort,
    API_HOST: source.API_HOST ?? '127.0.0.1',
    PERSON_PORT: personPort,
    CLINICIAN_PORT: clinicianPort,
    OPS_PORT: opsPort,
    POSTGRES_USER: user,
    POSTGRES_PASSWORD: password,
    POSTGRES_DB: db,
    POSTGRES_PORT: postgresPort,
    DATABASE_URL:
      source.DATABASE_URL ??
      `postgres://${user}:${password}@localhost:${postgresPort}/${db}`,
    NEXT_PUBLIC_API_URL: source.NEXT_PUBLIC_API_URL ?? `http://localhost:${apiPort}`,
    CORS_ORIGINS:
      source.CORS_ORIGINS ??
      [personPort, clinicianPort, opsPort].map((p) => `http://localhost:${p}`).join(','),
    STAFF_LINK_BASE_URL: source.STAFF_LINK_BASE_URL ?? `http://localhost:${clinicianPort}`,
    COMPOSE_PROJECT_NAME: source.COMPOSE_PROJECT_NAME ?? `mawsool-${offset}`,
  };
}

/**
 * Load .env (when present) into process.env, then return process.env merged with the derived values.
 * Variables already set in the shell win over the file.
 * @returns {NodeJS.ProcessEnv}
 */
export function resolveEnv() {
  const file = resolve(ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
  return { ...process.env, ...deriveEnv(process.env) };
}

/**
 * @param {Record<string, string>} env
 * @returns {{ name: string, url: string }[]}
 */
export function appUrls(env) {
  return [
    { name: 'api', url: `http://localhost:${env.API_PORT}/health` },
    { name: 'person', url: `http://localhost:${env.PERSON_PORT}/en/` },
    { name: 'clinician', url: `http://localhost:${env.CLINICIAN_PORT}/en/` },
    { name: 'ops', url: `http://localhost:${env.OPS_PORT}/en/` },
  ];
}

/**
 * Stops a process and everything it started. `pnpm`, Turborepo and Next each start children that outlive a
 * signal sent only to the parent, so the whole tree is collected first (children are re-parented to init once
 * the parent dies) and then signalled: SIGTERM, then SIGKILL for whatever is still alive after `graceMs`.
 * @param {number} rootPid
 * @param {number} [graceMs]
 */
export async function killTree(rootPid, graceMs = 8000) {
  const { execFileSync } = await import('node:child_process');
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const children = new Map();
  for (const [pid, ppid] of rows) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  /** @type {number[]} */
  const tree = [];
  const walk = (/** @type {number} */ pid) => {
    tree.push(pid);
    for (const child of children.get(pid) ?? []) walk(child);
  };
  walk(rootPid);

  const signal = (/** @type {NodeJS.Signals} */ name) => {
    for (const pid of [...tree].reverse()) {
      try {
        process.kill(pid, name);
      } catch {
        /* already gone */
      }
    }
  };
  const alive = () =>
    tree.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (alive().length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  if (alive().length > 0) signal('SIGKILL');
}
