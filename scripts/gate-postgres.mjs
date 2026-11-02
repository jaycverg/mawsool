// @ts-check
// `pnpm gate:postgres`: the checks PGlite cannot make, against the real Compose Postgres.
//
//   - several connections sweeping at once leave exactly one `overdue` event per ticket;
//   - pg-boss starts, the sweep's schedule exists, and one fire of the queue runs the sweep;
//   - the demo's reset and one sweep leave the funnel and the Urdu row equal to the ones PGlite gives for the same steps.
//
// It needs Docker and fails, never skips, when Docker is not available. It starts the Compose Postgres (and leaves it
// running; `pnpm db:down` stops it), works in a database of its own that it drops at the end, and takes under a
// minute. It stays out of `verify`: `verify` already needs Docker for `smoke:dev`, but this adds a database and a
// queue run that only matters when the sweep or the queue changes.
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';

const log = (/** @type {string} */ message) => console.log(`[gate:postgres] ${message}`);

if (spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 30_000 }).status !== 0) {
  log('Docker is not available. Start it (OrbStack: `orb start`); this check is never skipped.');
  process.exit(1);
}

const run = (/** @type {string[]} */ args, /** @type {number} */ timeout) => spawnSync('node', ['scripts/with-env.mjs', ...args], { cwd: ROOT, stdio: 'inherit', timeout });

if (run(['docker', 'compose', '-f', 'infra/docker-compose.yml', 'up', '-d', '--wait', 'postgres'], 120_000).status !== 0) {
  log('could not start the Compose Postgres');
  process.exit(1);
}
const checked = run(['pnpm', '--filter', '@mawsool/api', 'exec', 'tsx', 'src/cli/verify-postgres.ts'], 180_000);
if (checked.signal) log(`killed by ${checked.signal}`);
process.exit(checked.status === 0 ? 0 : 1);
