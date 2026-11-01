// @ts-check
// `pnpm dev`: Postgres (Docker Compose), migrations, then the API and the three web apps through Turborepo.
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, killTree, resolveEnv } from './lib.mjs';

const env = resolveEnv();
const compose = ['compose', '-f', 'infra/docker-compose.yml'];

/**
 * @param {string} cmd
 * @param {string[]} args
 */
function runOrExit(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: ROOT, env, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n"${cmd} ${args.join(' ')}" failed (exit ${result.status}).`);
    process.exit(result.status ?? 1);
  }
}

const docker = spawnSync('docker', ['info'], { cwd: ROOT, env, stdio: 'ignore' });
if (docker.status !== 0) {
  console.error('The Docker daemon is not reachable. Start it (OrbStack: `orb start`) and run `pnpm dev` again.');
  process.exit(1);
}

console.log(`Starting Postgres on port ${env.POSTGRES_PORT} (project ${env.COMPOSE_PROJECT_NAME})`);
runOrExit('docker', [...compose, 'up', '-d', '--wait', 'postgres']);
runOrExit('pnpm', ['--filter', '@mawsool/api', 'db:migrate']);

console.log(
  `api :${env.API_PORT}  person :${env.PERSON_PORT}  clinician :${env.CLINICIAN_PORT}  ops :${env.OPS_PORT}`,
);
const turbo = spawn('pnpm', ['exec', 'turbo', 'run', 'dev'], { cwd: ROOT, env, stdio: 'inherit' });

// Turborepo does not always stop the apps it started, so stop the whole tree.
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => {
    if (turbo.pid) void killTree(turbo.pid);
  });
}
turbo.on('exit', (code) => {
  console.log('Apps stopped. Postgres is still running; stop it with `pnpm db:down`.');
  process.exit(code ?? 0);
});
